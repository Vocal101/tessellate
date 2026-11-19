// Tessellate — ?dev test harness. Exposes window.T for driving the game from a console or a test.
'use strict';
(function () {
  if (!/[?&]dev\b/.test(location.search)) return;
  const T = {
    errs: [],
    get world() { return Game.world; },
    get session() { return Game.session; },
    // Start a match. opts: {mode:'cpu'|'watch', diff, seed}
    start(opts = {}) {
      const seed = opts.seed === undefined ? 12345 : opts.seed;
      if (opts.mode === 'watch') Game.startWatch(seed, opts.l0 || 'normal', opts.l1 || 'hard');
      else Game.startCpu(opts.diff || 'normal', seed);
      return T.state();
    },
    // Advance n ticks synchronously through the real input path (CPU thinks, commands commit).
    step(n = 1) { return Game.stepN(n); },
    run(sec) { return Game.stepN(Math.round(sec * TS.HZ)); },
    frames(n = 1) { for (let i = 0; i < n; i++) { const t = performance.now(); Game.after(t); if (!Game.world) break; Render.draw(1, t); Hud.frame(Game, t); } return Render.stats.ms; },
    hash(full) { return Game.world.hash(!!full); },
    dump() { return Game.world.dump(); },
    spawn(key, owner, tx, ty, n) { return Game.world.debugSpawn(key, owner, tx, ty, n); },
    cmd(c) { return Game.issue(c); },
    select(ids) { Render.sel.clear(); for (const id of ids) Render.sel.add(id); Hud.selSig = ''; return ids.length; },
    mine(kind) { return Game.world.ents.filter(e => e.owner === Game.me && (!kind || (e.kind === TS.KU ? TS.UNITS[e.tid].key : e.kind === TS.KB ? TS.BLDS[e.tid].key : 'res') === kind)).map(e => e.id); },
    cam(tx, ty, z) { if (z) Render.cam.z = z; Render.centerOn(tx * Render.TILE, ty * Render.TILE); },
    reveal(on = true) { Render.view = on ? -1 : Game.me; },
    // Corrupt local state to demonstrate desync detection in an online match.
    desync() { const u = Game.world.units.find(u => u.owner === Game.me); if (u) u.hp -= 1; return !!u; },
    state() {
      const w = Game.world; if (!w) return null;
      return { mode: Game.mode, tick: w.tick, over: w.over, winner: w.winner, hash: w.hash(false),
        players: w.players.map((p, i) => ({ res: p.res, sup: p.sup + '/' + p.cap, units: w.units.filter(u => u.owner === i).length, blds: w.blds.filter(b => b.owner === i).length })),
        desync: Game.session && Game.session.desync, stalled: !!Game.stallSince, lead: Game.session ? Game.session.lead() : null };
    },
    // Headless CPU vs CPU in this page (does not touch the current match).
    cpuVsCpu(minutes = 20, seed = 1, l0 = 'normal', l1 = 'normal') {
      const w = new TS.World({ seed });
      const s = new TS.Session({ world: w, delay: 2, cpus: [{ pid: 0, cpu: new TS.Cpu(w, 0, l0, seed) }, { pid: 1, cpu: new TS.Cpu(w, 1, l1, seed) }] });
      const t0 = performance.now();
      while (!w.over && w.tick < minutes * 60 * TS.HZ) s.step();
      const rep = s.replay();
      const verified = new TS.ReplayPlayer(JSON.parse(JSON.stringify(rep))).run();
      return { winner: w.winner, ticks: w.tick, hash: w.hash(true), ms: Math.round(performance.now() - t0), replayVerified: verified };
    },
    // Save a JPEG of the canvas through the dev server (POST /__snap/<name>).
    async snap(name = 'snap') {
      T.frames(1);
      const url = document.getElementById('view').toDataURL('image/jpeg', 0.85);
      const blob = await (await fetch(url)).blob();
      const r = await fetch('/__snap/' + name, { method: 'POST', body: blob });
      return r.ok;
    },
  };
  window.addEventListener('error', e => T.errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => T.errs.push(String(e.reason)));
  window.T = T;
  console.log('Tessellate dev harness ready: window.T');
})();
