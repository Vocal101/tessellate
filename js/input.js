// Tessellate — mouse and keyboard. Selection, groups and camera are local; every order becomes
// a command object handed to Game.issue (the lockstep session), never applied to the world here.
'use strict';
const Input = (() => {
  const TS_ = window.TS, SUB = TS_.SUB;
  const I = { mode: null, placeKey: null, groups: new Map(), lastGroup: { k: 0, t: 0 }, mx: -1, my: -1, inside: false,
    down: null, pan: null, keys: new Set(), lastClick: { t: 0, id: 0 }, idleIdx: 0 };
  let cv, mm;

  I.init = function () {
    cv = document.getElementById('view'); mm = document.getElementById('minimap');
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => { e.preventDefault(); if (Game.world) Render.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    cv.addEventListener('mouseenter', () => { I.inside = true; });
    cv.addEventListener('mouseleave', () => { I.inside = false; });
    document.addEventListener('mouseleave', () => { I.inside = false; });
    window.addEventListener('blur', () => { I.inside = false; I.keys.clear(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', e => I.keys.delete(e.key));
    mm.addEventListener('contextmenu', e => e.preventDefault());
    mm.addEventListener('mousedown', mmDown);
  };
  I.reset = function () { I.mode = null; I.placeKey = null; I.groups.clear(); Render.place = null; Render.box = null; I.down = null; cv.style.cursor = 'default'; };

  const own = e => Game.me >= 0 && e.owner === Game.me;
  const sel = () => Hud.selected();
  const selOwnUnits = () => sel().filter(e => e.kind === TS.KU && own(e));
  const toUnits = px => Math.round(px / Render.U2P);
  const now = () => performance.now();

  // ------------------------------------------------------------------ picking
  function pick(sx, sy) {
    const w = Game.world, p = Render.toWorld(sx, sy);
    let best = null, bd = 1e9;
    for (const u of w.units) {
      if (!Render.entVisible(u)) continue;
      const q = Render.posOf(u, 1), d = Math.hypot(q.x - p.x, q.y - p.y), r = u.r * Render.U2P + 5;
      if (d < r && d < bd) { bd = d; best = u; }
    }
    if (best) return best;
    for (const b of w.blds) {
      if (!Render.entVisible(b)) continue;
      const x0 = b.tx * Render.TILE, y0 = b.ty * Render.TILE;
      if (p.x >= x0 && p.y >= y0 && p.x < x0 + b.w * Render.TILE && p.y < y0 + b.h * Render.TILE) return b;
    }
    for (const e of w.ents) {
      if (e.kind !== TS.KR || !Render.tileExplored(e.tx, e.ty)) continue;
      if (Math.abs(e.x * Render.U2P - p.x) < 16 && Math.abs(e.y * Render.U2P - p.y) < 18) return e;
    }
    return null;
  }

  function overHud(sx, sy) { return sy < Render.topH || sy > Render.h - Render.botH; }

  // ------------------------------------------------------------------ mouse
  function onDown(e) {
    if (!Game.world) return;
    cv.focus && cv.focus();
    if (e.button === 1) { e.preventDefault(); I.pan = { x: e.clientX, y: e.clientY, cx: Render.cam.x, cy: Render.cam.y }; return; }
    if (overHud(e.offsetX, e.offsetY)) return;
    if (e.button === 2) { rightClick(e.offsetX, e.offsetY, e.shiftKey); return; }
    if (e.button !== 0) return;
    if (I.mode === 'place') { tryPlace(e.shiftKey); return; }
    if (I.mode === 'amove') { attackMove(e.offsetX, e.offsetY); if (!e.shiftKey) setMode(null); return; }
    I.down = { x: e.offsetX, y: e.offsetY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }
  function onMove(e) {
    const r = cv.getBoundingClientRect();
    I.mx = e.clientX - r.left; I.my = e.clientY - r.top;
    if (I.pan) {
      Render.cam.x = I.pan.cx - (e.clientX - I.pan.x) / Render.cam.z;
      Render.cam.y = I.pan.cy - (e.clientY - I.pan.y) / Render.cam.z;
      Render.clampCam(); return;
    }
    if (I.mmDrag) { mmJump(e); return; }
    if (I.down) {
      const d = I.down;
      if (Math.abs(I.mx - d.x) > 4 || Math.abs(I.my - d.y) > 4) Render.box = { x0: Math.min(d.x, I.mx), y0: Math.min(d.y, I.my), x1: Math.max(d.x, I.mx), y1: Math.max(d.y, I.my) };
    }
  }
  function onUp(e) {
    if (e.button === 1) { I.pan = null; return; }
    if (I.mmDrag && e.button === 0) { I.mmDrag = false; return; }
    if (e.button !== 0 || !I.down || !Game.world) { I.down = null; return; }
    const d = I.down; I.down = null;
    if (Render.box) { boxSelect(Render.box, d.shift); Render.box = null; return; }
    clickSelect(d.x, d.y, d.shift, d.ctrl);
  }

  function boxSelect(b, add) {
    const w = Game.world, inBox = [];
    for (const u of w.units) {
      if (!own(u) && Game.me >= 0) continue;
      if (Game.me < 0 && !Render.entVisible(u)) continue;
      const p = Render.posOf(u, 1), s = Render.toScreen(p.x, p.y);
      if (s.x >= b.x0 - 4 && s.x <= b.x1 + 4 && s.y >= b.y0 - 4 && s.y <= b.y1 + 4) inBox.push(u);
    }
    let pickd = inBox;
    // Prefer army over workers when both are boxed.
    if (pickd.some(u => u.tid !== 0) && pickd.some(u => u.tid === 0) && !add) pickd = pickd.filter(u => u.tid !== 0);
    if (!pickd.length) {
      for (const bl of w.blds) {
        if (!own(bl)) continue;
        const s = Render.toScreen(bl.x * Render.U2P, bl.y * Render.U2P);
        if (s.x >= b.x0 && s.x <= b.x1 && s.y >= b.y0 && s.y <= b.y1) pickd.push(bl);
      }
    }
    if (!add) Render.sel.clear();
    for (const e of pickd) Render.sel.add(e.id);
    Hud.selSig = '';
  }

  function clickSelect(sx, sy, add, ctrl) {
    const e = pick(sx, sy);
    const t = now();
    if (!e) { if (!add) Render.sel.clear(); Hud.selSig = ''; return; }
    const dbl = t - I.lastClick.t < 320 && I.lastClick.id === e.id;
    I.lastClick = { t, id: e.id };
    if ((dbl || ctrl) && e.kind === TS.KU && (own(e) || Game.me < 0)) {
      if (!add) Render.sel.clear();
      for (const u of Game.world.units) {
        if (u.tid !== e.tid || u.owner !== e.owner) continue;
        const p = Render.posOf(u, 1), s = Render.toScreen(p.x, p.y);
        if (s.x >= 0 && s.y >= Render.topH && s.x <= Render.w && s.y <= Render.h - Render.botH) Render.sel.add(u.id);
      }
    } else if (add && own(e) && sel().every(s => own(s))) {
      if (Render.sel.has(e.id)) Render.sel.delete(e.id); else Render.sel.add(e.id);
    } else { Render.sel.clear(); Render.sel.add(e.id); }
    Hud.selSig = '';
  }

  function rightClick(sx, sy, shift) {
    if (Game.me < 0 || Game.world.over) return;
    if (I.mode) { setMode(null); return; }
    const p = Render.toWorld(sx, sy), x = toUnits(p.x), y = toUnits(p.y);
    const units = selOwnUnits();
    const t = pick(sx, sy);
    const t_ = performance.now();
    if (units.length) {
      const ids = units.map(u => u.id);
      const workers = units.filter(u => TS.UNITS[u.tid].cls === 'worker').map(u => u.id);
      if (t && t.owner >= 0 && t.owner !== Game.me) {
        Game.issue({ t: 'attack', ids, tg: t.id }); Render.ping(p.x, p.y, '#ff6b6b', t_); return;
      }
      if (t && t.kind === TS.KR && workers.length) {
        Game.issue({ t: 'gather', ids: workers, tg: t.id });
        const rest = ids.filter(id => workers.indexOf(id) < 0);
        if (rest.length) Game.issue({ t: 'move', ids: rest, x, y });
        Render.ping(t.x * Render.U2P, t.y * Render.U2P, '#c9a6ff', t_); return;
      }
      if (t && t.kind === TS.KB && own(t) && workers.length) {
        if (!t.done) { Game.issue({ t: 'help', ids: workers, tg: t.id }); Render.ping(p.x, p.y, '#ffd166', t_); return; }
        if (TS.BLDS[t.tid].drop && units.some(u => u.carry)) { Game.issue({ t: 'drop', ids: workers }); Render.ping(p.x, p.y, '#c9a6ff', t_); return; }
      }
      Game.issue({ t: 'move', ids, x, y }); Render.ping(p.x, p.y, '#7dff9a', t_);
      return;
    }
    const blds = sel().filter(e => e.kind === TS.KB && own(e) && TS.BLDS[e.tid].trains);
    if (blds.length) {
      const cmd = { t: 'rally', ids: blds.map(b => b.id), x, y };
      if (t && t.kind === TS.KR) cmd.tg = t.id;
      Game.issue(cmd); Render.ping(p.x, p.y, '#7dff9a', t_);
    }
  }

  function attackMove(sx, sy) {
    const units = selOwnUnits(); if (!units.length) return;
    const p = Render.toWorld(sx, sy), t = pick(sx, sy), ids = units.map(u => u.id);
    if (t && t.owner >= 0 && t.owner !== Game.me) Game.issue({ t: 'attack', ids, tg: t.id });
    else Game.issue({ t: 'amove', ids, x: toUnits(p.x), y: toUnits(p.y) });
    Render.ping(p.x, p.y, '#ffb347', now());
  }

  function placeSpot() {
    const bd = TS.BKEY.get(I.placeKey), p = Render.toWorld(I.mx, I.my);
    return { bd, tx: Math.round(p.x / Render.TILE - bd.w / 2), ty: Math.round(p.y / Render.TILE - bd.h / 2) };
  }
  function tryPlace(shift) {
    const s = placeSpot(), w = Game.world;
    const workers = selOwnUnits().filter(u => TS.UNITS[u.tid].cls === 'worker');
    if (!workers.length) { setMode(null); return; }
    let ok = w.canPlace(s.bd, s.tx, s.ty);
    for (let y = s.ty; y < s.ty + s.bd.h && ok; y++) for (let x = s.tx; x < s.tx + s.bd.w; x++) if (!Render.tileExplored(x, y)) { ok = false; break; }
    if (!ok) { Hud.toast("Can't build there"); return; }
    if (w.players[Game.me].res < s.bd.cost) { Hud.toast('Not enough Lumen'); return; }
    const cx = (s.tx + s.bd.w / 2) * SUB, cy = (s.ty + s.bd.h / 2) * SUB;
    workers.sort((a, b) => (Math.hypot(a.x - cx, a.y - cy) + (a.carry ? 512 : 0)) - (Math.hypot(b.x - cx, b.y - cy) + (b.carry ? 512 : 0)) || a.id - b.id);
    Game.issue({ t: 'build', ids: [workers[0].id], b: s.bd.key, tx: s.tx, ty: s.ty });
    if (!shift) setMode(null);
  }

  function setMode(m, key) {
    I.mode = m; I.placeKey = m === 'place' ? key : null;
    Render.place = null;
    cv.style.cursor = m === 'amove' ? 'crosshair' : 'default';
    Hud.selSig = '';
  }

  // ------------------------------------------------------------------ minimap
  function mmPoint(e) {
    const r = mm.getBoundingClientRect(), w = Game.world;
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    return { x: fx * w.W * Render.TILE, y: fy * w.H * Render.TILE };
  }
  function mmJump(e) { const p = mmPoint(e); Render.centerOn(p.x, p.y); }
  function mmDown(e) {
    if (!Game.world) return;
    e.preventDefault();
    if (e.button === 0) {
      if (I.mode === 'amove') { const p = mmPoint(e); const s = Render.toScreen(p.x, p.y); attackMove(s.x, s.y); setMode(null); return; }
      I.mmDrag = true; mmJump(e); return;
    }
    if (e.button === 2 && Game.me >= 0) {
      const p = mmPoint(e), units = selOwnUnits();
      if (units.length) { Game.issue({ t: 'move', ids: units.map(u => u.id), x: toUnits(p.x), y: toUnits(p.y) }); Render.ping(p.x, p.y, '#7dff9a', now()); }
      else {
        const blds = sel().filter(b => b.kind === TS.KB && own(b) && TS.BLDS[b.tid].trains);
        if (blds.length) Game.issue({ t: 'rally', ids: blds.map(b => b.id), x: toUnits(p.x), y: toUnits(p.y) });
      }
    }
  }

  // ------------------------------------------------------------------ actions (card + hotkeys)
  I.action = function (act) {
    if (!Game.world || Game.me < 0) return;
    const w = Game.world, me = Game.me;
    if (act === 'amove') { if (selOwnUnits().length) setMode('amove'); return; }
    if (act === 'stop') { const ids = selOwnUnits().map(u => u.id); if (ids.length) Game.issue({ t: 'stop', ids }); return; }
    if (act === 'drop') { const ids = selOwnUnits().filter(u => u.carry).map(u => u.id); if (ids.length) Game.issue({ t: 'drop', ids }); return; }
    if (act === 'rallyhint') { Hud.toast('Right-click the map to set the rally point'); return; }
    if (act === 'cancel') { const b = sel().filter(e => e.kind === TS.KB && own(e) && e.q.length).sort((a, b) => b.q.length - a.q.length)[0]; if (b) Game.issue({ t: 'cancel', ids: [b.id] }); return; }
    const [kind, key] = act.split(':');
    if (kind === 'build') {
      const bd = TS.BKEY.get(key);
      if (bd.req && !w.hasDone(me, bd.req)) { Hud.toast('Requires a finished ' + TS.BKEY.get(bd.req).name); return; }
      if (w.players[me].res < bd.cost) { Hud.toast('Not enough Lumen'); return; }
      setMode('place', key); return;
    }
    if (kind === 'train') {
      const ids = sel().filter(e => e.kind === TS.KB && own(e)).map(e => e.id);
      const n = I.keys.has('Shift') ? 5 : 1;
      for (let i = 0; i < n; i++) Game.issue({ t: 'train', ids, u: key });
    }
  };

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!Game.world || document.getElementById('hud').classList.contains('hidden')) return;
    I.keys.add(e.key);
    const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k;
    const pauseOpen = !document.getElementById('pause').classList.contains('hidden');
    const endOpen = !document.getElementById('end').classList.contains('hidden');
    if (endOpen) return;
    if (k === 'Escape' || k === 'F10') {
      e.preventDefault();
      if (I.mode && k === 'Escape') { setMode(null); return; }
      UI.togglePause(); return;
    }
    if (pauseOpen) return;
    if (k.startsWith('Arrow')) { e.preventDefault(); return; }
    if (Game.mode === 'replay' || Game.mode === 'watch') {
      if (k === ' ') { e.preventDefault(); Game.setPaused(!Game.paused); }
      return;
    }
    if (k === 'p' || k === 'P') { if (Game.canPause()) Game.setPaused(!Game.paused); return; }
    if (k === ' ') { e.preventDefault(); centerSel(); return; }
    if (k === '.') { idleWorker(); return; }
    if (/^[0-9]$/.test(k)) { group(+k, e.ctrlKey || e.metaKey, e.shiftKey); e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const c = Hud.card.find(c => c.key.toLowerCase() === lower);
    if (c) { e.preventDefault(); I.action(c.act); }
  }

  function group(n, set, add) {
    const w = Game.world;
    if (set || add) {
      const ids = sel().filter(own).map(e => e.id);
      if (!ids.length) return;
      const cur = add ? (I.groups.get(n) || []) : [];
      I.groups.set(n, Array.from(new Set(cur.concat(ids))));
      Hud.toast(`Group ${n}: ${I.groups.get(n).length}`);
      return;
    }
    const ids = (I.groups.get(n) || []).filter(id => w.byId.has(id));
    if (!ids.length) return;
    Render.sel.clear(); for (const id of ids) Render.sel.add(id); Hud.selSig = '';
    const t = now();
    if (I.lastGroup.k === n && t - I.lastGroup.t < 400) centerSel();
    I.lastGroup = { k: n, t };
  }
  function centerSel() {
    const s = sel();
    let list = s.length ? s : Game.world.blds.filter(b => b.owner === Game.me && b.tid === 0);
    if (!list.length) return;
    let x = 0, y = 0; for (const e of list) { x += e.x; y += e.y; }
    Render.centerOn(x / list.length * Render.U2P, y / list.length * Render.U2P);
  }
  function idleWorker() {
    const idle = Game.world.units.filter(u => u.owner === Game.me && u.tid === 0 && u.ord === TS.ORD.IDLE);
    if (!idle.length) { Hud.toast('No idle Motes'); return; }
    const u = idle[I.idleIdx++ % idle.length];
    Render.sel.clear(); Render.sel.add(u.id); Hud.selSig = '';
    Render.centerOn(u.x * Render.U2P, u.y * Render.U2P);
  }

  // ------------------------------------------------------------------ per frame
  I.update = function (dt, t) {
    if (!Game.world) return;
    const sp = 900 * dt / 1000 / Render.cam.z;
    let dx = 0, dy = 0;
    if (I.keys.has('ArrowLeft')) dx -= sp; if (I.keys.has('ArrowRight')) dx += sp;
    if (I.keys.has('ArrowUp')) dy -= sp; if (I.keys.has('ArrowDown')) dy += sp;
    if (I.inside && !I.down && !I.pan && document.hasFocus()) {
      const m = 6;
      if (I.mx >= 0 && I.mx < m) dx -= sp; else if (I.mx > Render.w - m) dx += sp;
      if (I.my >= 0 && I.my < m) dy -= sp; else if (I.my > Render.h - m) dy += sp;
    }
    if (dx || dy) { Render.cam.x += dx; Render.cam.y += dy; Render.clampCam(); }
    if (I.mode === 'place' && I.mx >= 0) {
      const s = placeSpot(); Render.place = { bd: s.bd, tx: s.tx, ty: s.ty };
    }
    const h = I.mx >= 0 && !overHud(I.mx, I.my) ? pick(I.mx, I.my) : null;
    Render.hover = h ? h.id : 0;
    if (!I.mode && !I.pan) cv.style.cursor = h && h.owner >= 0 && h.owner !== Game.me && Game.me >= 0 && selOwnUnits().length ? 'crosshair' : 'default';
  };

  return I;
})();
