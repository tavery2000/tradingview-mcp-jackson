// ─── NEWS.JS PATCH — MOC DATA WRITER ─────────────────────────────────────────
//
// Apply this patch to news.js to wire parseMOC() → moc-data.json
//
// STEP 1: Add fs import at top of news.js (after existing imports):
//
//   import { writeFileSync } from 'fs';
//   import { fileURLToPath } from 'url';
//   import { dirname, join }  from 'path';
//   const __dirname = dirname(fileURLToPath(import.meta.url));
//
// ─────────────────────────────────────────────────────────────────────────────
//
// STEP 2: Replace parseMOC() in news.js with this version:

function parseMOC(text) {
  if (!/MOC Imbalance|MOO Imbalance/i.test(text)) return null;

  const type  = /MOO/i.test(text) ? 'MOO' : 'MOC';
  const clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const lines = clean.split('\n').filter(Boolean);

  // ── Structured extraction ──────────────────────────────────────────────────
  //
  // Financial Juice MOC format (typical):
  //   "NYSE MOC Imbalance: Buy 4.2M | Sell 1.1M | Net Buy 3.1M"
  //   followed by lines like: "AAPL  +820,000  BUY" or "MSFT  -340,000  SELL"
  //
  // We try to extract:
  //   - totalBuyShares, totalSellShares, netShares
  //   - direction: BUY if net > 0, SELL if net < 0
  //   - topNames: [{symbol, side, shares}]

  let totalBuyShares  = 0;
  let totalSellShares = 0;
  let netShares       = 0;
  const topNames      = [];

  for (const line of lines) {
    // Summary line: "Buy 4.2M" / "Sell 1.1M" / "Net Buy 3.1M"
    const buyMatch = line.match(/Buy\s+([\d,.]+)\s*([KkMm]?)/i);
    const selMatch = line.match(/Sell\s+([\d,.]+)\s*([KkMm]?)/i);
    const netMatch = line.match(/Net\s+(?:Buy|Sell)\s+([\d,.]+)\s*([KkMm]?)/i);

    if (buyMatch && !line.match(/Net/i)) totalBuyShares  = parseShares(buyMatch[1], buyMatch[2]);
    if (selMatch && !line.match(/Net/i)) totalSellShares = parseShares(selMatch[1], selMatch[2]);
    if (netMatch) {
      netShares = parseShares(netMatch[1], netMatch[2]);
      if (/Net\s+Sell/i.test(line)) netShares = -netShares;
    }

    // Individual stock lines: "AAPL  +820,000  BUY"
    const stockMatch = line.match(/\b([A-Z]{2,5})\b.*?([\+\-][\d,]+)\s*(BUY|SELL)/i);
    if (stockMatch) {
      const shares = parseInt(stockMatch[2].replace(/,/g, ''), 10);
      topNames.push({
        symbol: stockMatch[1],
        side:   stockMatch[3].toUpperCase(),
        shares: Math.abs(shares),
      });
    }
  }

  // Fallback: if we didn't parse summary line, infer net from individual stocks
  if (totalBuyShares === 0 && topNames.length > 0) {
    totalBuyShares  = topNames.filter(n => n.side === 'BUY').reduce((a, n) => a + n.shares, 0);
    totalSellShares = topNames.filter(n => n.side === 'SELL').reduce((a, n) => a + n.shares, 0);
    netShares       = totalBuyShares - totalSellShares;
  }

  const direction = netShares >= 0 ? 'BUY' : 'SELL';

  // Sort top names by shares descending
  topNames.sort((a, b) => b.shares - a.shares);

  const mocData = {
    type,
    date:             etDate(),
    timestamp:        Date.now(),
    direction,
    totalBuyShares,
    totalSellShares,
    netShares:        Math.abs(netShares) * (netShares >= 0 ? 1 : -1),
    topNames:         topNames.slice(0, 8),
    raw:              clean.slice(0, 500),
  };

  // Write to moc-data.json for moc.js to consume
  try {
    writeFileSync(join(__dirname, 'moc-data.json'), JSON.stringify(mocData, null, 2));
  } catch (e) {
    console.error(`  [MOC] Failed to write moc-data.json: ${e.message}`);
  }

  return { type, lines, mocData };
}

// Helper: parse share count with K/M suffix
function parseShares(numStr, suffix) {
  const n = parseFloat(numStr.replace(/,/g, ''));
  if (/[Mm]/.test(suffix)) return Math.round(n * 1_000_000);
  if (/[Kk]/.test(suffix)) return Math.round(n * 1_000);
  return Math.round(n);
}

// ─────────────────────────────────────────────────────────────────────────────
//
// STEP 3: In printNewsItem(), the MOC branch already uses parseMOC().
//         No changes needed there — parseMOC() now writes the file as a side effect.
//         The existing display logic still works (moc.lines, moc.type).
//
// STEP 4: Add speak() enhancement in the MOC branch of printNewsItem():
//   Replace:   speak(`${moc.type} imbalance alert`);
//   With:      speak(`${moc.type} imbalance. ${moc.mocData?.direction} ${((moc.mocData?.netShares||0)/1e6).toFixed(1)} million shares.`);
//
// ─────────────────────────────────────────────────────────────────────────────
//
// TESTING:
//   To manually test without waiting for Financial Juice, create moc-data.json:
//
//   node -e "
//     const fs = require('fs');
//     fs.writeFileSync('moc-data.json', JSON.stringify({
//       type: 'MOC', date: new Date().toISOString().slice(0,10),
//       timestamp: Date.now(), direction: 'BUY',
//       totalBuyShares: 4200000, totalSellShares: 1100000, netShares: 3100000,
//       topNames: [{symbol:'AAPL',side:'BUY',shares:820000},{symbol:'MSFT',side:'BUY',shares:640000}],
//       raw: 'test'
//     }, null, 2));
//     console.log('moc-data.json written');
//   "
//
//   Then run: node moc.js
//   (Set ARM_MINUTE / TRIGGER_MINUTE to now+1 min for faster test)
