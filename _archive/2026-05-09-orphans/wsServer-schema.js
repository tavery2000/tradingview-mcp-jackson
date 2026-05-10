// ─── wsServer.js — SIGNAL broadcast schema ───────────────────────────────────
//
// moc.js subscribes to ws://localhost:8765 and expects this message type:
//
// {
//   type: 'SIGNAL',
//   data: {
//     action:     'TAKE CALLS 🟢' | 'TAKE PUTS 🔴' | 'CHOP — STAY OUT 🟡' | ...,
//     confidence: 'HIGH' | 'MEDIUM' | 'WEAK' | 'NONE',
//     reason:     string,
//     spyPrice:   number,    // ← ADD THIS if not already present
//     spyBias:    string,    // 'bullish' | 'bearish' | 'neutral' | 'div_bear' | 'div_bull'
//     bulls:      number,    // 0–6
//     bears:      number,    // 0–6
//     timestamp:  number,    // Date.now()
//   }
// }
//
// ─── Patch for monitor.js → wsServer broadcast ───────────────────────────────
//
// In monitor.js poll(), after buildSignal(), broadcast to wsServer:
//
//   // At bottom of poll(), after printSummary():
//   if (global.wsBroadcast) {
//     global.wsBroadcast({
//       type:       'SIGNAL',
//       data: {
//         action:     signal.action,
//         confidence: signal.confidence,
//         reason:     signal.reason,
//         spyPrice:   spy.price,
//         spyBias:    spy.bias,
//         bulls:      leanBulls ?? bulls,
//         bears:      leanBears ?? bears,
//         timestamp:  Date.now(),
//       }
//     });
//   }
//
// ─── wsServer.js wsBroadcast setup ───────────────────────────────────────────
//
// In wsServer.js, expose a global broadcast function:
//
//   import { WebSocketServer } from 'ws';
//   const wss = new WebSocketServer({ port: 8765 });
//   const clients = new Set();
//
//   wss.on('connection', ws => {
//     clients.add(ws);
//     ws.on('close', () => clients.delete(ws));
//   });
//
//   // Expose globally so monitor.js can call it after import
//   global.wsBroadcast = (msg) => {
//     const payload = JSON.stringify(msg);
//     for (const client of clients) {
//       if (client.readyState === 1) client.send(payload);  // OPEN
//     }
//   };
//
//   console.log('wsServer listening on ws://localhost:8765');
//
// ─── Integration order ───────────────────────────────────────────────────────
//
//   Window 1: node monitor.js     (producer — broadcasts SIGNAL)
//   Window 2: node news.js        (produces moc-data.json on MOC detection)
//   Window 3: node moc.js         (consumer — reads both, fires orders at 15:50)
//   Window 4: node wsServer.js    (relay — if running standalone)
//
// If wsServer.js is embedded in monitor.js, global.wsBroadcast is already set.
// moc.js handles wsServer being offline gracefully (monitorSignal = null → no boost).
