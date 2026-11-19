// Tessellate — seeded map generator. 180° rotationally symmetric so both players get the same map.
(function () {
  'use strict';
  const TS = globalThis.TS;
  const { Rng } = TS;

  const W = 96, H = 96, N = W * H;
  const GROUND = 0, ROCK = 1, WATER = 2;
  TS.TER = { GROUND, ROCK, WATER };

  // Hand-placed node offsets (no trig in sim code). Main field arcs behind the base, toward the corner.
  const MAIN = [[-7, 1], [-7, -1], [-6, -3], [-5, -5], [-3, -6], [-1, -7], [1, -7], [-7, 3], [3, -7]];
  const SIDE = [[-6, -3], [-6, -1], [-6, 1], [-6, 3], [-5, -5], [-5, 5], [-7, 0]];

  TS.genMap = function (seed) {
    const rng = new Rng((seed ^ 0x51ED2701) >>> 0);
    const T = new Uint8Array(N);
    const mir = i => N - 1 - i;
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    const disc = (cx, cy, r, v) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (!inb(x, y)) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r + r) { const i = y * W + x; T[i] = v; T[mir(i)] = v; }
      }
    };

    // Obstacle blobs: random walks of discs.
    const blobs = 16 + rng.int(6);
    for (let b = 0; b < blobs; b++) {
      let cx = rng.int(W), cy = rng.int(H);
      const v = rng.int(4) === 0 ? WATER : ROCK;
      const steps = 3 + rng.int(7), r = 1 + rng.int(3);
      for (let s = 0; s < steps; s++) {
        disc(cx, cy, r, v);
        cx += rng.int(5) - 2; cy += rng.int(5) - 2;
      }
    }
    // A thin rock rim.
    for (let x = 0; x < W; x++) { T[x] = ROCK; T[N - 1 - x] = ROCK; }
    for (let y = 0; y < H; y++) { T[y * W] = ROCK; T[y * W + W - 1] = ROCK; }

    const starts = [{ tx: 9, ty: 9 }, { tx: W - 13, ty: H - 13 }];
    const c0 = { x: 11, y: 11 };
    // Expansion sites for player 0's half (player 1 gets the mirror).
    const exp0 = [
      { x: 12, y: 40, off: SIDE, flip: false, amt: 2000 },
      { x: 40, y: 12, off: SIDE, flip: true, amt: 2000 },
      { x: 32, y: 64, off: SIDE, flip: false, amt: 1800 },
    ];

    const carveLine = (x0, y0, x1, y1, r) => {
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy, x = x0, y = y0;
      for (;;) {
        disc(x, y, r, GROUND);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
      }
    };
    // Paths so every base and expansion is reachable.
    carveLine(c0.x, c0.y, exp0[0].x, exp0[0].y, 2);
    carveLine(c0.x, c0.y, exp0[1].x, exp0[1].y, 2);
    carveLine(exp0[0].x, exp0[0].y, exp0[2].x, exp0[2].y, 2);
    carveLine(exp0[2].x, exp0[2].y, 48, 48, 2);
    carveLine(exp0[1].x, exp0[1].y, 48, 48, 2);
    carveLine(c0.x, c0.y, 48, 48, 1);

    // Clear base and expansion pads.
    disc(c0.x, c0.y, 10, GROUND);
    for (const e of exp0) disc(e.x, e.y, 7, GROUND);
    disc(48, 48, 5, GROUND);
    for (let x = 0; x < W; x++) { T[x] = ROCK; T[N - 1 - x] = ROCK; }
    for (let y = 0; y < H; y++) { T[y * W] = ROCK; T[y * W + W - 1] = ROCK; }

    // Fields of Lumen crystals.
    const fields = [];
    const addField = (cx, cy, offs, flip, amt, owner) => {
      const nodes = [];
      for (const o of offs) {
        const ox = flip ? o[1] : o[0], oy = flip ? o[0] : o[1];
        nodes.push({ tx: cx + ox, ty: cy + oy, amt });
      }
      fields.push({ cx, cy, nodes, owner });
      const mnodes = nodes.map(n => ({ tx: W - 1 - n.tx, ty: H - 1 - n.ty, amt }));
      fields.push({ cx: W - 1 - cx, cy: H - 1 - cy, nodes: mnodes, owner: owner >= 0 ? 1 - owner : -1 });
    };
    addField(c0.x, c0.y, MAIN, false, 2500, 0);
    for (const e of exp0) addField(e.x, e.y, e.off, e.flip, e.amt, -1);
    for (const f of fields) for (const n of f.nodes) T[n.ty * W + n.tx] = GROUND;

    // Flood fill from base 0; seal off unreachable ground pockets.
    const seen = new Uint8Array(N);
    const q = [c0.y * W + c0.x]; seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % W, y = (i - x) / W;
      for (let d = 0; d < 8; d += 2) {
        const nx = x + TS.DX[d], ny = y + TS.DY[d];
        if (!inb(nx, ny)) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && T[ni] === GROUND) { seen[ni] = 1; q.push(ni); }
      }
    }
    for (let i = 0; i < N; i++) if (T[i] === GROUND && !seen[i]) T[i] = ROCK;
    // Nodes stay placeable even if they sat in a sealed pocket (they are on carved pads anyway).
    for (const f of fields) for (const n of f.nodes) T[n.ty * W + n.tx] = GROUND;

    // Decorative variation index per tile (render only, but derived from seed so it is stable).
    const deco = new Uint8Array(N);
    for (let i = 0; i < N; i++) deco[i] = rng.int(256);

    return { W, H, terrain: T, deco, starts, fields };
  };
})();
