// Tessellate — canvas renderer. Reads the world, never writes it. Positions are interpolated
// between the previous and current tick (alpha in [0,1]) so motion is smooth at any frame rate.
'use strict';
const Render = (() => {
  const TS = window.TS, SUB = TS.SUB;
  const TILE = 32, U2P = TILE / SUB;
  const COL = [
    { main: '#4fd1c5', dark: '#0f3236', mid: '#2a8c84', light: '#b4f5ee', name: 'Teal' },
    { main: '#ff9152', dark: '#3d1d10', mid: '#b8582a', light: '#ffd5b8', name: 'Ember' },
  ];
  const NEUTRAL = { main: '#b892ff', dark: '#2a1d4a', mid: '#7a5cc4', light: '#e6d9ff' };
  const R = {
    TILE, U2P, COL,
    cv: null, ctx: null, dpr: 1, w: 0, h: 0, topH: 38, botH: 186,
    cam: { x: 0, y: 0, z: 1 },
    world: null, view: 0,           // view: player whose fog we show, -1 = everything
    terrain: null, miniBase: null, fogCv: null, fogCtx: null, fogImg: null,
    fx: [], pings: [], alerts: [], memory: new Map(), heads: new Map(),
    sel: new Set(), hover: 0, place: null, box: null, rallyFor: [],
    stats: { ms: 0 },
  };

  // ------------------------------------------------------------------ setup
  R.init = function (canvas) {
    R.cv = canvas; R.ctx = canvas.getContext('2d');
    R.fogCv = document.createElement('canvas');
    R.resize();
    window.addEventListener('resize', R.resize);
  };
  R.resize = function () {
    R.dpr = Math.min(2, window.devicePixelRatio || 1);
    R.w = window.innerWidth; R.h = window.innerHeight;
    R.cv.width = Math.round(R.w * R.dpr); R.cv.height = Math.round(R.h * R.dpr);
    R.botH = R.w <= 900 ? 150 : 186;
    R.clampCam();
  };

  R.setWorld = function (w, view) {
    R.world = w; R.view = view;
    R.fx.length = 0; R.pings.length = 0; R.alerts.length = 0; R.memory.clear(); R.heads.clear(); R.sel.clear();
    R.terrain = buildTerrain(w, TILE);
    R.miniBase = buildTerrain(w, 2);
    R.fogCv.width = w.W; R.fogCv.height = w.H;
    R.fogCtx = R.fogCv.getContext('2d');
    R.fogImg = R.fogCtx.createImageData(w.W, w.H);
    const s = view >= 0 ? w.starts[view] : { tx: w.W / 2 - 2, ty: w.H / 2 - 2 };
    R.centerOn((s.tx + 2) * TILE, (s.ty + 2) * TILE);
  };

  // Faceted ground: every tile is two triangles whose diagonal alternates like a lattice.
  function buildTerrain(w, ts) {
    const c = document.createElement('canvas');
    c.width = w.W * ts; c.height = w.H * ts;
    const g = c.getContext('2d');
    const pal = {
      0: ['#1a2440', '#1d2847', '#18213b', '#1f2a4a'],
      1: ['#3a4566', '#46527a', '#323c5a', '#505d88'],
      2: ['#0e2a4c', '#123359', '#0b2443', '#163b66'],
    };
    for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
      const i = y * w.W + x, t = w.terrain[i], d = w.deco[i], p = pal[t];
      const x0 = x * ts, y0 = y * ts, flip = (x + y) & 1;
      g.fillStyle = p[d & 3];
      g.beginPath();
      if (flip) { g.moveTo(x0, y0); g.lineTo(x0 + ts, y0); g.lineTo(x0, y0 + ts); }
      else { g.moveTo(x0, y0); g.lineTo(x0 + ts, y0); g.lineTo(x0 + ts, y0 + ts); }
      g.fill();
      g.fillStyle = p[(d >> 2) & 3];
      g.beginPath();
      if (flip) { g.moveTo(x0 + ts, y0); g.lineTo(x0 + ts, y0 + ts); g.lineTo(x0, y0 + ts); }
      else { g.moveTo(x0, y0); g.lineTo(x0 + ts, y0 + ts); g.lineTo(x0, y0 + ts); }
      g.fill();
    }
    if (ts >= 16) {
      // Lattice lines on open ground and lit edges where walls meet ground.
      g.strokeStyle = 'rgba(120,150,220,0.07)'; g.lineWidth = 1;
      g.beginPath();
      for (let y = 0; y <= w.H; y++) { g.moveTo(0, y * ts + .5); g.lineTo(w.W * ts, y * ts + .5); }
      for (let x = 0; x <= w.W; x++) { g.moveTo(x * ts + .5, 0); g.lineTo(x * ts + .5, w.H * ts); }
      g.stroke();
      for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
        const t = w.terrain[y * w.W + x]; if (!t) continue;
        const open = (xx, yy) => xx >= 0 && yy >= 0 && xx < w.W && yy < w.H && !w.terrain[yy * w.W + xx];
        g.strokeStyle = t === 1 ? 'rgba(170,190,240,0.35)' : 'rgba(110,190,255,0.35)'; g.lineWidth = 2;
        g.beginPath();
        if (open(x, y - 1)) { g.moveTo(x * ts, y * ts + 1); g.lineTo(x * ts + ts, y * ts + 1); }
        if (open(x - 1, y)) { g.moveTo(x * ts + 1, y * ts); g.lineTo(x * ts + 1, y * ts + ts); }
        g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.beginPath();
        if (open(x, y + 1)) { g.moveTo(x * ts, y * ts + ts - 1); g.lineTo(x * ts + ts, y * ts + ts - 1); }
        if (open(x + 1, y)) { g.moveTo(x * ts + ts - 1, y * ts); g.lineTo(x * ts + ts - 1, y * ts + ts); }
        g.stroke();
      }
    }
    return c;
  }

  // ------------------------------------------------------------------ camera
  R.viewH = () => R.h - R.topH - R.botH;
  R.centerOn = function (px, py) {
    R.cam.x = px - R.w / 2 / R.cam.z;
    R.cam.y = py - (R.topH + R.viewH() / 2) / R.cam.z;
    R.clampCam();
  };
  R.clampCam = function () {
    const w = R.world; if (!w) return;
    const ww = w.W * TILE, wh = w.H * TILE, z = R.cam.z;
    const minX = -R.w / z * 0.25, maxX = ww - R.w / z * 0.75;
    const minY = -R.topH / z - 2 * TILE, maxY = wh - (R.h - R.botH) / z + 2 * TILE;
    R.cam.x = Math.max(minX, Math.min(maxX, R.cam.x));
    R.cam.y = Math.max(minY, Math.min(maxY, R.cam.y));
  };
  R.zoomAt = function (sx, sy, f) {
    const wx = sx / R.cam.z + R.cam.x, wy = sy / R.cam.z + R.cam.y;
    R.cam.z = Math.max(0.45, Math.min(2, R.cam.z * f));
    R.cam.x = wx - sx / R.cam.z; R.cam.y = wy - sy / R.cam.z;
    R.clampCam();
  };
  R.toWorld = (sx, sy) => ({ x: sx / R.cam.z + R.cam.x, y: sy / R.cam.z + R.cam.y });       // world px
  R.toScreen = (wx, wy) => ({ x: (wx - R.cam.x) * R.cam.z, y: (wy - R.cam.y) * R.cam.z });

  // ------------------------------------------------------------------ visibility helpers
  R.tileVisible = function (tx, ty) {
    const w = R.world;
    if (R.view < 0) return true;
    if (tx < 0 || ty < 0 || tx >= w.W || ty >= w.H) return false;
    return w.players[R.view].vis[ty * w.W + tx] === 1;
  };
  R.tileExplored = function (tx, ty) {
    const w = R.world;
    if (R.view < 0) return true;
    if (tx < 0 || ty < 0 || tx >= w.W || ty >= w.H) return false;
    return w.players[R.view].exp[ty * w.W + tx] === 1;
  };
  R.entVisible = function (e) {
    if (R.view < 0 || e.owner === R.view) return true;
    if (e.kind === TS.KU) return R.tileVisible(e.x >> 8, e.y >> 8);
    for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) if (R.tileVisible(x, y)) return true;
    return false;
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  R.posOf = (e, a) => ({ x: lerp(e.px, e.x, a) * U2P, y: lerp(e.py, e.y, a) * U2P });

  // ------------------------------------------------------------------ events from the sim
  R.absorb = function (events, now) {
    const w = R.world;
    for (const ev of events) {
      if (ev.k === 'shot') {
        const a = w.byId.get(ev.a);
        if (a && a.kind === TS.KU) R.heads.set(a.id, Math.atan2(ev.ty - ev.y, ev.tx - ev.x));
        const vis = R.view < 0 || ev.p === R.view || R.tileVisible(ev.x >> 8, ev.y >> 8) || R.tileVisible(ev.tx >> 8, ev.ty >> 8);
        if (vis && R.fx.length < 600) R.fx.push({ k: 'shot', w: ev.w, p: ev.p, x: ev.x * U2P, y: ev.y * U2P, tx: ev.tx * U2P, ty: ev.ty * U2P, t0: now });
        const t = w.byId.get(ev.t);
        if (t && R.view >= 0 && t.owner === R.view) R.alert(t, now);
      } else if (ev.k === 'die') {
        if ((R.view < 0 || ev.p === R.view || R.tileVisible(ev.x >> 8, ev.y >> 8)) && R.fx.length < 800) {
          R.fx.push({ k: 'die', p: ev.p, kind: ev.kind, x: ev.x * U2P, y: ev.y * U2P, t0: now, big: ev.kind === TS.KB });
        }
        R.memory.delete(ev.id); R.heads.delete(ev.id); R.sel.delete(ev.id);
      } else if (ev.k === 'spawn' || ev.k === 'built') {
        const e = w.byId.get(ev.id);
        if (e && (R.view < 0 || ev.p === R.view)) R.fx.push({ k: 'ring', p: ev.p, x: e.x * U2P, y: e.y * U2P, t0: now, r: ev.k === 'built' ? 60 : 22 });
      }
    }
  };
  R.alert = function (e, now) {
    const last = R.alerts.length ? R.alerts[R.alerts.length - 1] : null;
    if (last && now - last.t0 < 3000 && Math.abs(last.x - e.x) < 12 * SUB && Math.abs(last.y - e.y) < 12 * SUB) return;
    R.alerts.push({ x: e.x, y: e.y, t0: now });
    if (R.alerts.length > 8) R.alerts.shift();
    if (R.onAlert) R.onAlert(e);
  };
  R.ping = function (wx, wy, color, now) { R.pings.push({ x: wx, y: wy, c: color, t0: now }); };

  // ------------------------------------------------------------------ main draw
  R.draw = function (alpha, now) {
    const w = R.world, ctx = R.ctx;
    if (!w) return;
    const t0 = performance.now();
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, R.w, R.h);
    const z = R.cam.z;
    ctx.save();
    ctx.scale(z, z); ctx.translate(-R.cam.x, -R.cam.y);
    // Visible world rect (px) for culling.
    const vx0 = R.cam.x - 64, vy0 = R.cam.y - 64, vx1 = R.cam.x + R.w / z + 64, vy1 = R.cam.y + R.h / z + 64;
    const inView = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(R.terrain, 0, 0);

    // Remember enemy buildings we have seen (drawn as ghosts under fog).
    for (const b of w.blds) {
      if (b.owner === R.view || R.view < 0) continue;
      if (R.entVisible(b)) R.memory.set(b.id, { tid: b.tid, tx: b.tx, ty: b.ty, w: b.w, h: b.h, owner: b.owner, done: b.done, prog: b.prog });
    }
    for (const [id, m] of R.memory) {
      if (w.byId.has(id)) continue;
      let seen = false;
      for (let y = m.ty; y < m.ty + m.h && !seen; y++) for (let x = m.tx; x < m.tx + m.w; x++) if (R.tileVisible(x, y)) { seen = true; break; }
      if (seen) R.memory.delete(id);
    }

    // Crystals (static: shown once explored).
    for (const e of w.ents) {
      if (e.kind !== TS.KR) continue;
      const x = e.x * U2P, y = e.y * U2P;
      if (!inView(x, y) || !R.tileExplored(e.tx, e.ty)) continue;
      drawCrystal(ctx, x, y, e.amt / e.max, e.id === R.hover);
    }

    // Buildings and ghosts.
    for (const [id, m] of R.memory) {
      const b = w.byId.get(id);
      if (b && R.entVisible(b)) continue;
      ctx.globalAlpha = 0.45;
      drawBuilding(ctx, m, TS.BLDS[m.tid], m.owner, now, null);
      ctx.globalAlpha = 1;
    }
    for (const b of w.blds) {
      if (!R.entVisible(b)) continue;
      if (!inView(b.x * U2P, b.y * U2P)) continue;
      drawBuilding(ctx, b, TS.BLDS[b.tid], b.owner, now, b);
      if (R.sel.has(b.id)) selRect(ctx, b, b.owner === R.view || R.view < 0 ? '#9ff7a0' : '#ff7a7a');
    }

    // Units.
    const shown = [];
    for (const u of w.units) {
      if (!R.entVisible(u)) continue;
      const p = R.posOf(u, alpha);
      if (!inView(p.x, p.y)) continue;
      shown.push([u, p]);
      if (R.sel.has(u.id)) {
        ctx.strokeStyle = u.owner === R.view || R.view < 0 ? '#9ff7a0' : '#ff7a7a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 2, u.r * U2P + 4, (u.r * U2P + 4) * 0.8, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    for (const [u, p] of shown) {
      const d = TS.UNITS[u.tid];
      const mvx = u.x - u.px, mvy = u.y - u.py;
      let hd = R.heads.get(u.id);
      if (hd === undefined) hd = u.owner ? Math.PI * 1.25 : Math.PI * 0.25;
      if (u.atk !== 1 && (mvx * mvx + mvy * mvy) > 4) {
        const want = Math.atan2(mvy, mvx);
        let dd = want - hd; while (dd > Math.PI) dd -= Math.PI * 2; while (dd < -Math.PI) dd += Math.PI * 2;
        hd += dd * 0.25;
      }
      R.heads.set(u.id, hd);
      drawUnit(ctx, d.key, p.x, p.y, u.r * U2P, hd, COL[u.owner], u, now);
    }

    // Effects.
    drawFx(ctx, now);

    // Health bars: damaged or selected things.
    for (const [u, p] of shown) {
      const d = TS.UNITS[u.tid];
      if (u.hp < d.hp || R.sel.has(u.id) || u.id === R.hover) hpBar(ctx, p.x, p.y - u.r * U2P - 6, Math.max(18, u.r * U2P * 2), u.hp / d.hp);
    }
    for (const b of w.blds) {
      const bd = TS.BLDS[b.tid];
      if (!R.entVisible(b)) continue;
      if (b.hp < bd.hp || R.sel.has(b.id) || b.id === R.hover) hpBar(ctx, b.x * U2P, b.ty * TILE - 6, b.w * TILE - 10, Math.max(0, b.hp) / bd.hp);
    }

    // Fog of war.
    if (R.view >= 0) {
      const pl = w.players[R.view], img = R.fogImg.data, N = w.N;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        img[o] = 6; img[o + 1] = 9; img[o + 2] = 18;
        img[o + 3] = pl.vis[i] ? 0 : pl.exp[i] ? 140 : 238;
      }
      R.fogCtx.putImageData(R.fogImg, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(R.fogCv, 0, 0, w.W * TILE, w.H * TILE);
      ctx.imageSmoothingEnabled = false;
    }

    // Rally lines for selected own buildings.
    for (const id of R.sel) {
      const b = w.byId.get(id);
      if (!b || b.kind !== TS.KB || !b.rset || (R.view >= 0 && b.owner !== R.view)) continue;
      ctx.strokeStyle = 'rgba(160,255,170,.7)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(b.x * U2P, b.y * U2P); ctx.lineTo(b.rx * U2P, b.ry * U2P); ctx.stroke(); ctx.setLineDash([]);
      flag(ctx, b.rx * U2P, b.ry * U2P);
    }

    // Placement ghost.
    if (R.place) {
      const pl = R.place, bd = pl.bd;
      for (let y = pl.ty; y < pl.ty + bd.h; y++) for (let x = pl.tx; x < pl.tx + bd.w; x++) {
        const okT = x > 0 && y > 0 && x < w.W - 1 && y < w.H - 1 && !w.block[y * w.W + x] && R.tileExplored(x, y);
        ctx.fillStyle = okT ? 'rgba(90,230,140,.28)' : 'rgba(255,80,90,.38)';
        ctx.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      }
      ctx.globalAlpha = 0.6;
      drawBuilding(ctx, { tx: pl.tx, ty: pl.ty, w: bd.w, h: bd.h, done: 1 }, bd, R.view < 0 ? 0 : R.view, now, null);
      ctx.globalAlpha = 1;
    }

    // Command pings.
    for (let i = R.pings.length - 1; i >= 0; i--) {
      const p = R.pings[i], k = Math.max(0, now - p.t0) / 450;
      if (k >= 1) { R.pings.splice(i, 1); continue; }
      ctx.strokeStyle = p.c; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 16 * (1 - k * 0.6), 11 * (1 - k * 0.6), 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (R.box) {
      const b = R.box;
      ctx.strokeStyle = '#9ff7a0'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(120,255,140,.08)';
      ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.strokeRect(b.x0 + .5, b.y0 + .5, b.x1 - b.x0, b.y1 - b.y0);
    }
    R.stats.ms = performance.now() - t0;
  };

  function hpBar(ctx, x, y, wd, f) {
    f = Math.max(0, Math.min(1, f));
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x - wd / 2 - 1, y - 1, wd + 2, 5);
    ctx.fillStyle = f > 0.6 ? '#67e39a' : f > 0.3 ? '#ffd166' : '#ff5d6c';
    ctx.fillRect(x - wd / 2, y, wd * f, 3);
  }
  function selRect(ctx, b, c) {
    ctx.strokeStyle = c; ctx.lineWidth = 1.5;
    ctx.strokeRect(b.tx * TILE - 1.5, b.ty * TILE - 1.5, b.w * TILE + 3, b.h * TILE + 3);
  }
  function flag(ctx, x, y) {
    ctx.strokeStyle = '#d6ffe0'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 16); ctx.stroke();
    ctx.fillStyle = '#7dff9a'; ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x + 10, y - 12); ctx.lineTo(x, y - 8); ctx.fill();
  }

  // ------------------------------------------------------------------ shapes
  function poly(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }
  function ngon(ctx, x, y, r, n, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + i * Math.PI * 2 / n; i ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    ctx.closePath();
  }

  // Units are drawn in local space: +x is the heading.
  function drawUnit(ctx, key, x, y, r, hd, c, u, now) {
    ctx.save(); ctx.translate(x, y);
    // soft shadow
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(1.5, 3, r * 0.95, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(hd);
    ctx.lineJoin = 'round';
    const outline = () => { ctx.lineWidth = Math.max(1.2, r * 0.14); ctx.strokeStyle = '#060a14'; ctx.stroke(); };
    const atk = u && u.atk === 1;
    switch (key) {
      case 'mote': {
        ctx.fillStyle = c.mid; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); outline();
        ctx.fillStyle = c.light; ctx.beginPath(); ctx.arc(r * 0.25, 0, r * 0.38, 0, Math.PI * 2); ctx.fill();
        if (u && (u.atk === 3 || u.atk === 2)) {           // mining / building sparkle
          const k = (now / 120) % 1;
          ctx.strokeStyle = u.atk === 3 ? '#e2d0ff' : '#fff2b0'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(r * 1.1, 0, r * (0.3 + k * 0.5), -0.8, 0.8); ctx.stroke();
        }
        if (u && u.carry) { ctx.rotate(-hd); ctx.fillStyle = '#c9a6ff'; poly(ctx, [0, -r - 7, 4, -r - 3, 0, -r + 1, -4, -r - 3]); ctx.fill(); }
        break;
      }
      case 'pike': {
        ctx.fillStyle = c.mid; poly(ctx, [r * 1.15, 0, -r * 0.8, r * 0.85, -r * 0.45, 0, -r * 0.8, -r * 0.85]); ctx.fill(); outline();
        ctx.fillStyle = c.light; poly(ctx, [r * 1.15, 0, -r * 0.1, r * 0.3, -r * 0.1, -r * 0.3]); ctx.fill();
        if (atk) { ctx.strokeStyle = c.light; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(r * 1.6, 0); ctx.stroke(); }
        break;
      }
      case 'glint': {
        ctx.fillStyle = c.mid; poly(ctx, [r * 1.1, 0, 0, r * 0.7, -r * 0.9, 0, 0, -r * 0.7]); ctx.fill(); outline();
        ctx.fillStyle = c.light; poly(ctx, [r * 1.1, 0, 0, r * 0.28, -r * 0.3, 0, 0, -r * 0.28]); ctx.fill();
        break;
      }
      case 'runner': {
        ctx.fillStyle = c.mid; poly(ctx, [r * 1.2, 0, -r * 0.9, r * 0.95, -r * 0.35, 0, -r * 0.9, -r * 0.95]); ctx.fill(); outline();
        ctx.strokeStyle = c.light; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-r * 0.6, r * 0.5); ctx.lineTo(r * 0.5, 0); ctx.lineTo(-r * 0.6, -r * 0.5); ctx.stroke();
        break;
      }
      case 'bastion': {
        ctx.fillStyle = c.mid; ngon(ctx, 0, 0, r, 6, 0); ctx.fill(); outline();
        ctx.fillStyle = c.dark; ngon(ctx, 0, 0, r * 0.62, 6, Math.PI / 6); ctx.fill();
        ctx.fillStyle = c.light; ngon(ctx, r * 0.1, 0, r * 0.3, 6, 0); ctx.fill();
        ctx.fillStyle = c.light; ctx.fillRect(r * 0.55, -r * 0.12, r * 0.55, r * 0.24);
        break;
      }
      case 'prism': {
        ctx.fillStyle = c.mid; ngon(ctx, 0, 0, r, 3, 0); ctx.fill(); outline();
        ctx.fillStyle = c.dark; ngon(ctx, 0, 0, r * 0.5, 3, Math.PI); ctx.fill();
        const glow = u && u.cd > 40 ? 1 : 0.55;
        ctx.fillStyle = `rgba(255,255,255,${glow})`; ngon(ctx, r * 0.18, 0, r * 0.22, 3, 0); ctx.fill();
        break;
      }
    }
    ctx.restore();
  }

  function drawCrystal(ctx, x, y, f, hover) {
    const s = 9 + 6 * Math.sqrt(Math.max(0.05, f));
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x + 2, y + 8, s * 0.9, s * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6f4fc4'; poly(ctx, [x, y - s * 1.25, x + s * 0.75, y - s * 0.1, x, y + s * 0.85, x - s * 0.75, y - s * 0.1]); ctx.fill();
    ctx.fillStyle = '#b892ff'; poly(ctx, [x, y - s * 1.25, x + s * 0.75, y - s * 0.1, x, y + s * 0.1]); ctx.fill();
    ctx.fillStyle = '#e6d9ff'; poly(ctx, [x, y - s * 1.25, x - s * 0.3, y - s * 0.35, x, y + s * 0.1]); ctx.fill();
    ctx.strokeStyle = hover ? '#ffffff' : '#2a1d4a'; ctx.lineWidth = hover ? 2 : 1;
    poly(ctx, [x, y - s * 1.25, x + s * 0.75, y - s * 0.1, x, y + s * 0.85, x - s * 0.75, y - s * 0.1]); ctx.stroke();
  }

  function drawBuilding(ctx, b, bd, owner, now, live) {
    const c = COL[owner] || NEUTRAL;
    const x0 = b.tx * TILE, y0 = b.ty * TILE, ww = b.w * TILE, hh = b.h * TILE;
    const cx = x0 + ww / 2, cy = y0 + hh / 2, s = Math.min(ww, hh);
    const done = b.done;
    ctx.save();
    if (!done) ctx.globalAlpha *= 0.7;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x0 + 5, y0 + 6, ww - 6, hh - 6);
    ctx.fillStyle = c.dark; ctx.strokeStyle = c.main; ctx.lineWidth = 2;
    roundRect(ctx, x0 + 3, y0 + 3, ww - 6, hh - 6, 6); ctx.fill();
    if (!done) ctx.setLineDash([5, 4]);
    ctx.stroke(); ctx.setLineDash([]);
    // Facet the roof with the same lattice as the ground.
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0 + 6, y0 + 6); ctx.lineTo(x0 + ww - 6, y0 + hh - 6); ctx.moveTo(x0 + ww - 6, y0 + 6); ctx.lineTo(x0 + 6, y0 + hh - 6); ctx.stroke();
    ctx.fillStyle = c.mid;
    switch (bd.key) {
      case 'core':
        ngon(ctx, cx, cy, s * 0.34, 6, Math.PI / 6); ctx.fill();
        ctx.fillStyle = c.light; ngon(ctx, cx, cy, s * 0.16, 6, 0); ctx.fill();
        ctx.fillStyle = c.main;
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) poly(ctx, [cx + dx * s * 0.42, cy + dy * s * 0.42, cx + dx * s * 0.28, cy + dy * s * 0.42, cx + dx * s * 0.42, cy + dy * s * 0.28]), ctx.fill();
        break;
      case 'conduit':
        poly(ctx, [cx, cy - s * 0.34, cx + s * 0.3, cy + 0.02 * s, cx - s * 0.3, cy + 0.02 * s]); ctx.fill();
        ctx.fillStyle = c.light; poly(ctx, [cx, cy - s * 0.02, cx + s * 0.3, cy + s * 0.34, cx - s * 0.3, cy + s * 0.34]); ctx.fill();
        break;
      case 'forge':
        ctx.fillRect(cx - s * 0.28, cy - s * 0.28, s * 0.56, s * 0.56);
        ctx.fillStyle = c.light; poly(ctx, [cx, cy - s * 0.2, cx + s * 0.2, cy + s * 0.16, cx - s * 0.2, cy + s * 0.16]); ctx.fill();
        break;
      case 'foundry':
        ngon(ctx, cx, cy, s * 0.33, 8, Math.PI / 8); ctx.fill();
        ctx.strokeStyle = c.light; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx - s * 0.16, cy + s * 0.1); ctx.lineTo(cx, cy - s * 0.08); ctx.lineTo(cx + s * 0.16, cy + s * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - s * 0.16, cy - s * 0.04); ctx.lineTo(cx, cy - s * 0.22); ctx.lineTo(cx + s * 0.16, cy - s * 0.04); ctx.stroke();
        break;
      case 'spire':
        poly(ctx, [cx, cy - s * 0.4, cx + s * 0.22, cy, cx, cy + s * 0.4, cx - s * 0.22, cy]); ctx.fill();
        ctx.fillStyle = c.light; poly(ctx, [cx, cy - s * 0.4, cx + s * 0.22, cy, cx, cy - s * 0.05]); ctx.fill();
        break;
      case 'sentinel': {
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2); ctx.fill();
        let a = -Math.PI / 2;
        if (live && live.tgt && R.world) { const t = R.world.byId.get(live.tgt); if (t) a = Math.atan2(t.y - live.y, t.x - live.x); }
        ctx.strokeStyle = c.light; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * s * 0.42, cy + Math.sin(a) * s * 0.42); ctx.stroke();
        ctx.fillStyle = c.light; ctx.beginPath(); ctx.arc(cx, cy, s * 0.12, 0, Math.PI * 2); ctx.fill();
        break;
      }
    }
    if (live && !done) {
      const f = live.prog / bd.time;
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x0 + 6, y0 + hh - 12, ww - 12, 5);
      ctx.fillStyle = '#ffd166'; ctx.fillRect(x0 + 6, y0 + hh - 12, (ww - 12) * f, 5);
    } else if (live && live.q && live.q.length && (R.view < 0 || owner === R.view)) {
      const ud = TS.UNITS[live.q[0]], f = live.qp / ud.time;
      ctx.strokeStyle = c.light; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x0 + ww - 11, y0 + 11, 5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawFx(ctx, now) {
    for (let i = R.fx.length - 1; i >= 0; i--) {
      const f = R.fx[i], age = Math.max(0, now - f.t0);
      const c = COL[f.p] || NEUTRAL;
      if (f.k === 'shot') {
        const life = f.w === 'prism' ? 380 : f.w === 'sentinel' ? 220 : f.w === 'glint' ? 180 : 140;
        if (age > life) { R.fx.splice(i, 1); continue; }
        const k = age / life;
        if (f.w === 'glint' || f.w === 'sentinel') {
          const h = Math.min(1, k * 2.2), px = f.x + (f.tx - f.x) * h, py = f.y + (f.ty - f.y) * h;
          const tl = 0.25, qx = f.x + (f.tx - f.x) * Math.max(0, h - tl), qy = f.y + (f.ty - f.y) * Math.max(0, h - tl);
          ctx.strokeStyle = f.w === 'sentinel' ? '#fff3c4' : c.light; ctx.lineWidth = f.w === 'sentinel' ? 3 : 2; ctx.globalAlpha = 1 - k * 0.5;
          ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
        } else if (f.w === 'prism') {
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = c.light; ctx.lineWidth = 5 * (1 - k) + 1;
          ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.tx, f.ty); ctx.stroke();
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.strokeStyle = c.main; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(f.tx, f.ty, 6 + k * 22, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.globalAlpha = 1 - k; ctx.strokeStyle = '#fffbe0'; ctx.lineWidth = 1.5;
          const r = 3 + k * 6;
          ctx.beginPath(); ctx.moveTo(f.tx - r, f.ty - r); ctx.lineTo(f.tx + r, f.ty + r); ctx.moveTo(f.tx + r, f.ty - r); ctx.lineTo(f.tx - r, f.ty + r); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (f.k === 'die') {
        const life = f.big ? 900 : 550;
        if (age > life) { R.fx.splice(i, 1); continue; }
        const k = age / life, n = f.big ? 14 : 7, dist = (f.big ? 50 : 18) * Math.sqrt(k);
        ctx.fillStyle = c.main; ctx.globalAlpha = 1 - k;
        for (let j = 0; j < n; j++) {
          const a = j * 2.399 + f.x * 0.01, px = f.x + Math.cos(a) * dist, py = f.y + Math.sin(a) * dist, s = (f.big ? 7 : 4) * (1 - k * 0.5);
          poly(ctx, [px, py - s, px + s * 0.87, py + s * 0.5, px - s * 0.87, py + s * 0.5]); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (f.k === 'ring') {
        if (age > 500) { R.fx.splice(i, 1); continue; }
        const k = age / 500;
        ctx.strokeStyle = c.light; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.4 + k), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }

  // ------------------------------------------------------------------ minimap
  R.drawMinimap = function (mm, now) {
    const w = R.world; if (!w) return;
    const g = mm.getContext('2d'), S = mm.width, k = S / w.W;
    g.imageSmoothingEnabled = true;
    g.drawImage(R.miniBase, 0, 0, S, S);
    for (const e of w.ents) {
      if (e.kind !== TS.KR || !R.tileExplored(e.tx, e.ty)) continue;
      g.fillStyle = '#b892ff'; g.fillRect(e.tx * k, e.ty * k, k + 0.5, k + 0.5);
    }
    for (const [id, m] of R.memory) { if (w.byId.has(id) && R.entVisible(w.byId.get(id))) continue; g.fillStyle = COL[m.owner].mid; g.fillRect(m.tx * k, m.ty * k, m.w * k, m.h * k); }
    for (const b of w.blds) {
      if (!R.entVisible(b)) continue;
      g.fillStyle = COL[b.owner].main; g.fillRect(b.tx * k, b.ty * k, b.w * k, b.h * k);
    }
    for (const u of w.units) {
      if (!R.entVisible(u)) continue;
      g.fillStyle = R.sel.has(u.id) ? '#ffffff' : COL[u.owner].light;
      g.fillRect(u.x / SUB * k - 1, u.y / SUB * k - 1, 2.2, 2.2);
    }
    if (R.view >= 0) { g.imageSmoothingEnabled = true; g.drawImage(R.fogCv, 0, 0, S, S); }
    for (let i = R.alerts.length - 1; i >= 0; i--) {
      const a = R.alerts[i], el = Math.max(0, now - a.t0), age = el / 2500;
      if (age > 1) { R.alerts.splice(i, 1); continue; }
      g.strokeStyle = '#ff5d6c'; g.lineWidth = 2; g.globalAlpha = 1 - age;
      g.beginPath(); g.arc(a.x / SUB * k, a.y / SUB * k, 3 + 10 * (el % 800) / 800, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
    const cz = R.cam.z, sc = k / TILE;
    g.strokeStyle = '#ffffff'; g.lineWidth = 1;
    g.strokeRect(R.cam.x * sc, (R.cam.y + R.topH / cz) * sc, R.w / cz * sc, R.viewH() / cz * sc);
  };

  // ------------------------------------------------------------------ icons for the HUD
  R.icon = function (cv, kind, key, owner) {
    const g = cv.getContext('2d'), S = cv.width;
    g.clearRect(0, 0, S, S);
    const c = COL[owner] || COL[0];
    if (kind === 'u') {
      const d = TS.UKEY.get(key), r = S * 0.3 * (d.r / 90);
      drawUnit(g, key, S / 2, S / 2, Math.min(S * 0.38, r), -Math.PI / 2 + (key === 'bastion' ? Math.PI / 2 : 0), c, null, 0);
    } else if (kind === 'b') {
      const bd = TS.BKEY.get(key);
      g.save(); const sc = S / (Math.max(bd.w, bd.h) * TILE + 4); g.scale(sc, sc);
      drawBuilding(g, { tx: 0, ty: 0, w: bd.w, h: bd.h, done: 1 }, bd, owner, 0, null);
      g.restore();
    } else if (kind === 'r') {
      drawCrystal(g, S / 2, S / 2 + S * 0.08, 1, false);
    }
  };

  return R;
})();
