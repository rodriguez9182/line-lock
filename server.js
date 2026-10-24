'use strict';
/*
  Line Lock watcher v1.1
  Runs the same checks as the Line Lock page, 24/7, and sends a push through ntfy
  when a play locks. Read only: it never trades and never logs in anywhere.

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
    MIN_EDGE        optional. Minimum edge after fee to TAKE, in dollars per $1 contract. Default 0.04
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
  minEdge: num(process.env.MIN_EDGE, 0.04),
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

/* ---------- state ---------- */
const FEEDS = {
  coinbase: { name: 'Coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', parse: j => +j.price },
  kraken: { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: j => +j.result[Object.keys(j.result)[0]].c[0] },
  bitstamp: { name: 'Bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: j => +j.last },
  gemini: { name: 'Gemini', url: 'https://api.gemini.com/v1/pubticker/btcusd', parse: j => +j.last },
  bitfinex: { name: 'Bitfinex', url: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD', parse: j => +j[6] }
};
const S = { prices: {}, trades: [], seen: new Set(), candles: new Map(), book: null, liq: [], hist: [], bt: null, clusters: [], kalshi: null, diag: {}, feedErr: {}, feedDownSince: {}, feedAlerted: {}, pend: [], scanT: null, liveP: {} };
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
  /* TAKE needs a real Kalshi price now: no price = no way to know there is an edge */
  const verdict = !side ? 'SKIP' : (counted.length && passN === counted.length && aligned && edge != null ? 'TAKE' : (passN >= counted.length - 1 || strength >= 40 ? 'WAIT' : 'SKIP'));
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
  if (CFG.results) push('Result: ' + R.locked.side + ' ' + res.toUpperCase() + (R.locked.decision === 'TAKE' ? '' : ' (no-edge call)'), 'Round ending ' + etTime(R.end) + ' ET. Line ' + usd(R.line) + ', final ' + usd(fin) + ' (' + (d >= 0 ? '+' : '-') + usd(Math.abs(d)) + '). Watcher estimate; Kalshi settles on the CF Benchmarks index and may differ. Use Edit on the page if it is wrong.' + (R.locked.decision === 'TAKE' ? '\n' + paperLine() : ''), 'low', res === 'won' ? 'white_check_mark' : 'x', pageUrl() ? { click: pageUrl() + '/' } : null);
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
const LOSS_SEGMENTS = [
  { id: 'high-ask', label: 'Ask 70c or higher', test: (side, prob, ask, edge, r) => ask != null && ask >= 0.70 },
  { id: 'high-ask-small-edge', label: 'Ask 70c+ with under 8c edge', test: (side, prob, ask, edge, r) => ask != null && ask >= 0.70 && edge != null && edge < 0.08 },
  { id: 'small-edge', label: 'Edge under 7c', test: (side, prob, ask, edge, r) => edge != null && edge < 0.07 },
  { id: 'low-model', label: 'Model under 70%', test: (side, prob, ask, edge, r) => prob != null && prob < 0.70 },
  { id: 'up', label: 'UP calls', test: (side, prob, ask, edge, r) => side === 'UP' },
  { id: 'down', label: 'DOWN calls', test: (side, prob, ask, edge, r) => side === 'DOWN' },
  { id: 'mismatch', label: 'Kalshi settlement differed', test: (side, prob, ask, edge, r) => !!(r && r.mismatch) }
];
function lossSegmentStats() {
  const takes = ROUNDS.filter(r => r.locked && r.locked.decision === 'TAKE' && (effRes(r) === 'won' || effRes(r) === 'lost'));
  return LOSS_SEGMENTS.map(seg => {
    const rows = takes.filter(r => { const L = r.locked; return seg.test(effSide(r), L.prob, L.ask, L.edge, r); });
    const w = rows.filter(r => effRes(r) === 'won').length, l = rows.length - w;
    const meanAsk = rows.length ? rows.reduce((s, r) => s + (r.locked.ask || 0), 0) / rows.length : null;
    const pnl = rows.reduce((s, r) => s + ((effRes(r) === 'won' ? 1 : 0) - (r.locked.ask || 0) - kalshiFee(r.locked.ask || 0)), 0);
    return { id: seg.id, label: seg.label, test: seg.test, n: rows.length, w, l, winRate: rows.length ? w / rows.length : null, breakeven: meanAsk, pnlPerContract: rows.length ? pnl / rows.length : null };
  });
}
function lossLearn() {
  const segments = lossSegmentStats();
  const rules = segments.filter(sg => sg.n >= 12 && sg.l >= 4 && sg.winRate != null && sg.breakeven != null && sg.winRate < sg.breakeven - 0.10)
    .map(sg => ({ id: sg.id, label: sg.label, n: sg.n, w: sg.w, l: sg.l, winRate: sg.winRate, breakeven: sg.breakeven, matches: (side, prob, ask, edge) => { const seg = LOSS_SEGMENTS.find(x => x.id === sg.id); return seg ? seg.test(side, prob, ask, edge, null) : false; } }));
  const settled = ROUNDS.filter(r => r.locked && r.locked.decision === 'TAKE' && (effRes(r) === 'won' || effRes(r) === 'lost')).sort((a, b) => a.end - b.end);
  let consec = 0; for (let k = settled.length - 1; k >= 0; k--) { if (effRes(settled[k]) === 'lost') consec++; else break; }
  const last6 = settled.slice(-6), last6Losses = last6.filter(r => effRes(r) === 'lost').length;
  const brake = consec >= 3 || last6Losses >= 5;
  return { segments, rules, brake, consec, last6Losses };
}
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
    let learnReason = null;
    if (decision === 'TAKE') {
      const learn = lossLearn();
      if (learn.brake) { decision = 'LEAN'; learnReason = 'loss brake: ' + learn.consec + ' TAKE losses in a row, ' + learn.last6Losses + ' in the last 6'; }
      else { const hit = learn.rules.find(ru => ru.matches(cand.side, pr, ask, edge)); if (hit) { decision = 'LEAN'; learnReason = 'loss rule: ' + hit.label + ' (' + hit.w + '-' + hit.l + ', ' + Math.round(hit.winRate * 100) + '% vs ' + Math.round(hit.breakeven * 100) + '% breakeven)'; } }
      if (learnReason) console.log('LOSS-LEARN downgrade to LEAN:', learnReason);
    }
    const stake = (CFG.bankroll > 0 && decision === 'TAKE') ? CFG.bankroll * kelly(pr, ask + fee) : null;
    const passN = A.passN, total = A.total;
    let paperRec = null;
    if (decision === 'TAKE') { const bal = paper().balance, z = paperSize(bal, pr, ask); paperRec = { balance: bal, contracts: z.n, cost: +(z.n * ask).toFixed(2), fee: orderFee(z.n, ask), sizing: z.mode }; }
    R.locked = { side: cand.side, t: now, px: A.price, gap: A.gap, prob: pr, rawProb: A.rawUp == null ? null : (sg > 0 ? A.rawUp : 1 - A.rawUp), ask, fee, edge, decision, stake, passN, total, reason: cand.reason, left: A.left, paper: paperRec, rsi1: A.rsi1, rsi5: A.rsi5, ema9: A.ema9, ema21: A.ema21, whaleNet5m: A.w300.net, buyPct60: A.f60.buyPct, sigUsd: A.sigUsd, z: A.z, learnReason };
    const body = usd(A.price) + ' vs line ' + usd(R.line) + ' (' + (A.gap >= 0 ? '+' : '-') + usd(Math.abs(A.gap)) + ')\n' +
      'Model ' + pct(pr) + (ask != null ? ' vs ask ' + cents(ask) + ' + ' + cents(fee) + ' fee' : ' (no Kalshi price)') + (edge != null ? ' -> edge ' + (edge >= 0 ? '+' : '') + Math.round(edge * 100) + 'c' : '') + '\n' +
      'Checks ' + passN + '/' + total + ' passed. ' + cand.reason + '. ' + mmss(A.left) + ' left.' + (stake ? '\nQuarter-Kelly stake: ' + usd(stake, 0) : '');
    console.log('LOCK', decision, cand.side, body.replace(/\n/g, ' | '));
    push((decision === 'TAKE' ? 'TAKE ' : 'Lean ') + cand.side + ' - BTC 15m' + (ask != null ? ' @ ' + cents(ask) : ''), body,
      decision === 'TAKE' ? 'urgent' : 'default', cand.side === 'UP' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend',
      { click: CFG.kalshiUrl, actions: kalshiActions() });
  }
}
function whaleHeadsUp(A, now) {
  if (!CFG.whaleAlerts || R.locked || R.surgeNotified || !A.surge || A.left < 45 || A.left > 720) return;
  R.surgeNotified = true;
  push('Whale surge ' + (A.surgeSgn > 0 ? 'buying' : 'selling'), usdK(Math.abs(A.w90.net)) + ' net in 90s. Price ' + usd(A.price) + (R.line != null ? ' vs line ' + usd(R.line) : '') + '. Not locked: ' + (A.whaleOk ? 'waiting to hold 4s' : 'line side, exchanges or RSI do not agree') + '.', 'default', 'whale');
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
  push('Line Lock alive', 'Up ' + Math.round((now - BOOT) / 3600000) + 'h. ' + live + '/' + Object.keys(FEEDS).length + ' feeds live. Price ' + usd(STATUS.price) + '. Locked record ' + st.all.w + '-' + st.all.l + ', TAKE ' + st.take.w + '-' + st.take.l + ' (' + (st.take.pnl >= 0 ? '+' : '-') + usd(Math.abs(st.take.pnl)) + '/contract). ' + ROUNDS.length + ' rounds logged. ' + paperLine() + '.', 'min', 'heartbeat');
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
  STATUS = {
    time: new Date(now).toISOString(), left: mmss(A.left), feeds: A.live.length, feedHealth: fh, price: A.price, line: R.line, lineFrom: R.lineFrom,
    side: A.side, strength: A.strength, prob: A.probSide == null ? null : Math.round(A.probSide * 100),
    rawProbUp: A.rawUp == null ? null : Math.round(A.rawUp * 100), marketProbUp: A.mktUp == null ? null : Math.round(A.mktUp * 100),
    edgeCents: A.edge == null ? null : Math.round(A.edge * 100), stake: A.stake, verdict: A.verdict,
    checks: A.checks.map(c => (c.na ? '-' : c.ok ? 'pass' : 'FAIL') + ' ' + c.label + ' (' + c.detail + ')'),
    whaleNet5m: Math.round(A.w300.net), surge: A.surge, rsi1: A.rsi1 == null ? null : +A.rsi1.toFixed(1), rsi5: A.rsi5 == null ? null : +A.rsi5.toFixed(1),
    locked: R.locked ? { side: R.locked.side, decision: R.locked.decision, at: new Date(R.locked.t).toISOString(), reason: R.locked.reason, edge: R.locked.edge } : null,
    kalshi: A.K ? { ticker: A.K.ticker, yesAsk: A.K.yesAsk, noAsk: A.K.noAsk } : null, diag: S.diag, topicSet: !!CFG.topic, roundsLogged: ROUNDS.length
  };
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
  }));
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

/* ---------- 1-minute chart, pattern recognition, scalp watch ---------- */
function chartSvg(cs, linePrice) {
  const data = cs.slice(-90); if (data.length < 5) return '<p class="muted">Not enough 1-minute candles yet.</p>';
  const W = 680, H = 280, PL = 8, PR = 56, PT = 12, PB = 20, IW = W - PL - PR, IH = H - PT - PB;
  let lo = Infinity, hi = -Infinity; data.forEach(c => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
  if (linePrice != null) { lo = Math.min(lo, linePrice); hi = Math.max(hi, linePrice); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const X = i => PL + (i + 0.5) * (IW / data.length), Y = v => PT + (hi - v) / (hi - lo) * IH;
  const closes = data.map(c => c.c), e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
  const line = (arr, col) => { const pts = arr.map((v, i) => v == null ? null : X(i).toFixed(1) + ',' + Y(v).toFixed(1)).filter(Boolean).join(' '); return pts ? '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="1.5" opacity="0.9"/>' : ''; };
  let candles = '';
  data.forEach((c, i) => { const x = X(i), w = Math.max(2, IW / data.length * 0.7), col = c.c >= c.o ? '#34d399' : '#fb7185'; candles += '<line x1="' + x.toFixed(1) + '" y1="' + Y(c.h).toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + Y(c.l).toFixed(1) + '" stroke="' + col + '" stroke-width="1"/><rect x="' + (x - w / 2).toFixed(1) + '" y="' + Y(Math.max(c.o, c.c)).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(1, Math.abs(Y(c.o) - Y(c.c))).toFixed(1) + '" fill="' + col + '"/>'; });
  const last = data[data.length - 1];
  const lineEl = linePrice != null && linePrice >= lo && linePrice <= hi ? '<line x1="' + PL + '" y1="' + Y(linePrice).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(linePrice).toFixed(1) + '" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="6 4"/><text x="' + (W - PR + 4) + '" y="' + (Y(linePrice) + 4).toFixed(1) + '" fill="#fbbf24" font-size="11">line</text>' : '';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block"><rect width="100%" height="100%" fill="#0f1118" rx="12"/>' + candles + line(e9, '#00c2ff') + line(e21, '#7c5cff') + lineEl + '<text x="' + (W - PR + 4) + '" y="' + (Y(last.c) + 4).toFixed(1) + '" fill="#eef1f6" font-size="11">' + fmtN(last.c, 0) + '</text></svg>' +
    '<div class="muted" style="margin-top:8px">Last 90 closed 1-minute candles, Coinbase BTC-USD · <span style="color:#00c2ff">EMA 9</span> · <span style="color:#7c5cff">EMA 21</span> · <span style="color:#fbbf24">Kalshi line (dashed)</span></div>';
}
function _linSlope(xs) { const n = xs.length, mx = (n - 1) / 2, my = mean(xs); let num = 0, den = 0; xs.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) * (i - mx); }); return den ? num / den : 0; }
function _body(c) { return Math.abs(c.c - c.o); }
function detectPatterns(cs) {
  const out = []; if (cs.length < 30) return out;
  const ind = indArrays(cs), i = cs.length - 1, last = cs[i], prev = cs[i - 1], prev2 = cs[i - 2];
  const add = (name, dir, status, detail, conf) => out.push({ name, dir, status, detail, conf });
  // Candlestick signals already backtested by this watcher
  PATS.forEach(p => { if (testPat(p, cs, i, ind)) { const w = patWeight(p), r = S.bt && S.bt.res[p.id]; add(p.name, p.dir, 'live', r && r.n >= 50 ? 'Backtested ' + Math.round(r.w / r.n * 100) + '% in the expected direction (' + r.n + ' cases)' : 'Live signal, not enough backtest cases yet', w > 0 ? 'High' : 'Medium'); } });
  // Morning / evening star, piercing, dark cloud, harami
  if (red(prev2) && _body(prev) <= 0.4 * _body(prev2) && grn(last) && last.c > (prev2.o + prev2.c) / 2) add('Morning star', 1, 'live', 'Red candle, small middle candle, then a green close above the first candle midpoint', 'Medium');
  if (grn(prev2) && _body(prev) <= 0.4 * _body(prev2) && red(last) && last.c < (prev2.o + prev2.c) / 2) add('Evening star', -1, 'live', 'Green candle, small middle candle, then a red close below the first candle midpoint', 'Medium');
  if (red(prev) && grn(last) && last.o < prev.c && last.c > (prev.o + prev.c) / 2 && last.c < prev.o) add('Piercing pattern', 1, 'live', 'Green candle opens below the red close and closes above its midpoint', 'Medium');
  if (grn(prev) && red(last) && last.o > prev.c && last.c < (prev.o + prev.c) / 2 && last.c > prev.o) add('Dark cloud cover', -1, 'live', 'Red candle opens above the green close and closes below its midpoint', 'Medium');
  if (_body(last) < 0.5 * _body(prev) && Math.min(last.o, last.c) >= Math.min(prev.o, prev.c) && Math.max(last.o, last.c) <= Math.max(prev.o, prev.c)) add(grn(prev) ? 'Bearish harami' : 'Bullish harami', grn(prev) ? -1 : 1, 'forming', 'Small candle fully inside the previous candle body — a pause that can precede a reversal', 'Low');
  // Double top / bottom on the last 40 candles
  const win = cs.slice(-40), highs = win.map(c => c.h), lows = win.map(c => c.l);
  const hi1 = Math.max.apply(null, highs.slice(0, 20)), hi2 = Math.max.apply(null, highs.slice(20));
  const lo1 = Math.min.apply(null, lows.slice(0, 20)), lo2 = Math.min.apply(null, lows.slice(20));
  const trough = Math.min.apply(null, lows.slice(highs.indexOf(hi1), highs.indexOf(hi2) + 1 > 0 ? highs.indexOf(hi2) : 20));
  if (Math.abs(hi1 - hi2) / hi1 < 0.0025 && (Math.min(hi1, hi2) - trough) / hi1 > 0.004) add('Double top', -1, last.c < trough ? 'confirmed' : 'forming', 'Two peaks near ' + fmtN(Math.max(hi1, hi2), 0) + ' with a trough at ' + fmtN(trough, 0), last.c < trough ? 'High' : 'Medium');
  const peak = Math.max.apply(null, highs.slice(lows.indexOf(lo1), lows.indexOf(lo2) + 1 > 0 ? lows.indexOf(lo2) : 20));
  if (Math.abs(lo1 - lo2) / lo1 < 0.0025 && (peak - Math.max(lo1, lo2)) / lo1 > 0.004) add('Double bottom', 1, last.c > peak ? 'confirmed' : 'forming', 'Two troughs near ' + fmtN(Math.min(lo1, lo2), 0) + ' with a peak at ' + fmtN(peak, 0), last.c > peak ? 'High' : 'Medium');
  // Triangles and wedges on the last 24 candles
  const t24 = cs.slice(-24), th = t24.map(c => c.h), tl = t24.map(c => c.l), px = last.c;
  const hs = _linSlope(th) / px * 100, ls = _linSlope(tl) / px * 100;
  const flatH = Math.abs(th.slice(0, 12).reduce((a, b) => Math.max(a, b), 0) - th.slice(12).reduce((a, b) => Math.max(a, b), 0)) / px < 0.002;
  const flatL = Math.abs(tl.slice(0, 12).reduce((a, b) => Math.min(a, b), Infinity) - tl.slice(12).reduce((a, b) => Math.min(a, b), Infinity)) / px < 0.002;
  if (flatH && ls > 0.02) add('Ascending triangle', 1, 'forming', 'Highs flat, lows rising — watch for an upside breakout', 'Medium');
  if (flatL && hs < -0.02) add('Descending triangle', -1, 'forming', 'Lows flat, highs falling — watch for a downside breakout', 'Medium');
  if (hs < -0.02 && ls > 0.02) add('Symmetrical triangle', 0, 'forming', 'Highs falling and lows rising, price compressing — breakout either way', 'Medium');
  if (hs > 0.02 && ls > 0.02 && hs < ls) add('Rising wedge', -1, 'forming', 'Both highs and lows rising, but the range is narrowing', 'Medium');
  if (hs < -0.02 && ls < -0.02 && hs > ls) add('Falling wedge', 1, 'forming', 'Both highs and lows falling, but the range is narrowing', 'Medium');
  // Flags: sharp move, then a tight consolidation
  const move = (cs[i - 5].c - cs[i - 10].c) / cs[i - 10].c, flagRange = (Math.max.apply(null, cs.slice(-5).map(c => c.h)) - Math.min.apply(null, cs.slice(-5).map(c => c.l))) / px;
  if (move > 0.012 && flagRange < 0.005) add('Bull flag', 1, 'forming', 'Sharp rise, then 5 tight candles — continuation setup if it breaks up', 'Medium');
  if (move < -0.012 && flagRange < 0.005) add('Bear flag', -1, 'forming', 'Sharp fall, then 5 tight candles — continuation setup if it breaks down', 'Medium');
  // Head and shoulders: three pivot highs, middle highest, shoulders within 0.5%
  const pivH = []; for (let k = 2; k < cs.length - 2; k++) if (cs[k].h >= cs[k - 1].h && cs[k].h >= cs[k + 1].h && cs[k].h >= cs[k - 2].h && cs[k].h >= cs[k + 2].h) pivH.push(k);
  const recentH = pivH.slice(-3);
  if (recentH.length === 3) { const a = cs[recentH[0]].h, b = cs[recentH[1]].h, c2 = cs[recentH[2]].h; if (b > a && b > c2 && Math.abs(a - c2) / b < 0.005) add('Head and shoulders', -1, 'forming', 'Left shoulder, higher head, right shoulder near the left shoulder level', 'Medium'); }
  const pivL = []; for (let k = 2; k < cs.length - 2; k++) if (cs[k].l <= cs[k - 1].l && cs[k].l <= cs[k + 1].l && cs[k].l <= cs[k - 2].l && cs[k].l <= cs[k + 2].l) pivL.push(k);
  const recentL = pivL.slice(-3);
  if (recentL.length === 3) { const a = cs[recentL[0]].l, b = cs[recentL[1]].l, c2 = cs[recentL[2]].l; if (b < a && b < c2 && Math.abs(a - c2) / a < 0.005) add('Inverse head and shoulders', 1, 'forming', 'Left shoulder, lower head, right shoulder near the left shoulder level', 'Medium'); }
  return out.slice(0, 8);
}
function scalpWatch(cs, s) {
  if (cs.length < 30) return null;
  const closes = cs.map(c => c.c), e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21), rsi = rsiSeries(closes, 14);
  const last = cs[cs.length - 1], i = cs.length - 1, atr = mean(cs.slice(-14).map(c => c.h - c.l)) || 0;
  const hi15 = Math.max.apply(null, cs.slice(-15).map(c => c.h)), lo15 = Math.min.apply(null, cs.slice(-15).map(c => c.l));
  let score = 0; const factors = [];
  const push = (d, t) => { score += d; factors.push(t); };
  if (e9[i] > e21[i]) push(1, 'EMA 9 above EMA 21'); else if (e9[i] < e21[i]) push(-1, 'EMA 9 below EMA 21');
  if (rsi[i] != null && rsi[i - 1] != null) { if (rsi[i] > rsi[i - 1] && rsi[i] >= 50) push(1, 'RSI rising above 50 (' + rsi[i].toFixed(0) + ')'); else if (rsi[i] < rsi[i - 1] && rsi[i] <= 50) push(-1, 'RSI falling below 50 (' + rsi[i].toFixed(0) + ')'); }
  if (last.c > hi15 * 0.999) push(1, 'Price near the 15-minute high'); else if (last.c < lo15 * 1.001) push(-1, 'Price near the 15-minute low');
  if (s && s.whaleNet5m != null) { if (s.whaleNet5m > 0) push(1, 'Whale net 5m positive'); else if (s.whaleNet5m < 0) push(-1, 'Whale net 5m negative'); }
  if (s && s.surge) push(s.side === 'UP' ? 1 : -1, 'Whale surge active');
  const signal = score >= 3 ? 'LONG' : score <= -3 ? 'SHORT' : 'WAIT';
  const entry = last.c, swingLo = Math.min.apply(null, cs.slice(-10).map(c => c.l)), swingHi = Math.max.apply(null, cs.slice(-10).map(c => c.h));
  const stop = signal === 'LONG' ? swingLo : signal === 'SHORT' ? swingHi : null;
  const risk = stop == null ? null : Math.abs(entry - stop);
  const target = stop == null ? null : signal === 'LONG' ? entry + 1.5 * risk : entry - 1.5 * risk;
  return { score, signal, entry, stop, target, risk, atr, rsi: rsi[i], factors, hi15, lo15 };
}

/* ---------- tiny web server (health check + status page) ---------- */
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
  const takeLosses = ROUNDS.filter(r => r.locked && r.locked.decision === 'TAKE' && effRes(r) === 'lost');
  const highAskLosses = takeLosses.filter(r => r.locked.ask != null && r.locked.ask >= 0.70).length;
  const smallEdgeLosses = takeLosses.filter(r => r.locked.edge != null && r.locked.edge < 0.07).length;
  const mismatchLosses = takeLosses.filter(r => r.mismatch).length;
  const P = paper();
  const learn1 = lossLearn();
  const rulesHtml = learn1.rules.length ? learn1.rules.map(ru => '<div style="margin-top:8px"><b>Active loss rule:</b> ' + esc(ru.label) + ' — ' + ru.w + '-' + ru.l + ' (' + Math.round(ru.winRate * 100) + '% vs ' + Math.round(ru.breakeven * 100) + '% breakeven). New TAKEs in this segment are downgraded to LEAN until it recovers.</div>').join('') : '<div class="muted" style="margin-top:8px">No segment has lost enough, on enough trades, to ban yet. Rules need 12+ TAKEs, 4+ losses, and a win rate 10+ points below breakeven.</div>';
  const brakeHtml = learn1.brake ? '<div style="margin-top:8px"><b>Loss brake active:</b> ' + learn1.consec + ' TAKE losses in a row, ' + learn1.last6Losses + ' in the last 6. New TAKEs are downgraded to LEAN until a win breaks the streak.</div>' : '';
  const cs1 = closedCandles(Date.now());
  const pats1 = detectPatterns(cs1);
  const scalp1 = scalpWatch(cs1, s);
  const patsHtml = pats1.length ? pats1.map(pp => '<div style="margin-top:10px"><b>' + (pp.dir > 0 ? '▲ ' : pp.dir < 0 ? '▼ ' : '◆ ') + esc(pp.name) + '</b> <span class="muted">· ' + esc(pp.status) + ' · ' + esc(pp.conf) + ' confidence</span><br><span class="muted">' + esc(pp.detail) + '</span></div>').join('') : '<div class="muted" style="margin-top:10px">No clean pattern right now — that is also information. Do not force a trade.</div>';
  const scalpHtml = scalp1 ? '<div><span class="pill" style="background:' + (scalp1.signal === 'LONG' ? 'rgba(52,211,153,.15);color:#34d399' : scalp1.signal === 'SHORT' ? 'rgba(251,113,133,.15);color:#fb7185' : 'rgba(251,191,36,.15);color:#fbbf24') + '">' + scalp1.signal + ' · score ' + scalp1.score + '</span></div><div style="margin-top:10px">Entry ' + fmtN(scalp1.entry, 0) + (scalp1.stop == null ? ' · stop/target: set only on a LONG or SHORT signal' : ' · stop ' + fmtN(scalp1.stop, 0) + ' · target ' + fmtN(scalp1.target, 0) + ' (1.5x risk)') + '</div><div class="muted" style="margin-top:6px">1m RSI ' + (scalp1.rsi == null ? '--' : scalp1.rsi.toFixed(0)) + ' · ATR (14x 1m) $' + fmtN(scalp1.atr, 0) + ' · 15m range $' + fmtN(scalp1.lo15, 0) + ' – $' + fmtN(scalp1.hi15, 0) + '</div><div class="muted" style="margin-top:6px">' + scalp1.factors.map(f => esc(f)).join(' · ') + '</div>' : '<div class="muted">Not enough 1-minute candles yet.</div>';
  const leanPct = s.prob == null ? 0 : Math.min(100, Math.max(0, s.prob));
  const heroTitle = s.locked ? 'LOCKED ' + esc(s.locked.side) + ' (' + esc(s.locked.decision) + ')' : 'Watching';
  const heroReason = s.locked ? esc(s.locked.reason) : 'Waiting for the next lock';
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Line Lock watcher</title>' +
    '<style>body{max-width:720px;margin:0 auto}h2{font-size:30px;letter-spacing:-.03em;font-weight:800}h3{font-size:19px;margin:32px 4px 12px;color:#cbd2e1}.card{background:linear-gradient(180deg,#1b1e2a,#14161f);border:1px solid #262a38;border-radius:24px;padding:18px 20px;margin:14px 0;box-shadow:0 8px 24px rgba(0,0,0,.28);overflow-wrap:anywhere}.hero{border:1px solid transparent;background:linear-gradient(#171924,#171924) padding-box,linear-gradient(135deg,#7c5cff,#00c2ff,#34d399) border-box}.big{font-size:42px;font-weight:800;letter-spacing:-.03em;line-height:1.1}.muted{color:#9aa3b2;font-size:14px}.pill{display:inline-block;padding:5px 12px;border-radius:999px;font-weight:700;font-size:14px;background:rgba(52,211,153,.15);color:#34d399}.pill-tape{background:rgba(124,92,255,.18);color:#c4b5fd}.bar{height:10px;border-radius:999px;background:#262a38;overflow:hidden;margin:10px 0}.bar>div{height:100%;background:linear-gradient(90deg,#7c5cff,#00c2ff)}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}.grid .card{margin:0}table{border-collapse:collapse;width:100%;background:#14161f;border:1px solid #262a38;border-radius:20px;overflow:hidden;display:block;overflow-x:auto}td,th{padding:12px 14px;border-bottom:1px solid #222634;text-align:left;white-space:nowrap}th{font-size:13px;color:#9aa3b2;font-weight:600}button{background:linear-gradient(135deg,#7c5cff,#00c2ff);color:#fff;border:0;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer;min-height:42px}select,input{background:#1b1e2a;color:#eef1f6;border:1px solid #2c3245;border-radius:14px;padding:11px 14px;min-height:42px}a{color:#7dd3fc;text-decoration:none}#edbox{display:none;position:fixed;top:18%;left:50%;transform:translateX(-50%);background:#1b1e2a;border:1px solid #2c3245;padding:20px;border-radius:20px;box-shadow:0 12px 32px rgba(0,0,0,.4);width:min(92vw,380px);z-index:10}details summary{cursor:pointer;color:#cbd2e1}@media(max-width:560px){.grid{grid-template-columns:1fr 1fr}.big{font-size:34px}}</style>' +
    '<body style="font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;color:#eef1f6;padding:16px"><h2>Line Lock</h2><p class="muted" style="margin-top:-8px">BTC 15-minute watcher · Live</p>' +
    '<div class="card hero"><span class="pill">&#9679; ' + heroTitle + '</span> <span class="pill pill-tape">' + heroReason + '</span>' +
    '<div class="big" style="margin-top:12px">' + (s.price == null ? '--' : usd(s.price)) + '</div>' +
    '<div class="muted">Line ' + (s.line == null ? '--' : usd(s.line)) + ' (' + (s.lineFrom || '--') + ') · ' + (s.left || '--') + ' left · lean ' + (s.side || '--') + ' ' + (s.prob || '--') + '% · ' + (s.verdict || '--') + '</div>' +
    '<div style="margin-top:14px"><b>Lean ' + (s.side || '--') + ' ' + (s.prob || '--') + '%</b> <span class="muted">· model up ' + (s.rawProbUp == null ? '--' : s.rawProbUp + '%') + ' · Kalshi up ' + (s.marketProbUp == null ? '--' : s.marketProbUp + '%') + ' · edge ' + (s.edgeCents == null ? '--' : (s.edgeCents >= 0 ? '+' : '') + s.edgeCents + 'c') + (s.stake ? ' · quarter-Kelly ' + usd(s.stake, 0) : '') + '</span></div>' +
    '<div class="bar"><div style="width:' + leanPct + '%"></div></div>' +
    '<div class="muted">' + (s.feeds || 0) + ' feeds live · RSI 1m ' + (s.rsi1 == null ? '--' : s.rsi1) + ' · whale net 5m ' + (s.whaleNet5m == null ? '--' : usdK(s.whaleNet5m)) + (s.surge ? ' · SURGE' : '') + '</div>' +
    '<div style="margin-top:8px">' + feeds + '</div></div>' +
    '<div class="grid"><div class="card"><div class="muted">All locks</div><div style="font-size:26px;font-weight:800">' + wr(st.all.w, st.all.l) + '</div><div class="muted">' + st.all.w + '-' + st.all.l + '</div></div><div class="card"><div class="muted">TAKE only</div><div style="font-size:26px;font-weight:800">' + wr(st.take.w, st.take.l) + '</div><div class="muted">' + st.take.w + '-' + st.take.l + ' · ' + (st.take.pnl >= 0 ? '+' : '-') + usd(Math.abs(st.take.pnl)) + ' / contract</div></div><div class="card"><div class="muted">Paper balance</div><div style="font-size:26px;font-weight:800">' + usd(P.balance) + '</div><div class="muted">' + (P.pnl >= 0 ? '+' : '-') + usd(Math.abs(P.pnl)) + ' · ROI ' + (P.roi == null ? '--' : (P.roi * 100).toFixed(1) + '%') + '</div></div></div>' +
    '<h3>1-minute chart</h3><div class="card">' + chartSvg(cs1, s.line) + '</div>' + '<div class="card"><h3 style="margin:0 0 8px">Pattern recognition</h3><div class="muted">Live 1-minute patterns, plus the candlestick signals this watcher already backtests. Patterns are probabilities, not guarantees — forming patterns still need a breakout to confirm.</div>' + patsHtml + '</div>' + '<div class="card"><h3 style="margin:0 0 8px">Scalp watch</h3>' + scalpHtml + '<div class="muted" style="margin-top:10px">Separate from the 15-minute Line Lock. This watcher never trades. A scalp is only a short price watch — if price breaks the stop, the idea is wrong.</div></div>' + '<div class="card"><h3 style="margin:0 0 8px;color:#fda4af">What losses are teaching</h3>' +
    '<div>TAKE losses so far: <b>' + takeLosses.length + '</b> · at 70c or higher: <b>' + highAskLosses + '</b> · with under 7c edge: <b>' + smallEdgeLosses + '</b> · where Kalshi settlement differed: <b>' + mismatchLosses + '</b></div>' +
    '<div style="margin-top:10px" class="muted">Expensive TAKEs need a much higher win rate to break even, and small edges are mostly noise. Suggested paper test: no TAKE under +10c edge, a higher bar over 65c, and cap risk at 1-2% per trade. Never increase size after a loss.</div>' +
    (st.take.n < 200 ? '<div style="margin-top:8px" class="muted"><i>Under 200 TAKEs, too early to judge — treat these as lessons to test, not final rules.</i></div>' : '') + rulesHtml + brakeHtml + '</div>' +
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
    'setInterval(function(){if(!editing)location.reload()},5000)</script></body>';
}
function paperCard() {
  const P = paper(), sg = v => (v >= 0 ? '+' : '-') + usd(Math.abs(v)), tr = t => t ? sg(t.pnl) + ' (' + etDate(t.end) + ' ' + etTime(t.end) + ' ET, ' + t.contracts + 'x ' + esc(t.side) + ' @ ' + cents(t.ask) + ')' : '--';
  return '<h3>Paper trading</h3><div style="border:1px solid #262a38;border-radius:24px;padding:18px 20px;background:linear-gradient(180deg,#1b1e2a,#14161f);display:inline-block">' +
    'Balance <b>' + usd(P.balance) + '</b> (start ' + usd(P.start) + ', ' + (P.mode === 'kelly' ? 'quarter-Kelly capped, ' + usd(P.fixedStake, 0) + ' fallback' : 'fixed ' + usd(P.fixedStake, 0)) + ')<br>' +
    'P/L <b style="color:' + (P.pnl >= 0 ? '#34d399' : '#fb7185') + '">' + sg(P.pnl) + '</b> · ROI ' + (P.roi == null ? '--' : (P.roi * 100).toFixed(1) + '%') + ' · win rate ' + pct(P.winRate) + ' (' + P.wins + '-' + P.losses + (P.open ? ', ' + P.open + ' open' : '') + ') · fees ' + usd(P.fees) + '<br>' +
    'Max drawdown ' + usd(P.maxDrawdown) + ' (' + (P.maxDrawdownPct * 100).toFixed(1) + '%) · best ' + tr(P.best) + ' · worst ' + tr(P.worst) + '<br>' +
    '<span style="color:#7a899f">Simulated buys at the ask at lock time on every TAKE; edits recompute it. <a style="color:#7a899f" href="/api/paper">json</a> · <a style="color:#7a899f" href="/api/export.csv">csv</a></span></div>';
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
  startServer();
  pollPrices(); pollTrades(); pollBook(); pollCandles(); pollKalshi();
  setInterval(pollPrices, 2000); setInterval(pollTrades, 2500); setInterval(pollBook, 3000); setInterval(pollCandles, 4000); setInterval(pollKalshi, 2000);
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
module.exports = { S, CFG, tick, newRound, getR: () => R, push, checksFor, analyze, getStatus: () => STATUS, stats, kalshiFee, kelly, effRes, lossLearn, lossSegmentStats };
