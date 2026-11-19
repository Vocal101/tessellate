// Tessellate — the deterministic world. World.step(cmds) advances exactly one tick given both
// players' command lists. Same seed + same commands = same state, bit for bit, on every machine.
(function () {
  'use strict';
  const TS = globalThis.TS;
  const { SUB, isqrt, idiv, Rng, Hasher, UNITS, BLDS, UKEY, BKEY, DX, DY } = TS;
  const HALF = SUB >> 1;
  const ORD = TS.ORD = { IDLE: 0, MOVE: 1, AMOVE: 2, ATTACK: 3, GATHER: 4, BUILD: 5 };
  const KU = TS.KU = 1, KB = TS.KB = 2, KR = TS.KR = 3;
  const CELL_SHIFT = 9;               // spatial grid cells are 2x2 tiles (512 units)
  const FOG_EVERY = 4;
  const LEASH = 9 * SUB;
  const MAX_IDS = 300;
  const BIG = 0x3fffffff;

  // Precomputed vision discs, radius 0..14 tiles.
  const DISCS = [];
  for (let r = 0; r <= 14; r++) {
    const o = [];
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) o.push(x, y);
    DISCS.push(o);
  }

  const isInt = v => typeof v === 'number' && Number.isInteger(v) && v >= -BIG && v <= BIG;

  class World {
    constructor(cfg) {
      cfg = cfg || {};
      this.seed = (cfg.seed >>> 0);
      this.rng = new Rng(this.seed ^ 0xA5A5A5A5);
      this.tick = 0;
      const m = TS.genMap(this.seed);
      this.W = m.W; this.H = m.H; this.N = m.W * m.H;
      this.terrain = m.terrain; this.deco = m.deco; this.fields = m.fields; this.starts = m.starts;
      this.block = new Uint8Array(this.N);   // 0 open, 1 terrain, 2 building, 3 crystal
      for (let i = 0; i < this.N; i++) if (this.terrain[i]) this.block[i] = 1;
      this.navVer = 0;
      this.ents = []; this.byId = new Map(); this.nextId = 1; this.grpSeq = 0;
      this.units = []; this.blds = [];
      this.over = false; this.winner = -1;
      this.events = [];
      this.tainted = false;
      this.players = [0, 1].map(i => ({
        id: i, res: TS.START_RES, sup: 0, cap: 0, alive: 1, noCore: 0,
        vis: new Uint8Array(this.N), exp: new Uint8Array(this.N),
        st: { mined: 0, spent: 0, made: 0, lost: 0, kills: 0, dmg: 0 },
      }));
      this.flow = new TS.FlowCache(this);
      this.cellHead = new Int32Array((this.W >> 1) * (this.H >> 1));
      this.cellNext = new Int32Array(1024);
      this.gcount = new Map();

      for (const f of this.fields) for (const n of f.nodes) this.addRes(n.tx, n.ty, n.amt);
      for (let p = 0; p < 2; p++) {
        const s = this.starts[p];
        const core = this.addBld(BKEY.get('core'), p, s.tx, s.ty, true);
        for (let k = 0; k < TS.START_WORKERS; k++) {
          const pt = this.exitPoint(core, core.x + (p ? -1 : 1) * 4 * SUB, core.y + (p ? -1 : 1) * 4 * SUB, k);
          this.mkUnit(0, p, pt.x, pt.y);
        }
      }
      this.rebuildLists();
      this.recount();
      this.updateFog();
    }

    // ------------------------------------------------------------------ entity creation
    mkUnit(tid, owner, x, y) {
      const d = UNITS[tid];
      const e = {
        id: this.nextId++, kind: KU, tid, owner, x, y, px: x, py: y, hp: d.hp, r: d.r,
        ord: 0, ox: x, oy: y, otgt: 0, arrR: 0, grp: 0, gx: x, gy: y, tgt: 0, cd: 0, stuck: 0, lastD: 0,
        carry: 0, gnode: 0, gst: 0, gt: 0, bld: 0, atk: 0, vx: 0, vy: 0,
      };
      this.ents.push(e); this.byId.set(e.id, e);
      return e;
    }
    addBld(bd, owner, tx, ty, done) {
      const e = {
        id: this.nextId++, kind: KB, tid: bd.tid, owner, tx, ty, w: bd.w, h: bd.h,
        x: tx * SUB + bd.w * HALF, y: ty * SUB + bd.h * HALF, px: 0, py: 0,
        hp: done ? bd.hp : Math.max(1, idiv(bd.hp, 10)), done: done ? 1 : 0, prog: done ? bd.time : 0,
        q: [], qp: 0, rx: 0, ry: 0, rtg: 0, rset: 0, tgt: 0, cd: 0,
      };
      e.px = e.x; e.py = e.y;
      this.ents.push(e); this.byId.set(e.id, e);
      this.stamp(e, 2);
      return e;
    }
    addRes(tx, ty, amt) {
      const e = { id: this.nextId++, kind: KR, tid: 0, owner: -1, tx, ty, w: 1, h: 1,
        x: tx * SUB + HALF, y: ty * SUB + HALF, px: 0, py: 0, hp: 1, amt, max: amt };
      e.px = e.x; e.py = e.y;
      this.ents.push(e); this.byId.set(e.id, e);
      this.stamp(e, 3);
      return e;
    }
    stamp(e, v) {
      for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) {
        const i = y * this.W + x;
        this.block[i] = v ? v : (this.terrain[i] ? 1 : 0);
      }
      this.navVer++;
    }

    // ------------------------------------------------------------------ queries
    tileOf(x, y) { return (y >> 8) * this.W + (x >> 8); }
    defOf(e) { return e.kind === KU ? UNITS[e.tid] : e.kind === KB ? BLDS[e.tid] : null; }

    // Distance from u's edge to e's body (circle or rectangle).
    edgeDist(u, e) {
      if (e.kind === KU) { const dx = u.x - e.x, dy = u.y - e.y; return isqrt(dx * dx + dy * dy) - u.r - e.r; }
      const x0 = e.tx * SUB, y0 = e.ty * SUB, x1 = x0 + e.w * SUB, y1 = y0 + e.h * SUB;
      const dx = u.x < x0 ? x0 - u.x : u.x > x1 ? u.x - x1 : 0;
      const dy = u.y < y0 ? y0 - u.y : u.y > y1 ? u.y - y1 : 0;
      return isqrt(dx * dx + dy * dy) - u.r;
    }

    visibleTo(p, e) {
      const vis = this.players[p].vis;
      if (e.kind === KU) return vis[this.tileOf(e.x, e.y)] === 1;
      for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) if (vis[y * this.W + x]) return true;
      return false;
    }

    canPlace(bd, tx, ty) {
      if (tx < 1 || ty < 1 || tx + bd.w > this.W - 1 || ty + bd.h > this.H - 1) return false;
      for (let y = ty; y < ty + bd.h; y++) for (let x = tx; x < tx + bd.w; x++) if (this.block[y * this.W + x]) return false;
      return true;
    }
    hasDone(p, key) {
      const tid = BKEY.get(key).tid;
      for (const b of this.blds) if (b.owner === p && b.tid === tid && b.done) return true;
      return false;
    }

    // Free spot just outside a building, closest to (tx, ty). k skips the first k picks (spawn spread).
    exitPoint(b, tx, ty, k) {
      const W = this.W, H = this.H, cands = [];
      for (let ring = 1; ring <= 3 && cands.length <= (k || 0); ring++) {
        const x0 = b.tx - ring, y0 = b.ty - ring, x1 = b.tx + b.w - 1 + ring, y1 = b.ty + b.h - 1 + ring;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
          if (x < 0 || y < 0 || x >= W || y >= H || this.block[y * W + x]) continue;
          const cx = x * SUB + HALF, cy = y * SUB + HALF;
          const dx = cx - tx, dy = cy - ty;
          cands.push({ x: cx, y: cy, d: dx * dx + dy * dy, i: y * W + x });
        }
      }
      if (!cands.length) return { x: b.x, y: b.y + b.h * HALF + HALF };
      cands.sort((a, c) => a.d - c.d || a.i - c.i);
      return cands[Math.min(k || 0, cands.length - 1)];
    }

    nearestDrop(u) {
      let best = null, bd = BIG;
      for (const b of this.blds) {
        if (b.owner !== u.owner || !b.done || !BLDS[b.tid].drop) continue;
        const dx = b.x - u.x, dy = b.y - u.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = b; }
      }
      return best;
    }
    nearestNode(x, y, maxTiles) {
      let best = null, bs = BIG;
      const lim = maxTiles * SUB;
      for (const e of this.ents) {
        if (e.kind !== KR) continue;
        const dx = e.x - x, dy = e.y - y;
        if (Math.abs(dx) > lim || Math.abs(dy) > lim) continue;
        const d = isqrt(dx * dx + dy * dy);
        if (d > lim) continue;
        const s = d + (this.gcount.get(e.id) || 0) * 2 * SUB;
        if (s < bs) { bs = s; best = e; }
      }
      return best;
    }

    // ------------------------------------------------------------------ the tick
    step(cmds) {
      this.events.length = 0;
      if (this.over) { this.tick++; return; }
      for (let p = 0; p < 2; p++) {
        const list = cmds && cmds[p];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length && i < 64; i++) {
          try { this.apply(p, list[i]); } catch (err) { this.events.push({ k: 'err', p, msg: 'Bad command' }); }
        }
      }
      for (const e of this.ents) { e.px = e.x; e.py = e.y; }
      this.rebuildLists();
      this.recount();
      this.buildGrid();
      for (const b of this.blds) this.updateBld(b);
      for (const u of this.units) this.think(u);
      this.integrate();
      this.cleanup();
      if ((this.tick + 1) % FOG_EVERY === 0) this.updateFog();
      this.checkWin();
      this.tick++;
    }

    rebuildLists() {
      this.units.length = 0; this.blds.length = 0;
      for (const e of this.ents) { if (e.kind === KU) this.units.push(e); else if (e.kind === KB) this.blds.push(e); }
    }

    recount() {
      for (const p of this.players) { p.sup = 0; p.cap = 0; }
      for (const u of this.units) this.players[u.owner].sup += UNITS[u.tid].sup;
      for (const b of this.blds) {
        const bd = BLDS[b.tid], pl = this.players[b.owner];
        if (b.done && bd.sup) pl.cap += bd.sup;
        for (const t of b.q) pl.sup += UNITS[t].sup;
      }
      for (const p of this.players) if (p.cap > TS.MAX_SUP) p.cap = TS.MAX_SUP;
      this.gcount.clear();
      for (const u of this.units) if (u.ord === ORD.GATHER && u.gnode) this.gcount.set(u.gnode, (this.gcount.get(u.gnode) || 0) + 1);
    }

    buildGrid() {
      const GW = this.W >> 1, n = this.units.length;
      this.cellHead.fill(-1);
      if (this.cellNext.length < n) this.cellNext = new Int32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const u = this.units[i], c = (u.y >> CELL_SHIFT) * GW + (u.x >> CELL_SHIFT);
        this.cellNext[i] = this.cellHead[c]; this.cellHead[c] = i;
      }
    }
    // Calls fn(unit, index) for units in cells overlapping the square of radius rad around (x, y).
    near(x, y, rad, fn) {
      const GW = this.W >> 1, GH = this.H >> 1;
      const cx0 = Math.max(0, (x - rad) >> CELL_SHIFT), cx1 = Math.min(GW - 1, (x + rad) >> CELL_SHIFT);
      const cy0 = Math.max(0, (y - rad) >> CELL_SHIFT), cy1 = Math.min(GH - 1, (y + rad) >> CELL_SHIFT);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * GW + cx]; i >= 0; i = this.cellNext[i]) fn(this.units[i], i);
      }
    }

    // ------------------------------------------------------------------ commands
    ownUnits(p, ids) {
      const out = [];
      if (!Array.isArray(ids)) return out;
      for (let i = 0; i < ids.length && i < MAX_IDS; i++) {
        const e = isInt(ids[i]) ? this.byId.get(ids[i]) : null;
        if (e && e.kind === KU && e.owner === p && e.hp > 0 && out.indexOf(e) < 0) out.push(e);
      }
      return out;
    }
    ownBlds(p, ids) {
      const out = [];
      if (!Array.isArray(ids)) return out;
      for (let i = 0; i < ids.length && i < MAX_IDS; i++) {
        const e = isInt(ids[i]) ? this.byId.get(ids[i]) : null;
        if (e && e.kind === KB && e.owner === p && out.indexOf(e) < 0) out.push(e);
      }
      return out;
    }
    clampX(x) { return Math.max(0, Math.min(this.W * SUB - 1, x)); }
    clampY(y) { return Math.max(0, Math.min(this.H * SUB - 1, y)); }
    err(p, msg) { this.events.push({ k: 'err', p, msg }); }

    apply(p, c) {
      if (!c || typeof c !== 'object' || typeof c.t !== 'string') return;
      const pl = this.players[p];
      if (!pl.alive) return;
      switch (c.t) {
        case 'move': case 'amove': {
          if (!isInt(c.x) || !isInt(c.y)) return;
          const us = this.ownUnits(p, c.ids); if (!us.length) return;
          const x = this.clampX(c.x), y = this.clampY(c.y), g = ++this.grpSeq;
          let rsum = 0; for (const u of us) rsum += u.r;
          const n = us.length, ravg = idiv(rsum, n);
          const arr = n > 1 ? 24 + idiv(ravg * 13 * isqrt(n * 100), 100) : 24;
          for (const u of us) {
            this.resetOrder(u);
            u.ord = c.t === 'move' ? ORD.MOVE : ORD.AMOVE;
            u.ox = x; u.oy = y; u.arrR = arr; u.grp = g;
          }
          return;
        }
        case 'attack': {
          const t = isInt(c.tg) ? this.byId.get(c.tg) : null;
          if (!t || t.kind === KR || t.owner === p) return;
          for (const u of this.ownUnits(p, c.ids)) {
            this.resetOrder(u);
            u.ord = ORD.ATTACK; u.otgt = t.id; u.ox = t.x; u.oy = t.y;
          }
          return;
        }
        case 'gather': {
          const t = isInt(c.tg) ? this.byId.get(c.tg) : null;
          if (!t || t.kind !== KR) return;
          // The clicked crystal gets up to two Motes; the rest spread over neighbouring crystals.
          let first = true;
          for (const u of this.ownUnits(p, c.ids)) {
            if (UNITS[u.tid].cls !== 'worker') continue;
            if (u.ord === ORD.GATHER && u.gnode) this.gcount.set(u.gnode, (this.gcount.get(u.gnode) || 1) - 1);
            this.resetOrder(u);
            let n = t;
            if (!first && (this.gcount.get(t.id) || 0) >= 2) n = this.nearestNode(t.x, t.y, 5) || t;
            first = false;
            this.gcount.set(n.id, (this.gcount.get(n.id) || 0) + 1);
            u.ord = ORD.GATHER; u.gnode = n.id; u.gst = u.carry >= TS.CARRY ? 2 : 0; u.ox = n.x; u.oy = n.y;
          }
          return;
        }
        case 'drop': {
          for (const u of this.ownUnits(p, c.ids)) {
            if (UNITS[u.tid].cls !== 'worker' || !u.carry) continue;
            const keep = u.gnode;
            this.resetOrder(u);
            u.ord = ORD.GATHER; u.gnode = keep; u.gst = 2; u.ox = u.x; u.oy = u.y;
          }
          return;
        }
        case 'build': {
          const bd = typeof c.b === 'string' ? BKEY.get(c.b) : null;
          if (!bd || !isInt(c.tx) || !isInt(c.ty)) return;
          const ws = this.ownUnits(p, c.ids).filter(u => UNITS[u.tid].cls === 'worker');
          if (!ws.length) return;
          if (bd.req && !this.hasDone(p, bd.req)) { this.err(p, 'Requires ' + BKEY.get(bd.req).name); return; }
          if (pl.res < bd.cost) { this.err(p, 'Not enough Lumen'); return; }
          if (!this.canPlace(bd, c.tx, c.ty)) { this.err(p, "Can't build there"); return; }
          pl.res -= bd.cost; pl.st.spent += bd.cost;
          const b = this.addBld(bd, p, c.tx, c.ty, false);
          for (const u of ws) { const keep = u.gnode; this.resetOrder(u); u.gnode = keep; u.ord = ORD.BUILD; u.bld = b.id; }
          this.events.push({ k: 'place', p, id: b.id });
          return;
        }
        case 'help': {
          const b = isInt(c.tg) ? this.byId.get(c.tg) : null;
          if (!b || b.kind !== KB || b.owner !== p || b.done) return;
          for (const u of this.ownUnits(p, c.ids)) {
            if (UNITS[u.tid].cls !== 'worker') continue;
            const keep = u.gnode; this.resetOrder(u); u.gnode = keep; u.ord = ORD.BUILD; u.bld = b.id;
          }
          return;
        }
        case 'train': {
          const ud = typeof c.u === 'string' ? UKEY.get(c.u) : null;
          if (!ud) return;
          const bs = this.ownBlds(p, c.ids).filter(b => b.done && BLDS[b.tid].trainIds.indexOf(ud.tid) >= 0);
          if (!bs.length) return;
          bs.sort((a, b) => a.q.length - b.q.length || a.id - b.id);   // shortest queue first
          const b = bs[0];
          if (b.q.length >= 5) { this.err(p, 'Queue full'); return; }
          if (pl.res < ud.cost) { this.err(p, 'Not enough Lumen'); return; }
          if (pl.sup + ud.sup > pl.cap) { this.err(p, pl.cap >= TS.MAX_SUP ? 'Supply maxed' : 'Need more supply — build a Conduit'); return; }
          pl.res -= ud.cost; pl.st.spent += ud.cost; pl.sup += ud.sup;
          b.q.push(ud.tid);
          return;
        }
        case 'cancel': {
          for (const b of this.ownBlds(p, c.ids)) {
            if (!b.q.length) continue;
            const t = b.q.pop(); if (!b.q.length) b.qp = 0;
            pl.res += UNITS[t].cost; pl.st.spent -= UNITS[t].cost; pl.sup -= UNITS[t].sup;
            return;
          }
          return;
        }
        case 'rally': {
          if (!isInt(c.x) || !isInt(c.y)) return;
          const t = isInt(c.tg) ? this.byId.get(c.tg) : null;
          for (const b of this.ownBlds(p, c.ids)) {
            b.rx = this.clampX(c.x); b.ry = this.clampY(c.y); b.rset = 1; b.rtg = t && t.kind === KR ? t.id : 0;
          }
          return;
        }
        case 'stop': {
          for (const u of this.ownUnits(p, c.ids)) { this.resetOrder(u); u.gx = u.x; u.gy = u.y; }
          return;
        }
        case 'gg': { pl.alive = 0; return; }
      }
    }

    resetOrder(u) {
      u.ord = ORD.IDLE; u.tgt = 0; u.otgt = 0; u.bld = 0; u.gnode = 0; u.gst = 0; u.gt = 0; u.stuck = 0; u.lastD = 0;
    }

    // ------------------------------------------------------------------ buildings
    updateBld(b) {
      if (!b.done) return;
      const bd = BLDS[b.tid];
      if (b.q.length) {
        const ud = UNITS[b.q[0]];
        if (++b.qp >= ud.time) {
          b.q.shift(); b.qp = 0;
          this.spawnFrom(b, ud);
        }
      }
      if (bd.atk) {
        if (b.cd > 0) b.cd--;
        let t = b.tgt ? this.byId.get(b.tgt) : null;
        if (!t || t.hp <= 0 || this.edgeDist({ x: b.x, y: b.y, r: 0 }, t) > bd.atk.range || !this.visibleTo(b.owner, t)) {
          t = null; b.tgt = 0;
          if ((this.tick + b.id) % 3 === 0) {
            let bs = BIG;
            const vis = this.players[b.owner].vis;
            this.near(b.x, b.y, bd.atk.range + 128, e => {
              if (e.owner === b.owner || e.hp <= 0 || !vis[this.tileOf(e.x, e.y)]) return;
              const dx = e.x - b.x, dy = e.y - b.y, d2 = dx * dx + dy * dy, lim = bd.atk.range + e.r;
              if (d2 <= lim * lim && (d2 < bs || (d2 === bs && e.id < t.id))) { bs = d2; t = e; }
            });
            if (t) b.tgt = t.id;
          }
        }
        if (t && b.cd === 0) { this.hit(b, bd.atk, bd, t); b.cd = bd.atk.cd; }
      }
    }

    spawnFrom(b, ud) {
      const tx = b.rset ? b.rx : b.x + (b.owner ? -1 : 1) * SUB * 3;
      const ty = b.rset ? b.ry : b.y + (b.owner ? -1 : 1) * SUB * 3;
      const pt = this.exitPoint(b, tx, ty, 0);
      const u = this.mkUnit(ud.tid, b.owner, pt.x, pt.y);
      this.players[b.owner].st.made++;
      if (b.rset) {
        const rt = b.rtg ? this.byId.get(b.rtg) : null;
        if (ud.cls === 'worker' && rt && rt.kind === KR) { u.ord = ORD.GATHER; u.gnode = rt.id; u.ox = rt.x; u.oy = rt.y; }
        else { u.ord = ORD.MOVE; u.ox = b.rx; u.oy = b.ry; u.arrR = 160; u.grp = 0; }
      } else if (ud.cls === 'worker') {
        const n = this.nearestNode(b.x, b.y, 12);
        if (n) { u.ord = ORD.GATHER; u.gnode = n.id; u.ox = n.x; u.oy = n.y; }
      }
      this.events.push({ k: 'spawn', p: b.owner, id: u.id });
    }

    // ------------------------------------------------------------------ units
    think(u) {
      const d = UNITS[u.tid];
      u.vx = 0; u.vy = 0; u.atk = 0;
      // Units killed earlier this tick still act: damage resolves simultaneously, so a lower
      // entity id (which player 0 tends to have) never gets a first-strike advantage.
      if (u.cd > 0) u.cd--;
      switch (u.ord) {
        case ORD.IDLE: {
          if (d.cls === 'worker') return;
          let t = this.validTgt(u, u.tgt);
          if (!t || ((this.tick + u.id) % 10 === 0 && this.edgeDist(u, t) > d.range)) { const n = this.acquire(u, d); if (n) t = n; }
          u.tgt = t ? t.id : 0;
          if (!t) return;
          const gx = u.x - u.gx, gy = u.y - u.gy;
          if (gx * gx + gy * gy > LEASH * LEASH) {
            u.tgt = 0; u.ord = ORD.MOVE; u.ox = u.gx; u.oy = u.gy; u.arrR = 64; u.grp = 0;
            return;
          }
          this.engage(u, d, t);
          return;
        }
        case ORD.MOVE: this.moveTo(u, u.ox, u.oy); return;
        case ORD.AMOVE: {
          let t = this.validTgt(u, u.tgt);
          if (!t || ((this.tick + u.id) % 10 === 0 && this.edgeDist(u, t) > d.range)) {
            if ((this.tick + u.id) % 3 === 0 || !t) { const n = this.acquire(u, d); if (n) t = n; }
          }
          u.tgt = t ? t.id : 0;
          if (t) this.engage(u, d, t); else this.moveTo(u, u.ox, u.oy);
          return;
        }
        case ORD.ATTACK: {
          const t = this.byId.get(u.otgt);
          if (!t || t.hp <= 0) { this.arrive(u); return; }
          if (!this.visibleTo(u.owner, t)) {
            if (t.kind === KB) { this.chase(u, t); return; }
            u.ord = ORD.AMOVE; u.otgt = 0; u.arrR = 64;   // lost sight: sweep its last known spot
            return;
          }
          u.ox = t.x; u.oy = t.y; u.tgt = t.id;
          this.engage(u, d, t);
          return;
        }
        case ORD.GATHER: this.gather(u); return;
        case ORD.BUILD: {
          const b = this.byId.get(u.bld);
          if (!b || b.hp <= 0 || b.done) {
            const n = u.gnode && this.byId.get(u.gnode);
            if (n) { u.ord = ORD.GATHER; u.gst = u.carry >= TS.CARRY ? 2 : 0; u.bld = 0; }
            else { const nn = this.nearestNode(u.x, u.y, 10); if (nn) { u.ord = ORD.GATHER; u.gnode = nn.id; u.gst = 0; u.bld = 0; } else this.arrive(u); }
            return;
          }
          if (this.edgeDist(u, b) <= 48) { this.construct(b); u.atk = 2; }
          else this.followEnt(u, b);
          return;
        }
      }
    }

    validTgt(u, id) {
      if (!id) return null;
      const t = this.byId.get(id);
      if (!t || t.hp <= 0 || t.owner === u.owner || t.owner < 0) return null;
      if (!this.visibleTo(u.owner, t)) return null;
      return t;
    }

    acquire(u, d) {
      const rad = d.sight * SUB, vis = this.players[u.owner].vis;
      let best = null, bs = BIG;
      this.near(u.x, u.y, rad + 128, e => {
        if (e.owner === u.owner || e.hp <= 0) return;
        if (!vis[this.tileOf(e.x, e.y)]) return;
        const dx = e.x - u.x, dy = e.y - u.y, d2 = dx * dx + dy * dy, lim = rad + e.r;
        if (d2 > lim * lim) return;
        // Prefer things that fight back over workers, then nearest.
        const s = d2 + (UNITS[e.tid].cls === 'worker' ? 4 * SUB * SUB : 0);
        if (s < bs || (s === bs && best && e.id < best.id)) { bs = s; best = e; }
      });
      if (best) return best;
      for (const b of this.blds) {
        if (b.owner === u.owner || b.hp <= 0) continue;
        const ed = this.edgeDist(u, b);
        if (ed > rad) continue;
        if (!this.visibleTo(u.owner, b)) continue;
        const s = ed * ed + (BLDS[b.tid].atk ? 0 : SUB * SUB);
        if (s < bs) { bs = s; best = b; }
      }
      return best;
    }

    engage(u, d, t) {
      const ed = this.edgeDist(u, t);
      if (d.minRange && ed < d.minRange && t.kind === KU) {
        this.steer(u, u.x * 2 - t.x, u.y * 2 - t.y, UNITS[u.tid].speed);
        return;
      }
      if (ed <= d.range) {
        u.atk = 1; u.stuck = 0;
        if (u.cd === 0) { this.hit(u, d, d, t); u.cd = d.cd; }
        return;
      }
      this.chase(u, t);
    }

    chase(u, t) {
      if (t.kind !== KU) { this.followEnt(u, t); return; }
      const dx = t.x - u.x, dy = t.y - u.y;
      if (Math.abs(dx) < 6 * SUB && Math.abs(dy) < 6 * SUB && this.lineClear(u.x, u.y, t.x, t.y)) {
        this.steer(u, t.x, t.y, UNITS[u.tid].speed);
        return;
      }
      // Share fields: quantize the chase goal to 2x2 tile blocks.
      const tx = (t.x >> 9) * 2, ty = (t.y >> 9) * 2;
      this.followField(u, this.flow.forTile(ty * this.W + tx), t.x, t.y);
    }

    hit(src, atk, def, t) {
      const tdef = this.defOf(t);
      const m = TS.mult(def, tdef);
      const dmg = Math.max(1, idiv(atk.dmg * m, 100) - (tdef.armor || 0));
      this.damage(src, t, dmg);
      if (def.splash) {
        const sp = def.splash;
        this.near(t.x, t.y, sp + 128, e => {
          if (e === t || e.owner === src.owner || e.owner < 0 || e.hp <= 0) return;
          const dx = e.x - t.x, dy = e.y - t.y, lim = sp + e.r;
          if (dx * dx + dy * dy > lim * lim) return;
          const ed = UNITS[e.tid];
          this.damage(src, e, Math.max(1, idiv(idiv(atk.dmg * TS.mult(def, ed), 100), 2) - (ed.armor || 0)));
        });
      }
      this.events.push({ k: 'shot', w: def.key, p: src.owner, x: src.x, y: src.y, tx: t.x, ty: t.y, a: src.id, t: t.id });
    }

    damage(src, t, dmg) {
      const was = t.hp;
      t.hp -= dmg;
      const ps = this.players[src.owner].st;
      ps.dmg += Math.min(was, dmg);
      if (was > 0 && t.hp <= 0) { ps.kills++; this.players[t.owner].st.lost++; }
    }

    construct(b) {
      const bd = BLDS[b.tid];
      if (b.done || b.prog >= bd.time) return;
      const before = idiv(b.prog * bd.hp * 9, bd.time * 10);
      b.prog++;
      const after = idiv(b.prog * bd.hp * 9, bd.time * 10);
      b.hp = Math.min(bd.hp, b.hp + after - before);
      if (b.prog >= bd.time) { b.done = 1; this.events.push({ k: 'built', p: b.owner, id: b.id }); }
    }

    gather(u) {
      let node = u.gnode ? this.byId.get(u.gnode) : null;
      if (u.gst === 2) {
        const core = this.nearestDrop(u);
        if (!core) { this.arrive(u); return; }
        if (this.edgeDist(u, core) <= 48) {
          const pl = this.players[u.owner];
          pl.res += u.carry; pl.st.mined += u.carry; u.carry = 0; u.gst = 0;
          this.events.push({ k: 'drop', p: u.owner, id: u.id });
          if (!node) { node = this.nearestNode(core.x, core.y, 12); if (node) u.gnode = node.id; else { this.arrive(u); return; } }
          return;
        }
        this.followEnt(u, core);
        return;
      }
      if (!node) {
        node = this.nearestNode(u.ox, u.oy, 10);
        if (!node) { if (u.carry) { u.gst = 2; return; } this.arrive(u); return; }
        u.gnode = node.id; u.gst = 0;
      }
      if (u.gst === 0) {
        if (this.edgeDist(u, node) <= 48) { u.gst = 1; u.gt = TS.MINE_T; }
        else { this.followEnt(u, node); return; }
      }
      if (u.gst === 1) {
        u.atk = 3;
        if (--u.gt > 0) return;
        const take = Math.min(TS.CARRY - u.carry, node.amt);
        node.amt -= take; u.carry += take;
        if (node.amt <= 0) node.hp = 0;
        u.gst = 2;
      }
    }

    arrive(u) {
      u.ord = ORD.IDLE; u.gx = u.x; u.gy = u.y; u.tgt = 0; u.otgt = 0; u.stuck = 0; u.bld = 0;
    }

    moveTo(u, x, y) {
      const dx = x - u.x, dy = y - u.y, d = isqrt(dx * dx + dy * dy);
      if (d <= u.arrR) { this.arrive(u); return; }
      if ((this.tick + u.id) % 10 === 0) {
        if (u.lastD && d > u.lastD - 16) u.stuck++; else u.stuck = 0;
        u.lastD = d;
        if ((u.stuck >= 4 && d < u.arrR * 4 + SUB) || u.stuck >= 15) { this.arrive(u); return; }
      }
      if (d < 2 * SUB && this.lineClear(u.x, u.y, x, y)) { this.steer(u, x, y, UNITS[u.tid].speed); return; }
      this.followField(u, this.flow.forTile(this.tileOf(x, y)), x, y);
    }

    followEnt(u, e) { this.followField(u, this.flow.forEnt(e), e.x, e.y); }

    followField(u, f, gx, gy) {
      const W = this.W, sp = UNITS[u.tid].speed;
      const ti = this.tileOf(u.x, u.y), dir = f.dir[ti];
      if (dir === 8) { this.steer(u, gx, gy, sp); return; }
      if (dir === 255) {
        if (this.block[ti]) return;                 // collision pass will free us
        this.steer(u, gx, gy, sp); return;          // unreachable: head straight at it
      }
      const tx = (ti % W) + DX[dir], ty = ((ti / W) | 0) + DY[dir];
      const ni = ty * W + tx, d2 = f.dir[ni];
      if (d2 < 8) {
        const ax = tx + DX[d2], ay = ty + DY[d2];
        const px = ax * SUB + HALF, py = ay * SUB + HALF;
        if (this.lineClear(u.x, u.y, px, py)) { this.steer(u, px, py, sp); return; }
      } else if (d2 === 8) { this.steer(u, gx, gy, sp); return; }
      this.steer(u, tx * SUB + HALF, ty * SUB + HALF, sp);
    }

    steer(u, x, y, sp) {
      const dx = x - u.x, dy = y - u.y, d = isqrt(dx * dx + dy * dy);
      if (d === 0) return;
      if (d <= sp) { u.vx = dx; u.vy = dy; return; }
      u.vx = idiv(dx * sp, d); u.vy = idiv(dy * sp, d);
    }

    // Samples the segment every half tile; true if no blocked tile is crossed.
    lineClear(x0, y0, x1, y1) {
      const dx = x1 - x0, dy = y1 - y0;
      const steps = Math.max(1, idiv(Math.max(Math.abs(dx), Math.abs(dy)), HALF));
      for (let s = 1; s <= steps; s++) {
        const x = x0 + idiv(dx * s, steps), y = y0 + idiv(dy * s, steps);
        if (x < 0 || y < 0 || x >= this.W * SUB || y >= this.H * SUB) return false;
        if (this.block[this.tileOf(x, y)]) return false;
      }
      return true;
    }

    integrate() {
      const us = this.units, n = us.length;
      for (const u of us) {
        if (u.hp <= 0) continue;
        u.x = this.clampX(u.x + u.vx); u.y = this.clampY(u.y + u.vy);
      }
      this.buildGrid();
      // Pairwise separation (each pair once, lower list index first).
      for (let i = 0; i < n; i++) {
        const a = us[i];
        if (a.hp <= 0) continue;
        const aw = a.ord === ORD.GATHER || a.ord === ORD.BUILD;
        this.near(a.x, a.y, a.r + 128, (b, j) => {
          if (j <= i || b.hp <= 0) return;
          if (aw && (b.ord === ORD.GATHER || b.ord === ORD.BUILD)) return;   // workers ghost through each other
          const lim = a.r + b.r;
          let dx = b.x - a.x, dy = b.y - a.y;
          if (Math.abs(dx) >= lim || Math.abs(dy) >= lim) return;
          const d2 = dx * dx + dy * dy;
          if (d2 >= lim * lim) return;
          let d = isqrt(d2);
          if (d === 0) { const k = ((a.id + b.id) & 3) * 2; dx = DX[k]; dy = DY[k]; d = 1; }
          const ma = this.mass(a), mb = this.mass(b);
          const o = Math.min(lim - d, 96);
          const pa = idiv(o * mb, ma + mb), pb = o - pa;
          a.x = this.clampX(a.x - idiv(dx * pa, d)); a.y = this.clampY(a.y - idiv(dy * pa, d));
          b.x = this.clampX(b.x + idiv(dx * pb, d)); b.y = this.clampY(b.y + idiv(dy * pb, d));
          // Arrival contagion: bumping into a squad-mate that already arrived means we're there too.
          if (a.ord === ORD.MOVE && b.ord === ORD.IDLE && a.grp && b.grp === a.grp) this.nearGoal(a);
          else if (b.ord === ORD.MOVE && a.ord === ORD.IDLE && b.grp && a.grp === b.grp) this.nearGoal(b);
        });
      }
      for (const u of us) if (u.hp > 0) this.collide(u);
    }
    mass(u) { return u.atk === 1 ? 4 : (u.ord === ORD.IDLE ? 2 : 1) + (u.r > 100 ? 2 : 0); }
    nearGoal(u) {
      const dx = u.ox - u.x, dy = u.oy - u.y, lim = u.arrR * 2 + 128;
      if (dx * dx + dy * dy <= lim * lim) this.arrive(u);
    }

    // Push a unit out of blocked tiles (terrain, buildings, crystals).
    collide(u) {
      const W = this.W, H = this.H, B = this.block;
      const tx = u.x >> 8, ty = u.y >> 8;
      if (B[ty * W + tx]) {
        const fi = this.flow.nearestOpen(ty * W + tx);
        const fx = (fi % W) * SUB + HALF, fy = ((fi / W) | 0) * SUB + HALF;
        const dx = fx - u.x, dy = fy - u.y, d = isqrt(dx * dx + dy * dy);
        if (d > 0) { const s = Math.min(d, 64); u.x += idiv(dx * s, d); u.y += idiv(dy * s, d); }
        return;
      }
      const r = u.r;
      for (let k = 0; k < 8; k++) {
        const d8 = (k < 4 ? k * 2 : (k - 4) * 2 + 1);   // orthogonals first, then diagonals
        const nx = tx + DX[d8], ny = ty + DY[d8];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !B[ny * W + nx]) continue;
        const x0 = nx * SUB, y0 = ny * SUB;
        const cx = u.x < x0 ? x0 : u.x > x0 + SUB ? x0 + SUB : u.x;
        const cy = u.y < y0 ? y0 : u.y > y0 + SUB ? y0 + SUB : u.y;
        const dx = u.x - cx, dy = u.y - cy, d2 = dx * dx + dy * dy;
        if (d2 >= r * r || d2 === 0) continue;
        const d = isqrt(d2), push = r - d;
        u.x = this.clampX(u.x + idiv(dx * push, d)); u.y = this.clampY(u.y + idiv(dy * push, d));
      }
    }

    // ------------------------------------------------------------------ cleanup, fog, victory
    cleanup() {
      let dead = false;
      for (const e of this.ents) {
        if (e.hp > 0) continue;
        dead = true;
        this.byId.delete(e.id);
        if (e.kind === KB || e.kind === KR) this.stamp(e, 0);
        this.events.push({ k: 'die', kind: e.kind, tid: e.tid, p: e.owner, x: e.x, y: e.y, id: e.id });
      }
      if (dead) this.ents = this.ents.filter(e => e.hp > 0);
    }

    updateFog() {
      const W = this.W, H = this.H;
      for (const pl of this.players) pl.vis.fill(0);
      for (const e of this.ents) {
        if (e.owner < 0 || e.hp <= 0) continue;
        const pl = this.players[e.owner], vis = pl.vis, exp = pl.exp;
        const sight = e.kind === KU ? UNITS[e.tid].sight : (e.done ? BLDS[e.tid].sight : 3);
        const disc = DISCS[sight];
        const cx = e.x >> 8, cy = e.y >> 8;
        for (let k = 0; k < disc.length; k += 2) {
          const x = cx + disc[k], y = cy + disc[k + 1];
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = y * W + x;
          vis[i] = 1; exp[i] = 1;
        }
      }
      for (const b of this.blds) {
        if (b.hp <= 0 || !this.revealed(b.owner)) continue;
        const o = this.players[1 - b.owner];
        for (let y = b.ty; y < b.ty + b.h; y++) for (let x = b.tx; x < b.tx + b.w; x++) { o.vis[y * W + x] = 1; o.exp[y * W + x] = 1; }
      }
    }
    revealed(p) { const n = this.players[p].noCore; return n > 0 && this.tick - n >= 60 * TS.HZ; }

    checkWin() {
      const has = [0, 0], core = [0, 0];
      for (const b of this.blds) if (b.hp > 0) { has[b.owner] = 1; if (b.tid === 0) core[b.owner] = 1; }
      // A player with no Core for a minute has their remaining buildings revealed (no endless hide-and-seek).
      for (let p = 0; p < 2; p++) {
        const pl = this.players[p];
        if (core[p]) pl.noCore = 0; else if (!pl.noCore) pl.noCore = this.tick + 1;
      }
      for (let p = 0; p < 2; p++) if (!has[p]) this.players[p].alive = 0;
      const a0 = this.players[0].alive, a1 = this.players[1].alive;
      if (a0 && a1) return;
      this.over = true;
      this.winner = a0 ? 0 : a1 ? 1 : -2;
      this.events.push({ k: 'over', winner: this.winner });
    }

    // ------------------------------------------------------------------ hashing and dumps
    hash(full) {
      const h = new Hasher();
      h.add(this.tick).add(this.rng.s).add(this.navVer).add(this.nextId).add(this.grpSeq).add(this.over ? 1 : 0).add(this.winner);
      for (const p of this.players) h.add(p.res).add(p.sup).add(p.cap).add(p.alive).add(p.noCore);
      for (const e of this.ents) {
        h.add(e.id).add(e.kind).add(e.tid).add(e.owner).add(e.x).add(e.y).add(e.hp);
        if (e.kind === KU) {
          h.add(e.ord).add(e.ox).add(e.oy).add(e.otgt).add(e.arrR).add(e.grp).add(e.gx).add(e.gy).add(e.tgt)
            .add(e.cd).add(e.stuck).add(e.lastD).add(e.carry).add(e.gnode).add(e.gst).add(e.gt).add(e.bld);
        } else if (e.kind === KB) {
          h.add(e.done).add(e.prog).add(e.qp).add(e.rx).add(e.ry).add(e.rtg).add(e.rset).add(e.tgt).add(e.cd).addArr(e.q);
        } else h.add(e.amt);
      }
      if (full) for (const p of this.players) { h.addArr(p.vis); h.addArr(p.exp); }
      return h.hex();
    }

    dump() {
      const skip = { px: 1, py: 1, vx: 1, vy: 1 };
      return {
        tick: this.tick, seed: this.seed, rng: this.rng.s, navVer: this.navVer, nextId: this.nextId, grpSeq: this.grpSeq,
        over: this.over, winner: this.winner, hash: this.hash(false), fullHash: this.hash(true),
        players: this.players.map(p => ({ res: p.res, sup: p.sup, cap: p.cap, alive: p.alive, noCore: p.noCore, st: Object.assign({}, p.st),
          visCount: p.vis.reduce((a, b) => a + b, 0), expCount: p.exp.reduce((a, b) => a + b, 0) })),
        ents: this.ents.map(e => { const o = {}; for (const k in e) if (!skip[k]) o[k] = Array.isArray(e[k]) ? e[k].slice() : e[k]; return o; }),
      };
    }

    // Dev only (?dev harness): spawns outside the input stream, so it marks the world as tainted.
    debugSpawn(key, owner, tx, ty, n) {
      const ud = UKEY.get(key); if (!ud) return [];
      this.tainted = true;
      const out = [];
      for (let k = 0; k < (n || 1); k++) {
        const x = this.clampX(tx * SUB + HALF + ((k % 6) - 3) * ud.r * 2), y = this.clampY(ty * SUB + HALF + (((k / 6) | 0) - 2) * ud.r * 2);
        const u = this.mkUnit(ud.tid, owner, x, y); out.push(u.id);
      }
      this.rebuildLists(); this.recount();
      return out;
    }
  }

  TS.World = World;
})();
