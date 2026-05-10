// ═══════════════════════════════════════════════════════════════════════════════
// monitor-ws-patch.js
// Patches monitor.js to broadcast SPY data + SIGNAL via wsServer on every poll.
// Three surgical changes. Apply in order.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── PATCH 1 of 3: Imports ────────────────────────────────────────────────────
//
// FIND (line 21–24 in monitor.js):
//
//   import CDP           from 'chrome-remote-interface';
//   import { readFileSync } from 'fs';
//   import { fileURLToPath } from 'url';
//   import { dirname, join }  from 'path';
//
// REPLACE WITH:

import CDP              from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { WebSocketServer } from 'ws';          // ← ADD

// ─── PATCH 2 of 3: wsServer init block ───────────────────────────────────────
//
// FIND (line 26 in monitor.js — right after the imports, before the comment):
//
//   // ─── Config ───────────────────────────────────────────────────────────────────
//
// INSERT THIS ENTIRE BLOCK BEFORE THAT LINE:

// ─── wsServer — broadcast layer ───────────────────────────────────────────────
//
// Broadcasts SPY tick + SIGNAL to all connected clients (moc.js, React dashboard)
// on every poll cycle (~30s). Clients connect to ws://localhost:8765.
//
// Message types emitted:
//   TICK   — every poll, always (even if signal is NEUTRAL)
//   SIGNAL — every poll, carries full signal + SPY fundamentals

const WS_BROADCAST_PORT = 8765;
const wsClients         = new Set();
let   wss               = null;

function initWsServer() {
  try {
    wss = new WebSocketServer({ port: WS_BROADCAST_PORT });

    wss.on('connection', ws => {
      wsClients.add(ws);
      ws.on('close',   () => wsClients.delete(ws));
      ws.on('error',   () => wsClients.delete(ws));
    });

    wss.on('error', err => {
      // Port already in use — wsServer.js may be running standalone. That's fine.
      if (err.code === 'EADDRINUSE') {
        console.log(`  ${C.yellow}[ws] Port ${WS_BROADCAST_PORT} in use — broadcast disabled (wsServer.js running?)${C.reset}`);
        wss = null;
      }
    });

    console.log(`  ${C.cyan}[ws] Broadcast server listening on ws://localhost:${WS_BROADCAST_PORT}${C.reset}`);
  } catch (e) {
    console.log(`  ${C.gray}[ws] Could not start broadcast server: ${e.message}${C.reset}`);
    wss = null;
  }
}

function wsBroadcast(msg) {
  if (!wss || wsClients.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) client.send(payload); // WebSocket.OPEN === 1
    } catch { /* client disconnected mid-send */ }
  }
}

// ─── PATCH 3 of 3: Broadcast call at end of poll() ───────────────────────────
//
// FIND (line 711 in monitor.js — the closing brace of the alert logic block):
//
//     } else if (spy.bias === 'bullish' || spy.bias === 'div_bull') {
//       fireDivergence(`${bears}/6 stocks bearish but SPY tab diverging (SPY: ${spy.bias})`);
//     }
//   }
// }
//
// REPLACE WITH (adds broadcast at end of poll(), before closing brace):

    } else if (spy.bias === 'bullish' || spy.bias === 'div_bull') {
      fireDivergence(`${bears}/6 stocks bearish but SPY tab diverging (SPY: ${spy.bias})`);
    }
  }

  // ── wsServer broadcast — TICK + SIGNAL ──────────────────────────────────────
  // Sent every poll cycle. moc.js and React dashboard subscribe to this.
  // TICK carries the raw SPY fundamentals moc.js needs for snapshot + gate checks.
  // SIGNAL carries the full trading signal for the React dashboard.

  const signal = buildSignal(leanBulls ?? bulls, leanBears ?? bears, spy, spySummary, isChop);

  // TICK — always broadcast, even pre-market (moc.js needs it for snapshot)
  wsBroadcast({
    type: 'TICK',
    data: {
      spyPrice:  spy.price,
      spyDelta:  spy.delta,
      spyVwap:   spy.vwap,
      spyBias:   spy.bias,
      spyLevels: spy.levels
        ? {
            support:    spy.levels.support?.map(l => ({ price: l.price, label: l.label }))    ?? [],
            resistance: spy.levels.resistance?.map(l => ({ price: l.price, label: l.label })) ?? [],
          }
        : null,
      timestamp: Date.now(),
    },
  });

  // SIGNAL — full trading context for dashboard + moc conviction boost
  wsBroadcast({
    type: 'SIGNAL',
    data: {
      action:     signal.action,
      confidence: signal.confidence,
      reason:     signal.reason,
      spyPrice:   spy.price,
      spyDelta:   spy.delta,
      spyVwap:    spy.vwap,
      spyBias:    spy.bias,
      spyLevels:  spy.levels
        ? {
            support:    spy.levels.support?.map(l => ({ price: l.price, label: l.label }))    ?? [],
            resistance: spy.levels.resistance?.map(l => ({ price: l.price, label: l.label })) ?? [],
          }
        : null,
      bulls:      leanBulls ?? bulls,
      bears:      leanBears ?? bears,
      pureBulls,
      pureBears,
      isChop,
      rows: rows.map(r => ({
        symbol: r.symbol,
        price:  r.price,
        vwap:   r.vwap,
        delta:  r.delta,
        bias:   r.bias,
      })),
      timestamp: Date.now(),
    },
  });
}

// ─── PATCH 3b: initWsServer() call inside main() ─────────────────────────────
//
// FIND (line 816–817 in monitor.js):
//
//   await initClients();
//   console.log('');
//
// REPLACE WITH:

  await initClients();
  initWsServer();           // ← ADD — start broadcast server after CDP connects
  console.log('');

// ─── PATCH 3c: Update main() startup log ─────────────────────────────────────
//
// FIND:
//   console.log(`  S/R:        swing highs/lows over ${OHLCV_COUNT} bars + VWAP bands\n`);
//
// REPLACE WITH:
//   console.log(`  S/R:        swing highs/lows over ${OHLCV_COUNT} bars + VWAP bands`);
//   console.log(`  Broadcast:  ws://localhost:${WS_BROADCAST_PORT}  (moc.js + dashboard)\n`);

// ─── DEPENDENCY NOTE ─────────────────────────────────────────────────────────
//
// 'ws' must be in package.json. If not already installed:
//   npm install ws
//
// Verify it's there:
//   cat package.json | grep '"ws"'

// ─── WHAT THIS BROADCAST GIVES moc.js ────────────────────────────────────────
//
// Every 30s, moc.js receives:
//
//   live.spyPrice  → used for snapshot lock at 15:50 and chase gate calculation
//   live.spyDelta  → used for "delta confirms" conviction factor
//   live.spyVwap   → used for trend direction cross-check
//   live.spyBias   → used for "trend at 15:50 agrees" conviction factor
//   live.spyLevels → used for "near S/R" early exit trigger in active rescore loop
//
// Without this patch, moc.js runs in degraded mode:
//   - No snapshot → chase gate skipped
//   - No delta → delta confirmation factor = 0
//   - No levels → S/R early exit disabled
//   All three of those are critical gate checks. This patch makes them live.

// ─── VERIFICATION ────────────────────────────────────────────────────────────
//
// After applying patch, run this in a separate terminal to verify broadcast:
//
//   node -e "
//     import('ws').then(({default: WebSocket}) => {
//       const ws = new WebSocket('ws://localhost:8765');
//       ws.on('message', d => { console.log(JSON.parse(d)); ws.close(); });
//       ws.on('error', e => console.error('Error:', e.message));
//     });
//   "
//
// Should print a TICK or SIGNAL object within 30s of monitor.js polling.
