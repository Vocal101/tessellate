// Tessellate — PeerJS transport. Host/join with a room code; after the handshake the data
// channel only carries lockstep input packets ({t:'in'}), pings, and a goodbye.
'use strict';
const Net = (() => {
  const PREFIX = 'tessellate-v' + TS.VERSION + '-';
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const N = { peer: null, conn: null, role: 'off', code: '', onMsg: null, onClose: null, rtt: 0, lastPong: 0 };

  const available = () => typeof Peer !== 'undefined';
  function genCode() { let s = ''; for (let i = 0; i < 5; i++) s += ALPH[Math.floor(Math.random() * ALPH.length)]; return s; }
  function errText(e) {
    const t = e && e.type;
    if (t === 'peer-unavailable') return 'No room with that code. Check it and try again.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Could not reach the PeerJS signalling server. Check your connection.';
    if (t === 'browser-incompatible') return 'This browser does not support WebRTC data channels.';
    return 'Connection error' + (t ? ' (' + t + ')' : '') + '.';
  }

  function close() {
    try { if (N.conn && N.conn.open) N.conn.send({ t: 'bye' }); } catch (e) { /* ignore */ }
    try { if (N.conn) N.conn.close(); } catch (e) { /* ignore */ }
    try { if (N.peer) N.peer.destroy(); } catch (e) { /* ignore */ }
    clearInterval(N.pingTimer);
    N.peer = null; N.conn = null; N.role = 'off'; N.code = ''; N.rtt = 0;
  }

  function wire(conn) {
    N.conn = conn;
    N.lastPong = performance.now();
    conn.on('data', d => {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'ping') { conn.send({ t: 'pong', ts: d.ts }); return; }
      if (d.t === 'pong') { N.rtt = performance.now() - d.ts; N.lastPong = performance.now(); return; }
      if (d.t === 'bye') { if (N.onClose) N.onClose('Your opponent left the match.'); return; }
      if (N.onMsg) N.onMsg(d);
    });
    conn.on('close', () => { if (N.conn === conn && N.onClose) N.onClose('Connection to your opponent was lost.'); });
    conn.on('error', () => { /* close follows */ });
    clearInterval(N.pingTimer);
    N.pingTimer = setInterval(() => { try { if (conn.open) conn.send({ t: 'ping', ts: performance.now() }); } catch (e) { /* ignore */ } }, 1000);
  }

  // cb(err, code) when the room is open; onStart(startCfg) once a guest joins.
  function host(cb, onStart) {
    if (!available()) { cb('Online play needs PeerJS, which did not load.'); return; }
    close();
    const code = genCode();
    N.role = 'host'; N.code = code;
    const peer = new Peer(PREFIX + code, { debug: 0 });
    N.peer = peer;
    let opened = false, busy = false;
    peer.on('open', () => { opened = true; cb(null, code); });
    peer.on('connection', conn => {
      conn.on('open', () => {
        conn.once('data', d => {
          if (!d || d.t !== 'hello') return;
          if (d.v !== TS.VERSION) { conn.send({ t: 'deny', why: 'Game versions differ. Both players should refresh.' }); return; }
          if (busy) { conn.send({ t: 'deny', why: 'That room is already in a match.' }); return; }
          busy = true;
          wire(conn);
          const cfg = { seed: (Math.random() * 0xffffffff) >>> 0, delay: 4, hostPid: 0 };
          conn.send({ t: 'start', cfg });
          onStart(Object.assign({ pid: 0 }, cfg));
        });
      });
    });
    peer.on('error', e => {
      if (!opened && e.type === 'unavailable-id') { close(); host(cb, onStart); return; }
      if (!opened) cb(errText(e));
    });
    peer.on('disconnected', () => { try { if (!N.conn) peer.reconnect(); } catch (e) { /* ignore */ } });
  }

  function join(code, cb) {
    if (!available()) { cb('Online play needs PeerJS, which did not load.'); return; }
    close();
    code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { cb('Enter the 5-letter room code.'); return; }
    N.role = 'guest'; N.code = code;
    const peer = new Peer({ debug: 0 });
    N.peer = peer;
    let done = false;
    const fail = msg => { if (done) return; done = true; clearTimeout(timer); close(); cb(msg); };
    const timer = setTimeout(() => fail('Timed out. Is the room still open?'), 15000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => conn.send({ t: 'hello', v: TS.VERSION }));
      conn.on('data', d => {
        if (done || !d) return;
        if (d.t === 'deny') { fail(d.why || 'The host refused the connection.'); return; }
        if (d.t === 'start') {
          done = true; clearTimeout(timer);
          wire(conn);
          const cfg = d.cfg || {};
          cb(null, { pid: 1, seed: cfg.seed >>> 0, delay: Math.max(2, Math.min(10, cfg.delay | 0)) });
        }
      });
    });
    peer.on('error', e => fail(errText(e)));
  }

  function send(msg) { try { if (N.conn && N.conn.open) N.conn.send(msg); } catch (e) { /* ignore */ } }

  return { N, host, join, send, close, available };
})();
