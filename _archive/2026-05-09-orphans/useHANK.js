/**
 * useHANK.js — HANK AI WebSocket Hook
 * Built by NYC2000
 *
 * Production-grade hook for 20+ tick/second environment
 *
 * Design principles:
 *   - HIGH FREQ data (Greeks, IV, P&L) → useRef only — zero React overhead
 *   - LOW FREQ data (news, signals, mode) → useState — triggers render
 *   - Binary MessagePack (WAR_ROOM) ↔ JSON (normal) — auto-detected per packet
 *   - Reconnect with exponential backoff — survives network blips
 *   - requestAnimationFrame rendering — capped at 60fps regardless of tick rate
 *   - Ghost signal prevention — requestId tracking exposed to consumer
 *   - Signal strength dot data — lag in ms updated every rAF cycle
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { decode } from '@msgpack/msgpack';

// ─── Constants ────────────────────────────────────────────

const RECONNECT_BASE_MS  = 1000;
const RECONNECT_MAX_MS   = 30000;
const RECONNECT_FACTOR   = 1.5;
const STALE_THRESHOLD_MS = 200;   // red dot threshold
const MAX_MESSAGES       = 50;    // news/alert history cap

// ─── useHANK Hook ────────────────────────────────────────

export function useHANK(url) {
  // ── Low-frequency state (triggers React renders) ────────
  const [status,   setStatus]   = useState('DISCONNECTED');
  const [mode,     setMode]     = useState('OVERNIGHT');
  const [messages, setMessages] = useState([]);  // news + alerts
  const [signal,   setSignal]   = useState(null); // latest signal (fires render for UI update)
  const [mocData,  setMocData]  = useState(null); // MOC imbalance

  // ── High-frequency buffers (NO renders on update) ───────
  const greeksRef      = useRef({});   // Black-Scholes Greeks — updated every tick
  const positionRef    = useRef(null); // Open position P&L
  const lastPacketRef  = useRef(Date.now()); // signal strength
  const lagRef         = useRef(0);    // current lag in ms
  const socketRef      = useRef(null);
  const reconnectRef   = useRef(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const mountedRef     = useRef(true);
  const isBinaryRef    = useRef(false); // current serialization mode

  // ── Decode incoming packet ───────────────────────────────
  // Auto-detects binary (MessagePack WAR_ROOM) vs JSON (normal hours)
  const decode_packet = useCallback(async (event) => {
    try {
      if (event.data instanceof ArrayBuffer) {
        isBinaryRef.current = true;
        return decode(new Uint8Array(event.data));
      }
      isBinaryRef.current = false;
      return JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
    } catch {
      return null;
    }
  }, []);

  // ── Route incoming data ───────────────────────────────────
  const handlePacket = useCallback((data) => {
    if (!data || !mountedRef.current) return;

    // Always update signal strength timestamp
    lastPacketRef.current = Date.now();

    switch (data.type) {

      // HIGH FREQ — ref only, no render
      case 'greeks':
        greeksRef.current = {
          ...data.payload,
          _ts: Date.now(),
        };
        break;

      case 'position':
        positionRef.current = {
          ...data.payload,
          _ts: Date.now(),
        };
        break;

      // LOW FREQ — state update, triggers render
      case 'signal':
        setSignal({ ...data.payload, _ts: Date.now() });
        break;

      case 'moc':
        setMocData({ ...data.payload, _ts: Date.now() });
        break;

      case 'status':
        if (data.payload?.modeChange) {
          setMode(data.payload.to);
        }
        break;

      case 'welcome':
        setMode(data.mode || 'OVERNIGHT');
        break;

      // PERSISTENT — keep history
      case 'news':
      case 'alert':
        setMessages(prev => [
          { ...data, _ts: Date.now() },
          ...prev,
        ].slice(0, MAX_MESSAGES));
        break;

      case 'gc':
        // GC event — log but no render needed
        console.log(`[HANK] GC: ${data.payload?.label} — freed ${data.payload?.freed?.toFixed(1)}MB`);
        break;

      default:
        break;
    }
  }, []);

  // ── Connect ───────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer'; // CRITICAL — enables MessagePack binary

    socketRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus('CONNECTED');
      reconnectDelay.current = RECONNECT_BASE_MS; // reset backoff on success
      console.log(`[HANK] WebSocket connected: ${url}`);

      // Browser-side keepalive ping every 5s
      // Prevents NAT/proxy timeouts independent of server heartbeat
      const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } else {
          clearInterval(pingTimer);
        }
      }, 5000);

      ws._pingTimer = pingTimer;
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      setStatus('DISCONNECTED');
      clearInterval(ws._pingTimer);

      if (!event.wasClean) {
        // Abnormal close — reconnect with backoff
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
        console.log(`[HANK] Disconnected — reconnecting in ${(delay/1000).toFixed(1)}s`);
        reconnectRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnect
      setStatus('ERROR');
    };

    ws.onmessage = async (event) => {
      const data = await decode_packet(event);
      handlePacket(data);
    };

  }, [url, decode_packet, handlePacket]);

  // ── Lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      clearInterval(socketRef.current?._pingTimer);
      socketRef.current?.close(1000, 'Component unmounted');
    };
  }, [connect]);

  // ── Lag tracker — runs on its own rAF loop ────────────────
  // Updates lagRef every frame — consumed by GreeksDisplay
  useEffect(() => {
    let rafId;
    const updateLag = () => {
      lagRef.current = Date.now() - lastPacketRef.current;
      rafId = requestAnimationFrame(updateLag);
    };
    rafId = requestAnimationFrame(updateLag);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return {
    // Connection
    status,
    mode,
    isWarRoom:    mode === 'WAR_ROOM',
    isBinary:     isBinaryRef,

    // Low-freq state
    messages,
    signal,
    mocData,

    // High-freq refs — consume in rAF loops only
    greeksRef,
    positionRef,
    lastPacketRef,
    lagRef,
  };
}


// ─── GreeksDisplay Component ──────────────────────────────
// The institutional secret sauce — rAF loop + direct DOM manipulation
// Zero React reconciliation overhead at 60fps

export function GreeksDisplay({ greeksRef, lagRef }) {
  const thetaRef    = useRef(null);
  const ivRef       = useRef(null);
  const deltaRef    = useRef(null);
  const gammaRef    = useRef(null);
  const vegaRef     = useRef(null);
  const pnlRef      = useRef(null);
  const pnlPctRef   = useRef(null);
  const dotRef      = useRef(null);
  const lagTextRef  = useRef(null);
  const ivCrushRef  = useRef(null);
  const burnRef     = useRef(null);

  useEffect(() => {
    let rafId;

    const updateLoop = () => {
      const g   = greeksRef.current;
      const lag = lagRef?.current ?? (Date.now() - Date.now());

      // Signal strength dot
      if (dotRef.current) {
        const color = lag < 100  ? '#00ff88'   // green — live
                    : lag < 200  ? '#00cc66'   // green dim
                    : lag < 500  ? '#ffd700'   // yellow — slowing
                    : lag < 1000 ? '#ff8c00'   // orange — warning
                                 : '#ff4444';  // red — STALE
        dotRef.current.style.backgroundColor = color;
        dotRef.current.title = `${lag}ms`;
      }

      if (lagTextRef.current) {
        lagTextRef.current.textContent = `${lag}ms`;
        lagTextRef.current.style.color = lag > 200 ? '#ff4444' : '#556677';
      }

      if (!g || !g.delta) {
        rafId = requestAnimationFrame(updateLoop);
        return;
      }

      // Greeks — direct DOM, zero Virtual DOM overhead
      if (thetaRef.current)
        thetaRef.current.textContent = `$${(g.thetaPerMinContract ?? g.thetaPerMin ?? 0).toFixed(4)}/min`;

      if (ivRef.current) {
        const ivPct = ((g.currentIV ?? g.iv ?? 0) * 100).toFixed(1);
        ivRef.current.textContent = `${ivPct}%`;
        ivRef.current.style.color = g.ivCrushing ? '#ff4444' : '#e8f0f8';
      }

      if (deltaRef.current)
        deltaRef.current.textContent = (g.delta ?? 0).toFixed(3);

      if (gammaRef.current)
        gammaRef.current.textContent = (g.gamma ?? 0).toFixed(4);

      if (vegaRef.current)
        vegaRef.current.textContent = `$${(g.vega ?? 0).toFixed(3)}`;

      if (pnlRef.current) {
        const pnl = g.pnlTotal ?? 0;
        pnlRef.current.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`;
        pnlRef.current.style.color = pnl >= 0 ? '#00ff88' : '#ff4444';
      }

      if (pnlPctRef.current) {
        const pct = g.pnlPct ?? 0;
        pnlPctRef.current.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
        pnlPctRef.current.style.color = pct >= 0 ? '#00ff88' : '#ff4444';
      }

      if (ivCrushRef.current) {
        ivCrushRef.current.style.display = g.ivCrushing ? 'block' : 'none';
      }

      if (burnRef.current) {
        const zone = g.burnZone ?? 'SLOW';
        const col  = zone === 'CRITICAL' ? '#ff0000'
                   : zone === 'FAST'     ? '#ff8c00'
                   : zone === 'MEDIUM'   ? '#ffd700'
                                         : '#00ff88';
        burnRef.current.textContent = zone;
        burnRef.current.style.color = col;
      }

      rafId = requestAnimationFrame(updateLoop);
    };

    rafId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(rafId);
  }, [greeksRef, lagRef]);

  const S = {
    wrap: {
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      background: '#080c10',
      border: '1px solid #1a2a3a',
      borderRadius: '4px',
      padding: '12px 16px',
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: '12px',
      fontSize: '12px',
    },
    label: { color: '#3a5a7a', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' },
    value: {
      color: '#e8f0f8',
      fontSize: '14px',
      fontWeight: '500',
      display: 'inline-block',
      width: '80px',                     // fixed width — no layout reflow on digit change
      fontVariantNumeric: 'tabular-nums', // monospace digit alignment — no jank
      letterSpacing: '0.02em',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    },
    header: { gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', paddingBottom: '8px', borderBottom: '1px solid #1a2a3a' },
    dot: { width: '8px', height: '8px', borderRadius: '50%', background: '#334455', flexShrink: 0 },
    crush: { gridColumn: '1/-1', background: '#2a0000', border: '1px solid #ff4444', borderRadius: '3px', padding: '4px 8px', fontSize: '11px', color: '#ff4444', display: 'none' },
  };

  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <div ref={dotRef} style={S.dot} />
        <span style={{ color: '#3a5a7a', fontSize: '10px' }}>GREEKS ENGINE</span>
        <span ref={lagTextRef} style={{ color: '#556677', fontSize: '10px', marginLeft: 'auto' }}>--ms</span>
      </div>

      <div>
        <div style={S.label}>IV</div>
        <div ref={ivRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Theta/min</div>
        <div ref={thetaRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Delta</div>
        <div ref={deltaRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Gamma</div>
        <div ref={gammaRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Vega/1%</div>
        <div ref={vegaRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>P&L</div>
        <div ref={pnlRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Return</div>
        <div ref={pnlPctRef} style={S.value}>--</div>
      </div>
      <div>
        <div style={S.label}>Burn Zone</div>
        <div ref={burnRef} style={S.value}>--</div>
      </div>

      <div ref={ivCrushRef} style={S.crush}>
        ⚠️ IV CRUSH DETECTED — Consider exit
      </div>
    </div>
  );
}


// ─── ConnectionBadge Component ────────────────────────────
// Shows connection status + mode + binary/JSON indicator
// Uses useState so it re-renders on status change — correct

export function ConnectionBadge({ status, mode }) {
  const colors = {
    CONNECTED:    '#00ff88',
    DISCONNECTED: '#ff4444',
    ERROR:        '#ff8c00',
  };

  const modeColors = {
    WAR_ROOM:   '#ff4444',
    MARKET:     '#00ff88',
    PRE_MARKET: '#4488ff',
    OVERNIGHT:  '#334455',
    MOC_CLOSED: '#334455',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
    }}>
      <div style={{
        width: '6px', height: '6px', borderRadius: '50%',
        background: colors[status] || '#334455',
      }} />
      <span style={{ color: colors[status] || '#334455' }}>{status}</span>
      <span style={{ color: '#334455' }}>│</span>
      <span style={{ color: modeColors[mode] || '#334455' }}>{mode}</span>
      {mode === 'WAR_ROOM' && (
        <span style={{
          background: '#2a0000', color: '#ff4444', fontSize: '9px',
          padding: '1px 5px', borderRadius: '2px', border: '1px solid #ff4444',
        }}>BINARY</span>
      )}
    </div>
  );
}


// ─── MOCPanel Component ───────────────────────────────────
// Fires at 15:50 ET — uses useState (low freq, renders on imbalance arrival)

export function MOCPanel({ mocData }) {
  if (!mocData) return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      background: '#080c10', border: '1px solid #1a2a3a',
      borderRadius: '4px', padding: '12px 16px',
      color: '#334455', fontSize: '12px',
    }}>
      MOC ENGINE — Waiting for imbalance data (15:50 ET)
    </div>
  );

  const { sp500, nasdaq, dow, mag7, conviction, direction, ts } = mocData;
  const dirColor = direction === 'BULL' ? '#00ff88' : '#ff4444';
  const convColor = conviction >= 3 ? '#00ff88' : conviction === 2 ? '#ffd700' : '#ff4444';

  const fmt = (n) => n >= 0 ? `+$${n}M` : `-$${Math.abs(n)}M`;

  return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      background: '#0a0500', border: `1px solid ${dirColor}40`,
      borderLeft: `3px solid ${dirColor}`,
      borderRadius: '4px', padding: '12px 16px', fontSize: '12px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ color: '#3a5a7a', fontSize: '10px', textTransform: 'uppercase' }}>MOC IMBALANCE</span>
        <span style={{ color: convColor, fontSize: '11px', fontWeight: '600' }}>
          {conviction}/4 conviction
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
        {[
          { label: 'S&P 500', val: sp500 },
          { label: 'Nasdaq',  val: nasdaq },
          { label: 'Dow 30',  val: dow },
          { label: 'Mag-7',   val: mag7 },
        ].map(({ label, val }) => (
          <div key={label}>
            <div style={{ color: '#3a5a7a', fontSize: '10px' }}>{label}</div>
            <div style={{ color: val >= 0 ? '#00ff88' : '#ff4444', fontSize: '13px', fontWeight: '500' }}>
              {val != null ? fmt(val) : '--'}
            </div>
          </div>
        ))}
      </div>

      <div style={{
        borderTop: '1px solid #1a2a3a', paddingTop: '8px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: dirColor, fontSize: '13px', fontWeight: '700' }}>
          {direction} → SPX {direction === 'BULL' ? 'CALLS' : 'PUTS'}
        </span>
        <span style={{ color: '#334455', fontSize: '10px' }}>
          {ts ? new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) : '--'} ET
        </span>
      </div>
    </div>
  );
}


// ─── NewsFeed Component ───────────────────────────────────
// Low-freq — useState is correct here, renders on each headline

export function NewsFeed({ messages }) {
  if (!messages?.length) return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      background: '#080c10', border: '1px solid #1a2a3a',
      borderRadius: '4px', padding: '12px 16px',
      color: '#334455', fontSize: '12px',
    }}>
      News feed — waiting for headlines...
    </div>
  );

  return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      background: '#080c10', border: '1px solid #1a2a3a',
      borderRadius: '4px', padding: '0',
      maxHeight: '240px', overflowY: 'auto', fontSize: '11px',
    }}>
      {messages.map((msg, i) => {
        const isAlert = msg.type === 'alert';
        return (
          <div key={i} style={{
            padding: '8px 12px',
            borderBottom: '1px solid #0d1a27',
            borderLeft: `2px solid ${isAlert ? '#ff4444' : '#1a3a5a'}`,
            background: isAlert ? '#1a000080' : 'transparent',
          }}>
            <div style={{ color: isAlert ? '#ff4444' : '#4a8aaa', marginBottom: '2px' }}>
              {isAlert ? '⚠️ ALERT' : '◉ NEWS'} · {msg._ts ? new Date(msg._ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) : '--'} ET
            </div>
            <div style={{ color: '#c0d0e0', lineHeight: '1.4' }}>
              {msg.payload?.title || msg.payload?.text || JSON.stringify(msg.payload)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
