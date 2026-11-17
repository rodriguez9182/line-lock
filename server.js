'use strict';
/*
  Line Lock watcher v1.1
  Runs the same checks as the Line Lock page, 24/7, and sends a push through ntfy
  when a play locks. Read only: it never trades and never logs in anywhere.
  Also shows read-only market context on the page (OKX funding + open interest,
  a macro-event calendar, MACD + reversion readouts, and the Polymarket US
  15m BTC price next to Kalshi's), plus display-only readouts (odds trail,
  taker flow, call grade, distance to line, market gauge, FVG and
  supply/demand zones, liquidity map, order blocks, session timing and a
  risk line), multi-timeframe confirmation with lock-in alerts, and a BTC
  chart with zones drawn on it and zoom buttons.
  Display only; never used for calls.

  Environment variables
    NTFY_TOPIC      required. Your private ntfy topic name (long and random).
    NTFY_SERVER     optional. Default https://ntfy.sh
    WHALE_USD       optional. Whale fill size in dollars. Default 150000
    RESULT_ALERTS   optional. Set to 0 to skip the "won/lost" push after each locked round
    WHALE_ALERTS    optional. Set to 1 to also push on any whale surge, even without a lock
    KALSHI_SERIES   optional. Default KXBTC15M
    PORT            set by the host
  New in 1.1
    DATA_DIR        optional. Folder for rounds.json (the server-side scoreboard). Default ./data
                    On Render, point this at a persistent disk mount, e.g. /var/data
    EDIT_KEY        optional. Password for the Edit buttons. Defaults to NTFY_TOPIC.
    MIN_EDGE        optional. Minimum edge after fee to TAKE, in dollars per $1 contract. Default 0.02
    SHRINK          optional. 0..1, how much to trust the model vs the Kalshi price. Default 0.5
    VOL_MULT        optional. Fattens the volatility estimate (BTC has fat tails). Default 1.25
    TILT_WEIGHT     optional. How far flow/trend/etc. can push the z-score. Default 0.3 (was 0.6)
    BANKROLL        optional. If set, the page and alert suggest a quarter-Kelly stake in dollars
    KELLY_FRACTION  optional. Default 0.25.  KELLY_CAP optional, max fraction of bankroll. Default 0.05
    HEARTBEAT_MIN   optional. Minutes between "still alive" pushes. Default 60. 0 = off
    FEED_ALERTS     optional. Set to 0 to skip feed-down / feed-back pushes
    PAPER_BANKROLL  optional. Starting balance for the paper-trading tally. Default 1000
    PAPER_STAKE     optional. 'kelly' (default: KELLY_FRACTION of Kelly, capped at KELLY_CAP) or 'fixed'
    PAPER_FIXED_STAKE optional. Dollars per paper trade in fixed mode, or when Kelly gives nothing. Default 10
    KALSHI_URL      optional. Link opened from the alert. Default https://kalshi.com/markets/<series>
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const CFG = {
  topic: process.env.NTFY_TOPIC || '',
  ntfy: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
  whale: +process.env.WHALE_USD || 150000,
  port: +process.env.PORT || 3000,
  series: process.env.KALSHI_SERIES || 'KXBTC15M',
  results: process.env.RESULT_ALERTS !== '0',
  whaleAlerts: process.env.WHALE_ALERTS === '1',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  editKey: process.env.EDIT_KEY || process.env.NTFY_TOPIC || '',
  minEdge: num(process.env.MIN_EDGE, 0.02),
  shrink: Math.max(0, Math.min(1, num(process.env.SHRINK, 0.5))),
  volMult: num(process.env.VOL_MULT, 1.25),
  tiltW: num(process.env.TILT_WEIGHT, 0.3),
  bankroll: num(process.env.BANKROLL, 0),
  kellyFrac: num(process.env.KELLY_FRACTION, 0.25),
  kellyCap: num(process.env.KELLY_CAP, 0.05),
  heartbeatMin: num(process.env.HEARTBEAT_MIN, 60),
  feedAlerts: process.env.FEED_ALERTS !== '0',
  paperBank: num(process.env.PAPER_BANKROLL, 1000),
  paperMode: (process.env.PAPER_STAKE || 'kelly').toLowerCase() === 'fixed' ? 'fixed' : 'kelly',
  paperFixed: num(process.env.PAPER_FIXED_STAKE, 10)
};
CFG.kalshiUrl = process.env.KALSHI_URL || ('https://kalshi.com/markets/' + CFG.series.toLowerCase());
const ROUND_MS = 900000;
const FEED_STALE_MS = 8000, FEED_DOWN_ALERT_MS = 120000;
const UA = { 'User-Agent': 'line-lock-watcher/1.1', 'Accept': 'application/json' };

/* ---------- small helpers ---------- */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sd = a => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const fmtN = (n, d = 2) => (n == null || !isFinite(n)) ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n, d = 2) => (n == null || !isFinite(n)) ? '--' : '$' + fmtN(n, d);
const usdK = n => { const a = Math.abs(n); return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'k' : a.toFixed(0)); };
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const etTime = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const etDate = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const erf = x => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = p => p == null || !isFinite(p) ? '--' : Math.round(p * 100) + '%';
const cents = p => p == null || !isFinite(p) ? '--' : Math.round(p * 100) + 'c';

/* Kalshi taker fee per contract: 0.07 * P * (1-P), rounded up to the cent per order.
   For a single contract that is ceil(7 * P * (1-P)) cents. Check kalshi.com/fee-schedule, it can change. */
const kalshiFee = p => p == null ? 0 : Math.ceil(7 * p * (1 - p) - 1e-9) / 100;
/* Kelly for a binary contract bought at cost c (incl. fee) with win prob q: f = (q - c) / (1 - c) */
function kelly(q, c) {
  if (q == null || c == null || c <= 0 || c >= 1) return 0;
  const f = (q - c) / (1 - c); return f > 0 ? clamp(f * CFG.kellyFrac, 0, CFG.kellyCap) : 0;
}

/* ---------- market context (DISPLAY ONLY — never feeds a check, verdict, lock, or order) ----------
   Two read-only context sources shown on the status page and in /status:
   1. OKX perpetual funding rate + open interest (public endpoints, no key).
      Binance/Bybit futures APIs are geo-blocked from this host; OKX works.
   2. A hardcoded macro-event calendar (CPI / FOMC / one NVDA earnings).
   Dates were verified against the BLS schedule and the Fed calendar on
   2026-11-17. Nothing here is consulted by checksFor/analyze/lockLogic. */

/* ET calendar math: Intl with timeZone America/New_York is the source of truth
   for "today" and for converting an ET wall-clock time to epoch ms. The offset
   is derived per date (two passes) so DST transitions are handled; events sit
   at 08:30/14:00/16:00 ET, far from the 02:00 transitions. */
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function etDateKey(ms) {
  const p = etParts.formatToParts(ms), g = t => p.find(x => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function etOffsetMs(ms) {
  const p = etParts.formatToParts(ms), g = t => +p.find(x => x.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ms;
}
function etWallToMs(dateKey, hour, min) {
  const guess = Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(5, 7) - 1, +dateKey.slice(8, 10), hour, min);
  const off1 = etOffsetMs(guess);
  let ms = guess - off1;
  const off2 = etOffsetMs(ms);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}
/* Verified 2026-11-17: CPI dates/times from the BLS release schedule (08:30 ET);
   FOMC decision dates from the Federal Reserve calendar (statement 14:00 ET on
   the meeting's second day; 2027 dates are tentative per the Fed). July and
   October 2027 FOMC dates could not be resolved from the sources checked, so
   they are deliberately omitted rather than guessed. Payrolls were left out:
   no verified dates were on hand. */
const MACRO_EVENTS = [
  { name: 'NVDA earnings', date: '2026-11-17', hour: 16, min: 0 },
  { name: 'FOMC decision', date: '2026-12-09', hour: 14, min: 0 },
  { name: 'CPI', date: '2026-12-10', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-01-13', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-01-27', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-02-11', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-03-10', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-03-17', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-04-13', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-04-28', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-05-12', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-06-09', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-06-10', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-07-14', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-08-11', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-09-14', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-09-15', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-10-14', hour: 8, min: 30 },
  { name: 'CPI', date: '2027-11-10', hour: 8, min: 30 },
  { name: 'FOMC decision', date: '2027-11-17', hour: 14, min: 0 },
  { name: 'FOMC decision', date: '2027-12-08', hour: 14, min: 0 },
  { name: 'CPI', date: '2027-12-10', hour: 8, min: 30 }
];
function eventAtMs(e) { return etWallToMs(e.date, e.hour, e.min); }
function eventsToday(now) { const k = etDateKey(now); return MACRO_EVENTS.filter(e => e.date === k).map(e => e.name); }
function nextEvent(now) {
  let best = null;
  MACRO_EVENTS.forEach(e => { const at = eventAtMs(e); if (at > now && (!best || at < best.at)) best = { name: e.name, at }; });
  return best ? { name: best.name, atISO: new Date(best.at).toISOString(), minsUntil: Math.round((best.at - now) / 60000) } : null;
}
/* OKX public response shapes, verified live 2026-11-17. fundingRate is a string
   fraction per ~8h funding period (0.0000403 = +0.004%/8h, neutral). */
function parseOkxFunding(j) { const d = j && j.data && j.data[0]; const r = d ? parseFloat(d.fundingRate) : NaN; return isFinite(r) ? r : null; }
function parseOkxOi(j) { const d = j && j.data && j.data[0]; const v = d ? parseFloat(d.oiUsd) : NaN; return isFinite(v) ? v : null; }

/* ---------- state ---------- */
const FEEDS = {
  coinbase: { name: 'Coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', parse: j => +j.price },
  kraken: { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: j => +j.result[Object.keys(j.result)[0]].c[0] },
  bitstamp: { name: 'Bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: j => +j.last },
  gemini: { name: 'Gemini', url: 'https://api.gemini.com/v1/pubticker/btcusd', parse: j => +j.last },
  bitfinex: { name: 'Bitfinex', url: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD', parse: j => +j[6] }
};
const S = { prices: {}, trades: [], seen: new Set(), candles: new Map(), book: null, liq: [], hist: [], bt: null, clusters: [], kalshi: null, okx: null, polyUs: null, diag: {}, feedErr: {}, feedDownSince: {}, feedAlerted: {}, pend: [], scanT: null, liveP: {} };
let R = null, persist = 0, lastCand = null, STATUS = {}, RECENT = [], lastWhaleAlert = 0, LASTA = null;
const BOOT = Date.now();

function newRound(end) { R = { end, start: end - ROUND_MS, line: null, lineFrom: null, locked: null, lean: null, snap: null, ticker: null, surgeNotified: false }; persist = 0; lastCand = null; return R; }

/* ---------- server-side round log (data/rounds.json) ---------- */
const LOG_FILE = () => path.join(CFG.dataDir, 'rounds.json');
let ROUNDS = [];
function loadRounds() {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); } catch (e) { }
  try { ROUNDS = JSON.parse(fs.readFileSync(LOG_FILE(), 'utf8')); if (!Array.isArray(ROUNDS)) ROUNDS = []; }
  catch (e) { ROUNDS = []; }
  console.log('round log:', LOG_FILE(), '-', ROUNDS.length, 'rounds');
}
function saveRounds() {
  try { const tmp = LOG_FILE() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ROUNDS)); fs.renameSync(tmp, LOG_FILE()); }
  catch (e) { console.log('could not save round log', e.message); }
}
/* result for the call actually made, honoring edits */
function effSide(r) { return (r.edit && r.edit.side) || (r.locked && r.locked.side) || null; }
function effUp(r) { if (r.edit && r.edit.up != null) return r.edit.up; return r.up; } /* did BTC finish above the line: true/false/null */
function effRes(r) {
  if (r.edit && r.edit.res) return r.edit.res;
  const s = effSide(r), up = effUp(r); if (!s || up == null) return null;
  return (up === (s === 'UP')) ? 'won' : 'lost';
}

/* ---------- stats: scoreboard + calibration ---------- */
function stats() {
  const out = { all: { w: 0, l: 0, skip: 0 }, take: { w: 0, l: 0, pnl: 0, n: 0 }, cal: [], brier: null, brierMkt: null, nCal: 0, edited: 0 };
  const B = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(b => ({ lo: b[0], hi: b[1], n: 0, hit: 0, sumP: 0 }));
  let bs = 0, bm = 0, nm = 0, nb = 0;
  ROUNDS.forEach(r => {
    if (r.edit) out.edited++;
    const res = effRes(r);
    if (r.locked) {
      if (res === 'won') out.all.w++; else if (res === 'lost') out.all.l++; else if (res === 'skip') out.all.skip++;
      if (r.locked.decision === 'TAKE' && (res === 'won' || res === 'lost') && r.locked.ask != null) {
        out.take.n++; if (res === 'won') out.take.w++; else out.take.l++;
        out.take.pnl += (res === 'won' ? 1 : 0) - r.locked.ask - kalshiFee(r.locked.ask);
      }
    }
    /* calibration uses the 4-minutes-left snapshot of every round (locked or not) */
    const up = effUp(r); if (!r.snap || r.snap.probUp == null || up == null || res === 'skip') return;
    const p = r.snap.probUp, o = up ? 1 : 0; bs += (p - o) * (p - o); nb++;
    if (r.snap.mktUp != null) { bm += (r.snap.mktUp - o) * (r.snap.mktUp - o); nm++; }
    const ps = Math.max(p, 1 - p), hit = (p >= 0.5) === !!up;
    const b = B.find(x => ps >= x.lo && ps < x.hi); if (b) { b.n++; b.sumP += ps; if (hit) b.hit++; }
  });
  out.nCal = nb; out.brier = nb ? bs / nb : null; out.brierMkt = nm ? bm / nm : null;
  out.cal = B.map(b => ({ range: Math.round(b.lo * 100) + '-' + Math.min(100, Math.round(b.hi * 100)) + '%', n: b.n, avgP: b.n ? b.sumP / b.n : null, actual: b.n ? b.hit / b.n : null }));
  return out;
}

/* ---------- paper trading: replayed from ROUNDS so edits recompute everything ---------- */
const orderFee = (n, p) => n > 0 && p != null ? Math.ceil(7 * n * p * (1 - p) - 1e-9) / 100 : 0; /* Kalshi taker fee per order */
function paperSize(bal, prob, ask) {
  if (ask == null || ask <= 0 || ask >= 1 || bal <= 0) return { n: 0, stake: 0, mode: 'none' };
  let stake = 0, mode = CFG.paperMode;
  if (mode === 'kelly') { stake = bal * kelly(prob, ask + kalshiFee(ask)); if (stake <= 0) mode = 'fixed'; }
  if (mode === 'fixed') stake = Math.min(CFG.paperFixed, bal);
  let n = Math.floor(stake / (ask + kalshiFee(ask)));
  if (n < 1 && mode === 'kelly') { mode = 'fixed'; stake = Math.min(CFG.paperFixed, bal); n = Math.floor(stake / (ask + kalshiFee(ask))); }
  while (n > 0 && n * ask + orderFee(n, ask) > bal) n--;
  return { n, stake, mode };
}
function paper() {
  let bal = CFG.paperBank, peak = bal, maxDD = 0, maxDDpct = 0, w = 0, l = 0, open = 0, best = null, worst = null, fees = 0;
  const trades = [];
  ROUNDS.slice().sort((a, b) => a.end - b.end).forEach(r => {
    const L = r.locked; if (!L || L.decision !== 'TAKE' || L.ask == null) return;
    const res = effRes(r); if (res === 'skip') return;
    const side = effSide(r), z = paperSize(bal, L.prob, L.ask); if (z.n < 1) return;
    const cost = z.n * L.ask, fee = orderFee(z.n, L.ask);
    const t = { id: r.id, end: r.end, ticker: r.ticker || null, side, contracts: z.n, ask: L.ask, cost: +cost.toFixed(2), fee, sizing: z.mode, edited: !!r.edit, res: res || 'open', balBefore: +bal.toFixed(2) };
    if (res !== 'won' && res !== 'lost') { open++; t.pnl = null; trades.push(t); return; } /* pending: not settled yet, cash not deducted */
    const payout = res === 'won' ? z.n : 0, pnl = payout - cost - fee;
    bal += pnl; fees += fee; if (res === 'won') w++; else l++;
    t.payout = payout; t.pnl = +pnl.toFixed(2); t.balAfter = +bal.toFixed(2);
    if (!best || pnl > best.pnl) best = t; if (!worst || pnl < worst.pnl) worst = t;
    if (bal > peak) peak = bal; const dd = peak - bal; if (dd > maxDD) { maxDD = dd; maxDDpct = peak > 0 ? dd / peak : 0; }
    trades.push(t);
  });
  const pnl = bal - CFG.paperBank;
  return { start: CFG.paperBank, mode: CFG.paperMode, fixedStake: CFG.paperFixed, balance: +bal.toFixed(2), pnl: +pnl.toFixed(2), roi: CFG.paperBank ? pnl / CFG.paperBank : null, trades: w + l, open, wins: w, losses: l, winRate: (w + l) ? w / (w + l) : null, fees: +fees.toFixed(2), maxDrawdown: +maxDD.toFixed(2), maxDrawdownPct: maxDDpct, best, worst, recent: trades.slice(-50).reverse() };
}
/* Display only: every settled paper trade, replayed exactly like paper() (same
   round order, same paperSize/orderFee/effRes math, same skips) so the P&L
   calendar and the tiles use the same P&L figures as the paper tally. paper()
   only keeps the last 50 trades, which is not enough for a month view, so this
   mirrors its loop instead of changing paper(). Keep the two loops in sync. */
function settledPaperTrades() {
  let bal = CFG.paperBank;
  const out = [];
  ROUNDS.slice().sort((a, b) => a.end - b.end).forEach(r => {
    const L = r.locked; if (!L || L.decision !== 'TAKE' || L.ask == null) return;
    const res = effRes(r); if (res === 'skip') return;
    const z = paperSize(bal, L.prob, L.ask); if (z.n < 1) return;
    const cost = z.n * L.ask, fee = orderFee(z.n, L.ask);
    if (res !== 'won' && res !== 'lost') return; /* pending: not settled yet, no P&L */
    const payout = res === 'won' ? z.n : 0, pnl = payout - cost - fee;
    bal += pnl;
    out.push({ end: r.end, pnl, res });
  });
  return out;
}
/* Display only: settled paper P&L grouped by ET calendar date. */
function dailyPnl() {
  const m = new Map();
  settledPaperTrades().forEach(t => {
    const k = etDateKey(t.end);
    let d = m.get(k); if (!d) { d = { pnl: 0, w: 0, l: 0 }; m.set(k, d); }
    d.pnl += t.pnl; if (t.res === 'won') d.w++; else d.l++;
  });
  return m;
}
function savePaper() { try { const P = paper(); delete P.recent; fs.writeFileSync(path.join(CFG.dataDir, 'paper.json'), JSON.stringify(P, null, 2)); } catch (e) { console.log('could not save paper.json', e.message); } }
const paperLine = () => { const P = paper(); return 'Paper ' + usd(P.balance) + ' (' + (P.pnl >= 0 ? '+' : '-') + usd(Math.abs(P.pnl)) + ', ROI ' + (P.roi == null ? '--' : (P.roi * 100).toFixed(1) + '%') + ', ' + P.wins + '-' + P.losses + ')'; };
const CSV_COLS = ['id', 'end_iso', 'ticker', 'line', 'line_from', 'final', 'up', 'source', 'mismatch', 'snap_prob_up', 'snap_raw_up', 'snap_mkt_up', 'snap_verdict', 'snap_edge', 'locked_side', 'decision', 'lock_prob', 'lock_ask', 'lock_fee', 'lock_edge', 'checks_passed', 'checks_total', 'reason', 'edited', 'edit_side', 'edit_res', 'result'];
function exportCsv() {
  const q = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = ROUNDS.slice().sort((a, b) => a.end - b.end).map(r => { const L = r.locked || {}, N = r.snap || {}, E = r.edit || {};
    return [r.id, new Date(r.end).toISOString(), r.ticker, r.line, r.lineFrom, r.fin, r.up, r.source, r.mismatch, N.probUp, N.rawUp, N.mktUp, N.verdict, N.edge, L.side, L.decision, L.prob, L.ask, L.fee, L.edge, L.passN, L.total, L.reason, r.edit ? 1 : 0, E.side, E.res, effRes(r)].map(q).join(','); });
  return CSV_COLS.join(',') + '\n' + rows.join('\n') + '\n';
}

/* ---------- indicators ---------- */
function rsiSeries(c, n = 14) {
  const o = new Array(c.length).fill(null); if (c.length <= n) return o;
  let g = 0, l = 0, i, d;
  for (i = 1; i <= n; i++) { d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (i = n + 1; i < c.length; i++) { d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}
function emaSeries(c, n) { const k = 2 / (n + 1), o = new Array(c.length).fill(null); if (!c.length) return o; let e = c[0]; o[0] = e; for (let i = 1; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; } return o; }
function indArrays(cs) {
  const n = cs.length, closes = cs.map(c => c.c), rsi = rsiSeries(closes, 14);
  const bbU = new Array(n).fill(Infinity), bbL = new Array(n).fill(-Infinity), vwap = new Array(n).fill(null), vavg = new Array(n).fill(Infinity);
  let i, k;
  for (i = 19; i < n; i++) { let s = 0; for (k = i - 19; k <= i; k++) s += closes[k]; const m = s / 20; let v = 0; for (k = i - 19; k <= i; k++) v += (closes[k] - m) * (closes[k] - m); const d = Math.sqrt(v / 20); bbU[i] = m + 2 * d; bbL[i] = m - 2 * d; }
  const pv = [0], vv = [0];
  for (i = 0; i < n; i++) { const tp = (cs[i].h + cs[i].l + cs[i].c) / 3; pv.push(pv[i] + tp * cs[i].v); vv.push(vv[i] + cs[i].v); }
  for (i = 0; i < n; i++) { const a = Math.max(0, i - 59), dv = vv[i + 1] - vv[a]; vwap[i] = dv > 0 ? (pv[i + 1] - pv[a]) / dv : cs[i].c; const b = Math.max(0, i - 19); vavg[i] = (vv[i + 1] - vv[b]) / (i - b + 1); }
  return { rsi, bbU, bbL, vwap, vavg, closes };
}
/* ---------- display-only indicators: MACD + reversion readout ----------
   Pure helper, called from tick() ONLY for the STATUS literal / status page.
   Nothing in analyze(), checksFor(), lockLogic, paper, stats, CSV, or sizing
   reads these values. The duplicate indArrays() call is deliberate: separation
   from decision code matters more than the trivial CPU cost. */
function computeDisplayIndicators(cs) {
  const n = cs ? cs.length : 0;
  if (n < 35) return { macd: null, reversion: null };
  const ind = indArrays(cs), last = n - 1, closes = ind.closes;
  /* MACD 12/26/9 on 1-minute closes, in USD. */
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdSeries = closes.map((_, i) => e12[i] - e26[i]);
  const sig = emaSeries(macdSeries, 9);
  const r2 = v => Math.round(v * 100) / 100;
  const macd = { line: r2(macdSeries[last]), signal: r2(sig[last]), hist: r2(macdSeries[last] - sig[last]) };
  /* Reversion: distance from the rolling VWAP, and Bollinger %B. The label
     comes from %B ONLY: above the upper band = stretched up, below the lower
     band = stretched down, inside the bands = near mean. */
  const vw = ind.vwap[last], close = closes[last];
  const vwapDistPct = (vw != null && vw !== 0) ? +(((close - vw) / vw) * 100).toFixed(3) : null;
  const bu = ind.bbU[last], bl = ind.bbL[last];
  const pctB = (isFinite(bu) && isFinite(bl) && (bu - bl) !== 0) ? +((close - bl) / (bu - bl)).toFixed(4) : null;
  const label = pctB == null ? null : pctB > 1 ? 'stretched up' : pctB < 0 ? 'stretched down' : 'near mean';
  return { macd, reversion: { vwapDistPct, pctB, label } };
}
/* ---------- display-only readouts: odds trail, taker flow, grade, distance, gauge ----------
   Same rule as computeDisplayIndicators: pure helpers plus one small recorder,
   consumed ONLY by the STATUS literal in tick() and by page() rendering.
   No check, verdict, lock, paper, stats, CSV, or hook code reads these. */
function summarizeOddsTrail(pts, ticker) {
  if (!pts || !pts.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const p of pts) { if (p.ask > hi) hi = p.ask; if (p.ask < lo) lo = p.ask; }
  return { ticker: ticker || null, open: pts[0].ask, high: hi, low: lo, last: pts[pts.length - 1].ask, n: pts.length };
}
/* Odds trail state: Kalshi yesAsk samples for the current window only.
   pollKalshi runs every 2s, so 450 entries cover one 15-minute window. */
let oddsTrailPts = [], oddsTrailTicker = null;
function recordOddsTick(k) {
  if (!k || k.yesAsk == null || !isFinite(k.yesAsk)) return summarizeOddsTrail(oddsTrailPts, oddsTrailTicker);
  if (k.ticker !== oddsTrailTicker) { oddsTrailTicker = k.ticker; oddsTrailPts = []; }
  oddsTrailPts.push({ t: k.t, ask: k.yesAsk });
  while (oddsTrailPts.length > 450) oddsTrailPts.shift();
  return summarizeOddsTrail(oddsTrailPts, oddsTrailTicker);
}
/* Taker flow over 15s/30s/60s, from the same S.trades store the flow check
   already reads (windowFlow). No new feed, no new data. */
function computeTakerFlow(now) {
  const w = ms => { const f = windowFlow(now, ms); return { buyUsd: Math.round(f.b), sellUsd: Math.round(f.s), deltaUsd: Math.round(f.b - f.s), buyPct: f.buyPct == null ? null : +f.buyPct.toFixed(1) }; };
  return { '15s': w(15000), '30s': w(30000), '60s': w(60000) };
}
function takerFlowLabel(buyPct) {
  if (buyPct == null || !isFinite(buyPct)) return null;
  return buyPct >= 60 ? 'Buyers pressing' : buyPct <= 40 ? 'Sellers pressing' : 'Balanced';
}
/* Grade is a pure derivation from the checks already counted in tick():
   all counted checks = A, one short = B, anything worse = C. */
function gradeFor(passN, total) {
  if (total == null || total <= 0 || passN == null) return null;
  return { grade: passN >= total ? 'A' : passN >= total - 1 ? 'B' : 'C', passN, total };
}
function distToLine(price, line) {
  if (price == null || line == null || !isFinite(price) || !isFinite(line) || line === 0) return null;
  const d = price - line;
  return { usd: +d.toFixed(2), pct: +((d / line) * 100).toFixed(3), side: d > 0 ? 'above' : d < 0 ? 'below' : 'at' };
}
/* Market gauge: how one-sided the Kalshi market probability is, 0-100.
   prob is the market-implied P(up) analyze() already computes (midpoint of
   the yes ask and the implied yes bid, i.e. the same number the page shows
   as "Kalshi up"); 0.5 = perfectly balanced. */
function marketGauge(prob) {
  if (prob == null || !isFinite(prob)) return null;
  const score = Math.round(Math.abs(prob - 0.5) * 200);
  return { score, direction: prob > 0.5 ? 'UP' : 'DOWN', label: score < 25 ? 'Balanced' : score < 50 ? 'Leaning' : score < 75 ? 'One-sided' : 'Extreme' };
}
/* Fair value gaps (FVG) on the 1-minute candles. A 3-candle gap: bullish when
   candle[i-2].high < candle[i].low (zone = [high, low]), bearish when
   candle[i-2].low > candle[i].high (zone = [high, low]). A gap stays open until
   a LATER candle trades through its far edge: bullish fills when a later low
   prints at or below the zone low, bearish when a later high prints at or
   above the zone high. Only the 20 most recently formed open gaps are tracked.
   Nearest selection uses zones entirely below/above the price: a zone the
   price is currently inside is being tested, not "below" or "above" it.
   The returned `open` list (additive field) carries every open gap with its
   origin candle index, for the chart renderer; the nearest-zone fields and
   openCount are unchanged.
   Display only; evaluated every tick (1s), fresher than the 10s requirement. */
function computeFvgState(cs, price) {
  const empty = { bullish: null, bearish: null, openCount: 0, open: [] };
  if (!cs || cs.length < 3) return empty;
  const px = (price != null && isFinite(price)) ? price : cs[cs.length - 1].c;
  const open = [];
  for (let j = 0; j < cs.length; j++) {
    const c = cs[j];
    for (let k = open.length - 1; k >= 0; k--) {
      const f = open[k];
      if ((f.dir > 0 && c.l <= f.low) || (f.dir < 0 && c.h >= f.high)) open.splice(k, 1);
    }
    if (j >= 2) {
      const a = cs[j - 2];
      if (a.h < c.l) open.push({ dir: 1, low: a.h, high: c.l, formedAt: j });
      else if (a.l > c.h) open.push({ dir: -1, low: c.h, high: a.l, formedAt: j });
    }
    while (open.length > 20) open.shift();
  }
  const last = cs.length - 1;
  let bull = null, bear = null;
  for (const f of open) {
    const zone = { low: Math.round(f.low * 100) / 100, high: Math.round(f.high * 100) / 100, ageCandles: last - f.formedAt };
    if (f.dir > 0 && f.high <= px && (!bull || zone.high > bull.high)) bull = zone;
    if (f.dir < 0 && f.low >= px && (!bear || zone.low < bear.low)) bear = zone;
  }
  return { bullish: bull, bearish: bear, openCount: open.length, open: open.map(f => ({ dir: f.dir, low: Math.round(f.low * 100) / 100, high: Math.round(f.high * 100) / 100, startIdx: f.formedAt })) };
}
/* Supply/demand zones: ONE deterministic rule, documented here.
   Volatility context (computed once per evaluation from the recent past):
   - baseMax = 0.5 x median 1-minute range over the last 60 candles.
   - impulseMin = 1.5 x ATR(14) over the last 14 true ranges.
   A zone forms at a "base": the longest run of 1-3 consecutive candles
   starting at some index, each with range below baseMax, immediately
   followed by an impulse of 1-3 candles whose net move from the last base
   close clears impulseMin (up = demand, down = supply). The first
   qualifying impulse length wins; after a zone forms, the scan resumes
   after the impulse so zones never overlap. Zone = [low, high] of the
   base candles only. A zone stays untested until a later candle CLOSES
   through its far edge: demand breaks on a close below the zone low,
   supply on a close above the zone high (wicks do not break zones).
   Only the 10 most recently formed untested zones are tracked.
   The returned `open` list (additive field) carries every untested zone with
   its base-start candle index, for the chart renderer; the nearest-zone fields
   and openCount are unchanged.
   Display only; evaluated every tick alongside computeFvgState. */
function computeZoneState(cs, price) {
  const empty = { supply: null, demand: null, openCount: 0, open: [] };
  if (!cs || cs.length < 15) return empty;
  const n = cs.length;
  const medRange = median(cs.slice(-60).map(c => c.h - c.l));
  const baseMax = 0.5 * medRange;
  let trSum = 0;
  for (let i = n - 14; i < n; i++) {
    const c = cs[i], p = cs[i - 1];
    trSum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  const impulseMin = 1.5 * (trSum / 14);
  const zones = [];
  let b = 0;
  while (b < n - 1) {
    let run = 0;
    while (run < 3 && b + run < n && (cs[b + run].h - cs[b + run].l) < baseMax) run++;
    if (!run) { b++; continue; }
    const baseEnd = b + run - 1, baseClose = cs[baseEnd].c;
    let lo = Infinity, hi = -Infinity;
    for (let k = b; k <= baseEnd; k++) { lo = Math.min(lo, cs[k].l); hi = Math.max(hi, cs[k].h); }
    let formed = null;
    for (let m = 1; m <= 3; m++) {
      const e = baseEnd + m;
      if (e >= n) break;
      const move = cs[e].c - baseClose;
      if (move >= impulseMin) { formed = { dir: 1, low: lo, high: hi, formedAt: e, origin: b }; break; }
      if (-move >= impulseMin) { formed = { dir: -1, low: lo, high: hi, formedAt: e, origin: b }; break; }
    }
    if (formed) { zones.push(formed); b = formed.formedAt + 1; }
    else b++;
  }
  const open = zones.filter(z => {
    for (let j = z.formedAt + 1; j < n; j++) {
      if ((z.dir > 0 && cs[j].c < z.low) || (z.dir < 0 && cs[j].c > z.high)) return false;
    }
    return true;
  }).slice(-10);
  const px = (price != null && isFinite(price)) ? price : cs[n - 1].c;
  const last = n - 1;
  let dem = null, sup = null;
  for (const z of open) {
    const zone = { low: Math.round(z.low * 100) / 100, high: Math.round(z.high * 100) / 100, ageCandles: last - z.formedAt };
    if (z.dir > 0 && z.high <= px && (!dem || zone.high > dem.high)) dem = zone;
    if (z.dir < 0 && z.low >= px && (!sup || zone.low < sup.low)) sup = zone;
  }
  return { supply: sup, demand: dem, openCount: open.length, open: open.map(z => ({ dir: z.dir, low: Math.round(z.low * 100) / 100, high: Math.round(z.high * 100) / 100, startIdx: z.origin })) };
}
/* ---------- display-only Bucko-menu features: liquidity map, order blocks,
   session timing, risk line ----------
   Pure helpers, consumed ONLY by the STATUS literal in tick() and by page()
   rendering. Nothing in analyze(), checksFor(), lockLogic, paper, stats, CSV,
   or sizing reads these values. */
/* ATR(14): mean of the last 14 true ranges on 1-minute candles — the same
   volatility yardstick computeZoneState() uses inline for its impulse
   threshold (recomputed here so the zone code stays untouched). Null below
   15 candles: 14 ranges need 15 closes. */
function atr14(cs) {
  if (!cs || cs.length < 15) return null;
  let sum = 0;
  for (let i = cs.length - 14; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / 14;
}
/* Liquidity map: ONE fixed rule. A swing high is a 1-minute candle whose high
   exceeds the highs of the 3 candles on each side; a swing low is the mirror
   image. Swing levels within 0.05% of each other cluster into one pool:
   levels are scanned low to high and each joins the current pool when it is
   within 0.05% of the pool's running mean, so the pool level is the mean of
   its member levels. Only the nearest swing-high pool strictly above the
   price and the nearest swing-low pool strictly below it are reported —
   pools are where stop orders cluster, i.e. price magnets.
   Display only; evaluated every tick alongside FVG/zones. */
function computeLiquidityMap(cs, price) {
  const empty = { above: null, below: null, poolCount: 0 };
  if (!cs || cs.length < 7) return empty;
  const px = (price != null && isFinite(price)) ? price : cs[cs.length - 1].c;
  const highs = [], lows = [];
  for (let i = 3; i < cs.length - 3; i++) {
    const c = cs[i];
    if (c.h > cs[i - 3].h && c.h > cs[i - 2].h && c.h > cs[i - 1].h && c.h > cs[i + 1].h && c.h > cs[i + 2].h && c.h > cs[i + 3].h) highs.push(c.h);
    if (c.l < cs[i - 3].l && c.l < cs[i - 2].l && c.l < cs[i - 1].l && c.l < cs[i + 1].l && c.l < cs[i + 2].l && c.l < cs[i + 3].l) lows.push(c.l);
  }
  const cluster = levels => {
    const pools = [];
    for (const lv of levels.slice().sort((a, b) => a - b)) {
      const last = pools[pools.length - 1];
      if (last && Math.abs(lv - last.level) / last.level <= 0.0005) {
        last.level = (last.level * last.count + lv) / (last.count + 1);
        last.count++;
      } else pools.push({ level: lv, count: 1 });
    }
    return pools;
  };
  const hiPools = cluster(highs), loPools = cluster(lows);
  const r2 = v => Math.round(v * 100) / 100;
  let above = null, below = null;
  for (const p of hiPools) if (p.level > px && (!above || p.level < above.level)) above = p;
  for (const p of loPools) if (p.level < px && (!below || p.level > below.level)) below = p;
  return {
    above: above ? { level: r2(above.level), count: above.count } : null,
    below: below ? { level: r2(below.level), count: below.count } : null,
    poolCount: hiPools.length + loPools.length
  };
}
/* Order blocks: ONE fixed rule. An impulse is a 1–3 candle move whose net
   close-to-close change from the candle before it clears 1.5 x ATR(14) — the
   same impulse definition computeZoneState() uses, so blocks and zones agree
   on what counts as a push. The impulse's first candle must push in the
   impulse's direction, so a counter-move candle immediately before the push
   is not absorbed into the impulse window — it is the block candidate, not
   part of the impulse. The order block is the nearest opposite-direction
   candle within the 3 candles immediately before the impulse (the last red
   candle before an up impulse, the last green candle before a down impulse);
   if none of those 3 candles is opposite-direction, the impulse forms no
   block. The block zone is that candle's [low, high]. The first qualifying
   impulse length wins, and the scan resumes after the impulse, so blocks
   never overlap. A block is invalidated once a later candle CLOSES through
   its far edge (bullish block: close below the block low; bearish block:
   close above the block high — wicks do not invalidate). Only the nearest
   untested bullish block below the price and bearish block above it are
   reported. Display only: row + STATUS, never drawn on the chart. */
function computeOrderBlocks(cs, price) {
  const empty = { bullish: null, bearish: null, openCount: 0 };
  const atr = atr14(cs);
  if (atr == null || atr <= 0) return empty;
  const n = cs.length, impulseMin = 1.5 * atr, blocks = [];
  let i = 1;
  while (i < n) {
    let formed = null, consumedTo = -1;
    for (let m = 1; m <= 3; m++) {
      const e = i + m - 1;
      if (e >= n) break;
      const move = cs[e].c - cs[i - 1].c;
      if (Math.abs(move) < impulseMin) continue;
      const first = cs[i].c - cs[i - 1].c;
      if (first === 0 || (first > 0) !== (move > 0)) continue; /* impulse must start with a push its own way */
      const dir = move > 0 ? 1 : -1;
      consumedTo = e;
      for (let b = i - 1; b >= Math.max(0, i - 3); b--) {
        const opp = dir > 0 ? cs[b].c < cs[b].o : cs[b].c > cs[b].o;
        if (opp) { formed = { dir, low: cs[b].l, high: cs[b].h, formedAt: e, origin: b }; break; }
      }
      break; /* first qualifying impulse length wins */
    }
    if (formed) blocks.push(formed);
    i = consumedTo >= 0 ? consumedTo + 1 : i + 1;
  }
  const open = blocks.filter(z => {
    for (let j = z.formedAt + 1; j < n; j++) {
      if ((z.dir > 0 && cs[j].c < z.low) || (z.dir < 0 && cs[j].c > z.high)) return false;
    }
    return true;
  });
  const px = (price != null && isFinite(price)) ? price : cs[n - 1].c;
  const last = n - 1;
  let bull = null, bear = null;
  for (const z of open) {
    const zone = { low: Math.round(z.low * 100) / 100, high: Math.round(z.high * 100) / 100, ageCandles: last - z.formedAt };
    if (z.dir > 0 && z.high <= px && (!bull || zone.high > bull.high)) bull = zone;
    if (z.dir < 0 && z.low >= px && (!bear || zone.low < bear.low)) bear = zone;
  }
  return { bullish: bull, bearish: bear, openCount: open.length };
}
/* Session timing: pure ET wall-clock math on the server clock. Session
   boundaries: Asia 19:00–04:00 ET, London 03:00–11:30 ET, New York 09:30–16:00
   ET. Overlaps resolve to the later-opening session: 03:00–04:00 is London
   (opened later than Asia), 09:30–11:30 is New York (opened later than
   London). 16:00–19:00 ET no session is open. The next-open countdown looks
   at today plus the next two ET dates through etWallToMs, so DST transitions
   are handled per date. The next macro event is already shown by
   contextLine(), so this row carries sessions only. Display only. */
function computeSession(now) {
  const p = etParts.formatToParts(now), g = t => +p.find(x => x.type === t).value;
  const mins = (g('hour') % 24) * 60 + g('minute');
  const inWin = (a, b) => a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b);
  let current;
  if (inWin(570, 960)) current = 'New York';
  else if (inWin(180, 690)) current = 'London';
  else if (inWin(1140, 240)) current = 'Asia';
  else current = 'Between sessions';
  const opens = [{ name: 'Asia', h: 19, m: 0 }, { name: 'London', h: 3, m: 0 }, { name: 'New York', h: 9, m: 30 }];
  let best = null;
  for (let d = 0; d < 3; d++) {
    const key = etDateKey(now + d * 86400000);
    for (const o of opens) {
      const at = etWallToMs(key, o.h, o.m);
      if (at > now && (!best || at < best.at)) best = { name: o.name, at };
    }
  }
  return { current, next: best ? best.name : null, minsUntilNext: best ? Math.round((best.at - now) / 60000) : null, opensAtISO: best ? new Date(best.at).toISOString() : null };
}
/* Risk line: required velocity vs normal pace. required = |distance to line|
   / minutes left in the window ($/min); feasibility compares it against the
   recent typical 1-minute move, ATR(14). Null-safe: no distance, no ATR, or
   no time left all return null — never divide by zero. Display only. */
function computeRiskLine(dtl, leftSec, cs) {
  if (!dtl || leftSec == null || !isFinite(leftSec) || leftSec <= 0) return null;
  const atr = atr14(cs);
  if (atr == null || atr <= 0) return null;
  const minsLeft = leftSec / 60;
  const need = Math.abs(dtl.usd);
  const perMin = need / minsLeft;
  const r2 = v => Math.round(v * 100) / 100;
  return { needUsd: r2(need), minsLeft: r2(minsLeft), perMin: r2(perMin), atr: r2(atr), ratio: r2(perMin / atr) };
}
/* ---------- display-only multi-timeframe confirmation ----------
   Seven timeframes — 10s, 15s, 30s, 1m, 5m, 10m, 15m — each independently
   "locks in" UP or DOWN when its own trend, momentum, and price-vs-average
   ALL agree. Nothing here feeds analyze(), checksFor(), lockLogic, paper,
   stats, CSV, or the lock hook: the states render on the page and fire a
   one-shot alert on lock-in, and that is all.
   LOCK-IN RULE (identical for every timeframe, computed from that
   timeframe's own candles only):
     UP   when EMA9 > EMA21 AND RSI(14) > 50 AND last close > VWAP
     DOWN when EMA9 < EMA21 AND RSI(14) < 50 AND last close < VWAP
     otherwise not locked in (no direction).
   VWAP is the rolling 60-candle volume-weighted average of typical price
   ((h+l+c)/3), the same definition indArrays() uses; tfVwapLast() computes
   it for the last candle only. EMA/RSI reuse the existing emaSeries() and
   rsiSeries(), which already accept arbitrary close arrays.
   CANDLE SOURCES (no new feeds): 1m uses the closed 1-minute candles;
   5m/10m/15m aggregate them (same merge analyze() uses for its 5-min RSI);
   10s/15s/30s bucket the per-second price ticks tick() already receives
   (recordTfTick, called from tick() only). Sub-minute buckets are stateful
   on purpose: deriving them from S.hist would starve the 30s frame, because
   S.hist is pruned to 20 minutes (40 buckets) against the 35-bucket minimum.
   WARM-UP: a timeframe needs TF_MIN_CANDLES closes before it can lock in.
   Below that it reports warmingUp and can never lock in — after a restart
   the sub-minute frames fill in over minutes, which is expected. */
/* Minimum closes for a lock-in: 21 (a full EMA21 period) + 14 (the RSI(14)
   lookback). RSI(14) needs 15 closes for its first value; 35 gives both
   indicators room to settle, and matches the 35-candle threshold
   computeDisplayIndicators() already uses. */
const TF_MIN_CANDLES = 35;
const TF_ORDER = ['10s', '15s', '30s', '1m', '5m', '10m', '15m'];
const TF_SUB_MS = { '10s': 10000, '15s': 15000, '30s': 30000 };
const TF_SUB_MAX = 240; /* buckets kept per sub-minute frame: 40 min of 10s, 60 min of 15s, 120 min of 30s */
/* Sub-minute bucket state: arrays of forming candles {t,o,h,l,c,v} where v is
   the tick count in the bucket (the VWAP weight). The current bucket stays
   open and updates every tick; it counts like any other candle. */
const tfSubBuckets = { '10s': [], '15s': [], '30s': [] };
/* Last alerted lock-in direction per timeframe, plus the priming flag.
   tfFireAlerts() records the states it finds on its first run WITHOUT
   firing: a frame already locked in before a restart is not a new lock-in. */
const tfAlerted = {};
function tfAggregateCandles(cs, bucketMs) {
  const g = new Map();
  for (const c of cs) {
    const k = Math.floor(c.t / bucketMs) * bucketMs, b = g.get(k);
    if (!b) g.set(k, { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; b.v += c.v; }
  }
  return Array.from(g.values());
}
function tfVwapLast(cs, window) {
  const w = window || 60, n = cs ? cs.length : 0;
  if (!n) return null;
  let pv = 0, vv = 0;
  for (let i = Math.max(0, n - w); i < n; i++) { const tp = (cs[i].h + cs[i].l + cs[i].c) / 3; pv += tp * cs[i].v; vv += cs[i].v; }
  return vv > 0 ? pv / vv : null;
}
function tfStateFor(cs) {
  const n = cs ? cs.length : 0;
  const base = { warmingUp: true, locked: false, dir: null, n, ema9: null, ema21: null, rsi: null, vwap: null, close: null };
  if (n < TF_MIN_CANDLES) return base;
  const closes = cs.map(c => c.c), last = n - 1;
  const ema9 = emaSeries(closes, 9)[last], ema21 = emaSeries(closes, 21)[last], rsi = rsiSeries(closes, 14)[last];
  const vwap = tfVwapLast(cs, 60), close = closes[last];
  if (ema9 == null || ema21 == null || rsi == null || vwap == null) return base;
  /* The lock decision uses the raw values; the rounded copies below are display only. */
  const up = ema9 > ema21 && rsi > 50 && close > vwap;
  const down = ema9 < ema21 && rsi < 50 && close < vwap;
  return { warmingUp: false, locked: up || down, dir: up ? 'UP' : down ? 'DOWN' : null, n, ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), rsi: +rsi.toFixed(1), vwap: +vwap.toFixed(2), close };
}
function computeTfConfirm(ccs, subBuckets) {
  const frames = {
    '10s': tfStateFor(subBuckets && subBuckets['10s']),
    '15s': tfStateFor(subBuckets && subBuckets['15s']),
    '30s': tfStateFor(subBuckets && subBuckets['30s']),
    '1m': tfStateFor(ccs),
    '5m': tfStateFor(tfAggregateCandles(ccs || [], 300000)),
    '10m': tfStateFor(tfAggregateCandles(ccs || [], 600000)),
    '15m': tfStateFor(tfAggregateCandles(ccs || [], 900000))
  };
  let up = 0, down = 0, warming = 0;
  for (const name of TF_ORDER) { const f = frames[name]; if (f.warmingUp) warming++; else if (f.locked && f.dir === 'UP') up++; else if (f.locked && f.dir === 'DOWN') down++; }
  const summary = up > 0 && down === 0 ? up + ' of ' + TF_ORDER.length + ' locked in UP'
    : down > 0 && up === 0 ? down + ' of ' + TF_ORDER.length + ' locked in DOWN'
    : up > 0 && down > 0 ? 'Mixed · ' + up + ' UP / ' + down + ' DOWN'
    : 'None locked in';
  return { frames, order: TF_ORDER.slice(), up, down, warming, summary };
}
function recordTfTick(now, price, store) {
  if (price == null || !isFinite(price)) return;
  const buckets = store || tfSubBuckets;
  for (const name of Object.keys(TF_SUB_MS)) {
    const arr = buckets[name];
    if (!arr) continue;
    const k = Math.floor(now / TF_SUB_MS[name]) * TF_SUB_MS[name], lastB = arr[arr.length - 1];
    if (lastB && lastB.t === k) { lastB.h = Math.max(lastB.h, price); lastB.l = Math.min(lastB.l, price); lastB.c = price; lastB.v++; }
    else if (!lastB || k > lastB.t) { arr.push({ t: k, o: price, h: price, l: price, c: price, v: 1 }); while (arr.length > TF_SUB_MAX) arr.shift(); }
    /* k < lastB.t means the clock went backward: ignore the tick, keep order. */
  }
}
/* One-shot lock-in alerts, through push() only. Fires once per timeframe per
   direction when a frame newly locks in; a frame that stays locked in does
   not re-alert; unlocking resets it so a fresh lock-in alerts again. The
   first run only primes the state (see tfAlerted) and fires nothing, and the
   first 120s after boot prime silently too (see QUIET_BOOT_MS).
   `alerted`/`notify`/`now` are injectable for tests; production uses the module
   state, push(), and Date.now(). Returns the titles fired. Display path only. */
/* Quiet boot: the first 120 seconds after process start prime timeframe
   states silently and fire nothing. A cold boot is not a transition: frames
   resolve from warm-up as candles load, and without this guard each one
   alerts once within the first minute of a restart (observed for 1m/5m/10m/
   15m). BOOT is the process-start timestamp captured at module load; the
   `now` parameter exists so tests can step past the window. Call alerts are
   untouched — this guard lives only in tfFireAlerts. */
const QUIET_BOOT_MS = 120000;
function tfFireAlerts(tfc, price, alerted, notify, now) {
  const fired = [];
  if (!tfc) return fired;
  const seen = alerted || tfAlerted, send = notify || push;
  const quietBoot = (now != null ? now : Date.now()) - BOOT < QUIET_BOOT_MS;
  const priming = !seen.__primed || quietBoot;
  for (const name of tfc.order) {
    const f = tfc.frames[name];
    if (!f) continue;
    if (f.locked && f.dir) {
      if (!priming && seen[name] !== f.dir) {
        const title = name + ' chart locked in ' + f.dir;
        send(title, 'EMA9 vs EMA21, RSI(14), and price vs VWAP all agree on the ' + name + ' chart.' + (price != null ? ' Price ' + usd(price) + '.' : '') + ' ' + tfc.up + ' timeframe(s) locked UP, ' + tfc.down + ' locked DOWN.', 'default', 'chart');
        fired.push(title);
      }
      seen[name] = f.dir;
    } else {
      seen[name] = null;
    }
  }
  seen.__primed = true;
  return fired;
}
const red = k => k.c < k.o, grn = k => k.c > k.o;
const PATS = [
  { id: 'bearEng', name: 'Bearish engulfing', dir: -1, test: (c, i) => { const a = c[i - 1], b = c[i]; return grn(a) && red(b) && b.o >= a.c && b.c <= a.o; } },
  { id: 'bullEng', name: 'Bullish engulfing', dir: 1, test: (c, i) => { const a = c[i - 1], b = c[i]; return red(a) && grn(b) && b.o <= a.c && b.c >= a.o; } },
  { id: 'red3', name: 'Three red candles', dir: -1, test: (c, i) => red(c[i]) && red(c[i - 1]) && red(c[i - 2]) },
  { id: 'green3', name: 'Three green candles', dir: 1, test: (c, i) => grn(c[i]) && grn(c[i - 1]) && grn(c[i - 2]) },
  { id: 'vwUp', name: 'Crossed above VWAP', dir: 1, test: (c, i, x) => c[i - 1].c < x.vwap[i - 1] && c[i].c >= x.vwap[i] },
  { id: 'vwDn', name: 'Crossed below VWAP', dir: -1, test: (c, i, x) => c[i - 1].c > x.vwap[i - 1] && c[i].c <= x.vwap[i] },
  { id: 'volRed', name: 'Volume spike on red candle', dir: -1, test: (c, i, x) => c[i].v > 2 * x.vavg[i] && red(c[i]) },
  { id: 'volGrn', name: 'Volume spike on green candle', dir: 1, test: (c, i, x) => c[i].v > 2 * x.vavg[i] && grn(c[i]) },
  { id: 'star', name: 'Shooting star', dir: -1, test: (c, i) => { const k = c[i], b = Math.abs(k.c - k.o), uw = k.h - Math.max(k.o, k.c), lw = Math.min(k.o, k.c) - k.l; return b > 0 && uw >= 2 * b && lw <= 0.5 * b; } },
  { id: 'hammer', name: 'Hammer', dir: 1, test: (c, i) => { const k = c[i], b = Math.abs(k.c - k.o), uw = k.h - Math.max(k.o, k.c), lw = Math.min(k.o, k.c) - k.l; return b > 0 && lw >= 2 * b && uw <= 0.5 * b; } },
  { id: 'bbHi', name: 'Closed above upper Bollinger band', dir: -1, test: (c, i, x) => c[i].c > x.bbU[i] },
  { id: 'bbLo', name: 'Closed below lower Bollinger band', dir: 1, test: (c, i, x) => c[i].c < x.bbL[i] },
  { id: 'rsiHi', name: 'RSI rose to 75 or higher', dir: -1, test: (c, i, x) => x.rsi[i] != null && x.rsi[i - 1] != null && x.rsi[i] >= 75 && x.rsi[i - 1] < 75 },
  { id: 'rsiLo', name: 'RSI fell to 25 or lower', dir: 1, test: (c, i, x) => x.rsi[i] != null && x.rsi[i - 1] != null && x.rsi[i] <= 25 && x.rsi[i - 1] > 25 }
];
const testPat = (p, c, i, x) => { try { return !!p.test(c, i, x); } catch (e) { return false; } };
function backtest(cs) {
  const ind = indArrays(cs), H = 5, res = {}; let up = 0, tot = 0;
  PATS.forEach(p => { res[p.id] = { n: 0, w: 0 }; });
  for (let i = 30; i < cs.length - H; i++) {
    const mv = cs[i + H].c - cs[i].c; if (mv === 0) continue; tot++; if (mv > 0) up++;
    PATS.forEach(p => { if (testPat(p, cs, i, ind)) { const r = res[p.id]; r.n++; if ((mv > 0 ? 1 : -1) === p.dir) r.w++; } });
  }
  return { res, base: tot ? up / tot : 0.5, n: tot };
}
/* Patterns only count if they beat BOTH a coin flip and the base rate by >= 5 points,
   on >= 50 samples, and the edge is > 2 standard errors. Near-50% patterns get weight 0. */
function patWeight(p) {
  const r = S.bt && S.bt.res[p.id]; if (!r || r.n < 50) return 0;
  const hit = r.w / r.n, base = p.dir > 0 ? S.bt.base : 1 - S.bt.base, edge = Math.min(hit - base, hit - 0.5), se = Math.sqrt(0.25 / r.n);
  return (edge >= 0.05 && edge >= 2 * se) ? clamp(edge / 0.10, 0, 1) : 0;
}
const closedCandles = now => Array.from(S.candles.values()).sort((a, b) => a.t - b.t).filter(c => c.t + 60000 <= now);
function runBacktest() { const cs = closedCandles(Date.now()); if (cs.length > 200) S.bt = backtest(cs); }

/* ---------- trades ---------- */
function addTrades(arr) {
  const cut = Date.now() - 15 * 60000;
  arr.forEach(x => { const key = x.ex + x.id; if (S.seen.has(key) || x.t < cut || !isFinite(x.btc) || !isFinite(x.px)) return; S.seen.add(key); x.usd = x.btc * x.px; S.trades.push(x); });
  S.trades.sort((a, b) => a.t - b.t);
  while (S.trades.length && S.trades[0].t < cut) S.trades.shift();
  if (S.seen.size > 20000) S.seen = new Set(S.trades.map(t => t.ex + t.id));
}
function clusterTrades(ts) {
  const out = [], open = new Map();
  ts.forEach(x => {
    const k = x.ex + '|' + x.side, c = open.get(k);
    if (c && x.t - c.last <= 1500) { c.btc += x.btc; c.usd += x.usd; c.last = x.t; c.n++; }
    else { const nc = { t: x.t, last: x.t, ex: x.ex, side: x.side, btc: x.btc, usd: x.usd, px: x.px, n: 1 }; out.push(nc); open.set(k, nc); }
  });
  return out;
}
function windowFlow(now, ms) { let b = 0, s = 0; S.trades.forEach(t => { if (now - t.t <= ms) { if (t.side === 'buy') b += t.usd; else s += t.usd; } }); const tot = b + s; return { b, s, tot, buyPct: tot > 0 ? b / tot * 100 : null }; }
function whaleNet(now, ms, thr) { let net = 0, nb = 0, ns = 0, bu = 0, su = 0; S.clusters.forEach(c => { if (now - c.t <= ms && c.usd >= thr) { if (c.side === 'buy') { net += c.usd; nb++; bu += c.usd; } else { net -= c.usd; ns++; su += c.usd; } } }); return { net, nb, ns, bu, su }; }
function liqWin(now, ms) { let l = 0, s = 0, n = 0; S.liq.forEach(x => { if (now - x.t <= ms) { n++; if (x.side === 'long') l += x.usd; else s += x.usd; } }); return { l, s, n }; }
/* live feeds, dropping any single feed more than 0.3% away from the median (bad print / frozen feed) */
const liveFeeds = now => {
  const raw = Object.keys(S.prices).filter(k => S.prices[k] && now - S.prices[k].t < FEED_STALE_MS).map(k => ({ k, p: S.prices[k].p }));
  if (raw.length < 3) return raw;
  const m = median(raw.map(f => f.p)); return raw.filter(f => Math.abs(f.p / m - 1) < 0.003);
};
/* per-feed health: ok / stale / no data / error text */
function feedHealth(now) {
  const o = {};
  Object.keys(FEEDS).forEach(k => {
    const p = S.prices[k];
    if (p && now - p.t < FEED_STALE_MS) o[k] = 'ok';
    else if (p) o[k] = 'stale ' + Math.round((now - p.t) / 1000) + 's' + (S.feedErr[k] ? ' (' + S.feedErr[k] + ')' : '');
    else o[k] = 'no data' + (S.feedErr[k] ? ' (' + S.feedErr[k] + ')' : '');
  });
  return o;
}

/* ---------- checks and analysis ---------- */
function checksFor(sgn, c) {
  const out = [], side = sgn > 0 ? 'above' : 'below';
  out.push({ id: 'gap', label: 'Gap beats the expected move', ok: c.z != null && sgn * c.z >= 0.8, detail: c.z == null ? 'no line' : fmtN(Math.abs(c.z), 1) + ' sigma, needs 0.8' });
  const on = c.live.filter(f => c.line != null && sgn * (f.p - c.line) > 0).length;
  out.push({ id: 'exch', label: 'Exchanges agree', ok: c.live.length >= 2 && on === c.live.length, detail: on + ' of ' + c.live.length + ' feeds ' + side + ' the line' });
  const fb = c.f60.buyPct, f5 = c.f300.buyPct;
  out.push({ id: 'flow', label: 'Buy/sell flow agrees', ok: fb != null && sgn * (fb - 50) >= 5 && (f5 == null || sgn * (f5 - 50) >= 0), detail: fb == null ? 'no fills' : '60s ' + Math.round(fb) + '% buy' });
  out.push({ id: 'whale', label: 'Whales not against', ok: sgn * c.w300.net > -c.thr, detail: 'net whale flow 5m ' + (c.w300.net >= 0 ? '+' : '-') + usdK(c.w300.net) });
  out.push({ id: 'trend', label: 'Trend agrees', ok: c.ema9 != null && sgn * (c.ema9 - c.ema21) > 0, detail: c.ema9 == null ? 'not enough candles' : 'EMA 9 ' + (c.ema9 > c.ema21 ? 'above' : 'below') + ' EMA 21' });
  const rok = c.rsi1 == null ? true : (sgn > 0 ? (c.rsi1 < 75 && (c.rsi5 == null || c.rsi5 < 80)) : (c.rsi1 > 25 && (c.rsi5 == null || c.rsi5 > 20)));
  out.push({ id: 'rsi', label: 'RSI not stretched against it', ok: rok, detail: 'RSI 1m ' + (c.rsi1 == null ? '--' : c.rsi1.toFixed(0)) });
  /* Worth the price: blended probability minus (ask + Kalshi fee) must clear MIN_EDGE */
  const kpS = sgn > 0 ? c.kpYes : c.kpNo;
  if (kpS != null && c.probUp != null) {
    const ps = sgn > 0 ? c.probUp : 1 - c.probUp, ask = kpS / 100, edge = ps - ask - kalshiFee(ask);
    out.push({ id: 'price', label: 'Worth the price', ok: edge >= CFG.minEdge, edge, detail: 'blended ' + Math.round(ps * 100) + '% vs ' + Math.round(kpS) + 'c + ' + Math.round(kalshiFee(ask) * 100) + 'c fee = edge ' + (edge >= 0 ? '+' : '') + Math.round(edge * 100) + 'c, needs ' + Math.round(CFG.minEdge * 100) + 'c' });
  }
  else out.push({ id: 'price', label: 'Worth the price', ok: true, na: true, detail: 'no Kalshi price' });
  return out;
}

function analyze(now) {
  const live = liveFeeds(now), price = live.length ? mean(live.map(f => f.p)) : null, thr = CFG.whale;
  const left = Math.max(0, (R.end - now) / 1000), line = R.line;
  const recent = Array.from(S.candles.values()).sort((a, b) => a.t - b.t).slice(-320), n = recent.length;
  const ind = n > 25 ? indArrays(recent) : null;
  const rsi1 = ind ? ind.rsi[n - 1] : null;
  const g5 = new Map();
  recent.forEach(c => { const k = Math.floor(c.t / 300000) * 300000, g = g5.get(k); if (!g) g5.set(k, { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }); else { g.h = Math.max(g.h, c.h); g.l = Math.min(g.l, c.l); g.c = c.c; g.v += c.v; } });
  const c5 = Array.from(g5.values()), r5 = c5.length > 16 ? rsiSeries(c5.map(c => c.c), 14) : [], rsi5 = r5.length ? r5[r5.length - 1] : null;
  const ema9 = ind ? emaSeries(ind.closes, 9)[n - 1] : null, ema21 = ind ? emaSeries(ind.closes, 21)[n - 1] : null;
  const closed = recent.filter(c => c.t + 60000 <= now);
  /* Realized vol: blend a fast (30 min) and slow (2 h) estimate so one quiet half hour does not
     make the model overconfident, then fatten it by VOL_MULT for BTC's fat tails. */
  const retsOf = k => { const r = []; for (let i = Math.max(1, closed.length - k); i < closed.length; i++) r.push(Math.log(closed[i].c / closed[i - 1].c)); return r; };
  const sFast = sd(retsOf(30)), sSlow = sd(retsOf(120));
  let sig = sFast != null && sSlow != null ? Math.sqrt(0.5 * sFast * sFast + 0.5 * sSlow * sSlow) : (sFast || sSlow);
  if (sig == null || !isFinite(sig)) sig = 0.0004; sig = Math.max(sig, 0.00012) * CFG.volMult;
  const minsLeft = Math.max(left / 60, 0.35), px = price != null ? price : (n ? recent[n - 1].c : null);
  const sigUsd = px ? px * sig * Math.sqrt(minsLeft) : null;
  const gap = (price != null && line != null) ? price - line : null;
  /* lognormal distance to the line */
  const z = (price != null && line != null && px) ? Math.log(price / line) / (sig * Math.sqrt(minsLeft)) : null;
  S.clusters = clusterTrades(S.trades);
  const f60 = windowFlow(now, 60000), f300 = windowFlow(now, 300000);
  const w90 = whaleNet(now, 90000, thr), w120 = whaleNet(now, 120000, thr), w300 = whaleNet(now, 300000, thr);
  const l5 = liqWin(now, 300000);
  const firing = [];
  if (closed.length > 35) {
    const cind = indArrays(closed), last = closed.length - 1;
    for (let ii = Math.max(30, last - 1); ii <= last; ii++) PATS.forEach(p => { if (testPat(p, closed, ii, cind) && firing.indexOf(p) < 0) firing.push(p); });
  }
  const patC = clamp(firing.reduce((s, p) => s + p.dir * patWeight(p), 0), -1, 1);
  const flowC = f60.buyPct == null ? 0 : 0.6 * clamp((f60.buyPct - 50) / 25, -1, 1) + 0.4 * (f300.buyPct == null ? 0 : clamp((f300.buyPct - 50) / 25, -1, 1));
  const whaleC = Math.tanh((w120.net + 0.5 * w300.net) / (2 * thr));
  const bookC = S.book ? clamp(S.book.imb * 2, -1, 1) : 0;
  const trendC = (ema9 != null && px) ? Math.tanh((ema9 - ema21) / (px * sig * 1.5)) : 0;
  const rsiC = rsi1 == null ? 0 : (rsi1 >= 70 ? -clamp((rsi1 - 70) / 20, 0, 1) : rsi1 <= 30 ? clamp((30 - rsi1) / 20, 0, 1) : 0);
  const liqC = Math.tanh((l5.s - l5.l) / 500000);
  const tilt = 0.20 * flowC + 0.20 * whaleC + 0.10 * bookC + 0.15 * trendC + 0.10 * rsiC + 0.10 * liqC + 0.15 * patC;
  const K = (S.kalshi && Math.abs(S.kalshi.close - R.end) < 5000 && now - S.kalshi.t < 15000) ? S.kalshi : null;
  const kpYes = K && K.yesAsk != null ? K.yesAsk * 100 : null, kpNo = K && K.noAsk != null ? K.noAsk * 100 : null;
  /* market's implied P(up): midpoint of yes ask and (1 - no ask), i.e. the yes bid/ask mid */
  const mktUp = K && K.yesAsk != null && K.noAsk != null ? clamp((K.yesAsk + (1 - K.noAsk)) / 2, 0.01, 0.99) : (K && K.yesAsk != null ? K.yesAsk : null);
  const zAdj = z != null ? z + CFG.tiltW * tilt : null, rawUp = zAdj != null ? clamp(Phi(zAdj), 0.01, 0.99) : null;
  /* shrink toward the market: the crowd at Kalshi is usually closer to right than a single model */
  const probUp = rawUp == null ? null : (mktUp == null ? rawUp : CFG.shrink * rawUp + (1 - CFG.shrink) * mktUp);
  const side = probUp == null ? null : (probUp >= 0.5 ? 'UP' : 'DOWN'), sgn = side === 'UP' ? 1 : -1;
  const probSide = probUp == null ? null : Math.max(probUp, 1 - probUp), strength = probUp == null ? 0 : Math.round(Math.abs(probUp - 0.5) * 200);
  const ctx = { z, line, live, f60, f300, w300, thr, ema9, ema21, rsi1, rsi5, kpYes, kpNo, probUp };
  const checks = side ? checksFor(sgn, ctx) : [];
  const counted = checks.filter(c => !c.na), passN = counted.filter(c => c.ok).length, missing = counted.filter(c => !c.ok).map(c => c.label);
  const aligned = side ? sgn * tilt >= 0.1 : false;
  const priceChk = checks.find(c => c.id === 'price'), edge = priceChk && !priceChk.na ? priceChk.edge : null;
  const askSide = side ? (sgn > 0 ? kpYes : kpNo) : null;
  /* TAKE needs a real Kalshi price now: no price = no way to know there is an edge. One check may fail (6 of 7). */
  const verdict = !side ? 'SKIP' : (counted.length && passN >= counted.length - 1 && aligned && edge != null ? 'TAKE' : (passN >= counted.length - 1 || strength >= 40 ? 'WAIT' : 'SKIP'));
  const stake = (CFG.bankroll > 0 && askSide != null && probSide != null) ? CFG.bankroll * kelly(probSide, askSide / 100 + kalshiFee(askSide / 100)) : null;
  const surgeSgn = w90.net >= 2 * thr ? 1 : (w90.net <= -2 * thr ? -1 : 0);
  let surge = false;
  if (surgeSgn > 0) surge = w90.nb >= 2 || w90.net >= 4 * thr;
  if (surgeSgn < 0) surge = w90.ns >= 2 || -w90.net >= 4 * thr;
  let whaleOk = false;
  if (surge && gap != null) {
    const by = {}; checksFor(surgeSgn, ctx).forEach(c => { by[c.id] = c; });
    whaleOk = surgeSgn * gap > 0 && by.exch.ok && by.rsi.ok && (f60.buyPct == null || surgeSgn * (f60.buyPct - 50) >= -5);
  }
  return { now, live, price, left, line, rsi1, rsi5, ema9, ema21, sigUsd, gap, z, f60, f300, w90, w300, firing, tilt, kpYes, kpNo, K, mktUp, rawUp, probUp, side, sgn, probSide, strength, checks, passN, total: counted.length, missing, verdict, edge, askSide, stake, surge, surgeSgn, whaleOk };
}

/* ---------- push (ntfy JSON publish so we can add a click link and buttons) ---------- */
const PRI = { min: 1, low: 2, default: 3, high: 4, urgent: 5, max: 5 };
async function push(title, body, priority, tags, extra) {
  if (!CFG.topic) { console.log('[push skipped, no NTFY_TOPIC]', title, '|', body); return false; }
  const msg = { topic: CFG.topic, title, message: body, priority: PRI[priority] || 3, tags: tags ? String(tags).split(',').filter(Boolean) : [] };
  if (extra && extra.click) msg.click = extra.click;
  if (extra && extra.actions) msg.actions = extra.actions;
  try {
    const r = await fetch(CFG.ntfy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.log('ntfy HTTP', r.status);
    return r.ok;
  } catch (e) { console.log('ntfy error', e.message); return false; }
}
const pageUrl = () => (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const kalshiActions = () => {
  const a = [{ action: 'view', label: 'Open Kalshi', url: CFG.kalshiUrl, clear: true }];
  if (pageUrl()) a.push({ action: 'view', label: 'Scoreboard', url: pageUrl() + '/' });
  return a;
};

/* ---------- round logic ---------- */
function finalize() {
  if (R.line == null) return;
  const pts = S.hist.filter(h => h.t >= R.end - 60000 && h.t <= R.end + 2000).map(h => h.p);
  const fin = pts.length ? mean(pts) : (S.hist.length ? S.hist[S.hist.length - 1].p : null);
  const d = fin == null ? null : fin - R.line;
  const up = d == null || d === 0 ? null : d > 0;
  /* save every round (locked or not) so calibration has data; Kalshi's own result overwrites ours later */
  const rec = { id: R.end, end: R.end, ticker: R.ticker, line: R.line, lineFrom: R.lineFrom, fin, up, source: 'watcher', snap: R.snap, locked: R.locked };
  ROUNDS = ROUNDS.filter(r => r.id !== rec.id); ROUNDS.push(rec); if (ROUNDS.length > 20000) ROUNDS = ROUNDS.slice(-20000); saveRounds(); savePaper();
  if (R.ticker) S.pend.push({ id: rec.id, ticker: R.ticker, tries: 0 });
  if (!R.locked || fin == null) return;
  const res = d === 0 ? 'push' : (((d > 0) === (R.locked.side === 'UP')) ? 'won' : 'lost');
  RECENT.unshift({ end: R.end, side: R.locked.side, reason: R.locked.reason, line: R.line, fin, res }); RECENT = RECENT.slice(0, 30);
  if (CFG.results) push('Result: ' + (R.locked.decision === 'TAKE' ? 'TAKE ' : 'LEAN ') + R.locked.side + ' ' + res.toUpperCase(), 'Round ending ' + etTime(R.end) + ' ET. Line ' + usd(R.line) + ', final ' + usd(fin) + ' (' + (d >= 0 ? '+' : '-') + usd(Math.abs(d)) + '). Watcher estimate; Kalshi settles on the CF Benchmarks index and may differ. Use Edit on the page if it is wrong.' + (R.locked.decision === 'TAKE' ? '\n' + paperLine() : ''), 'low', res === 'won' ? 'white_check_mark' : 'x', pageUrl() ? { click: pageUrl() + '/' } : null);
}
function rollRound(now) { while (now >= R.end) { finalize(); newRound(R.end + ROUND_MS * Math.max(1, Math.floor((now - R.end) / ROUND_MS))); } }
function applyAutoLine(A, now) {
  const K = S.kalshi;
  if (K && Math.abs(K.close - R.end) < 5000) R.ticker = K.ticker;
  if (K && K.strike != null && Math.abs(K.close - R.end) < 5000 && now - K.t < 30000) { R.line = K.strike; R.lineFrom = 'kalshi'; return; }
  const c = S.candles.get(R.start);
  if (c) { R.line = c.o; R.lineFrom = 'candle'; } else if (R.line == null && A.price != null && now - R.start < 30000) { R.line = A.price; R.lineFrom = 'price'; }
}
/* ---------- loss learning: learn from TAKE losses, then downgrade bad segments ---------- */
/* A segment only becomes a rule when it has lost enough, on enough trades, to trust:
   at least 12 TAKEs, at least 4 losses, and a win rate at least 10 points below
   its breakeven win rate (mean ask). This stops one bad day from banning a good setup. */
function lockLogic(A, now) {
  if (R.locked || A.price == null || R.line == null || !A.side) { persist = 0; lastCand = null; return; }
  const inWin = A.left <= 720 && A.left >= 45; let cand = null;
  if (inWin && A.verdict === 'TAKE') cand = { side: A.side, reason: 'All signs aligned' };
  else if (inWin && A.whaleOk) cand = { side: A.surgeSgn > 0 ? 'UP' : 'DOWN', reason: 'Whale surge ' + (A.surgeSgn > 0 ? 'buying ' : 'selling ') + usdK(Math.abs(A.w90.net)) + ' in 90s' };
  if (cand && cand.side === lastCand) persist++; else persist = cand ? 1 : 0;
  lastCand = cand ? cand.side : null;
  if (cand && persist >= 4) {
    const sg = cand.side === 'UP' ? 1 : -1, pr = A.probUp == null ? null : (sg > 0 ? A.probUp : 1 - A.probUp), askC = sg > 0 ? A.kpYes : A.kpNo;
    const ask = askC == null ? null : askC / 100, fee = kalshiFee(ask), edge = (pr != null && ask != null) ? pr - ask - fee : null;
    /* a whale lock only counts as TAKE if the price still leaves an edge */
    let decision = edge != null && edge >= CFG.minEdge && (cand.reason === 'All signs aligned' || A.checks.every(c => c.id !== 'price' || c.ok)) ? 'TAKE' : 'LEAN';
    const stake = (CFG.bankroll > 0 && decision === 'TAKE') ? CFG.bankroll * kelly(pr, ask + fee) : null;
    const passN = A.passN, total = A.total;
    let paperRec = null;
    if (decision === 'TAKE') { const bal = paper().balance, z = paperSize(bal, pr, ask); paperRec = { balance: bal, contracts: z.n, cost: +(z.n * ask).toFixed(2), fee: orderFee(z.n, ask), sizing: z.mode }; }
    R.locked = { side: cand.side, t: now, px: A.price, gap: A.gap, prob: pr, rawProb: A.rawUp == null ? null : (sg > 0 ? A.rawUp : 1 - A.rawUp), ask, fee, edge, decision, stake, passN, total, reason: cand.reason, left: A.left, paper: paperRec };
    const body = usd(A.price) + ' vs line ' + usd(R.line) + ' (' + (A.gap >= 0 ? '+' : '-') + usd(Math.abs(A.gap)) + ')\n' +
      'Model ' + pct(pr) + (ask != null ? ' vs ask ' + cents(ask) + ' + ' + cents(fee) + ' fee' : ' (no Kalshi price)') + (edge != null ? ' -> edge ' + (edge >= 0 ? '+' : '') + Math.round(edge * 100) + 'c' : '') + '\n' +
      'Checks ' + passN + '/' + total + ' passed. ' + cand.reason + '. ' + mmss(A.left) + ' left.' + (stake ? '\nQuarter-Kelly stake: ' + usd(stake, 0) : '');
    console.log('LOCK', decision, cand.side, body.replace(/\n/g, ' | '));
    push((decision === 'TAKE' ? 'TAKE ' : 'LEAN ') + cand.side + ' - BTC 15m' + (ask != null ? ' @ ' + cents(ask) : ''), body,
      decision === 'TAKE' ? 'urgent' : 'high', cand.side === 'UP' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend',
      { click: CFG.kalshiUrl, actions: kalshiActions() });
  }
}
function whaleHeadsUp(A, now) {
  if (!CFG.whaleAlerts || R.locked || R.surgeNotified || !A.surge || A.left < 45 || A.left > 720) return;
  R.surgeNotified = true;
  push('Whale surge ' + (A.surgeSgn > 0 ? 'buying' : 'selling'), usdK(Math.abs(A.w90.net)) + ' net in 90s. Price ' + usd(A.price) + (R.line != null ? ' vs line ' + usd(R.line) : '') + '. No call yet: ' + (A.whaleOk ? 'waiting to hold 4s' : 'line side, exchanges or RSI do not agree') + '.', 'default', 'whale');
}
/* snapshot at 4 min left: this is what calibration is measured on, for every round */
function leanLogic(A, now) {
  if (!R.lean && A.left <= 240 && A.left >= 150 && A.price != null && R.line != null && A.side) {
    R.lean = { side: A.side, verdict: A.verdict };
    R.snap = { t: now, left: Math.round(A.left), probUp: A.probUp, rawUp: A.rawUp, mktUp: A.mktUp, side: A.side, verdict: A.verdict, edge: A.edge, ask: A.askSide == null ? null : A.askSide / 100, passN: A.passN, total: A.total, z: A.z };
  }
}

/* ---------- feed-down alerts + heartbeat ---------- */
function feedWatch(now) {
  if (now - BOOT < 60000) return; /* give feeds a minute to come up */
  Object.keys(FEEDS).forEach(k => {
    const p = S.prices[k], up = p && now - p.t < FEED_STALE_MS;
    if (up) {
      if (S.feedAlerted[k] && CFG.feedAlerts) push('Feed back: ' + FEEDS[k].name, FEEDS[k].name + ' prices are flowing again.', 'low', 'white_check_mark');
      S.feedDownSince[k] = null; S.feedAlerted[k] = false; return;
    }
    if (!S.feedDownSince[k]) S.feedDownSince[k] = now;
    if (!S.feedAlerted[k] && now - S.feedDownSince[k] >= FEED_DOWN_ALERT_MS) {
      S.feedAlerted[k] = true;
      if (CFG.feedAlerts) push('Feed down: ' + FEEDS[k].name, FEEDS[k].name + ' has had no fresh price for ' + Math.round((now - S.feedDownSince[k]) / 1000) + 's' + (S.feedErr[k] ? ' (' + S.feedErr[k] + ')' : '') + '. ' + liveFeeds(now).length + ' feeds still live.', liveFeeds(now).length < 2 ? 'high' : 'low', 'warning');
    }
  });
}
function heartbeat() {
  const now = Date.now(), st = stats(), live = liveFeeds(now).length;
  push('Line Lock alive', 'Up ' + Math.round((now - BOOT) / 3600000) + 'h. ' + live + '/' + Object.keys(FEEDS).length + ' feeds live. Price ' + usd(STATUS.price) + '. All calls ' + st.all.w + '-' + st.all.l + ', TAKE ' + st.take.w + '-' + st.take.l + ' (' + (st.take.pnl >= 0 ? '+' : '-') + usd(Math.abs(st.take.pnl)) + '/contract). ' + ROUNDS.length + ' rounds logged. ' + paperLine() + '.', 'min', 'heartbeat');
}

/* ---------- Kalshi settlement check: replace our estimate with the official result ---------- */
function pollSettle() {
  if (!S.pend.length) return;
  const p = S.pend[0];
  quiet(getJSON('https://api.elections.kalshi.com/trade-api/v2/markets/' + encodeURIComponent(p.ticker)).then(j => {
    const m = j.market || {}, res = m.result;
    if (res === 'yes' || res === 'no') {
      const r = ROUNDS.find(x => x.id === p.id);
      if (r) { const was = r.up; r.up = res === 'yes'; r.source = 'kalshi'; if (was != null && was !== r.up) { r.mismatch = true; console.log('Kalshi result differs from watcher estimate for', p.ticker); } saveRounds(); savePaper(); }
      S.pend.shift(); return;
    }
    throw new Error('not settled');
  }).catch(() => { p.tries++; S.pend.shift(); if (p.tries < 30) S.pend.push(p); }));
}

function tick() {
  const now = Date.now();
  rollRound(now);
  const pre = liveFeeds(now); if (pre.length) S.hist.push({ t: now, p: mean(pre.map(f => f.p)) });
  while (S.hist.length && S.hist[0].t < now - 20 * 60000) S.hist.shift();
  let A = analyze(now); applyAutoLine(A, now); if (R.line !== A.line) A = analyze(now);
  lockLogic(A, now); leanLogic(A, now); whaleHeadsUp(A, now); feedWatch(now);
  S.liq = S.liq.filter(x => now - x.t <= 3600000);
  const fh = feedHealth(now);
  LASTA = A;
  const di = computeDisplayIndicators(closedCandles(now)); // display only: never feeds analyze/lock/paper
  const ccs = closedCandles(now);
  const fv = computeFvgState(ccs, A.price); // display only: re-evaluated every tick (1s)
  const zn = computeZoneState(ccs, A.price); // display only: same cadence as FVG
  const tf = computeTakerFlow(now); // display only
  const ot = summarizeOddsTrail(oddsTrailPts, oddsTrailTicker); // display only
  const gr = gradeFor(A.passN, A.total); // display only: derived from the checks analyze() already counted
  const dtl = distToLine(A.price, R.line); // display only
  const gg = marketGauge(A.mktUp); // display only
  const lq = computeLiquidityMap(ccs, A.price); // display only
  const ob = computeOrderBlocks(ccs, A.price); // display only
  const sn = computeSession(now); // display only
  const rk = computeRiskLine(dtl, A.left, ccs); // display only
  recordTfTick(now, A.price); // display only: sub-minute buckets for timeframe confirmation
  const tfc = computeTfConfirm(ccs, tfSubBuckets); // display only: never feeds analyze/lock/paper
  STATUS = {
    time: new Date(now).toISOString(), left: mmss(A.left), feeds: A.live.length, feedHealth: fh, price: A.price, line: R.line, lineFrom: R.lineFrom,
    side: A.side, strength: A.strength, prob: A.probSide == null ? null : Math.round(A.probSide * 100),
    rawProbUp: A.rawUp == null ? null : Math.round(A.rawUp * 100), marketProbUp: A.mktUp == null ? null : Math.round(A.mktUp * 100),
    edgeCents: A.edge == null ? null : Math.round(A.edge * 100), stake: A.stake, verdict: A.verdict,
    checks: A.checks.map(c => (c.na ? '-' : c.ok ? 'pass' : 'FAIL') + ' ' + c.label + ' (' + c.detail + ')'),
    whaleNet5m: Math.round(A.w300.net), surge: A.surge, rsi1: A.rsi1 == null ? null : +A.rsi1.toFixed(1), rsi5: A.rsi5 == null ? null : +A.rsi5.toFixed(1),
    locked: R.locked ? { side: R.locked.side, decision: R.locked.decision, at: new Date(R.locked.t).toISOString(), reason: R.locked.reason, edge: R.locked.edge } : null,
    okx: (S.okx && now - S.okx.t < 120000) ? { fundingRate: S.okx.fundingRate, oiUsd: S.okx.oiUsd, t: S.okx.t } : null,
    events: { today: eventsToday(now), next: nextEvent(now) },
    macd: di.macd, reversion: di.reversion,
    oddsTrail: ot, takerFlow: tf, grade: gr, distToLine: dtl, gauge: gg, fvg: fv, zones: zn, tfConfirm: tfc,
    liquidity: lq, orderBlocks: ob, session: sn, risk: rk,
    kalshi: A.K ? { ticker: A.K.ticker, yesAsk: A.K.yesAsk, noAsk: A.K.noAsk } : null, polyUs: (S.polyUs && S.polyUs.t && now - S.polyUs.t < 60000 && S.polyUs.ask != null) ? { ask: S.polyUs.ask, bid: S.polyUs.bid, slug: S.polyUs.slug } : null, diag: S.diag, topicSet: !!CFG.topic, roundsLogged: ROUNDS.length
  };
  tfFireAlerts(tfc, A.price); // display only: one-shot lock-in alerts, deduped; never affects decisions
  return A;
}

/* ---------- data pollers ---------- */
/* diag is keyed by a label (feed name or endpoint), not hostname, so one good call to a host
   no longer hides a broken call to the same host. */
async function getJSON(url, ms, label) {
  let key = label; if (!key) { try { key = new URL(url).hostname; } catch (e) { key = url; } }
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms || 6000) });
    if (!r.ok) { S.diag[key] = 'HTTP ' + r.status; throw new Error('HTTP ' + r.status); }
    const j = await r.json(); S.diag[key] = 'ok'; return j;
  } catch (e) { if (!S.diag[key] || S.diag[key] === 'ok') S.diag[key] = e.name === 'TimeoutError' ? 'timed out' : (e.message || 'error').slice(0, 60); throw e; }
}
const quiet = p => p.catch(() => { });
function pollPrices() {
  Object.keys(FEEDS).forEach(k => quiet(getJSON(FEEDS[k].url, 6000, 'price:' + k).then(j => {
    let p; try { p = FEEDS[k].parse(j); } catch (e) { p = NaN; }
    if (isFinite(p) && p > 0) { S.prices[k] = { p, t: Date.now() }; S.feedErr[k] = null; }
    else { S.feedErr[k] = 'bad response'; S.diag['price:' + k] = 'bad response: ' + JSON.stringify(j).slice(0, 60); }
  }).catch(e => { S.feedErr[k] = e.name === 'TimeoutError' ? 'timed out' : e.message; })));
}
function pollTrades() {
  quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=100', 6000, 'trades:coinbase').then(j => addTrades(j.map(x => ({ id: x.trade_id, t: Date.parse(x.time), ex: 'coinbase', side: x.side === 'buy' ? 'sell' : 'buy', btc: +x.size, px: +x.price })))));
  quiet(getJSON('https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=100', 6000, 'trades:kraken').then(j => { const k = Object.keys(j.result).filter(x => x !== 'last')[0]; addTrades(j.result[k].map(x => ({ id: x[6] || (x[2] + '-' + x[1]), t: Math.round(x[2] * 1000), ex: 'kraken', side: x[3] === 'b' ? 'buy' : 'sell', btc: +x[1], px: +x[0] }))); }));
  quiet(getJSON('https://api.gemini.com/v1/trades/btcusd?limit_trades=100', 6000, 'trades:gemini').then(j => addTrades(j.map(x => ({ id: x.tid, t: x.timestampms, ex: 'gemini', side: x.type === 'buy' ? 'buy' : 'sell', btc: +x.amount, px: +x.price })))));
}
function makeBook(bids, asks) {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2, lo = mid * (1 - 0.0015), hi = mid * (1 + 0.0015); let bu = 0, au = 0;
  bids.forEach(l => { if (l[0] >= lo) bu += l[0] * l[1]; }); asks.forEach(l => { if (l[0] <= hi) au += l[0] * l[1]; });
  return { mid, bu, au, imb: (bu + au) > 0 ? (bu - au) / (bu + au) : 0 };
}
function pollBook() { quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', 6000, 'book:coinbase').then(j => { S.book = makeBook(j.bids.map(x => [+x[0], +x[1]]), j.asks.map(x => [+x[0], +x[1]])); })); }
function putCandles(j) { j.forEach(x => { const t = x[0] * 1000; S.candles.set(t, { t, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] }); }); }
function pollCandles() { quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60', 6000, 'candles:coinbase').then(putCandles)); }
function pollKalshi() {
  quiet(getJSON('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + encodeURIComponent(CFG.series) + '&status=open&limit=20', 6000, 'kalshi').then(j => {
    const now = Date.now(), ms = (j.markets || []).map(m => ({ m, close: Date.parse(m.close_time) })).filter(x => x.close > now - 1000).sort((a, b) => a.close - b.close);
    if (!ms.length) return;
    const x = ms[0], m = x.m, d = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const px = (dol, cents) => { const a = d(dol); if (a != null) return a; const b = d(cents); return b != null ? b / 100 : null; };
    /* 0 or 1 dollar asks mean "no offer", not a real price */
    const real = v => (v != null && v > 0 && v < 1) ? v : null;
    S.kalshi = { t: Date.now(), ticker: m.ticker, close: x.close, strike: d(m.floor_strike), yesAsk: real(px(m.yes_ask_dollars, m.yes_ask)), noAsk: real(px(m.no_ask_dollars, m.no_ask)) };
    recordOddsTick(S.kalshi); // display only: odds trail for the current window
  }));
}
/* OKX funding + open interest, display only. Failures keep the last good value
   and back off 30s; the poller never throws and never blocks tick(). */
let okxBackoffUntil = 0;
async function pollOkx() {
  if (Date.now() < okxBackoffUntil) return;
  try {
    const fj = await getJSON('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP', 10000, 'okx:funding');
    const oj = await getJSON('https://www.okx.com/api/v5/public/open-interest?instId=BTC-USDT-SWAP', 10000, 'okx:oi');
    const fr = parseOkxFunding(fj), oi = parseOkxOi(oj);
    if (fr == null || oi == null) throw new Error('bad OKX response');
    S.okx = { fundingRate: fr, oiUsd: oi, t: Date.now() };
  } catch (e) { okxBackoffUntil = Date.now() + 30000; }
}
/* ---------- Polymarket US price (display only) ---------- */
/* Shows the Polymarket US 15m BTC up/down top of book next to Kalshi's price.
   Read-only display: it never feeds the model, the edge math, or paper trading.
   Polled every 10s (the gateway rate-limits fast polling); failures keep the
   last good value and back off 30s. */
function polyUsSlug(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return 'cpc-btc-updown-15m-' + d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + 'z';
}
function pollPolyUs() {
  const now = Date.now();
  if (S.polyUs && S.polyUs.nextTry && now < S.polyUs.nextTry) return;
  const t0 = (R && R.start) ? R.start : Math.floor(now / ROUND_MS) * ROUND_MS;
  const slug = polyUsSlug(t0);
  getJSON('https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/bbo', 6000, 'polyus').then(j => {
    const md = j && j.marketData; if (!md) throw new Error('no marketData');
    const num = o => { const v = o && parseFloat(o.value); return isFinite(v) ? v : null; };
    S.polyUs = { t: Date.now(), slug, bid: num(md.bestBid), ask: num(md.bestAsk), mid: num(md.currentPx) };
  }).catch(() => {
    const prev = S.polyUs || { t: 0, slug, bid: null, ask: null, mid: null };
    prev.nextTry = Date.now() + 30000; S.polyUs = prev;
  });
}
async function loadHistory() {
  for (let k = 0; k < 6; k++) {
    const end = Date.now() - k * 295 * 60000, start = end - 295 * 60000;
    await quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=' + new Date(start).toISOString() + '&end=' + new Date(end).toISOString(), 9000, 'history:coinbase').then(putCandles));
    await new Promise(r => setTimeout(r, 250));
  }
  runBacktest(); console.log('history loaded, candles:', S.candles.size, 'backtest windows:', S.bt ? S.bt.n : 0);
}
function connectLiq() {
  if (typeof WebSocket === 'undefined') return;
  const open = (url, sub, handle) => {
    let ws; try { ws = new WebSocket(url); } catch (e) { return; }
    ws.onopen = () => { if (sub) ws.send(sub); };
    ws.onmessage = m => { try { handle(JSON.parse(m.data)); } catch (e) { } };
    ws.onerror = () => { };
    ws.onclose = () => setTimeout(() => open(url, sub, handle), 15000);
  };
  open('wss://fstream.binance.com/ws/btcusdt@forceOrder', null, j => { const o = j.o; if (!o) return; S.liq.push({ t: Date.now(), side: o.S === 'SELL' ? 'long' : 'short', usd: (+o.z || +o.q) * (+o.ap || +o.p) }); });
  open('wss://stream.bybit.com/v5/public/linear', JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }), j => { if (!j.topic || !j.data) return; (Array.isArray(j.data) ? j.data : [j.data]).forEach(d => S.liq.push({ t: Date.now(), side: d.S === 'Buy' ? 'long' : 'short', usd: (+d.v) * (+d.p) })); });
}

/* ---------- P&L calendar (display only) ----------
   Current month in America/New_York, Monday-first. Each day cell shows that
   day's settled paper P&L + W-L from dailyPnl() — the same replay paper()
   uses. Days with no settled trades show only the day number. */
function calendarHtml(now, daily) {
  const p = etParts.formatToParts(now), g = t => p.find(x => x.type === t).value;
  const y = +g('year'), mo = +g('month');
  const label = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' });
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  const lead = (new Date(etWallToMs(y + '-' + pad(mo) + '-01', 12, 0)).getUTCDay() + 6) % 7;
  const todayKey = etDateKey(now);
  let cells = '';
  ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].forEach(d => { cells += '<div class="calhead">' + d + '</div>'; });
  for (let i = 0; i < lead; i++) cells += '<div></div>';
  for (let d = 1; d <= dim; d++) {
    const k = y + '-' + pad(mo) + '-' + pad(d), rec = daily.get(k);
    const cls = 'calcell' + (rec ? (rec.pnl > 0 ? ' win' : rec.pnl < 0 ? ' loss' : '') : '') + (k === todayKey ? ' today' : '') + (k > todayKey ? ' future' : '');
    cells += '<div class="' + cls + '"><div class="calday">' + d + '</div>' +
      (rec ? '<div class="calpnl" style="color:' + (rec.pnl > 0 ? '#34d399' : rec.pnl < 0 ? '#fb7185' : '#eef1f6') + '">' + (rec.pnl >= 0 ? '+' : '-') + usd(Math.abs(rec.pnl), 0) + '</div><div class="calwl">' + rec.w + 'W &middot; ' + rec.l + 'L</div>' : '') + '</div>';
  }
  const trail = (7 - ((lead + dim) % 7)) % 7;
  for (let i = 0; i < trail; i++) cells += '<div></div>';
  return '<h3>P&amp;L calendar</h3><div class="card"><div style="font-weight:800;margin-bottom:10px">' + esc(label) + ' <span class="muted" style="font-weight:400">&middot; paper P&amp;L by day (ET)</span></div><div class="cal">' + cells + '</div></div>';
}

/* ---------- tiny web server (health check + status page) ---------- */
/* ---------- display-only BTC chart: 1-minute candles + FVG / supply-demand overlays ----------
   Server-rendered inline SVG from candles already in memory. chartCard() (called
   from page() only) recomputes the FVG/zone state from one consistent candle
   snapshot; the page's existing 5s reload refreshes the chart, faster than the
   requested 10s cadence. No client JS, no new feeds, no new timers. Nothing
   outside page() rendering reads this.
   chartSvg(candles, opts): candles = closed 1-minute candles, ascending t
   (the caller passes the last 60); opts = { fvg, zones } open lists from
   computeFvgState/computeZoneState (entries carry dir/low/high/startIdx, where
   startIdx is the origin candle's index in the FULL array the helpers saw),
   baseIndex = index of candles[0] in that full array, line = Kalshi line,
   price = current price. Zone rects run from the origin candle to the right
   edge; rects are capped at the 8 nearest to price. */
/* Chart zoom viewBox math, shared by the page script and the tests: the
   function source is embedded in the page (zoomViewBox.toString()), so the
   shipped client code IS the tested code. Zoom anchors bottom-right, so the
   latest candles stay in view. Levels: 1x, 1.5x, 2x, 3x, 4x. */
function zoomViewBox(level) {
  const W = 680, H = 260, L = (level > 0 && isFinite(level)) ? level : 1;
  const r = v => Math.round(v * 100) / 100;
  const w = W / L, h = H / L;
  return r(W - w) + ' ' + r(H - h) + ' ' + r(w) + ' ' + r(h);
}
function chartSvg(candles, opts) {
  const o = opts || {};
  const cs = (candles || []).filter(c => c && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c) && isFinite(c.t));
  if (cs.length < 10) return '<p class="muted">Chart loading…</p>';
  const W = 680, H = 260, L = 8, R = 56, T = 10, B = 18, PW = W - L - R, PH = H - T - B;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
  const line = isFinite(o.line) ? o.line : null, price = isFinite(o.price) ? o.price : null;
  if (line != null) { lo = Math.min(lo, line); hi = Math.max(hi, line); }
  if (price != null) { lo = Math.min(lo, price); hi = Math.max(hi, price); }
  let range = hi - lo;
  if (!isFinite(range) || range <= 0) { lo -= 1; hi += 1; range = hi - lo; }
  const pad = Math.max(range * 0.04, 0.25);
  lo -= pad; hi += pad; range = hi - lo;
  const y = p => T + (hi - p) / range * PH;
  const r1 = v => Math.round(v * 10) / 10;
  const n = cs.length, slot = PW / n, bw = Math.max(2, slot * 0.6);
  const cx = i => L + i * slot + slot / 2;
  const parts = [];
  parts.push('<svg id="llchart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="BTC 1-minute chart" style="display:block;background:#14161f;border-radius:16px">');
  /* gridlines + price labels */
  for (let k = 0; k < 4; k++) {
    const p = lo + range * (k / 3), gy = r1(y(p));
    parts.push('<line class="gl" x1="' + L + '" y1="' + gy + '" x2="' + (L + PW) + '" y2="' + gy + '" stroke="#262a38" stroke-width="1"/>');
    parts.push('<text x="' + (L + PW + 6) + '" y="' + r1(gy + 3) + '" font-size="10" fill="#9aa3b2">' + fmtN(p, 0) + '</text>');
  }
  /* zone rects: nearest to price first, capped at 8, drawn behind the candles */
  const rects = [];
  const pushZone = (z, kind) => {
    if (!z || !isFinite(z.low) || !isFinite(z.high) || z.high <= z.low) return;
    if (z.high < lo || z.low > hi) return; /* entirely off-chart */
    const d = price == null ? 0 : price > z.high ? price - z.high : price < z.low ? z.low - price : 0;
    rects.push({ kind, dir: z.dir, low: z.low, high: z.high, startIdx: z.startIdx, dist: d });
  };
  (o.fvg || []).forEach(z => pushZone(z, 'fvg'));
  (o.zones || []).forEach(z => pushZone(z, 'zone'));
  rects.sort((a, b) => a.dist - b.dist);
  const base = isFinite(o.baseIndex) ? o.baseIndex : 0;
  for (const z of rects.slice(0, 8)) {
    const x0 = L + Math.max(0, (isFinite(z.startIdx) ? z.startIdx : 0) - base) * slot;
    if (x0 >= L + PW) continue;
    const yT = y(Math.min(z.high, hi)), yB = y(Math.max(z.low, lo));
    const h = Math.max(1, yB - yT);
    const up = z.dir > 0, col = up ? '#34d399' : '#fb7185';
    const isZone = z.kind === 'zone';
    parts.push('<rect class="zn" x="' + r1(x0) + '" y="' + r1(yT) + '" width="' + r1(L + PW - x0) + '" height="' + r1(h) + '" fill="' + col + '" fill-opacity="' + (isZone ? '0.12' : '0.08') + '"' + (isZone ? ' stroke="' + col + '" stroke-width="1" stroke-dasharray="4 3" stroke-opacity="0.55"' : '') + '/>');
    const label = isZone ? (up ? 'DEMAND' : 'SUPPLY') : 'FVG';
    const ly = Math.min(yT + 11, T + PH - 3);
    parts.push('<text x="' + r1(x0 + 4) + '" y="' + r1(ly) + '" font-size="9" font-weight="700" fill="' + col + '" opacity="0.9" style="paint-order:stroke" stroke="#14161f" stroke-width="3">' + label + '</text>');
  }
  /* candles: wick + body */
  for (let i = 0; i < n; i++) {
    const c = cs[i], col = c.c >= c.o ? '#34d399' : '#fb7185', x = cx(i);
    parts.push('<line class="wk" x1="' + r1(x) + '" y1="' + r1(y(c.h)) + '" x2="' + r1(x) + '" y2="' + r1(y(c.l)) + '" stroke="' + col + '" stroke-width="1"/>');
    const yT = y(Math.max(c.o, c.c)), yB = y(Math.min(c.o, c.c));
    parts.push('<rect class="bd" x="' + r1(x - bw / 2) + '" y="' + r1(yT) + '" width="' + r1(bw) + '" height="' + r1(Math.max(1, yB - yT)) + '" fill="' + col + '"/>');
  }
  /* reference lines: Kalshi line (dashed) + current price (dotted). If the two
     lines nearly coincide, the price label drops below its line. */
  const refLine = (val, col, dash, label, below) => {
    const yy = y(val);
    parts.push('<line class="rl" x1="' + L + '" y1="' + r1(yy) + '" x2="' + (L + PW) + '" y2="' + r1(yy) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="' + dash + '"/>');
    const ly = below ? yy + 12 : yy - 4;
    parts.push('<text x="' + (L + 4) + '" y="' + r1(Math.max(T + 10, Math.min(T + PH - 2, ly))) + '" font-size="10" font-weight="700" fill="' + col + '" style="paint-order:stroke" stroke="#14161f" stroke-width="3">' + label + '</text>');
  };
  if (line != null && price != null && Math.abs(y(line) - y(price)) < 13) {
    refLine(line, '#c4b5fd', '6 4', 'LINE ' + usd(line, 0), false);
    refLine(price, '#eef1f6', '2 3', usd(price, 0), true);
  } else {
    if (line != null) refLine(line, '#c4b5fd', '6 4', 'LINE ' + usd(line, 0), false);
    if (price != null) refLine(price, '#eef1f6', '2 3', usd(price, 0), false);
  }
  /* time labels: first / middle / last candle, ET */
  [0, Math.floor(n / 2), n - 1].forEach(i => {
    parts.push('<text x="' + r1(cx(i)) + '" y="' + (H - 4) + '" font-size="10" fill="#9aa3b2" text-anchor="middle">' + etTime(cs[i].t) + '</text>');
  });
  parts.push('</svg>');
  const out = parts.join('');
  return /NaN|undefined/.test(out) ? '<p class="muted">Chart loading…</p>' : out;
}
function chartCard(s) {
  const ccs = closedCandles(Date.now());
  const vis = ccs.slice(-60);
  const fv = computeFvgState(ccs, s.price);
  const zn = computeZoneState(ccs, s.price);
  return chartSvg(vis, { fvg: fv.open, zones: zn.open, baseIndex: ccs.length - vis.length, line: s.line, price: s.price });
}
/* Row values for the Market context and Flow & levels cards. Display only:
   the same numbers as the shadow readouts, without sentence prefixes, so
   every card row reads "label on the left, value on the right". */
function gaugeTxt(s) {
  const g = s.gauge;
  if (!g) return '--';
  return g.score + '/100 · ' + g.direction + ' heavy · ' + g.label;
}
function distTxt(s) {
  const d = s.distToLine;
  if (!d) return '--';
  if (d.side === 'at') return 'At the line';
  return usd(Math.abs(d.usd)) + ' ' + d.side + ' the line (' + (d.pct >= 0 ? '+' : '') + d.pct.toFixed(2) + '%)';
}
function oddsTxt(s) {
  const o = s.oddsTrail;
  if (!o) return '--';
  return cents(o.open) + ' → ' + cents(o.last) + ' · high ' + cents(o.high) + ' · low ' + cents(o.low) + ' · ' + o.n + ' samples';
}
function flowTxt(s) {
  const tf = s.takerFlow;
  const w15 = tf && tf['15s'], w30 = tf && tf['30s'], w60 = tf && tf['60s'];
  if (!w15 && !w30 && !w60) return '--';
  const bp = w => (w && w.buyPct != null) ? Math.round(w.buyPct) + '% buy' : '--';
  const head = (w15 && w15.buyPct != null)
    ? 'Buy ' + usdK(w15.buyUsd) + ' · Sell ' + usdK(w15.sellUsd) + ' · Δ ' + (w15.deltaUsd >= 0 ? '+' : '-') + usdK(Math.abs(w15.deltaUsd)) + ' · ' + Math.round(w15.buyPct) + '% buy — ' + takerFlowLabel(w15.buyPct)
    : 'no fills in 15s';
  return '15s: ' + head + ' · 30s: ' + bp(w30) + ' · 60s: ' + bp(w60);
}
function fvgTxt(s) {
  const f = s.fvg;
  if (!f) return '--';
  const z = x => x ? usd(x.low, 0) + '–' + usd(x.high, 0) : '--';
  return 'Below ' + z(f.bullish) + ' · Above ' + z(f.bearish);
}
function zonesTxt(s) {
  const zn = s.zones;
  if (!zn) return '--';
  const w = x => x ? usd(x.low, 0) + '–' + usd(x.high, 0) : '--';
  return 'Supply ' + w(zn.supply) + ' · Demand ' + w(zn.demand);
}
function sessionTxt(s) {
  const sn = s.session;
  if (!sn) return '--';
  const dur = sn.minsUntilNext == null ? '--' : sn.minsUntilNext < 60 ? sn.minsUntilNext + 'm' : Math.floor(sn.minsUntilNext / 60) + 'h ' + String(sn.minsUntilNext % 60).padStart(2, '0') + 'm';
  return sn.current + ' · Next: ' + (sn.next || '--') + ' opens in ' + dur;
}
function riskTxt(s) {
  const r = s.risk;
  if (!r) return '--';
  const mins = r.minsLeft % 1 === 0 ? String(r.minsLeft) : r.minsLeft.toFixed(1);
  return 'needs ' + usd(r.needUsd) + ' in ' + mins + ' min (' + usd(r.perMin) + '/min, ' + r.ratio + 'x normal pace)';
}
function liquidityTxt(s) {
  const lq = s.liquidity;
  if (!lq) return '--';
  const a = lq.above ? usd(lq.above.level, 0) + ' (' + lq.above.count + ' highs)' : '--';
  const b = lq.below ? usd(lq.below.level, 0) + ' (' + lq.below.count + ' lows)' : '--';
  return 'Above: ' + a + ' · Below: ' + b;
}
function orderBlocksTxt(s) {
  const ob = s.orderBlocks;
  if (!ob) return '--';
  const w = x => x ? usd(x.low, 0) + '–' + usd(x.high, 0) : '--';
  return 'Bullish below ' + w(ob.bullish) + ' · Bearish above ' + w(ob.bearish);
}
/* Timeframe confirmation card: one row per timeframe plus a summary row.
   Renders from STATUS.tfConfirm only. Display only. */
function tfConfirmCard(s) {
  const t = s.tfConfirm;
  let inner;
  if (!t) inner = '<div class="muted">--</div>';
  else {
    inner = t.order.map(name => {
      const f = t.frames[name];
      const val = !f ? '--' : f.warmingUp ? 'warming up' : f.locked ? f.dir + ' · locked in' : '—';
      const col = f && f.locked ? (f.dir === 'UP' ? '#34d399' : '#fb7185') : '#eef1f6';
      return '<div class="ctxrow"><span class="clabel">' + esc(name) + '</span><span class="cval" style="color:' + col + '">' + esc(val) + '</span></div>';
    }).join('') + '<div class="ctxrow"><span class="clabel">Summary</span><span class="cval">' + esc(t.summary) + '</span></div>';
  }
  return '<div class="card"><h3 style="margin:0 0 8px">Timeframe confirmation</h3>' + inner + '</div>';
}
function page() {
  const s = STATUS, rows = (s.checks || []).map(c => '<li>' + esc(c) + '</li>').join('');
  const st = stats();
  const fh = s.feedHealth || {};
  const feeds = Object.keys(fh).map(k => '<span style="color:' + (fh[k] === 'ok' ? '#34d399' : '#fb7185') + '">' + esc(FEEDS[k].name) + ': ' + esc(fh[k]) + '</span>').join(' · ');
  const wr = (w, l) => (w + l) ? Math.round(w / (w + l) * 100) + '%' : '--';
  const locked = ROUNDS.filter(r => r.locked).slice(-40).reverse();
  const recRows = locked.map(r => {
    const res = effRes(r) || 'pending', side = effSide(r), L = r.locked;
    const col = res === 'won' ? '#34d399' : res === 'lost' ? '#fb7185' : '#fbbf24';
    return '<tr><td>' + etDate(r.end) + ' ' + etTime(r.end) + '</td><td>' + esc(side) + (r.edit && r.edit.side && r.edit.side !== L.side ? ' (was ' + esc(L.side) + ')' : '') + '</td><td>' + esc(L.decision || '--') + '</td><td>' + pct(L.prob) + '</td><td>' + cents(L.ask) + '</td><td>' + (L.edge == null ? '--' : (L.edge >= 0 ? '+' : '') + Math.round(L.edge * 100) + 'c') + '</td><td>' + fmtN(r.line, 0) + ' &rarr; ' + fmtN(r.fin, 0) + '</td><td style="color:' + col + '">' + esc(res) + (r.edit ? ' <i title="edited ' + esc(new Date(r.edit.at).toISOString()) + '">(edited)</i>' : '') + (r.source === 'kalshi' ? ' &#10003;K' : '') + (r.mismatch ? ' <b title="Kalshi result differed from the watcher estimate">!</b>' : '') + '</td>' +
      '<td><button onclick="ed(' + r.id + ',\'' + esc(side) + '\',\'' + esc(res) + '\')">Edit</button></td></tr>';
  }).join('') || '<tr><td colspan="9">none yet</td></tr>';
  const calRows = st.cal.map(b => '<tr><td>' + b.range + '</td><td>' + b.n + '</td><td>' + pct(b.avgP) + '</td><td>' + pct(b.actual) + '</td><td>' + (b.n >= 20 && b.actual != null ? (b.actual < b.avgP - 0.05 ? '<span style="color:#fb7185">overconfident</span>' : b.actual > b.avgP + 0.05 ? 'underconfident' : '<span style="color:#34d399">ok</span>') : 'need 20+') + '</td></tr>').join('');
  const P = paper();
  const leanPct = s.prob == null ? 0 : Math.min(100, Math.max(0, s.prob));
  const kAsk = s.kalshi && s.kalshi.yesAsk != null ? Math.round(s.kalshi.yesAsk * 100) + 'c' : '--';
  const pAsk = s.polyUs && s.polyUs.ask != null ? Math.round(s.polyUs.ask * 100) + 'c' : '--';
  /* stat tiles + calendar: all from paper()/dailyPnl(), real numbers only */
  const daily = dailyPnl();
  let bestDay = null; daily.forEach((d, k) => { if (!bestDay || d.pnl > bestDay.pnl) bestDay = { key: k, pnl: d.pnl, w: d.w, l: d.l }; });
  const tradingDays = daily.size;
  const sg = v => (v >= 0 ? '+' : '-') + usd(Math.abs(v));
  const tileCol = v => v > 0 ? '#34d399' : v < 0 ? '#fb7185' : '#eef1f6';
  const tile = (label, val, col, sub) => '<div class="tile"><div class="tlabel">' + label + '</div><div class="tval" style="color:' + col + '">' + esc(val) + '</div><div class="tsub">' + esc(sub) + '</div></div>';
  const tilesHtml = '<div class="tiles">' +
    tile('Paper P&amp;L', sg(P.pnl), tileCol(P.pnl), usd(P.balance) + ' balance · ' + P.trades + ' trades') +
    tile('TAKE win rate', P.winRate == null ? '--' : Math.round(P.winRate * 100) + '%', '#eef1f6', P.wins + '-' + P.losses + (P.open ? ' · ' + P.open + ' open' : '')) +
    tile('Best day', bestDay ? sg(bestDay.pnl) : '$0.00', bestDay ? tileCol(bestDay.pnl) : '#eef1f6', bestDay ? etDate(etWallToMs(bestDay.key, 12, 0)) + ' · ' + bestDay.w + 'W-' + bestDay.l + 'L' : 'no settled trades yet') +
    tile('Trading days', String(tradingDays), '#eef1f6', 'days with a settled TAKE') +
    '</div><p class="muted" style="margin:2px 4px 0">All calls ' + st.all.w + '-' + st.all.l + ' (' + wr(st.all.w, st.all.l) + ')</p>';
  /* market context card: from STATUS fields only, '--' when a source is stale */
  const o = s.okx;
  const frTxt = o && o.fundingRate != null ? (o.fundingRate >= 0 ? '+' : '') + (o.fundingRate * 100).toFixed(3) + '%/8h' : '--';
  const oiTxt = o && o.oiUsd != null ? '$' + (o.oiUsd / 1e9).toFixed(2) + 'B' : '--';
  const m = s.macd;
  const usdS = v => v == null ? '--' : (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
  const macdTxt = m ? 'MACD ' + usdS(m.line) + ' · signal ' + usdS(m.signal) + ' · hist ' + usdS(m.hist) : '--';
  const rv = s.reversion;
  const revTxt = rv ? (rv.vwapDistPct != null ? 'VWAP ' + (rv.vwapDistPct >= 0 ? '+' : '') + rv.vwapDistPct.toFixed(2) + '%' : 'VWAP --') + ' · ' + (rv.pctB != null ? '%B ' + rv.pctB.toFixed(2) : '%B --') + ' · ' + (rv.label || '--') : '--';
  let evTxt = 'No upcoming events';
  if (s.events) {
    if (s.events.today && s.events.today.length) evTxt = 'Today: ' + s.events.today.join(', ');
    else if (s.events.next) evTxt = 'Next: ' + s.events.next.name + ' · ' + etDate(Date.parse(s.events.next.atISO)) + ' ' + etTime(Date.parse(s.events.next.atISO)) + ' ET';
  }
  const ctxCard = '<div class="card"><h3 style="margin:0 0 4px">Market context</h3>' +
    '<div class="ctxrow"><span class="clabel">Market gauge</span><span class="cval">' + esc(gaugeTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Distance to line</span><span class="cval">' + esc(distTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Odds trail</span><span class="cval">' + esc(oddsTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Funding rate (OKX perps)</span><span class="cval">' + esc(frTxt) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Open interest (OKX)</span><span class="cval">' + esc(oiTxt) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">MACD 12/26/9</span><span class="cval">' + esc(macdTxt) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Reversion</span><span class="cval">' + esc(revTxt) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Session</span><span class="cval">' + esc(sessionTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Risk</span><span class="cval">' + esc(riskTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Events</span><span class="cval">' + esc(evTxt) + '</span></div></div>';
  const flowCard = '<div class="card"><h3 style="margin:0 0 4px">Flow &amp; levels</h3>' +
    '<div class="ctxrow"><span class="clabel">Taker flow</span><span class="cval">' + esc(flowTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Fair value gaps</span><span class="cval">' + esc(fvgTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Supply / demand zones</span><span class="cval">' + esc(zonesTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Liquidity map</span><span class="cval">' + esc(liquidityTxt(s)) + '</span></div>' +
    '<div class="ctxrow"><span class="clabel">Order blocks</span><span class="cval">' + esc(orderBlocksTxt(s)) + '</span></div></div>';
  const chartHtml = '<div class="card"><h3 style="margin:0 0 8px">BTC · 1-minute<span style="float:right;font-size:14px;font-weight:400"><button type="button" onclick="llZoomStep(-1)" style="padding:4px 12px;min-height:0">-</button> <span id="llzoomlbl" class="muted">1x</span> <button type="button" onclick="llZoomStep(1)" style="padding:4px 12px;min-height:0">+</button> <button type="button" onclick="llZoomReset()" style="padding:4px 12px;min-height:0">Reset</button></span></h3>' + chartCard(s) + '</div>';
  const calHtml = calendarHtml(Date.now(), daily);
  const heroTitle = s.locked ? esc(s.locked.decision) + ': ' + esc(s.locked.side) : 'Watching';
  const heroReason = s.locked ? esc(s.locked.reason) : 'Waiting for the next call';
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Line Lock watcher</title>' +
    '<style>body{max-width:720px;margin:0 auto}h2{font-size:30px;letter-spacing:-.03em;font-weight:800}h3{font-size:19px;margin:32px 4px 12px;color:#cbd2e1}.card{background:linear-gradient(180deg,#1b1e2a,#14161f);border:1px solid #262a38;border-radius:24px;padding:18px 20px;margin:14px 0;box-shadow:0 8px 24px rgba(0,0,0,.28);overflow-wrap:anywhere}.hero{border:1px solid transparent;background:linear-gradient(#171924,#171924) padding-box,linear-gradient(135deg,#7c5cff,#00c2ff,#34d399) border-box}.big{font-size:42px;font-weight:800;letter-spacing:-.03em;line-height:1.1}.muted{color:#9aa3b2;font-size:14px}.pill{display:inline-block;padding:5px 12px;border-radius:999px;font-weight:700;font-size:14px;background:rgba(52,211,153,.15);color:#34d399}.pill-tape{background:rgba(124,92,255,.18);color:#c4b5fd}.bar{height:10px;border-radius:999px;background:#262a38;overflow:hidden;margin:10px 0}.bar>div{height:100%;background:linear-gradient(90deg,#7c5cff,#00c2ff)}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}.grid .card{margin:0}table{border-collapse:collapse;width:100%;background:#14161f;border:1px solid #262a38;border-radius:20px;overflow:hidden;display:block;overflow-x:auto}td,th{padding:12px 14px;border-bottom:1px solid #222634;text-align:left;white-space:nowrap}th{font-size:13px;color:#9aa3b2;font-weight:600}button{background:linear-gradient(135deg,#7c5cff,#00c2ff);color:#fff;border:0;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer;min-height:42px}select,input{background:#1b1e2a;color:#eef1f6;border:1px solid #2c3245;border-radius:14px;padding:11px 14px;min-height:42px}a{color:#7dd3fc;text-decoration:none}#edbox{display:none;position:fixed;top:18%;left:50%;transform:translateX(-50%);background:#1b1e2a;border:1px solid #2c3245;padding:20px;border-radius:20px;box-shadow:0 12px 32px rgba(0,0,0,.4);width:min(92vw,380px);z-index:10}details summary{cursor:pointer;color:#cbd2e1}@media(max-width:560px){.grid{grid-template-columns:1fr 1fr}.big{font-size:34px}.calpnl{font-size:11px}.calwl{font-size:10px}.calcell{min-height:46px;padding:5px 3px}}.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}.tile{background:linear-gradient(180deg,#1b1e2a,#14161f);border:1px solid #262a38;border-radius:24px;padding:16px 18px;box-shadow:0 8px 24px rgba(0,0,0,.28)}.tlabel{color:#9aa3b2;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}.tval{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-top:4px}.tsub{color:#9aa3b2;font-size:14px}.ctxrow{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #222634}.ctxrow:last-child{border-bottom:0}.clabel{color:#9aa3b2;font-size:14px}.cval{font-weight:700;text-align:right}.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}.calhead{color:#9aa3b2;font-size:11px;font-weight:700;text-align:center;padding:4px 0;letter-spacing:.05em}.calcell{border:1px solid #262a38;border-radius:12px;padding:6px 4px;min-height:52px;background:#14161f;overflow:hidden}.calcell.win{background:rgba(52,211,153,.10);border-color:rgba(52,211,153,.35)}.calcell.loss{background:rgba(251,113,133,.10);border-color:rgba(251,113,133,.35)}.calcell.today{outline:2px solid #7c5cff}.calcell.future{opacity:.45}.calday{color:#9aa3b2;font-size:11px}.calpnl{font-weight:800;font-size:13px;white-space:nowrap}.calwl{color:#9aa3b2;font-size:11px;white-space:nowrap}</style>' +
    '<body style="font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;color:#eef1f6;padding:16px"><h2>Line Lock</h2><p class="muted" style="margin-top:-8px">BTC 15-minute watcher · Live</p>' +
    '<div class="card hero"><span class="pill">&#9679; ' + heroTitle + '</span> <span class="pill pill-tape">' + heroReason + '</span>' +
    '<div class="big" style="margin-top:12px">' + (s.price == null ? '--' : usd(s.price)) + '</div>' +
    '<div class="muted">Line ' + (s.line == null ? '--' : usd(s.line)) + ' (' + (s.lineFrom || '--') + ') · ' + (s.left || '--') + ' left · lean ' + (s.side || '--') + ' ' + (s.prob || '--') + '% · ' + (s.verdict || '--') + '</div>' +
    '<div style="margin-top:14px"><b>Lean ' + (s.side || '--') + ' ' + (s.prob || '--') + '%' + (s.grade ? ' · Grade ' + esc(s.grade.grade) + ' · ' + s.grade.passN + '/' + s.grade.total : '') + '</b> <span class="muted">· model up ' + (s.rawProbUp == null ? '--' : s.rawProbUp + '%') + ' · Kalshi up ' + (s.marketProbUp == null ? '--' : s.marketProbUp + '%') + ' · edge ' + (s.edgeCents == null ? '--' : (s.edgeCents >= 0 ? '+' : '') + s.edgeCents + 'c') + (s.stake ? ' · quarter-Kelly ' + usd(s.stake, 0) : '') + '</span></div>' +
    '<div class="bar"><div style="width:' + leanPct + '%"></div></div>' +
    '<div class="muted">Up ask &middot; Kalshi ' + kAsk + ' &middot; Polymarket US ' + pAsk + '</div>' +
    '<div class="muted">' + (s.feeds || 0) + ' feeds live · RSI 1m ' + (s.rsi1 == null ? '--' : s.rsi1) + ' · whale net 5m ' + (s.whaleNet5m == null ? '--' : usdK(s.whaleNet5m)) + (s.surge ? ' · SURGE' : '') + '</div>' +
    '<div style="margin-top:8px">' + feeds + '</div></div>' +
    chartHtml + tilesHtml + ctxCard + flowCard + tfConfirmCard(s) + calHtml +
    '<div class="card"><h3 style="margin:0 0 8px">Checks</h3><ul style="margin:8px 0;padding-left:20px">' + rows + '</ul></div>' +
    '<h3>Recent rounds</h3><table><tr><th>round (ET)</th><th>call</th><th>type</th><th>model</th><th>ask</th><th>edge</th><th>line &rarr; final</th><th>result</th><th></th></tr>' + recRows + '</table>' +
    paperCard() +
    '<h3>Calibration (snapshot at 4:00 left, every round)</h3><div class="card"><p style="margin:0">Brier score: model ' + (st.brier == null ? '--' : st.brier.toFixed(4)) + ' vs Kalshi price ' + (st.brierMkt == null ? '--' : st.brierMkt.toFixed(4)) + ' (lower is better; if Kalshi is lower, the market knows more than the model) · ' + st.nCal + ' rounds</p></div>' +
    '<table><tr><th>model said</th><th>rounds</th><th>avg said</th><th>actually won</th><th></th></tr>' + calRows + '</table>' +
    '<p class="muted">Alerts: ' + (s.topicSet ? 'topic set' : '<b>NTFY_TOPIC is not set</b>') + ' · ' + ROUNDS.length + ' rounds logged · ' + st.edited + ' edited</p>' +
    '<details><summary>Diagnostics</summary><p class="muted">' + esc(JSON.stringify(s.diag || {})) + '</p></details>' +
    '<div id="edbox"><b>Edit round</b><br>Call: <select id="eside"><option>UP</option><option>DOWN</option></select><br>Result: <select id="eres"><option value="auto">auto (from price)</option><option value="won">won</option><option value="lost">lost</option><option value="skip">skip (did not trade / ignore)</option></select><br>Key: <input id="ekey" type="password" placeholder="EDIT_KEY"><br><button onclick="save()">Save</button> <button onclick="clr()">Undo edit</button> <button onclick="cls()">Cancel</button> <span id="emsg"></span></div>' +
    '<script>var cur=null,editing=false;function ed(id,side,res){cur=id;editing=true;document.getElementById("eside").value=side;document.getElementById("eres").value=(res==="won"||res==="lost"||res==="skip")?res:"auto";document.getElementById("ekey").value=localStorage.llkey||"";document.getElementById("edbox").style.display="block"}' +
    'function cls(){editing=false;document.getElementById("edbox").style.display="none"}' +
    'function send(b){var k=document.getElementById("ekey").value;localStorage.llkey=k;fetch("/api/rounds/"+cur+"/edit",{method:"POST",headers:{"Content-Type":"application/json","X-Edit-Key":k},body:JSON.stringify(b)}).then(function(r){return r.text().then(function(t){if(r.ok)location.reload();else document.getElementById("emsg").textContent=t})})}' +
    'function save(){var r=document.getElementById("eres").value;send({side:document.getElementById("eside").value,res:r==="auto"?null:r})}function clr(){send({clear:true})}' +
    /* Chart zoom: pure client-side view state. zoomViewBox() is embedded from
       the tested server function; the level persists in localStorage so the
       5s reload keeps the zoom. Silent no-op when the SVG or storage is
       unavailable; the reload and the edit box are untouched. */
    zoomViewBox.toString() + ';var LLZ=[1,1.5,2,3,4];function llZoomApply(){try{var svg=document.getElementById("llchart");if(!svg)return;var L=parseFloat(localStorage.getItem("llChartZoom"))||1;if(LLZ.indexOf(L)<0)L=1;svg.setAttribute("viewBox",zoomViewBox(L));var lb=document.getElementById("llzoomlbl");if(lb)lb.textContent=L+"x";}catch(e){}}' +
    'function llZoomStep(d){try{var cur=parseFloat(localStorage.getItem("llChartZoom"))||1;var i=LLZ.indexOf(cur);if(i<0)i=0;i=Math.max(0,Math.min(LLZ.length-1,i+d));localStorage.setItem("llChartZoom",String(LLZ[i]));}catch(e){}llZoomApply();}' +
    'function llZoomReset(){try{localStorage.setItem("llChartZoom","1");}catch(e){}llZoomApply();}llZoomApply();' +
    'setInterval(function(){if(!editing)location.reload()},5000)</script></body>';
}
function paperCard() {
  const P = paper(), sg = v => (v >= 0 ? '+' : '-') + usd(Math.abs(v)), tr = t => t ? sg(t.pnl) + ' (' + etDate(t.end) + ' ' + etTime(t.end) + ' ET, ' + t.contracts + 'x ' + esc(t.side) + ' @ ' + cents(t.ask) + ')' : '--';
  return '<h3>Paper trading</h3><div style="border:1px solid #262a38;border-radius:24px;padding:18px 20px;background:linear-gradient(180deg,#1b1e2a,#14161f);display:inline-block">' +
    'Balance <b>' + usd(P.balance) + '</b> (start ' + usd(P.start) + ', ' + (P.mode === 'kelly' ? 'quarter-Kelly capped, ' + usd(P.fixedStake, 0) + ' fallback' : 'fixed ' + usd(P.fixedStake, 0)) + ')<br>' +
    'P/L <b style="color:' + (P.pnl >= 0 ? '#34d399' : '#fb7185') + '">' + sg(P.pnl) + '</b> · ROI ' + (P.roi == null ? '--' : (P.roi * 100).toFixed(1) + '%') + ' · win rate ' + pct(P.winRate) + ' (' + P.wins + '-' + P.losses + (P.open ? ', ' + P.open + ' open' : '') + ') · fees ' + usd(P.fees) + '<br>' +
    'Max drawdown ' + usd(P.maxDrawdown) + ' (' + (P.maxDrawdownPct * 100).toFixed(1) + '%) · best ' + tr(P.best) + ' · worst ' + tr(P.worst) + '<br>' +
    '<span style="color:#7a899f">Simulated buys at the ask when the call is made, on every TAKE; edits recompute it. <a style="color:#7a899f" href="/api/paper">json</a> · <a style="color:#7a899f" href="/api/export.csv">csv</a></span></div>';
}
function readBody(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 10000) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); }); }
function startServer() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    /* /health stays a plain 200 so Render does not restart the app over one flaky exchange;
       /health?strict=1 returns 503 when fewer than 2 feeds are live */
    if (u.pathname === '/health') {
      const live = liveFeeds(Date.now()).length, bad = u.searchParams.get('strict') === '1' && live < 2;
      res.writeHead(bad ? 503 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: !bad, liveFeeds: live, feeds: feedHealth(Date.now()) }));
    }
    if (u.pathname === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(STATUS, null, 2)); }
    if (u.pathname === '/api/rounds') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ stats: stats(), paper: paper(), rounds: ROUNDS.slice(-500) })); }
    if (u.pathname === '/api/paper') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(paper(), null, 2)); }
    if (u.pathname === '/api/export.csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="line-lock-rounds.csv"' }); return res.end(exportCsv()); }
    const m = u.pathname.match(/^\/api\/rounds\/(\d+)\/edit$/);
    if (m && req.method === 'POST') {
      if (!CFG.editKey || req.headers['x-edit-key'] !== CFG.editKey) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('wrong or missing key (EDIT_KEY, or your NTFY_TOPIC if EDIT_KEY is not set)'); }
      const r = ROUNDS.find(x => x.id === +m[1]); if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('round not found'); }
      let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad JSON'); }
      if (b.clear) delete r.edit;
      else {
        const e = { at: Date.now() };
        if (b.side === 'UP' || b.side === 'DOWN') e.side = b.side;
        if (b.res === 'won' || b.res === 'lost' || b.res === 'skip') e.res = b.res;
        if (b.up === true || b.up === false) e.up = b.up;
        /* if the user said won/lost for a side, infer which way BTC actually went so calibration matches */
        const sd = e.side || (r.locked && r.locked.side);
        if (e.up == null && sd && (e.res === 'won' || e.res === 'lost')) e.up = (e.res === 'won') === (sd === 'UP');
        r.edit = e;
      }
      saveRounds(); savePaper(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, round: r, stats: stats(), paper: paper() }));
    }
    if (u.pathname === '/test') {
      if (!CFG.topic || u.searchParams.get('key') !== CFG.topic) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Add ?key=YOUR_TOPIC_NAME to the address'); }
      const ok = await push('Test - Line Lock', 'If you can read this on your phone, alerts work. Tap to open Kalshi.', 'high', 'bell', { click: CFG.kalshiUrl, actions: kalshiActions() });
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ok ? 'sent' : 'failed, check the topic name and the logs');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page());
  });
  srv.listen(CFG.port, () => console.log('status page on port', CFG.port));
}

function main() {
  loadRounds();
  newRound(Math.floor(Date.now() / ROUND_MS) * ROUND_MS + ROUND_MS);
  console.log('Line Lock watcher starting. Alerts topic set:', !!CFG.topic, '| whale size', usdK(CFG.whale), '| min edge', CFG.minEdge, '| shrink', CFG.shrink);
  console.log('Market context (display only): OKX funding + open interest, macro-event calendar, MACD/reversion, Polymarket US price. Never affects calls.');
  startServer();
  pollPrices(); pollTrades(); pollBook(); pollCandles(); pollKalshi(); quiet(pollOkx()); pollPolyUs();
  setInterval(pollPrices, 2000); setInterval(pollTrades, 2500); setInterval(pollBook, 3000); setInterval(pollCandles, 4000); setInterval(pollKalshi, 2000); setInterval(() => quiet(pollOkx()), 60000); setInterval(pollPolyUs, 10000);
  setInterval(pollSettle, 20000);
  loadHistory(); connectLiq();
  setInterval(() => { try { tick(); } catch (e) { console.log('tick error', e.stack || e.message); } }, 1000);
  setInterval(() => { if (S.candles.size > 200) runBacktest(); }, 30 * 60000);
  if (CFG.heartbeatMin > 0) setInterval(heartbeat, CFG.heartbeatMin * 60000);
  /* Keep a free Render instance awake: it visits its own public address every 8 minutes.
     Render sets RENDER_EXTERNAL_URL on its own, so nothing to configure. */
  if (process.env.RENDER_EXTERNAL_URL) {
    const self = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/health';
    setInterval(() => { fetch(self, { signal: AbortSignal.timeout(10000) }).catch(() => { }); }, 8 * 60000);
    console.log('keep-awake ping on', self);
  }
}
if (require.main === module) main();
module.exports = { S, CFG, tick, newRound, getR: () => R, push, checksFor, analyze, getStatus: () => STATUS, stats, kalshiFee, kelly, effRes };
