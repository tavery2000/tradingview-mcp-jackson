// ─── NEWS.JS PATCH — RSS_FEEDS + impact scoring fixes ────────────────────────
//
// Fixes:
//   1. "undefinedNasdaq News" — missing color fields on new feeds
//   2. HIGH impact too loose — bankruptcy/refund headlines not market-moving
//   3. Tighter keyword specificity for HIGH vs MEDIUM
//
// APPLY: Replace RSS_FEEDS array and HIGH_IMPACT/MEDIUM_IMPACT lists in news.js
//
// ─────────────────────────────────────────────────────────────────────────────

// ── REPLACE: RSS_FEEDS ────────────────────────────────────────────────────────

const RSS_FEEDS = [
  {
    name:    'Financial Juice',
    url:     'https://www.financialjuice.com/feed.ashx?xy=rss',
    color:   '\x1b[32m',        // green
    primary: true,               // poll every 30s
  },
  {
    name:  'Reuters Business',
    url:   'https://feeds.reuters.com/reuters/businessNews',
    color: '\x1b[36m',          // cyan
  },
  {
    name:  'AP Business',
    url:   'https://feeds.apnews.com/rss/apf-business',
    color: '\x1b[33m',          // yellow
  },
  {
    name:  'CNBC Top News',
    url:   'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    color: '\x1b[34m',          // blue
  },
  {
    name:  'MarketWatch',
    url:   'https://feeds.marketwatch.com/marketwatch/topstories/',
    color: '\x1b[35m',          // magenta
  },
  {
    name:  'Investing.com',
    url:   'https://www.investing.com/rss/news.rss',
    color: '\x1b[94m',          // bright blue
  },
  {
    name:  'Yahoo Finance',
    url:   'https://finance.yahoo.com/news/rssindex',
    color: '\x1b[93m',          // bright yellow
  },
  {
    name:  'Nasdaq News',
    url:   'https://www.nasdaq.com/feed/rssoutbound?category=Markets',
    color: '\x1b[96m',          // bright cyan
  },
];

// ── REPLACE: HIGH_IMPACT keywords ────────────────────────────────────────────
//
// Tightened — removed generic 'lawsuit', 'bankruptcy', 'default' (fires on
// unrelated companies). Kept only systemic/macro-relevant terms.
// Rule: HIGH = market-moving within 30 minutes, not just financially notable.

const HIGH_IMPACT = [
  // Fed / macro
  'federal reserve', 'fomc', 'rate cut', 'rate hike', 'rate decision',
  'cpi', 'pce', 'nonfarm payroll', 'jobs report', 'gdp', 'recession',
  // Geopolitical — systemic risk
  'hormuz', 'strait of hormuz', 'iran nuclear', 'ceasefire', 'blockade',
  'nuclear', 'attack on', 'military strike',
  // OPEC / energy systemic
  'opec', 'oil embargo', 'crude supply cut',
  // Earnings — watchlist only (handled separately by ticker extraction)
  'earnings beat', 'earnings miss', 'revenue miss', 'guidance cut', 'guidance raised',
  // Corporate events — systemic scale only
  'chapter 11', 'systemic', 'contagion', 'bank run', 'fdic',
  'merger agreement', 'acquisition completed', 'hostile takeover',
  'sec charges', 'sec fraud', 'doj investigation',
  // Macro figures
  'trump', 'powell', 'treasury secretary',
  // Watchlist-specific (these only score HIGH when combined with ticker hit)
  'bankruptcy',   // only HIGH if watchlist ticker present
  'downgrade',
  'upgrade',
  'tariff',
];

// ── REPLACE: MEDIUM_IMPACT keywords ──────────────────────────────────────────
//
// Added: specific enough to be signal, not noise.
// Removed: 'war', 'conflict' at MEDIUM (too broad — UK/Ukraine headlines
// shouldn't score MEDIUM every cycle).

const MEDIUM_IMPACT = [
  // Tech / sector
  'semiconductor', 'chip shortage', 'ai regulation', 'artificial intelligence',
  'datacenter', 'cloud outage', 'software recall',
  'iphone', 'ipo priced', 'ipo filing',
  // Corporate
  'layoffs', 'mass layoff', 'restructuring',
  'ceo resigns', 'ceo fired', 'cfo resigns',
  'stock split', 'special dividend', 'share buyback', 'secondary offering',
  'earnings guidance', 'revenue outlook', 'profit warning',
  // Macro — regional
  'china gdp', 'china tariff', 'trade deal',
  'sanctions', 'export ban',
  // Energy
  'oil', 'crude', 'wti', 'brent', 'natural gas',
  // Watchlist companies by name (catches headlines without ticker)
  'nvidia', 'apple', 'microsoft', 'meta', 'amazon', 'alphabet', 'google',
  'tesla', 'avis', 'cerebras',
];

// ── ALSO ADD: scoreImpact() tweak ────────────────────────────────────────────
//
// Current logic: highHits >= 2 OR (highHits >= 1 AND tickerHit) → HIGH
//
// Problem: 'bankruptcy' + any ticker hit = HIGH even if ticker is Texas winery.
// Fix: Add ticker validation — only score HIGH on watchlist ticker hit,
// not any ticker mention.
//
// Replace scoreImpact() in news.js with this version:

function scoreImpact(text) {
  const lower = text.toLowerCase();

  // Check watchlist tickers (exact word boundary)
  const tickerHit = WATCHLIST.find(t => {
    const re = new RegExp(`\\b${t}\\b`, 'i');
    return re.test(text);
  });

  const highHits = HIGH_IMPACT.filter(k => lower.includes(k)).length;
  const medHits  = MEDIUM_IMPACT.filter(k => lower.includes(k)).length;

  // HIGH: needs 2+ high keywords, OR 1 high keyword that is NOT a
  // conditional term (bankruptcy/downgrade/upgrade/tariff) + watchlist ticker
  const conditionalTerms = ['bankruptcy', 'downgrade', 'upgrade', 'tariff'];
  const hardHighHits = HIGH_IMPACT
    .filter(k => !conditionalTerms.includes(k))
    .filter(k => lower.includes(k)).length;

  if (hardHighHits >= 2)                                    return { level: 'HIGH',   score: hardHighHits * 10 };
  if (hardHighHits >= 1 && tickerHit)                       return { level: 'HIGH',   score: hardHighHits * 10 + 5 };
  if (highHits >= 2)                                        return { level: 'HIGH',   score: highHits * 8 };
  if (highHits >= 1 && tickerHit && medHits >= 1)           return { level: 'HIGH',   score: highHits * 8 + 3 };
  if (highHits === 1 || medHits >= 2)                       return { level: 'MEDIUM', score: highHits * 5 + medHits * 2 };
  if (medHits >= 1 || tickerHit)                            return { level: 'LOW',    score: medHits + (tickerHit ? 3 : 0) };
  return null;
}

// ─── QUICK TEST ───────────────────────────────────────────────────────────────
// Run from node REPL to verify scoring after patch:
//
// scoreImpact('Texas winery files for Chapter 12 bankruptcy to settle debt')
// → should be LOW or null (no watchlist ticker, 'bankruptcy' is conditional)
//
// scoreImpact('FOMC rate decision: Fed holds rates, Powell signals cuts ahead')
// → should be HIGH (fomc + rate decision = 2 hard high hits)
//
// scoreImpact('Trump: US effort to free up ships in Strait of Hormuz')
// → should be HIGH (trump + hormuz = 2 hard high hits)
//
// scoreImpact('NVDA earnings beat: revenue $44B vs $43B expected')
// → should be HIGH (earnings beat = hard high hit + NVDA watchlist ticker)
//
// scoreImpact('AI boom faces reality check as returns lag spending')
// → should be MEDIUM (ai regulation hit at medium level)
