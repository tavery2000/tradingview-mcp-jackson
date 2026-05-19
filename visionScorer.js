/**
 * visionScorer.js — Vision Phase 5 scoring module.
 *
 * 2026-05-19: Built during the 13:00 ET work block per operator's URGENT
 * directive. Reads a chart screenshot, asks Claude Haiku 4.5 to score it
 * on a 5-dimension rubric, returns numeric scores + a contracts multiplier.
 *
 * Architecture choice — synchronous-per-alert, NOT polling-monitor.
 *   The locked memory spec called for vision-monitor.js + visionCache.js
 *   with 20-30s polling. Today's spec inverts: capture + score at the
 *   moment of pine-alert.inbound. Trade-off:
 *     polling — fresh cache hit on every alert (sub-ms lookup) but
 *               the cache may be 30s stale
 *     per-alert — adds 2-5s latency per entry but the model sees the
 *               EXACT bar that triggered the alert
 *   Per-alert is more accurate for late-fire detection (the whole point
 *   of Phase 5). The 2-5s latency adds to Pine's bar-close lag but
 *   doesn't change the structural problem.
 *
 * DRY-RUN mode (default): scores get logged but the multiplier is NOT
 * applied to contract sizing. Operator validates the scores against
 * actual outcomes for a few days, then flips VISION_SIZING_ENABLED=true.
 *
 * Model: claude-haiku-4-5-20251001 (per operator's afternoon spec — a
 * change from the locked memory spec which had Sonnet 4.6. Haiku is
 * 5-10× cheaper; smoke-test rollout first, upgrade later if accuracy
 * insufficient).
 *
 * Returns: {
 *   trend_alignment, momentum, sr_headroom, volume_confirm, exhaustion_safety,
 *   composite, multiplier, tier, reasoning,
 *   modelLatencyMs, inputTokens, outputTokens, costEstimateUsd
 * }
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = process.env.VISION_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS || '512', 10);

// Haiku 4.5 pricing (approx, per 1M tokens): $1.00 input / $5.00 output
const COST_INPUT_PER_MTOK  = parseFloat(process.env.VISION_COST_INPUT_PER_MTOK  || '1.00');
const COST_OUTPUT_PER_MTOK = parseFloat(process.env.VISION_COST_OUTPUT_PER_MTOK || '5.00');

let _client = null;
function _getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing — set in .env');
  _client = new Anthropic({ apiKey });
  return _client;
}

// 5-dimension rubric. Returns 0-10 for each dimension + reasoning.
// All dimensions framed POSITIVELY (higher = better for the proposed trade)
// so multiplier math is straightforward: composite average → multiplier band.
function _buildPrompt({ instrument, direction, engine, price, levels }) {
  const ctx = levels ? `
Current price context:
  Price: ${price}
  VWAP:  ${levels.vwap}
  PDH:   ${levels.pdHigh}
  PDL:   ${levels.pdLow}
` : (price ? `\nCurrent price: ${price}\n` : '');

  return `You are scoring a paper-trading entry signal on a TradingView chart screenshot.

Signal details:
  Instrument: ${instrument}
  Direction:  ${direction} (${direction === 'CALLS' ? 'bullish/long' : 'bearish/short'})
  Engine:     ${engine}${ctx}

Score the chart on these 5 dimensions (0=very bad for this trade, 10=ideal):

1. trend_alignment — Is the higher-timeframe trend aligned with the ${direction} direction? 10 = strong aligned trend on display, 0 = strongly opposed trend.

2. momentum — Recent bar momentum confirming the ${direction} direction? 10 = strong impulse in our direction in last 5-10 bars, 0 = stalling or reversing.

3. sr_headroom — How much room before hitting nearest support (for PUTS) / resistance (for CALLS)? 10 = clear runway, plenty of move room ahead. 0 = entry IS right at a key S/R level (selling into PDL / buying into PDH / hitting an obvious zone). LATE-FIRE indicator: low score here = entering at the extreme.

4. volume_confirm — Is recent volume confirming the move? 10 = above-avg volume on the trigger bar, 0 = light or declining volume (signal lacks conviction).

5. exhaustion_safety — Inverted exhaustion risk. 10 = move is fresh, low exhaustion. 0 = move is mature, stretched, parabolic, likely to mean-revert. Look at distance-from-VWAP, consecutive same-direction bars, RSI-style extremes.

Respond in this EXACT JSON shape — no markdown, no prose outside the JSON:

{"trend_alignment": <0-10>, "momentum": <0-10>, "sr_headroom": <0-10>, "volume_confirm": <0-10>, "exhaustion_safety": <0-10>, "reasoning": "<one sentence, max 25 words, naming the deciding factor>"}`;
}

function _multiplierFromComposite(c) {
  if (c >= 8.0) return { mult: 1.5, tier: 'STRONG'  };
  if (c >= 6.0) return { mult: 1.2, tier: 'GOOD'    };
  if (c >= 4.0) return { mult: 1.0, tier: 'NEUTRAL' };
  if (c >= 2.0) return { mult: 0.7, tier: 'WEAK'    };
  return         { mult: 0.0, tier: 'REJECT'  };
}

/**
 * Score a chart screenshot for a given signal.
 *
 * @param {object} signal { instrument, direction, engine, price?, levels? }
 * @param {Buffer} imageBuffer  PNG image bytes
 * @returns {Promise<object>} scores + multiplier + meta
 */
export async function scoreChart(signal, imageBuffer) {
  const t0 = Date.now();
  const client = _getClient();
  const prompt = _buildPrompt(signal);
  const b64 = imageBuffer.toString('base64');

  const resp = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const latencyMs = Date.now() - t0;
  const textBlock = (resp.content || []).find(b => b.type === 'text');
  const raw = textBlock?.text || '';

  // Extract JSON — Haiku usually returns clean JSON but tolerate a code-fence wrapper.
  let parsed = null, parseError = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : JSON.parse(raw);
  } catch (e) { parseError = e.message; }

  const dims = parsed ? {
    trend_alignment:    _clamp(parsed.trend_alignment),
    momentum:           _clamp(parsed.momentum),
    sr_headroom:        _clamp(parsed.sr_headroom),
    volume_confirm:     _clamp(parsed.volume_confirm),
    exhaustion_safety:  _clamp(parsed.exhaustion_safety),
  } : null;

  const composite = dims
    ? (dims.trend_alignment + dims.momentum + dims.sr_headroom + dims.volume_confirm + dims.exhaustion_safety) / 5
    : null;

  const { mult, tier } = composite != null ? _multiplierFromComposite(composite) : { mult: 1.0, tier: 'PARSE_ERR' };

  const inputTokens  = resp.usage?.input_tokens  ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const costEstimateUsd = (inputTokens / 1e6) * COST_INPUT_PER_MTOK
                       + (outputTokens / 1e6) * COST_OUTPUT_PER_MTOK;

  return {
    ...dims,
    composite: composite != null ? +composite.toFixed(2) : null,
    multiplier: mult,
    tier,
    reasoning: parsed?.reasoning || null,
    parseError,
    raw: raw.slice(0, 300),
    model: MODEL_ID,
    modelLatencyMs: latencyMs,
    inputTokens, outputTokens,
    costEstimateUsd: +costEstimateUsd.toFixed(5),
  };
}

function _clamp(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return 5;   // neutral default if model returned non-numeric
  return Math.max(0, Math.min(10, n));
}

export { _multiplierFromComposite };
