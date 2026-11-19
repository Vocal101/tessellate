// Tessellate determinism suite: `npm test` (or `node tests/determinism.test.js [minutes]`).
// Checks that the lockstep simulation is bit-for-bit reproducible, that two peers never diverge,
// that desyncs are caught, and that replays round-trip.
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load');
const TS = load();

const LONG_MIN = +process.argv[2] || 20;     // cap for the long CPU-vs-CPU match, in game minutes
const HZ = TS.HZ;
let pass = 0, fail = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { const note = fn(); pass++; console.log(`  ok   ${name}${note ? '  — ' + note : ''}  (${Date.now() - t0} ms)`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'mismatch'}: ${a} !== ${b}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }

// CPU vs CPU through a Session (the real input path). Returns the session.
function cpuMatch(seed, ticks, l0 = 'normal', l1 = 'normal') {
  const w = new TS.World({ seed });
  const s = new TS.Session({ world: w, delay: 3, cpus: [{ pid: 0, cpu: new TS.Cpu(w, 0, l0, seed) }, { pid: 1, cpu: new TS.Cpu(w, 1, l1, seed) }] });
  while (!w.over && w.tick < ticks) s.step();
  return s;
}

console.log('Tessellate determinism tests');

test('isqrt is exact', () => {
  for (let n = 0; n < 200000; n++) { const r = TS.isqrt(n); if (r * r > n || (r + 1) * (r + 1) <= n) throw new Error('isqrt ' + n); }
  for (const n of [2 ** 30 - 1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 40 + 3, 9e15]) { const r = TS.isqrt(n); ok(r * r <= n && (r + 1) * (r + 1) > n, 'isqrt ' + n); }
});

test('seeded RNG is reproducible', () => {
  const a = new TS.Rng(42), b = new TS.Rng(42), c = new TS.Rng(43);
  let same = true, diff = false;
  for (let i = 0; i < 1000; i++) { const x = a.next(), y = b.next(); if (x !== y) same = false; if (x !== c.next()) diff = true; }
  ok(same && diff);
});

test('maps are 180° symmetric and connected', () => {
  for (const seed of [1, 2, 3, 12345, 0xdeadbeef]) {
    const m = TS.genMap(seed), N = m.W * m.H;
    for (let i = 0; i < N; i++) if (m.terrain[i] !== m.terrain[N - 1 - i]) throw new Error('asymmetric map, seed ' + seed);
    const w = new TS.World({ seed });
    const core1 = w.blds.find(b => b.owner === 1);
    const f = w.flow.forEnt(core1);
    const u0 = w.units.find(u => u.owner === 0);
    ok(f.dir[w.tileOf(u0.x, u0.y)] < 8, 'base 1 unreachable from base 0, seed ' + seed);
  }
});

test('source audit: no floats, clocks or Math.random in sim code', () => {
  const bad = /Math\.(random|sin|cos|tan|atan2?|sqrt|pow|exp|log|hypot|cbrt)\b|\bDate\b|performance\.|toFixed|parseFloat/;
  const files = ['js/sim/fixed.js', 'js/sim/defs.js', 'js/sim/map.js', 'js/sim/flow.js', 'js/sim/world.js', 'js/sim/ai.js', 'js/lockstep.js'];
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (bad.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  ok(!hits.length, 'forbidden calls:\n' + hits.join('\n'));
});

let ref = null;
test('same seed + same inputs = same hash, run after run', () => {
  const T = 8 * 60 * HZ;
  const a = cpuMatch(777, T), b = cpuMatch(777, T);
  eq(a.world.hash(true), b.world.hash(true), 'CPU vs CPU reruns differ');
  eq(JSON.stringify(a.log), JSON.stringify(b.log), 'input logs differ');
  // Feed run A's inputs to a fresh world: must land on the same state.
  const rp = new TS.ReplayPlayer(JSON.parse(JSON.stringify(a.replay())));
  ok(rp.run() === true, 'replaying the input log did not reproduce the hash');
  const c = cpuMatch(778, T);
  ok(c.world.hash(true) !== a.world.hash(true), 'different seeds should differ');
  ref = a;
  return `${a.log.length} input batches, tick ${a.world.tick}, hash ${a.world.hash(true)}`;
});

test(`two sims fed the same inputs never diverge (CPU vs CPU, up to ${LONG_MIN} min)`, () => {
  const seed = 31337;
  const A = new TS.World({ seed }), B = new TS.World({ seed });
  const cpus = [new TS.Cpu(A, 0, 'hard', seed), new TS.Cpu(A, 1, 'normal', seed)];
  const queue = new Map();
  let maxUnits = 0;
  while (!A.over && A.tick < LONG_MIN * 60 * HZ) {
    const t = A.tick;
    for (let p = 0; p < 2; p++) {
      const cmds = cpus[p].tickCmds();
      const k = t + 3; let s = queue.get(k); if (!s) { s = [[], []]; queue.set(k, s); }
      s[p] = JSON.parse(JSON.stringify(cmds));            // what goes over the wire
    }
    const s = queue.get(t) || [[], []]; queue.delete(t);
    A.step(s); B.step(JSON.parse(JSON.stringify(s)));
    const ha = A.hash(false), hb = B.hash(false);
    if (ha !== hb) throw new Error(`diverged at tick ${t}: ${ha} vs ${hb}`);
    if (A.units.length > maxUnits) maxUnits = A.units.length;
  }
  eq(A.hash(true), B.hash(true), 'full hash (incl. fog) differs');
  // Every number in the state must be an integer.
  for (const e of A.ents) for (const k in e) {
    const v = e[k];
    if (typeof v === 'number' && !Number.isInteger(v)) throw new Error(`non-integer ${k}=${v} on entity ${e.id}`);
  }
  for (const p of A.players) for (const k of ['res', 'sup', 'cap']) ok(Number.isInteger(p[k]), 'player ' + k);
  return `${A.tick} ticks (${(A.tick / HZ / 60).toFixed(1)} min), peak ${maxUnits} units, winner ${A.winner}`;
});

// Two Sessions talking over a fake network with seeded random latency and jitter.
function netMatch(seed, ticks, opts = {}) {
  const lat = new TS.Rng(seed ^ 0x77);
  const wires = [[], []];   // messages in flight to peer i: {at, msg}
  let now = 0;
  const peers = [0, 1].map(pid => {
    const w = new TS.World({ seed });
    const sess = new TS.Session({ world: w, delay: 4, humans: [pid], remote: 1 - pid,
      send: msg => wires[1 - pid].push({ at: now + 20 + lat.int(opts.jitter || 120) + (lat.int(50) === 0 ? 400 : 0), msg: JSON.parse(JSON.stringify(msg)) }) });
    return { pid, w, sess, bot: new TS.Cpu(w, pid, pid ? 'normal' : 'hard', seed), next: pid * 17, stalls: 0 };
  });
  while (now < ticks * 50 * 4 && peers.some(p => p.w.tick < ticks && !p.w.over)) {
    now += 5;
    for (let i = 0; i < 2; i++) {
      const inbox = wires[i];
      for (let k = 0; k < inbox.length;) { if (inbox[k].at <= now) { peers[i].sess.receive(inbox[k].msg); inbox.splice(k, 1); } else k++; }
    }
    for (const P of peers) {
      if (P.w.tick >= ticks || P.w.over || now < P.next) continue;
      if (!P.sess.canStep()) { P.stalls++; continue; }
      // The bot plays as a human would: look at the screen, issue commands into the session.
      for (const c of P.bot.tickCmds()) P.sess.issue(P.pid, c);
      if (opts.tamper && P.pid === 1 && P.w.tick === opts.tamper) P.w.units[0].hp -= 1;
      P.sess.step();
      P.next += 50;
    }
  }
  return peers;
}

test('lockstep over a laggy fake network: peers stall, never desync', () => {
  const T = 6 * 60 * HZ;
  const [a, b] = netMatch(4242, T);
  ok(!a.sess.desync && !b.sess.desync, 'desync reported: ' + JSON.stringify(a.sess.desync || b.sess.desync));
  eq(a.w.tick, b.w.tick, 'tick counts');
  eq(a.w.hash(true), b.w.hash(true), 'final hashes');
  ok(a.sess.lastHashTick > T - 50, 'hash exchange stopped early at ' + a.sess.lastHashTick);
  return `tick ${a.w.tick}, stalls ${a.stalls}/${b.stalls}, hashes compared up to ${a.sess.lastHashTick}`;
});

test('desync is detected within a few ticks', () => {
  const [a, b] = netMatch(99, 1200, { tamper: 600 });
  ok(a.sess.desync && b.sess.desync, 'tampering went unnoticed');
  ok(a.sess.desync.tick >= 600 && a.sess.desync.tick < 615, 'detected late at ' + a.sess.desync.tick);
  const dump = a.w.dump();
  ok(dump.ents.length > 10 && dump.hash, 'state dump');
  return `caught at tick ${a.sess.desync.tick}`;
});

test('replay round-trips through JSON and verifies; a tampered replay fails', () => {
  const s = ref || cpuMatch(777, 8 * 60 * HZ);
  const text = JSON.stringify(s.replay({ names: ['A', 'B'] }));
  const rep = JSON.parse(text);
  const p = new TS.ReplayPlayer(rep);
  eq(p.run(), true, 'replay verification');
  eq(p.world.tick, s.world.tick, 'replay length');
  const bad = JSON.parse(text);
  // Drop the first worker order: the economy (and so the final hash) must change.
  bad.log.splice(bad.log.findIndex(e => e[2].some(c => c.t === 'train')), 1);
  eq(new TS.ReplayPlayer(bad).run(), false, 'tampered replay should fail verification');
  return `${(text.length / 1024).toFixed(1)} KB for ${(s.world.tick / HZ / 60).toFixed(1)} min`;
});

test('garbage commands are rejected without touching state', () => {
  const clean = new TS.World({ seed: 5 }), dirty = new TS.World({ seed: 5 });
  const junk = [null, 7, 'x', {}, { t: 'move' }, { t: 'move', ids: [1, 2, 3, 'a'], x: 1.5, y: 2 }, { t: 'train', ids: [1], u: 'constructor' },
    { t: 'build', ids: [9999], b: '__proto__', tx: 1, ty: 1 }, { t: 'attack', ids: [{}], tg: -1 }, { t: 'rally', ids: 5, x: 1, y: 1 },
    { t: 'move', ids: Array(5000).fill(1), x: 1e12, y: -5 }];
  for (let i = 0; i < 40; i++) { clean.step([[], []]); dirty.step([junk, junk.slice().reverse()]); }
  // Player 1 moving player 0's units must not work either.
  const u0 = dirty.units.find(u => u.owner === 0);
  dirty.step([[], [{ t: 'move', ids: [u0.id], x: 100, y: 100 }]]); clean.step([[], []]);
  eq(dirty.hash(true), clean.hash(true));
});

test('flow fields: 600 units cross the map at an acceptable cost', () => {
  const w = new TS.World({ seed: 2024 });
  const ids = [[], []];
  for (let p = 0; p < 2; p++) {
    const s = w.starts[p];
    for (let k = 0; k < 6; k++) ids[p].push(...w.debugSpawn(TS.UNITS[1 + (k % 5)].key, p, s.tx + (p ? -3 : 7) + (k % 3), s.ty + (p ? -3 : 7) + ((k / 3) | 0) * 2, 50));
  }
  const goal = p => { const s = w.starts[1 - p]; return { x: (s.tx + 2) * TS.SUB, y: (s.ty + 2) * TS.SUB }; };
  const startD = ids[0].map(id => { const u = w.byId.get(id), g = goal(0); return Math.hypot(u.x - g.x, u.y - g.y); });
  const cmds = [0, 1].map(p => [{ t: 'move', ids: ids[p], x: goal(p).x, y: goal(p).y }]);
  w.step(cmds);
  const t0 = process.hrtime.bigint(); const N = 400;
  for (let i = 0; i < N; i++) w.step([[], []]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  let closer = 0;
  ids[0].forEach((id, i) => { const u = w.byId.get(id); if (u) { const g = goal(0); if (Math.hypot(u.x - g.x, u.y - g.y) < startD[i] - 10 * TS.SUB) closer++; } });
  ok(closer > ids[0].length * 0.8, `only ${closer}/${ids[0].length} units made progress`);
  ok(ms < 25, `too slow: ${ms.toFixed(2)} ms/tick`);
  return `${w.units.length} units, ${ms.toFixed(2)} ms/tick, ${w.flow.built} fields built, ${closer}/${ids[0].length} advanced 10+ tiles`;
});

test('CPU difficulty ladder: hard beats easy', () => {
  let wins = 0; const seeds = [11, 12, 13, 14];
  for (const seed of seeds) {
    const a = cpuMatch(seed, 25 * 60 * HZ, seed & 1 ? 'hard' : 'easy', seed & 1 ? 'easy' : 'hard');
    const hardSide = seed & 1 ? 0 : 1;
    if (a.world.winner === hardSide) wins++;
  }
  ok(wins >= 3, `hard won only ${wins}/${seeds.length}`);
  return `hard won ${wins}/${seeds.length}`;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
