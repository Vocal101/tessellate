// Tessellate — flow-field pathfinding. One integration field per goal, shared by every unit
// heading there, cached and invalidated when the walkable map changes (nav version).
(function () {
  'use strict';
  const TS = globalThis.TS;
  const { DX, DY } = TS;
  const INF = 0x3fffffff;

  class FlowCache {
    constructor(world) {
      this.w = world;
      const N = world.N;
      this.map = new Map();
      this.max = 72;
      this.cost = new Int32Array(N);
      this.heap = new Float64Array(N * 8 + 16);
      this.built = 0;      // stats: fields computed
    }

    // Field toward a point (tile index). Blocked goals snap to the nearest open tile.
    forTile(ti) { return this.get(ti, () => [this.nearestOpen(ti)]); }
    // Field toward an entity footprint (building or crystal): every footprint tile is a seed.
    forEnt(e) {
      return this.get(this.w.N + e.id, () => {
        const W = this.w.W, s = [];
        for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) s.push(y * W + x);
        return s;
      });
    }

    get(key, seedFn) {
      const w = this.w;
      let f = this.map.get(key);
      if (f && f.ver === w.navVer) { f.used = w.tick; return f; }
      if (!f && this.map.size >= this.max) this.evict();
      if (!f) { f = { dir: new Uint8Array(w.N), ver: -1, used: 0 }; this.map.set(key, f); }
      this.compute(f.dir, seedFn());
      f.ver = w.navVer; f.used = w.tick;
      this.built++;
      return f;
    }

    evict() {
      let worstK = null, worst = INF;
      for (const [k, f] of this.map) if (f.used < worst) { worst = f.used; worstK = k; }
      if (worstK !== null) this.map.delete(worstK);
    }

    nearestOpen(ti) {
      const w = this.w, W = w.W, H = w.H, B = w.block;
      if (!B[ti]) return ti;
      const x0 = ti % W, y0 = (ti - x0) / W;
      for (let r = 1; r < 24; r++) {
        let best = -1, bd = INF;
        for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (Math.max(Math.abs(x - x0), Math.abs(y - y0)) !== r) continue;
          const i = y * W + x;
          if (B[i]) continue;
          const d = (x - x0) * (x - x0) + (y - y0) * (y - y0);
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) return best;
      }
      return ti;
    }

    // Dijkstra from the seeds over 8-connected tiles (no corner cutting). dir[i] = direction to step.
    compute(dir, seeds) {
      const w = this.w, W = w.W, H = w.H, N = w.N, B = w.block, cost = this.cost, heap = this.heap;
      dir.fill(255); cost.fill(INF);
      let n = 0;
      const push = (c, i) => {
        let k = n++; const v = c * 16384 + i;
        while (k > 0) { const p = (k - 1) >> 1; if (heap[p] <= v) break; heap[k] = heap[p]; k = p; }
        heap[k] = v;
      };
      const pop = () => {
        const top = heap[0]; const last = heap[--n];
        let k = 0;
        for (;;) {
          let c = 2 * k + 1; if (c >= n) break;
          if (c + 1 < n && heap[c + 1] < heap[c]) c++;
          if (heap[c] >= last) break;
          heap[k] = heap[c]; k = c;
        }
        heap[k] = last;
        return top;
      };
      for (const s of seeds) { if (s < 0 || s >= N) continue; cost[s] = 0; dir[s] = 8; push(0, s); }
      while (n > 0) {
        const v = pop();
        const i = v % 16384, c = (v - i) / 16384;
        if (c > cost[i]) continue;
        const x = i % W, y = (i - x) / W;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (B[ni]) continue;
          let nc;
          if (d & 1) {
            if (B[y * W + nx] || B[ny * W + x]) continue;
            nc = c + 14;
          } else nc = c + 10;
          if (nc < cost[ni]) { cost[ni] = nc; dir[ni] = (d + 4) & 7; push(nc, ni); }
        }
      }
    }
  }
  TS.FlowCache = FlowCache;
})();
