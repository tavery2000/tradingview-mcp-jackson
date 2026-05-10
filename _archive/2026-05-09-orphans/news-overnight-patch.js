/**
 * news-overnight-patch.js
 * 
 * INSTRUCTIONS — patch your existing working news.js:
 * 
 * 1. At the TOP of news.js, after the existing imports, add:
 * 
 *    import { writeFileSync, readFileSync, existsSync } from 'fs';
 *    import { fileURLToPath } from 'url';
 *    import { dirname, join } from 'path';
 *    const __dirname = dirname(fileURLToPath(import.meta.url));
 *    const OVERNIGHT_FILE = join(__dirname, 'overnight-news.json');
 *
 *    function saveOvernightNews(title, tickers, tier) {
 *      try {
 *        const existing = existsSync(OVERNIGHT_FILE) ? JSON.parse(readFileSync(OVERNIGHT_FILE,'utf8')) : [];
 *        const cutoff   = Date.now() - 24*60*60*1000;
 *        const fresh    = existing.filter(e => e.ts > cutoff);
 *        fresh.push({
 *          ts:      Date.now(),
 *          time:    new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}),
 *          title:   title.slice(0,200),
 *          tickers: tickers ?? [],
 *          tier,
 *        });
 *        writeFileSync(OVERNIGHT_FILE, JSON.stringify(fresh.slice(-50), null, 2));
 *      } catch {}
 *    }
 *
 * 2. In the printNewsItem function, just BEFORE the final "return true" line
 *    (after the TTS/beep section), add ONE line:
 *
 *    saveOvernightNews(title, tickers, tier);
 *
 * That's it. Nothing else changes. The rest of news.js v3 stays exactly as-is.
 */
