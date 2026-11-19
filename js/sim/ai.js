// Tessellate — CPU opponent. It only reads what its player could see (fog-filtered enemy units,
// remembered enemy buildings, public map layout) and returns command objects that go through the
// exact same lockstep input path as a human's clicks. Deterministic: its own seeded RNG, integer math.
(function () {
  'use strict';
  const TS = globalThis.TS;
  const { SUB, Rng, UNITS, BLDS, UKEY, BKEY, ORD, KU, KB, KR, isqrt } = TS;
  const HZ = TS.HZ;

  const LEVELS = {
    easy:   { period: 24, workers: 12, army: 22, grow: 6,  counter: 0,   maxProd: 2, towers: 0, expand: 0, micro: 0, qlen: 1, edge: 0 },
    normal: { period: 14, workers: 18, army: 16, grow: 8,  counter: 50,  maxProd: 6, towers: 1, expand: 1, micro: 1, qlen: 2, edge: 100 },
    hard:   { period: 8,  workers: 22, army: 14, grow: 10, counter: 100, maxProd: 9, towers: 2, expand: 1, micro: 1, qlen: 2, edge: 120 },
  };
  TS.CPU_LEVELS = Object.keys(LEVELS);

  // Which of my units answer an enemy type.
  const ANSWERS = { mote: ['runner'], pike: ['glint', 'bastion'], glint: ['runner', 'bastion'], runner: ['pike', 'bastion'], bastion: ['prism'], prism: ['runner'] };
  const BASE_MIX = { pike: 4, glint: 4, runner: 3, bastion: 2, prism: 2 };

  class Cpu {
    constructor(world, pid, level, seed) {
      this.w = world; this.p = pid; this.level = LEVELS[level] ? level : 'normal';
      this.L = LEVELS[this.level];
      this.rng = new Rng(((seed >>> 0) ^ Math.imul(pid + 1, 0x9E3779B1)) >>> 0);
      this.period = this.L.period;
      this.phase = (pid * 5) % this.period;
      this.goal = this.L.army;
      this.mode = 'build'; this.wave = new Set(); this.armyAtStart = 0; this.lastOrder = -9999; this.lastDefend = -9999;
      this.defending = 0; this.gatherStart = 0; this.lastWave = 0;
      this.enemySeen = new Map();        // enemy army unit id -> {sup, t} last sighting
      this.pending = null;               // { key, tick } building we just ordered
      this.scout = 0;                    // index into scoutPoints while hunting for hidden buildings
      this.seenBlds = new Map();         // id -> {x, y, tid}
      this.seenUnits = new Map();        // enemy tid -> count seen recently (decays)
      this.rallied = new Set();
      const s = world.starts[pid], e = world.starts[1 - pid];
      this.home = { x: (s.tx + 2) * SUB, y: (s.ty + 2) * SUB };
      this.enemyHome = { x: (e.tx + 2) * SUB, y: (e.ty + 2) * SUB };
      // Staging point: a few tiles from home toward the map centre.
      const cx = world.W * SUB / 2, cy = world.H * SUB / 2;
      // Places an enemy might hide: its home, then every expansion field, nearest to its home first.
      this.scoutPoints = [this.enemyHome].concat(world.fields.filter(f => f.owner < 0).map(f => ({ x: f.cx * SUB, y: f.cy * SUB }))
        .sort((a, b) => this.d2(a, this.enemyHome) - this.d2(b, this.enemyHome) || a.x - b.x || a.y - b.y));
      this.stage = { x: this.home.x + TS.idiv((cx - this.home.x) * 22, 100), y: this.home.y + TS.idiv((cy - this.home.y) * 22, 100) };
    }

    // Called by the session every tick; returns [] off-period.
    tickCmds() {
      if ((this.w.tick % this.period) !== this.phase) return [];
      return this.think();
    }

    think() {
      const w = this.w, p = this.p, me = w.players[p];
      if (!me.alive || w.over) return [];
      const cmds = [];
      let budget = me.res, supLeft = me.cap - me.sup;
      const mine = { workers: [], army: [], blds: [], byKey: {}, done: {}, cores: [] };
      for (const k of BKEY.keys()) { mine.byKey[k] = []; mine.done[k] = 0; }
      const enemyVisible = [];
      for (const e of w.ents) {
        if (e.kind === KU) {
          if (e.owner === p) (UNITS[e.tid].cls === 'worker' ? mine.workers : mine.army).push(e);
          else if (w.players[p].vis[w.tileOf(e.x, e.y)]) enemyVisible.push(e);
        } else if (e.kind === KB) {
          if (e.owner === p) {
            const k = BLDS[e.tid].key;
            mine.blds.push(e); mine.byKey[k].push(e); if (e.done) mine.done[k]++;
            if (k === 'core' && e.done) mine.cores.push(e);
          } else if (w.visibleTo(p, e)) this.seenBlds.set(e.id, { x: e.x, y: e.y, tid: e.tid });
        }
      }
      // Forget remembered buildings that we can now see are gone.
      for (const [id, s] of this.seenBlds) {
        if (!w.byId.has(id) && w.players[p].vis[w.tileOf(s.x, s.y)]) this.seenBlds.delete(id);
      }
      for (const [k, v] of this.seenUnits) this.seenUnits.set(k, (v * 9) >> 4);
      for (const e of enemyVisible) { const k = UNITS[e.tid].key; this.seenUnits.set(k, (this.seenUnits.get(k) || 0) + 4); }

      const queued = key => { let n = 0; for (const b of mine.blds) for (const t of b.q) if (UNITS[t].key === key) n++; return n; };
      if (this.pending && (w.tick - this.pending.tick > 30 * HZ)) this.pending = null;
      if (this.pending && mine.byKey[this.pending.key].length > this.pending.had) this.pending = null;

      // 1. Idle workers back to mining.
      for (const u of mine.workers) {
        if (u.ord !== ORD.IDLE) continue;
        const core = this.nearestCore(mine.cores, u) || mine.blds[0];
        let node = null;
        for (const c of mine.cores) { node = w.nearestNode(c.x, c.y, 12); if (node) break; }
        if (!node && core) node = w.nearestNode(core.x, core.y, 96);     // long-distance mining beats idling
        if (node) cmds.push({ t: 'gather', ids: [u.id], tg: node.id });
      }

      // 2. Workers.
      const wantW = this.L.workers * Math.max(1, Math.min(2, mine.cores.length));
      let wcount = mine.workers.length + queued('mote');
      for (const c of mine.cores) {
        if (c.q.length < 2 && wcount < wantW && budget >= 50 && supLeft >= 1) {
          cmds.push({ t: 'train', ids: [c.id], u: 'mote' }); budget -= 50; supLeft -= 1; wcount++;
        }
      }

      // 3. Buildings (one order at a time).
      const prodCount = mine.byKey.forge.length + mine.byKey.foundry.length + mine.byKey.spire.length;
      const minutes = Math.floor(w.tick / (60 * HZ));
      let want = null;
      const underway = k => mine.byKey[k].some(b => !b.done);
      if (me.cap < TS.MAX_SUP && supLeft <= 2 + prodCount * 2 && !underway('conduit') && me.cap - me.sup < 40) want = 'conduit';
      else if (mine.byKey.forge.length === 0 && mine.workers.length >= 9) want = 'forge';
      else if (mine.done.forge && mine.byKey.foundry.length === 0 && mine.workers.length >= 12) want = 'foundry';
      else if (mine.done.forge && mine.byKey.sentinel.length < this.L.towers && (this.defending > 0 || minutes >= 4)) want = 'sentinel';
      else if (mine.done.foundry && mine.byKey.spire.length === 0 && minutes >= 5) want = 'spire';
      else if (mine.byKey.core.length < 4 && !underway('core') && (this.L.expand || minutes >= 8) && this.lowOnLumen(mine) && budget >= 300) want = 'core';
      else if ((budget >= 380 && prodCount < this.L.maxProd || budget >= 900 && prodCount < 12) && mine.done.forge) want = (mine.byKey.forge.length <= mine.byKey.foundry.length || !mine.done.foundry) ? 'forge' : 'foundry';
      if (want && !this.pending) {
        const bd = BKEY.get(want);
        if (budget >= bd.cost && (!bd.req || mine.done[bd.req])) {
          const spot = want === 'core' ? this.expansionSpot(mine) : this.findSpot(bd, mine.cores[0] || mine.blds[0]);
          const builder = spot && this.pickBuilder(mine.workers, spot);
          if (spot && builder) {
            cmds.push({ t: 'build', ids: [builder.id], b: want, tx: spot.tx, ty: spot.ty });
            budget -= bd.cost;
            this.pending = { key: want, tick: w.tick, had: mine.byKey[want].length };
          }
        }
      }

      // 4. Army production.
      const reserve = this.pending ? 0 : (want ? Math.min(BKEY.get(want).cost, 150) : 0);
      for (const b of mine.blds) {
        const bd = BLDS[b.tid];
        if (!b.done || !bd.trains || bd.key === 'core' || b.q.length >= (budget > 500 ? 3 : this.L.qlen)) continue;
        if (!this.rallied.has(b.id)) { cmds.push({ t: 'rally', ids: [b.id], x: this.stage.x, y: this.stage.y }); this.rallied.add(b.id); }
        const pick = this.chooseUnit(bd.trains);
        const ud = UKEY.get(pick);
        if (budget - reserve >= ud.cost && supLeft >= ud.sup) {
          cmds.push({ t: 'train', ids: [b.id], u: pick }); budget -= ud.cost; supLeft -= ud.sup;
        }
      }

      // 5. Army control: build up at the staging point, gather, then attack as one wave.
      let armySup = 0; for (const u of mine.army) armySup += UNITS[u.tid].sup;
      for (const e of enemyVisible) if (UNITS[e.tid].cls !== 'worker') this.enemySeen.set(e.id, { sup: UNITS[e.tid].sup, t: w.tick });
      let enemyEst = 0;
      for (const [id, v] of this.enemySeen) { if (w.tick - v.t > 60 * HZ) this.enemySeen.delete(id); else enemyEst += v.sup; }
      const ids = mine.army.map(u => u.id);
      const wave = mine.army.filter(u => this.wave.has(u.id));
      let waveSup = 0; for (const u of wave) waveSup += UNITS[u.tid].sup;
      // Threat near my buildings?
      let threat = null, td = 0x3fffffff;
      for (const e of enemyVisible) {
        for (const b of mine.blds) {
          const dx = e.x - b.x, dy = e.y - b.y, d = dx * dx + dy * dy;
          if (d < (14 * SUB) * (14 * SUB) && d < td) { td = d; threat = e; }
        }
      }
      if (threat && this.mode !== 'attack') {
        this.defending = 8;
        if (ids.length && w.tick - this.lastOrder >= 2 * HZ) {
          cmds.push({ t: 'amove', ids, x: threat.x, y: threat.y }); this.lastOrder = w.tick;
        }
        this.mode = 'build';
        // Pull a few workers to fight when there is no army at all and raiders hit the mineral line.
        if (!ids.length && this.L.micro) {
          const fighters = mine.workers.filter(u => this.d2(u, threat) < (5 * SUB) * (5 * SUB)).slice(0, 6).map(u => u.id);
          if (fighters.length >= 3) cmds.push({ t: 'attack', ids: fighters, tg: threat.id });
        }
        return cmds;
      }
      if (threat && this.mode === 'attack') {
        // Home is hit while the wave is out: units that stayed home defend.
        const home = mine.army.filter(u => !this.wave.has(u.id)).map(u => u.id);
        if (home.length && w.tick - this.lastDefend >= 2 * HZ) { cmds.push({ t: 'amove', ids: home, x: threat.x, y: threat.y }); this.lastDefend = w.tick; }
        if (waveSup * 2 < enemyEst) this.recall(cmds, wave);
      }
      if (this.defending > 0) {
        this.defending--;
        if (this.defending === 0 && this.mode === 'build' && ids.length) cmds.push({ t: 'move', ids, x: this.stage.x, y: this.stage.y });
      }
      if (this.mode === 'build') {
        const ready = armySup >= this.goal && armySup * 100 >= enemyEst * this.L.edge;
        const restless = w.tick - this.lastWave > 150 * HZ && armySup >= 10;     // never sit forever
        if (ready || restless || (me.sup >= TS.MAX_SUP - 4 && armySup > 10)) {
          this.mode = 'gather'; this.gatherStart = w.tick;
          if (ids.length) cmds.push({ t: 'move', ids, x: this.stage.x, y: this.stage.y });
        }
      } else if (this.mode === 'gather') {
        const near = mine.army.filter(u => this.d2(u, this.stage) < (8 * SUB) * (8 * SUB));
        if (near.length * 10 >= mine.army.length * 8 || w.tick - this.gatherStart > 20 * HZ) {
          this.mode = 'attack'; this.wave = new Set(near.map(u => u.id)); this.lastWave = w.tick;
          let sup = 0; for (const u of near) sup += UNITS[u.tid].sup;
          this.armyAtStart = sup; this.goal += this.L.grow;
          const tgt = this.attackTarget(near);
          if (near.length) cmds.push({ t: 'amove', ids: near.map(u => u.id), x: tgt.x, y: tgt.y });
          this.lastOrder = w.tick;
        }
      } else if (this.mode === 'attack') {
        if (!wave.length || waveSup * 100 < this.armyAtStart * 35) this.recall(cmds, wave);
        else if (w.tick - this.lastOrder >= 6 * HZ) {
          const tgt = this.attackTarget(wave);
          cmds.push({ t: 'amove', ids: wave.map(u => u.id), x: tgt.x, y: tgt.y }); this.lastOrder = w.tick;
        }
      }
      return cmds;
    }

    recall(cmds, wave) {
      this.mode = 'build'; this.wave = new Set(); this.lastOrder = this.w.tick;
      if (wave.length) cmds.push({ t: 'move', ids: wave.map(u => u.id), x: this.stage.x, y: this.stage.y });
    }

    // Lumen left in fields within 12 tiles of my finished cores.
    lowOnLumen(mine) {
      let left = 0;
      for (const e of this.w.ents) {
        if (e.kind !== KR) continue;
        if (mine.cores.some(c => this.d2(c, e) < (12 * SUB) * (12 * SUB))) left += e.amt;
      }
      return left < 6000 + (this.L.expand ? 4000 : 0) || mine.cores.length === 0;
    }

    d2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

    nearestCore(cores, u) {
      let best = null, bd = 0x3fffffff;
      for (const c of cores) { const dx = c.x - u.x, dy = c.y - u.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = c; } }
      return best;
    }

    attackTarget(army) {
      let best = null, bd = 0x3fffffff;
      for (const [, s] of this.seenBlds) {
        const dx = s.x - this.home.x, dy = s.y - this.home.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = s; }
      }
      if (best) return best;
      // Nothing known: sweep the likely base sites one after another.
      const pts = this.scoutPoints;
      let pt = pts[this.scout % pts.length];
      const lim = 5 * SUB * 5 * SUB;
      if (army.some(u => this.d2(u, pt) < lim)) { this.scout++; pt = pts[this.scout % pts.length]; }
      return pt;
    }

    chooseUnit(opts) {
      if (opts.length === 1) return opts[0];
      const useCounter = this.rng.int(100) < this.L.counter;
      const score = {};
      for (const k of opts) score[k] = BASE_MIX[k] * 4;
      if (useCounter) {
        for (const [ek, n] of this.seenUnits) {
          for (const k of ANSWERS[ek] || []) if (k in score) score[k] += n;
        }
      }
      let tot = 0; for (const k of opts) tot += score[k];
      let r = this.rng.int(tot);
      for (const k of opts) { r -= score[k]; if (r < 0) return k; }
      return opts[0];
    }

    // Spiral search around an anchor building for a free footprint with a one-tile margin,
    // not hugging crystals.
    findSpot(bd, anchor) {
      if (!anchor) return null;
      const w = this.w, W = w.W;
      const ax = anchor.tx + (anchor.w >> 1), ay = anchor.ty + (anchor.h >> 1);
      // Bias toward the side away from the main crystal field (toward the map centre).
      const towardX = ax < W / 2 ? 1 : -1, towardY = ay < w.H / 2 ? 1 : -1;
      const jitter = this.rng.int(8);
      for (let r = 3; r <= 14; r++) {
        const cands = [];
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = ax + dx - (bd.w >> 1), ty = ay + dy - (bd.h >> 1);
          if (!this.freeWithMargin(bd, tx, ty)) continue;
          const bias = -(dx * towardX + dy * towardY) * 4 + ((dx * 7 + dy * 13 + jitter) & 7);
          cands.push({ tx, ty, s: bias });
        }
        if (cands.length) { cands.sort((a, b) => a.s - b.s || a.ty - b.ty || a.tx - b.tx); return cands[0]; }
      }
      return null;
    }

    freeWithMargin(bd, tx, ty) {
      const w = this.w, W = w.W, H = w.H;
      if (!w.canPlace(bd, tx, ty)) return false;
      for (let y = ty - 1; y <= ty + bd.h; y++) for (let x = tx - 1; x <= tx + bd.w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        if (w.block[y * W + x] >= 2) return false;
      }
      // Stay two tiles clear of crystals so the mining lanes stay open.
      for (let y = ty - 2; y <= ty + bd.h + 1; y++) for (let x = tx - 2; x <= tx + bd.w + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (w.block[y * W + x] === 3) return false;
      }
      return true;
    }

    expansionSpot(mine) {
      const w = this.w;
      let best = null, bd = 0x3fffffff;
      for (const f of w.fields) {
        if (f.owner >= 0) continue;
        let alive = 0; for (const n of f.nodes) { const t = n.ty * w.W + n.tx; if (w.block[t] === 3) alive++; }
        if (alive < 4) continue;
        const dx = f.cx * SUB - this.home.x, dy = f.cy * SUB - this.home.y, d = dx * dx + dy * dy;
        if (d >= bd) continue;
        // Skip fields that already have a core near them (anyone's).
        let taken = false;
        for (const b of w.blds) if (BLDS[b.tid].key === 'core') { const ex = b.x - f.cx * SUB, ey = b.y - f.cy * SUB; if (ex * ex + ey * ey < (8 * SUB) * (8 * SUB)) taken = true; }
        if (taken) continue;
        const tx = f.cx - 1, ty = f.cy - 2;
        const bdef = BKEY.get('core');
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2], [2, 1], [1, 2]]) {
          if (w.canPlace(bdef, tx + ox, ty + oy)) { best = { tx: tx + ox, ty: ty + oy }; bd = d; break; }
        }
      }
      return best;
    }

    pickBuilder(workers, spot) {
      let best = null, bd = 0x3fffffff;
      const x = spot.tx * SUB, y = spot.ty * SUB;
      for (const u of workers) {
        if (u.ord === ORD.BUILD) continue;
        const dx = u.x - x, dy = u.y - y, d = dx * dx + dy * dy + (u.carry ? 4 * SUB * SUB : 0);
        if (d < bd) { bd = d; best = u; }
      }
      return best;
    }
  }

  TS.Cpu = Cpu;
})();
