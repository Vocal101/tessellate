// Tessellate — lockstep session and replays. No DOM here: node tests drive this file directly.
//
// Every tick t, each controller (a human on this machine, a CPU, or the remote peer) must have
// committed its command list for t before anyone may simulate t. Local commands typed during
// tick t are committed for tick t + delay and sent to the peer at once, so a round trip shorter
// than delay * 50 ms never stalls. Each input message also carries this peer's state hash for an
// earlier tick; a mismatch means the simulations diverged (desync).
(function () {
  'use strict';
  const TS = globalThis.TS;

  class Session {
    // opts: { world, delay, humans: [pid...], cpus: [{pid, cpu}], remote: pid | -1, send: fn(msg), record }
    constructor(opts) {
      this.world = opts.world;
      this.delay = opts.delay || 3;
      this.humans = opts.humans || [];
      this.cpus = opts.cpus || [];
      this.remote = opts.remote === undefined ? -1 : opts.remote;
      this.send = opts.send || null;
      this.inputs = new Map();                 // tick -> [cmds0 | null, cmds1 | null]
      this.pending = [[], []];
      this.log = [];                           // [tick, pid, cmds] for non-empty inputs
      this.hashes = new Map();                 // tick -> local hash after stepping that tick
      this.remoteHashes = new Map();
      this.desync = null;                      // { tick, local, remote }
      this.maxRemote = -1;                     // highest tick the peer has committed
      this.onDesync = null;
      this.lastHashTick = -1;
      for (let t = 0; t < this.delay; t++) this.inputs.set(t, [[], []]);
      this.startHash = this.world.hash(true);
    }

    slot(t) { let s = this.inputs.get(t); if (!s) { s = [null, null]; this.inputs.set(t, s); } return s; }

    // Queue a command from a local human.
    issue(pid, cmd) { if (this.humans.indexOf(pid) >= 0 && !this.world.over) this.pending[pid].push(cmd); }

    canStep() {
      const s = this.inputs.get(this.world.tick);
      return !!(s && s[0] && s[1]);
    }

    // How many ticks of the peer's input we already hold beyond the current tick.
    lead() { return this.remote < 0 ? 99 : this.maxRemote - this.world.tick; }

    step() {
      const w = this.world, t = w.tick;
      if (!this.canStep()) return false;
      // CPUs decide based on the state at t, exactly like a human looking at the screen.
      for (const c of this.cpus) {
        const cmds = c.cpu.tickCmds();
        for (const cmd of cmds) this.pending[c.pid].push(cmd);
      }
      const k = t + this.delay;
      const locals = this.humans.concat(this.cpus.map(c => c.pid));
      for (const pid of locals) {
        const s = this.slot(k);
        if (!s[pid]) s[pid] = this.pending[pid];
        this.pending[pid] = [];
        if (pid !== this.remote && this.send && this.humans.indexOf(pid) >= 0) {
          const hk = t - 1;
          this.send({ t: 'in', k, c: s[pid], hk, h: hk >= 0 ? this.hashes.get(hk) : '' });
        }
      }
      const s = this.inputs.get(t);
      for (let p = 0; p < 2; p++) if (s[p].length) this.log.push([t, p, s[p]]);
      w.step(s);
      this.inputs.delete(t);
      const h = w.hash(false);
      this.hashes.set(t, h);
      this.check(t);
      if (t > 600) { this.hashes.delete(t - 600); this.remoteHashes.delete(t - 600); }
      return true;
    }

    // Peer message handler.
    receive(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'in') {
        const k = msg.k | 0;
        if (k < this.world.tick || this.remote < 0) return;
        const cmds = Array.isArray(msg.c) ? msg.c.slice(0, 64) : [];
        const s = this.slot(k);
        if (!s[this.remote]) s[this.remote] = cmds;
        if (k > this.maxRemote) this.maxRemote = k;
        if (typeof msg.h === 'string' && msg.h && msg.hk >= 0) { this.remoteHashes.set(msg.hk | 0, msg.h); this.check(msg.hk | 0); }
      }
    }

    check(t) {
      const a = this.hashes.get(t), b = this.remoteHashes.get(t);
      if (a && b) {
        this.lastHashTick = Math.max(this.lastHashTick, t);
        if (a !== b && !this.desync) {
          this.desync = { tick: t, local: a, remote: b };
          if (this.onDesync) this.onDesync(this.desync);
        }
      }
    }

    replay(meta) {
      return {
        game: 'tessellate', v: TS.VERSION, seed: this.world.seed, delay: this.delay,
        meta: meta || {}, log: this.log, end: this.world.tick, hash: this.world.hash(true), startHash: this.startHash,
        winner: this.world.winner,
      };
    }
  }

  // Plays a replay back by feeding its logged inputs to a fresh world.
  class ReplayPlayer {
    constructor(rep) {
      if (!rep || rep.game !== 'tessellate') throw new Error('Not a Tessellate replay');
      if (rep.v !== TS.VERSION) throw new Error('Replay is from a different game version (v' + rep.v + ')');
      this.rep = rep;
      this.world = new TS.World({ seed: rep.seed });
      this.byTick = new Map();
      for (const [t, p, cmds] of rep.log) {
        let s = this.byTick.get(t); if (!s) { s = [[], []]; this.byTick.set(t, s); }
        s[p] = cmds;
      }
      this.verified = null;     // true / false once the end is reached
    }
    get done() { return this.world.tick >= this.rep.end; }
    canStep() { return !this.done; }
    step() {
      if (this.done) return false;
      const t = this.world.tick;
      this.world.step(this.byTick.get(t) || [[], []]);
      if (this.done) this.verified = this.world.hash(true) === this.rep.hash;
      return true;
    }
    run() { while (this.step()); return this.verified; }
  }

  TS.Session = Session;
  TS.ReplayPlayer = ReplayPlayer;
})();
