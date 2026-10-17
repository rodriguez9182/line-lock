'use strict';
/*
  Line Lock watcher
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
*/
const http = require('http');

const CFG = {
  topic: process.env.NTFY_TOPIC || '',
  ntfy: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
  whale: +process.env.WHALE_USD || 150000,
  port: +process.env.PORT || 3000,
  series: process.env.KALSHI_SERIES || 'KXBTC15M',
  results: process.env.RESULT_ALERTS !== '0',
  whaleAlerts: process.env.WHALE_ALERTS === '1'
};
const ROUND_MS = 900000;
const UA = { 'User-Agent': 'line-lock-watcher/1.0', 'Accept': 'application/json' };

/* ---------- small helpers ---------- */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const fmtN = (n, d = 2) => (n == null || !isFinite(n)) ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n, d = 2) => (n == null || !isFinite(n)) ? '--' : '$' + fmtN(n, d);
const usdK = n => { const a = Math.abs(n); return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'k' : a.toFixed(0)); };
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const etTime = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const erf = x => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));

/* ---------- state ---------- */
const FEEDS = {
  coinbase: { name: 'Coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', parse: j => +j.price },
  kraken: { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: j => +j.result[Object.keys(j.result)[0]].c[0] },
  bitstamp: { name: 'Bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: j => +j.last },
  gemini: { name: 'Gemini', url: 'https://api.gemini.com/v1/pubticker/btcusd', parse: j => +j.last },
  bitfinex: { name: 'Bitfinex', url: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD', parse: j => +j[6] }
};
const S = { prices: {}, trades: [], seen: new Set(), candles: new Map(), book: null, liq: [], hist: [], bt: null, clusters: [], kalshi: null, diag: {}, pend: [], scanT: null, liveP: {} };
let R = null, persist = 0, lastCand = null, STATUS = {}, RECENT = [], lastWhaleAlert = 0;

function newRound(end) { R = { end, start: end - ROUND_MS, line: null, lineFrom: null, locked: null, lean: null, surgeNotified: false }; persist = 0; lastCand = null; return R; }

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
function patWeight(p) {
  const r = S.bt && S.bt.res[p.id]; if (!r || r.n < 30) return 0;
  const hit = r.w / r.n, base = p.dir > 0 ? S.bt.base : 1 - S.bt.base, edge = hit - base, se = Math.sqrt(0.25 / r.n);
  return Math.abs(edge) >= 1.5 * se ? clamp(edge / 0.08, -1, 1) : 0;
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
const liveFeeds = now => Object.keys(S.prices).filter(k => S.prices[k] && now - S.prices[k].t < 8000).map(k => ({ k, p: S.prices[k].p }));

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
  const kpS = sgn > 0 ? c.kpYes : c.kpNo;
  if (kpS != null) { const ps = sgn > 0 ? c.probUp : 1 - c.probUp; out.push({ id: 'price', label: 'Worth the price', ok: ps >= kpS / 100 + 0.05, detail: 'model ' + Math.round(ps * 100) + '% vs ' + Math.round(kpS) + 'c' }); }
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
  const closed = recent.filter(c => c.t + 60000 <= now), rets = [];
  for (let i = Math.max(1, closed.length - 30); i < closed.length; i++) rets.push(Math.log(closed[i].c / closed[i - 1].c));
  let sig = sd(rets); if (sig == null || !isFinite(sig)) sig = 0.0004; sig = Math.max(sig, 0.00012);
  const minsLeft = Math.max(left / 60, 0.35), px = price != null ? price : (n ? recent[n - 1].c : null);
  const sigUsd = px ? px * sig * Math.sqrt(minsLeft) : null;
  const gap = (price != null && line != null) ? price - line : null, z = (gap != null && sigUsd) ? gap / sigUsd : null;
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
  const zAdj = z != null ? z + 0.6 * tilt : null, probUp = zAdj != null ? Phi(zAdj) : null;
  const side = probUp == null ? null : (probUp >= 0.5 ? 'UP' : 'DOWN'), sgn = side === 'UP' ? 1 : -1;
  const probSide = probUp == null ? null : Math.max(probUp, 1 - probUp), strength = probUp == null ? 0 : Math.round(Math.abs(probUp - 0.5) * 200);
  const ctx = { z, line, live, f60, f300, w300, thr, ema9, ema21, rsi1, rsi5, kpYes, kpNo, probUp };
  const checks = side ? checksFor(sgn, ctx) : [];
  const counted = checks.filter(c => !c.na), passN = counted.filter(c => c.ok).length, missing = counted.filter(c => !c.ok).map(c => c.label);
  const aligned = side ? sgn * tilt >= 0.1 : false;
  const verdict = !side ? 'SKIP' : (counted.length && passN === counted.length && aligned ? 'TAKE' : (passN >= counted.length - 1 || strength >= 40 ? 'WAIT' : 'SKIP'));
  const surgeSgn = w90.net >= 2 * thr ? 1 : (w90.net <= -2 * thr ? -1 : 0);
  let surge = false;
  if (surgeSgn > 0) surge = w90.nb >= 2 || w90.net >= 4 * thr;
  if (surgeSgn < 0) surge = w90.ns >= 2 || -w90.net >= 4 * thr;
  let whaleOk = false;
  if (surge && gap != null) {
    const by = {}; checksFor(surgeSgn, ctx).forEach(c => { by[c.id] = c; });
    whaleOk = surgeSgn * gap > 0 && by.exch.ok && by.rsi.ok && (f60.buyPct == null || surgeSgn * (f60.buyPct - 50) >= -5);
  }
  return { now, live, price, left, line, rsi1, rsi5, ema9, ema21, sigUsd, gap, z, f60, f300, w90, w300, firing, tilt, kpYes, kpNo, K, probUp, side, sgn, probSide, strength, checks, passN, total: counted.length, missing, verdict, surge, surgeSgn, whaleOk };
}

/* ---------- push ---------- */
async function push(title, body, priority, tags) {
  if (!CFG.topic) { console.log('[push skipped, no NTFY_TOPIC]', title, '|', body); return false; }
  try {
    const r = await fetch(CFG.ntfy + '/' + encodeURIComponent(CFG.topic), { method: 'POST', headers: { Title: title, Priority: priority || 'default', Tags: tags || '' }, body });
    if (!r.ok) console.log('ntfy HTTP', r.status);
    return r.ok;
  } catch (e) { console.log('ntfy error', e.message); return false; }
}

/* ---------- round logic ---------- */
function finalize() {
  if (R.line == null || !R.locked) return;
  const pts = S.hist.filter(h => h.t >= R.end - 60000 && h.t <= R.end + 2000).map(h => h.p);
  const fin = pts.length ? mean(pts) : (S.hist.length ? S.hist[S.hist.length - 1].p : null); if (fin == null) return;
  const d = fin - R.line, res = d === 0 ? 'push' : (((d > 0) === (R.locked.side === 'UP')) ? 'won' : 'lost');
  RECENT.unshift({ end: R.end, side: R.locked.side, reason: R.locked.reason, line: R.line, fin, res }); RECENT = RECENT.slice(0, 30);
  if (CFG.results) push('Result: ' + R.locked.side + ' ' + res.toUpperCase(), 'Round ending ' + etTime(R.end) + ' ET. Line ' + usd(R.line) + ', final ' + usd(fin) + ' (' + (d >= 0 ? '+' : '-') + usd(Math.abs(d)) + ').', res === 'won' ? 'default' : 'low', res === 'won' ? 'white_check_mark' : 'x');
}
function rollRound(now) { while (now >= R.end) { finalize(); newRound(R.end + ROUND_MS * Math.max(1, Math.floor((now - R.end) / ROUND_MS))); } }
function applyAutoLine(A, now) {
  const K = S.kalshi;
  if (K && K.strike != null && Math.abs(K.close - R.end) < 5000 && now - K.t < 30000) { R.line = K.strike; R.lineFrom = 'kalshi'; return; }
  const c = S.candles.get(R.start);
  if (c) { R.line = c.o; R.lineFrom = 'candle'; } else if (R.line == null && A.price != null && now - R.start < 30000) { R.line = A.price; R.lineFrom = 'price'; }
}
function lockLogic(A, now) {
  if (R.locked || A.price == null || R.line == null || !A.side) { persist = 0; lastCand = null; return; }
  const inWin = A.left <= 720 && A.left >= 45; let cand = null;
  if (inWin && A.verdict === 'TAKE') cand = { side: A.side, reason: 'All signs aligned' };
  else if (inWin && A.whaleOk) cand = { side: A.surgeSgn > 0 ? 'UP' : 'DOWN', reason: 'Whale surge ' + (A.surgeSgn > 0 ? 'buying ' : 'selling ') + usdK(Math.abs(A.w90.net)) + ' in 90s' };
  if (cand && cand.side === lastCand) persist++; else persist = cand ? 1 : 0;
  lastCand = cand ? cand.side : null;
  if (cand && persist >= 4) {
    const sg = cand.side === 'UP' ? 1 : -1, pr = A.probUp == null ? null : (sg > 0 ? A.probUp : 1 - A.probUp), ask = sg > 0 ? A.kpYes : A.kpNo;
    R.locked = { side: cand.side, t: now, px: A.price, gap: A.gap, prob: pr, reason: cand.reason, left: A.left };
    const body = usd(A.price) + ' vs line ' + usd(R.line) + ' (' + (A.gap >= 0 ? '+' : '-') + usd(Math.abs(A.gap)) + '). Model ' + (pr == null ? '--' : Math.round(pr * 100) + '%') + (ask != null ? ', Kalshi ask ' + Math.round(ask) + 'c' : '') + '. ' + cand.reason + '. ' + mmss(A.left) + ' left.';
    console.log('LOCK', cand.side, body);
    push('LOCKED ' + cand.side + ' - BTC 15m', body, 'urgent', cand.side === 'UP' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend');
  }
}
function whaleHeadsUp(A, now) {
  if (!CFG.whaleAlerts || R.locked || R.surgeNotified || !A.surge || A.left < 45 || A.left > 720) return;
  R.surgeNotified = true;
  push('Whale surge ' + (A.surgeSgn > 0 ? 'buying' : 'selling'), usdK(Math.abs(A.w90.net)) + ' net in 90s. Price ' + usd(A.price) + (R.line != null ? ' vs line ' + usd(R.line) : '') + '. Not locked: ' + (A.whaleOk ? 'waiting to hold 4s' : 'line side, exchanges or RSI do not agree') + '.', 'high', 'whale');
}
function leanLogic(A, now) { if (!R.lean && A.left <= 240 && A.left >= 150 && A.price != null && R.line != null && A.side) R.lean = { side: A.side, verdict: A.verdict }; }

function tick() {
  const now = Date.now();
  rollRound(now);
  const pre = liveFeeds(now); if (pre.length) S.hist.push({ t: now, p: mean(pre.map(f => f.p)) });
  while (S.hist.length && S.hist[0].t < now - 20 * 60000) S.hist.shift();
  let A = analyze(now); applyAutoLine(A, now); if (R.line !== A.line) A = analyze(now);
  lockLogic(A, now); leanLogic(A, now); whaleHeadsUp(A, now);
  S.liq = S.liq.filter(x => now - x.t <= 3600000);
  STATUS = {
    time: new Date(now).toISOString(), left: mmss(A.left), feeds: A.live.length, price: A.price, line: R.line, lineFrom: R.lineFrom,
    side: A.side, strength: A.strength, prob: A.probSide == null ? null : Math.round(A.probSide * 100), verdict: A.verdict,
    checks: A.checks.map(c => (c.na ? '-' : c.ok ? 'pass' : 'FAIL') + ' ' + c.label + ' (' + c.detail + ')'),
    whaleNet5m: Math.round(A.w300.net), surge: A.surge, rsi1: A.rsi1 == null ? null : +A.rsi1.toFixed(1), rsi5: A.rsi5 == null ? null : +A.rsi5.toFixed(1),
    locked: R.locked ? { side: R.locked.side, at: new Date(R.locked.t).toISOString(), reason: R.locked.reason } : null,
    kalshi: A.K ? { ticker: A.K.ticker, yesAsk: A.K.yesAsk, noAsk: A.K.noAsk } : null, diag: S.diag, topicSet: !!CFG.topic
  };
  return A;
}

/* ---------- data pollers ---------- */
async function getJSON(url, ms) {
  let host = ''; try { host = new URL(url).hostname; } catch (e) { }
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms || 6000) });
    if (!r.ok) { S.diag[host] = 'HTTP ' + r.status; throw new Error('HTTP ' + r.status); }
    S.diag[host] = 'ok'; return await r.json();
  } catch (e) { if (!S.diag[host] || S.diag[host] === 'ok') S.diag[host] = e.name === 'TimeoutError' ? 'timed out' : 'error'; throw e; }
}
const quiet = p => p.catch(() => { });
function pollPrices() { Object.keys(FEEDS).forEach(k => quiet(getJSON(FEEDS[k].url).then(j => { const p = FEEDS[k].parse(j); if (isFinite(p) && p > 0) S.prices[k] = { p, t: Date.now() }; }))); }
function pollTrades() {
  quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=100').then(j => addTrades(j.map(x => ({ id: x.trade_id, t: Date.parse(x.time), ex: 'coinbase', side: x.side === 'buy' ? 'sell' : 'buy', btc: +x.size, px: +x.price })))));
  quiet(getJSON('https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=100').then(j => { const k = Object.keys(j.result).filter(x => x !== 'last')[0]; addTrades(j.result[k].map(x => ({ id: x[6] || (x[2] + '-' + x[1]), t: Math.round(x[2] * 1000), ex: 'kraken', side: x[3] === 'b' ? 'buy' : 'sell', btc: +x[1], px: +x[0] }))); }));
  quiet(getJSON('https://api.gemini.com/v1/trades/btcusd?limit_trades=100').then(j => addTrades(j.map(x => ({ id: x.tid, t: x.timestampms, ex: 'gemini', side: x.type === 'buy' ? 'buy' : 'sell', btc: +x.amount, px: +x.price })))));
}
function makeBook(bids, asks) {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2, lo = mid * (1 - 0.0015), hi = mid * (1 + 0.0015); let bu = 0, au = 0;
  bids.forEach(l => { if (l[0] >= lo) bu += l[0] * l[1]; }); asks.forEach(l => { if (l[0] <= hi) au += l[0] * l[1]; });
  return { mid, bu, au, imb: (bu + au) > 0 ? (bu - au) / (bu + au) : 0 };
}
function pollBook() { quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2').then(j => { S.book = makeBook(j.bids.map(x => [+x[0], +x[1]]), j.asks.map(x => [+x[0], +x[1]])); })); }
function putCandles(j) { j.forEach(x => { const t = x[0] * 1000; S.candles.set(t, { t, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] }); }); }
function pollCandles() { quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60').then(putCandles)); }
function pollKalshi() {
  quiet(getJSON('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + encodeURIComponent(CFG.series) + '&status=open&limit=20').then(j => {
    const now = Date.now(), ms = (j.markets || []).map(m => ({ m, close: Date.parse(m.close_time) })).filter(x => x.close > now - 1000).sort((a, b) => a.close - b.close);
    if (!ms.length) return;
    const x = ms[0], m = x.m, d = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const px = (dol, cents) => { const a = d(dol); if (a != null) return a; const b = d(cents); return b != null ? b / 100 : null; };
    S.kalshi = { t: Date.now(), ticker: m.ticker, close: x.close, strike: d(m.floor_strike), yesAsk: px(m.yes_ask_dollars, m.yes_ask), noAsk: px(m.no_ask_dollars, m.no_ask) };
  }));
}
async function loadHistory() {
  for (let k = 0; k < 6; k++) {
    const end = Date.now() - k * 295 * 60000, start = end - 295 * 60000;
    await quiet(getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=' + new Date(start).toISOString() + '&end=' + new Date(end).toISOString(), 9000).then(putCandles));
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

/* ---------- tiny web server (health check + status page) ---------- */
function page() {
  const s = STATUS, rows = (s.checks || []).map(c => '<li>' + c + '</li>').join('');
  const rec = RECENT.map(r => '<li>' + etTime(r.end) + ' ET · ' + r.side + ' · ' + r.res + ' · line ' + fmtN(r.line, 0) + ' to ' + fmtN(r.fin, 0) + '</li>').join('') || '<li>none yet</li>';
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Line Lock watcher</title>' +
    '<body style="font:14px/1.5 ui-monospace,monospace;background:#0a0e15;color:#e8eef8;padding:16px"><h2>Line Lock watcher</h2>' +
    '<p>' + (s.locked ? '<b>LOCKED ' + s.locked.side + '</b> · ' + s.locked.reason : 'Watching') + ' · ' + (s.left || '--') + ' left</p>' +
    '<p>price ' + usd(s.price) + ' · line ' + usd(s.line) + ' (' + (s.lineFrom || '--') + ') · lean ' + (s.side || '--') + ' ' + (s.prob || '--') + '% · ' + (s.verdict || '--') + '</p>' +
    '<p>' + (s.feeds || 0) + ' feeds live · RSI 1m ' + (s.rsi1 == null ? '--' : s.rsi1) + ' · whale net 5m ' + (s.whaleNet5m == null ? '--' : usdK(s.whaleNet5m)) + (s.surge ? ' · SURGE' : '') + '</p>' +
    '<ul>' + rows + '</ul><p>Recent locked rounds</p><ul>' + rec + '</ul><p>Alerts: ' + (s.topicSet ? 'topic set' : '<b>NTFY_TOPIC is not set</b>') + '</p>' +
    '<p style="color:#7a899f">' + JSON.stringify(s.diag || {}) + '</p></body>';
}
function startServer() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (u.pathname === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(STATUS, null, 2)); }
    if (u.pathname === '/test') {
      if (!CFG.topic || u.searchParams.get('key') !== CFG.topic) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Add ?key=YOUR_TOPIC_NAME to the address'); }
      const ok = await push('Test - Line Lock', 'If you can read this on your phone, alerts work.', 'high', 'bell');
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ok ? 'sent' : 'failed, check the topic name and the logs');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page());
  });
  srv.listen(CFG.port, () => console.log('status page on port', CFG.port));
}

function main() {
  newRound(Math.floor(Date.now() / ROUND_MS) * ROUND_MS + ROUND_MS);
  console.log('Line Lock watcher starting. Alerts topic set:', !!CFG.topic, '| whale size', usdK(CFG.whale));
  startServer();
  pollPrices(); pollTrades(); pollBook(); pollCandles(); pollKalshi();
  setInterval(pollPrices, 2000); setInterval(pollTrades, 2500); setInterval(pollBook, 3000); setInterval(pollCandles, 4000); setInterval(pollKalshi, 2000);
  loadHistory(); connectLiq();
  setInterval(() => { try { tick(); } catch (e) { console.log('tick error', e.stack || e.message); } }, 1000);
  setInterval(() => { if (S.candles.size > 200) runBacktest(); }, 30 * 60000);
  /* Keep a free Render instance awake: it visits its own public address every 8 minutes.
     Render sets RENDER_EXTERNAL_URL on its own, so nothing to configure. */
  if (process.env.RENDER_EXTERNAL_URL) {
    const self = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/health';
    setInterval(() => { fetch(self, { signal: AbortSignal.timeout(10000) }).catch(() => { }); }, 8 * 60000);
    console.log('keep-awake ping on', self);
  }
}
if (require.main === module) main();
module.exports = { S, CFG, tick, newRound, getR: () => R, push, checksFor, analyze, getStatus: () => STATUS };
