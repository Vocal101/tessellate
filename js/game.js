// Tessellate — match controller: owns the world, the input source (lockstep session or replay
// player) and the fixed-timestep loop. The sim ticks at 20 Hz; rendering runs every frame and
// interpolates between ticks.
'use strict';
const Game = (() => {
  const G = {
    mode: null,             // 'cpu' | 'online' | 'watch' | 'replay'
    world: null, session: null, rp: null, src: null,
    me: -1, speed: 1, paused: false, acc: 0, last: 0, stallSince: 0, seekTo: -1,
    overAt: 0, endShown: false, lastReplay: null, names: ['Teal', 'Ember'], diff: 'normal', connMsg: '',
  };
  const LS_REPLAY = 'tessellate_last_replay_v' + TS.VERSION;
  const STEP = TS.TICK_MS;

  function begin(world, src, me, view) {
    G.world = world; G.src = src; G.me = me;
    G.acc = 0; G.last = performance.now(); G.paused = false; G.speed = 1; G.stallSince = 0; G.seekTo = -1;
    G.overAt = 0; G.endShown = false; G.connMsg = '';
    Render.setWorld(world, view);
    Hud.enter(G);
    Input.reset();
  }

  G.startCpu = function (diff, seed) {
    G.mode = 'cpu'; G.diff = diff;
    const w = new TS.World({ seed });
    G.session = new TS.Session({ world: w, delay: 2, humans: [0], cpus: [{ pid: 1, cpu: new TS.Cpu(w, 1, diff, seed) }] });
    G.rp = null; G.names = ['You', 'CPU (' + diff + ')'];
    begin(w, G.session, 0, 0);
  };

  G.startWatch = function (seed, l0, l1) {
    G.mode = 'watch';
    const w = new TS.World({ seed });
    G.session = new TS.Session({ world: w, delay: 2, cpus: [{ pid: 0, cpu: new TS.Cpu(w, 0, l0 || 'normal', seed) }, { pid: 1, cpu: new TS.Cpu(w, 1, l1 || 'normal', seed) }] });
    G.rp = null; G.names = ['CPU Teal', 'CPU Ember'];
    begin(w, G.session, -1, -1);
  };

  G.startOnline = function (cfg) {
    G.mode = 'online';
    const w = new TS.World({ seed: cfg.seed });
    const s = new TS.Session({ world: w, delay: cfg.delay, humans: [cfg.pid], remote: 1 - cfg.pid, send: Net.send });
    s.onDesync = d => Hud.desync(d);
    G.session = s; G.rp = null;
    G.names = cfg.pid === 0 ? ['You (host)', 'Opponent'] : ['Opponent (host)', 'You'];
    Net.N.onMsg = m => { s.receive(m); pump(); };
    Net.N.onClose = msg => { if (G.mode === 'online' && !w.over) { G.connMsg = msg; Hud.banner(msg + ' The match is over.', 'desync'); finish(); } };
    begin(w, s, cfg.pid, cfg.pid);
  };

  G.startReplay = function (rep) {
    const rp = new TS.ReplayPlayer(rep);
    G.mode = 'replay'; G.rp = rp; G.session = null;
    G.names = (rep.meta && rep.meta.names) || ['Teal', 'Ember'];
    G.replayData = rep;
    begin(rp.world, rp, -1, -1);
  };

  G.quit = function () {
    if (G.mode === 'online') Net.close();
    G.mode = null; G.world = null; G.src = null; G.session = null; G.rp = null;
    Render.world = null;
    Hud.leave();
  };

  // Commands from this machine's human go through the lockstep session, never straight to the world.
  G.issue = function (cmd) {
    if (!G.session || G.me < 0 || G.world.over) return false;
    G.session.issue(G.me, cmd);
    return true;
  };

  G.canPause = () => G.mode === 'cpu' || G.mode === 'watch' || G.mode === 'replay';
  G.setPaused = function (p) { if (G.canPause()) { G.paused = p; G.last = performance.now(); } };

  function finish() {
    if (G.overAt) return;
    G.overAt = performance.now();
    if (G.session) {
      G.lastReplay = G.session.replay({ names: G.names, mode: G.mode, date: new Date().toISOString(), conn: G.connMsg || undefined });
      try { localStorage.setItem(LS_REPLAY, JSON.stringify(G.lastReplay)); } catch (e) { /* storage full or blocked */ }
    }
  }
  G.loadLastReplay = function () {
    if (G.lastReplay) return G.lastReplay;
    try { const s = localStorage.getItem(LS_REPLAY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  };
  G.download = function (obj, name) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  G.desyncDump = function () {
    const s = G.session;
    return { desync: s && s.desync, me: G.me, state: G.world.dump(), replay: s && s.replay({ names: G.names, mode: G.mode }) };
  };

  // Replay seeking: re-simulate from the start (fast: the sim is a few hundred µs per tick).
  G.seek = function (tick) {
    if (G.mode !== 'replay') return;
    tick = Math.max(0, Math.min(G.rp.rep.end, tick | 0));
    if (tick < G.world.tick) {
      const cam = Object.assign({}, Render.cam), view = Render.view;
      G.rp = new TS.ReplayPlayer(G.replayData); G.src = G.rp; G.world = G.rp.world;
      Render.setWorld(G.world, view); Object.assign(Render.cam, cam);
    }
    G.seekTo = tick;
  };

  function stepOnce(now, quiet) {
    if (!G.src.step()) return false;
    if (!quiet) { Render.absorb(G.world.events, now); Hud.events(G.world.events); }
    return true;
  }

  // Advance the simulation by dt ms of wall time; returns the interpolation alpha.
  function advance(dt, now) {
    const w = G.world;
    if (G.seekTo >= 0) {
      let n = 0;
      while (w.tick < G.seekTo && n < 3000) { stepOnce(now, true); n++; }
      if (w.tick >= G.seekTo) { G.seekTo = -1; G.acc = 0; }
      return 1;
    }
    if (G.paused || (w.over && G.mode !== 'replay')) return 1;
    G.acc += dt * G.speed;
    let steps = 0;
    const maxSteps = Math.min(80, Math.max(8, Math.ceil(G.speed * 2), Math.ceil(dt / STEP) + 2));
    while (G.acc >= STEP && steps < maxSteps) {
      if (!G.src.canStep()) {
        if (G.mode === 'online' && !G.stallSince) G.stallSince = now;
        G.acc = Math.min(G.acc, STEP);
        break;
      }
      G.stallSince = 0;
      stepOnce(now, false);
      G.acc -= STEP; steps++;
      if (w.over) break;
    }
    // Online: if the peer is well ahead of us, catch up a little faster.
    if (G.mode === 'online' && G.session.lead() > G.session.delay + 2 && G.src.canStep()) stepOnce(now, false);
    if (steps >= maxSteps) G.acc = Math.min(G.acc, STEP);
    return Math.min(1, G.acc / STEP);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    G.lastFrame = now;
    if (!G.world) return;
    let dt = now - G.last; G.last = now;
    if (dt > 250) dt = 250;
    const alpha = advance(dt, now);
    G.after(now);
    Input.update(dt, now);
    Render.draw(alpha, now);
    Hud.frame(G, now);
  }
  // Browsers stop requestAnimationFrame in background tabs. In an online match that would stall
  // the opponent, so a timer keeps the simulation (not the renderer) running while hidden.
  // Hidden tabs only get ~1 Hz timers, but data-channel messages still arrive at full speed, so
  // each incoming input packet also pumps the simulation.
  function pump() {
    if (!G.world || G.mode !== 'online') return;
    const now = performance.now();
    if (now - (G.lastFrame || 0) < 150) return;
    const dt = Math.min(4000, now - G.last); G.last = now;
    advance(dt, now);
    G.after(now);
  }
  setInterval(pump, 50);
  G.after = function (now) {
    if (!G.world) return;
    if (G.world.over && G.mode !== 'replay') finish();
    if (G.overAt && !G.endShown && now - G.overAt > 1600) { G.endShown = true; Hud.showEnd(G); }
  };
  G.boot = function () { G.last = performance.now(); requestAnimationFrame(frame); };
  // Dev: synchronous ticking (the preview pane throttles requestAnimationFrame).
  G.stepN = function (n) { let k = 0; while (k < n && G.src && G.src.canStep() && !G.world.over) { stepOnce(performance.now(), k < n - 10); k++; } return k; };

  return G;
})();
