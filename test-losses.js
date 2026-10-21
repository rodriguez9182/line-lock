'use strict';
const assert = require('assert'), m = require('./server.js');
const T0 = 1760000000000, rounds = [];
for (let i = 0; i < 12; i++) {
  const win = i % 3 !== 0;
  rounds.push({ id: T0 + i * 9e5, end: T0 + i * 9e5, line: 100000, fin: win ? 100050 : (i === 0 ? 100003 : 99950), up: win, source: 'kalshi',
    locked: { side: 'UP', decision: i === 3 ? 'LEAN' : 'TAKE', reason: i === 6 ? 'Whale surge buying $400k in 90s' : 'All signs aligned', prob: 0.8, ask: i === 9 ? 0.85 : 0.7, edge: 0.05, left: 500, gap: 30, passN: 6, total: 7,
      ctx: { z: win ? 2 : 0.9, sigUsd: 60, mktUp: 0.6, vol60: win ? 900000 + i : 100000 + i, buyPct60: win ? 60 : 40, whaleNet300: 0 },
      track: { minMargin: -20, crossedAt: T0 + i * 9e5 - 60000, wrongSideSecs: 10, ticks: 100, buyUsd: 1, sellUsd: win ? 0 : 5 } } });
}
rounds.push({ id: 1, end: 1, line: 1, fin: 0, up: false, locked: { side: 'UP', decision: 'TAKE', reason: 'All signs aligned', prob: 0.7, ask: 0.6, edge: 0.05, left: 100 } });
m.setRounds(rounds);
const X = m.lossAnalysis();
assert.strictEqual(X.settled, 13); assert.strictEqual(X.losses, 5);
const ids = X.reasons.map(r => r.id);
['lowVolume', 'volAgainst', 'flowAgainst', 'thinGap', 'lateReverse', 'coinflip', 'marketDisagreed'].forEach(k => assert(ids.includes(k), 'missing ' + k));
assert(X.recentLosses.every(l => l.reasons.length > 0));
assert(X.note && /1 older/.test(X.note));
console.log('loss analysis ok:', X.losses, 'losses;', X.reasons.slice(0, 4).map(r => r.id + '=' + r.losses).join(', '));
/* feedback loop: 40 locks, every low-volume lock loses -> volume floor should be learned, bounded, logged, revertable */
m.CFG.dataDir = require('fs').mkdtempSync('/tmp/llt-');
const R2 = [];
for (let i = 0; i < 40; i++) { const low = i % 2 === 0, win = !low || i % 8 === 0;
  R2.push({ id: T0 + i * 9e5, end: T0 + i * 9e5, line: 100000, fin: win ? 100080 : 99920, up: win, locked: { side: 'UP', decision: 'TAKE', reason: 'All signs aligned', prob: 0.75, ask: 0.6, edge: 0.15, left: 300, passN: 7, total: 7,
    ctx: { z: 2, sigUsd: 60, vol60: low ? 50000 + i : 2000000 + i, buyPct60: 60, whaleNet300: 0 } } }); }
m.setRounds(R2);
const before = m.K_('minVol60'); m.learnFromLosses('test');
const after = m.K_('minVol60'), st = m.learnState();
assert.strictEqual(before, 0); assert(after > 0, 'volume floor learned');
assert(st.log.some(l => l.knob === 'minVol60' && l.action === 'tighten'));
assert.strictEqual(m.K_('minEdge'), m.CFG.minEdge, 'unrelated knob untouched');
m.CFG.learn = false; assert.strictEqual(m.K_('minVol60'), 0, 'LEARN=0 falls back to defaults');
m.setRounds(R2.slice(0, 10)); m.CFG.learn = true; const n = st.log.length; m.learnFromLosses('small'); assert.strictEqual(m.learnState().log.length, n, 'no change under min sample');
console.log('feedback loop ok: minVol60 0 ->', after);
