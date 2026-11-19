// Tessellate — DOM HUD: top bar, selection panel, command card, minimap, banners, replay bar,
// menus and the end screen. Reads game state; sends commands only through Input/Game.
'use strict';
const Hud = (() => {
  const $ = id => document.getElementById(id);
  const H = { card: [], selSig: '', lastSel: 0, iconCache: new Map(), bannerKind: '' };
  const HZ = TS.HZ;

  H.icon = function (kind, key, owner, size) {
    const k = kind + key + owner + size;
    let url = H.iconCache.get(k);
    if (!url) {
      const c = document.createElement('canvas'); c.width = c.height = size * 2;
      Render.icon(c, kind, key, owner);
      url = c.toDataURL(); H.iconCache.set(k, url);
    }
    return url;
  };
  const fmtTime = t => { const s = Math.floor(t / HZ); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  H.fmtTime = fmtTime;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ screens
  H.show = function (id) {
    for (const s of ['menu', 'lobby', 'help', 'pause', 'end']) $(s).classList.toggle('hidden', s !== id);
  };
  H.enter = function (G) {
    H.show(null);
    $('hud').classList.remove('hidden');
    const rb = G.mode === 'replay' || G.mode === 'watch';
    $('replayBar').classList.toggle('hidden', !rb);
    $('rbTrack').style.display = G.mode === 'replay' ? '' : 'none';
    $('rbTime').style.display = G.mode === 'replay' ? '' : 'none';
    $('rbVerify').style.display = G.mode === 'replay' ? '' : 'none';
    $('rbVerify').className = 'badge'; $('rbVerify').textContent = 'verify at end';
    $('rbVision').value = '-1';
    H.speedButtons(G);
    H.banner(null);
    $('toast').innerHTML = '';
    H.selSig = '';
  };
  H.leave = function () {
    $('hud').classList.add('hidden');
    H.show('menu');
    H.banner(null);
  };

  H.speedButtons = function (G) {
    const box = $('rbSpeeds'); box.innerHTML = '';
    const speeds = G.mode === 'replay' ? [0.5, 1, 2, 4, 8, 16] : [1, 2, 4, 8];
    for (const s of speeds) {
      const b = document.createElement('button');
      b.textContent = s + '×'; b.className = s === G.speed ? 'on' : '';
      b.onclick = () => { G.speed = s; for (const x of box.children) x.classList.toggle('on', x === b); };
      box.appendChild(b);
    }
  };

  // ------------------------------------------------------------------ banners and toasts
  H.toast = function (msg) {
    const t = $('toast');
    const d = document.createElement('div'); d.textContent = msg; t.appendChild(d);
    while (t.children.length > 3) t.firstChild.remove();
    setTimeout(() => d.remove(), 2500);
  };
  H.banner = function (msg, kind, btn) {
    const b = $('banner');
    if (!msg) { b.classList.add('hidden'); H.bannerKind = ''; return; }
    b.className = kind || ''; b.innerHTML = '';
    const s = document.createElement('span'); s.textContent = msg; b.appendChild(s);
    if (btn) { const x = document.createElement('button'); x.className = 'tbtn'; x.textContent = btn.label; x.onclick = btn.fn; b.appendChild(x); }
    H.bannerKind = kind || 'info';
  };
  H.desync = function (d) {
    H.banner(`DESYNC at tick ${d.tick}: state hash ${d.local} here vs ${d.remote} on the other side.`, 'desync',
      { label: 'Download state dump', fn: () => Game.download(Game.desyncDump(), `tessellate-desync-${d.tick}.json`) });
  };
  H.events = function (evs) {
    for (const e of evs) if (e.k === 'err' && e.p === Game.me) H.toast(e.msg);
  };

  // ------------------------------------------------------------------ per-frame
  let lastTop = '';
  H.frame = function (G, now) {
    const w = G.world;
    const pid = G.me >= 0 ? G.me : Math.max(0, Render.view);
    const p = w.players[pid];
    let workers = 0; for (const u of w.units) if (u.owner === pid && u.tid === 0) workers++;
    const top = p.res + '|' + p.sup + '|' + p.cap + '|' + workers + '|' + Math.floor(w.tick / HZ);
    if (top !== lastTop) {
      lastTop = top;
      $('hRes').textContent = p.res;
      $('hSup').textContent = p.sup + '/' + p.cap;
      $('hSup').classList.toggle('warn', p.sup >= p.cap && p.cap < TS.MAX_SUP);
      $('hWork').textContent = workers;
      $('hClock').textContent = fmtTime(w.tick);
    }
    // Network status.
    let net = '';
    if (G.mode === 'online') {
      const rtt = Math.round(Net.N.rtt), s = G.session;
      const cls = rtt < 120 ? 'ok' : rtt < 250 ? 'warn' : 'bad';
      net = `<span class="${cls}">● ${rtt} ms</span> · delay ${s.delay * TS.TICK_MS} ms · hash ✓ ${s.lastHashTick >= 0 ? s.lastHashTick : '—'}`;
      if (s.desync) net = '<span class="bad">● DESYNC</span>';
      const stalled = G.stallSince && now - G.stallSince > 300;
      if (stalled && !H.bannerKind) H.banner('Waiting for opponent…', 'info');
      else if (!stalled && H.bannerKind === 'info') H.banner(null);
    } else if (G.mode === 'cpu') net = `vs CPU · ${G.diff}`;
    else if (G.mode === 'watch') net = 'CPU vs CPU';
    else if (G.mode === 'replay') net = 'Replay · ' + esc(G.names.join(' vs '));
    if (G.paused) net += ' · <b>paused</b>';
    if (net !== H.lastNet) { $('hNet').innerHTML = net; H.lastNet = net; }

    if (G.mode === 'replay') {
      const rep = G.rp.rep, f = Math.min(1, w.tick / Math.max(1, rep.end));
      $('rbFill').style.width = (f * 100).toFixed(1) + '%';
      $('rbTime').textContent = fmtTime(w.tick) + ' / ' + fmtTime(rep.end);
      const v = $('rbVerify');
      if (G.rp.verified === true && !v.classList.contains('ok')) { v.className = 'badge ok'; v.textContent = '✓ hash verified'; }
      if (G.rp.verified === false && !v.classList.contains('bad')) { v.className = 'badge bad'; v.textContent = '✗ hash mismatch'; }
      $('rbPlay').textContent = G.paused ? '▶' : '❚❚';
    } else if (G.mode === 'watch') $('rbPlay').textContent = G.paused ? '▶' : '❚❚';

    Render.drawMinimap($('minimap'), now);
    if (now - H.lastSel > 120) { H.lastSel = now; H.updateSelection(G); }
  };

  // ------------------------------------------------------------------ selection + command card
  H.selected = function () {
    const w = Game.world, out = [];
    for (const id of Render.sel) { const e = w.byId.get(id); if (e) out.push(e); else Render.sel.delete(id); }
    return out;
  };

  H.updateSelection = function (G) {
    const w = G.world, sel = H.selected();
    const mine = sel.length && G.me >= 0 && sel[0].owner === G.me;
    let sig = sel.map(e => e.id + ':' + e.hp + ':' + (e.carry || 0) + ':' + (e.q ? e.q.join(',') + '/' + (e.qp >> 2) + '/' + e.prog : '') + ':' + (e.amt || 0)).join('|');
    const pl = w.players[Math.max(0, G.me)];
    sig += '#' + (pl.sup + pl.cap * 1000) + '#' + (mine ? 1 : 0) + '#' + Input.mode + '#' + Input.placeKey + '#' + w.blds.filter(b => b.owner === G.me && b.done).length;
    if (sig === H.selSig) return;
    H.selSig = sig;
    H.renderSel(G, sel);
    H.renderCard(G, sel, mine);
  };

  function unitLines(d) {
    const rng = d.range > 200 ? (d.range / TS.SUB).toFixed(0) + ' tiles' : 'melee';
    const dps = (d.dmg * HZ / d.cd).toFixed(1);
    const name = k => k === 'buildings' ? 'buildings' : (TS.UKEY.get(k) || {}).name || k;
    return `<div class="line">Damage <b>${d.dmg}</b> (${dps}/s) · Range <b>${rng}</b> · Armor <b>${d.armor}</b> · Speed <b>${(d.speed * HZ / TS.SUB).toFixed(1)}</b></div>` +
      '<div class="vs">' + [d.strong.length ? `<span class="good">Strong vs</span> ${d.strong.map(name).join(', ')}` : '', d.weak.length ? `<span class="bad">Weak vs</span> ${d.weak.map(name).join(', ')}` : ''].filter(Boolean).join(' · ') + '</div>';
  }

  H.renderSel = function (G, sel) {
    const box = $('selPanel');
    if (!sel.length) { box.innerHTML = '<div class="sel-info"><div class="line">Nothing selected. Drag to select units, right-click to command.</div></div>'; return; }
    if (sel.length === 1) {
      const e = sel[0];
      let html = '', img = '', max = 1;
      if (e.kind === TS.KU) {
        const d = TS.UNITS[e.tid]; max = d.hp;
        img = H.icon('u', d.key, e.owner, 84);
        html = `<h4>${d.name}</h4><div class="role">${d.role} · ${Render.COL[e.owner].name}</div>
          <div class="hpbar"><i style="width:${Math.max(0, e.hp / max * 100)}%"></i></div><div class="line">HP <b>${Math.max(0, e.hp)}</b> / ${max}${e.carry ? ` · carrying <b class="lumen">${e.carry}</b> Lumen` : ''}</div>${unitLines(d)}`;
      } else if (e.kind === TS.KB) {
        const bd = TS.BLDS[e.tid]; max = bd.hp;
        img = H.icon('b', bd.key, e.owner, 84);
        html = `<h4>${bd.name}</h4><div class="role">Structure · ${Render.COL[e.owner].name}</div>
          <div class="hpbar"><i style="width:${Math.max(0, e.hp / max * 100)}%"></i></div><div class="line">HP <b>${Math.max(0, e.hp)}</b> / ${max} · Armor <b>${bd.armor}</b></div>`;
        if (!e.done) html += `<div class="line">Under construction <b>${Math.floor(e.prog / bd.time * 100)}%</b> — Motes build it.</div>`;
        else html += `<div class="line">${bd.blurb}</div>`;
        if (e.done && e.q.length && (G.me < 0 || e.owner === G.me)) {
          html += '<div class="queue">' + e.q.map((t, i) => `<div class="qi" data-cancel="${e.id}" title="Click to cancel the last unit in the queue"><img src="${H.icon('u', TS.UNITS[t].key, e.owner, 34)}" width="34" height="34">${i === 0 ? `<div class="pr" style="width:${e.qp / TS.UNITS[t].time * 100}%"></div>` : ''}</div>`).join('') + '</div>';
        }
      } else {
        img = H.icon('r', '', 0, 84);
        html = `<h4>Lumen crystal</h4><div class="role">Resource</div><div class="line"><b class="lumen">${e.amt}</b> / ${e.max} left</div><div class="line">Right-click with Motes to mine.</div>`;
      }
      box.innerHTML = `<div class="sel-main"><img class="sel-portrait" src="${img}"><div class="sel-info">${html}</div></div>`;
      for (const q of box.querySelectorAll('[data-cancel]')) q.onclick = () => Game.issue({ t: 'cancel', ids: [+q.dataset.cancel] });
      return;
    }
    const shown = sel.slice(0, 48);
    let html = '<div class="grid-sel">';
    for (const e of shown) {
      const d = e.kind === TS.KU ? TS.UNITS[e.tid] : TS.BLDS[e.tid];
      html += `<div class="gs" data-id="${e.id}" title="${d.name}"><img src="${H.icon(e.kind === TS.KU ? 'u' : 'b', d.key, e.owner, 38)}" width="38" height="38"><i style="width:${Math.max(0, e.hp / d.hp) * 34}px;background:${e.hp / d.hp > 0.5 ? '#67e39a' : e.hp / d.hp > 0.25 ? '#ffd166' : '#ff5d6c'}"></i></div>`;
    }
    if (sel.length > shown.length) html += `<div class="gs" style="display:flex;align-items:center;justify-content:center">+${sel.length - shown.length}</div>`;
    box.innerHTML = html + '</div>';
    for (const g of box.querySelectorAll('[data-id]')) g.onclick = ev => {
      const id = +g.dataset.id;
      if (ev.shiftKey) Render.sel.delete(id); else { Render.sel.clear(); Render.sel.add(id); }
      H.selSig = '';
    };
  };

  // Each card entry: {key, label, icon:[kind,key], cost, act, tip, locked}
  H.renderCard = function (G, sel, mine) {
    const card = [], w = G.world;
    if (mine) {
      const units = sel.filter(e => e.kind === TS.KU), blds = sel.filter(e => e.kind === TS.KB);
      if (units.length) {
        const hasWorker = units.some(u => TS.UNITS[u.tid].cls === 'worker');
        card.push({ key: 'A', label: 'Attack', icon: ['u', 'pike'], act: 'amove', tip: '<h5>Attack-move</h5><p>Move and fight anything met on the way. Press A then left-click.</p>', on: Input.mode === 'amove' });
        card.push({ key: 'S', label: 'Stop', icon: null, act: 'stop', tip: '<h5>Stop</h5><p>Halt and hold position.</p>' });
        if (units.some(u => u.carry)) card.push({ key: 'D', label: 'Return', icon: ['r', ''], act: 'drop', tip: '<h5>Return cargo</h5><p>Bring carried Lumen to the nearest Core.</p>' });
        if (hasWorker) {
          for (const bd of TS.BLDS.slice().sort((a, b) => 'QWERTY'.indexOf(a.hot) - 'QWERTY'.indexOf(b.hot))) {
            const locked = bd.req && !w.hasDone(G.me, bd.req);
            card.push({ key: bd.hot, label: bd.name, icon: ['b', bd.key], cost: bd.cost, act: 'build:' + bd.key, locked,
              tip: `<h5>${bd.name} <span class="c">${bd.cost}</span></h5><p>${bd.blurb}</p>${locked ? `<p class="bad">Requires a finished ${TS.BKEY.get(bd.req).name}.</p>` : ''}<p>Build time ${Math.round(bd.time / HZ)}s</p>`,
              on: Input.mode === 'place' && Input.placeKey === bd.key });
          }
        }
      } else if (blds.length) {
        const types = new Set(blds.map(b => b.tid));
        if (types.size === 1) {
          const bd = TS.BLDS[blds[0].tid];
          for (const k of bd.trains || []) {
            const d = TS.UKEY.get(k);
            const sup = w.players[G.me];
            card.push({ key: d.hot, label: d.name, icon: ['u', k], cost: d.cost, act: 'train:' + k, locked: !blds.some(b => b.done),
              tip: `<h5>${d.name} <span class="c">${d.cost}</span> · ${d.sup} supply</h5><p>${d.blurb}</p>${unitLines(d)}<p>Train time ${Math.round(d.time / HZ)}s${sup.sup + d.sup > sup.cap ? ' · <span class="bad">needs supply</span>' : ''}</p>` });
          }
          if (bd.trains) card.push({ key: 'X', label: 'Cancel', icon: null, act: 'cancel', tip: '<h5>Cancel</h5><p>Cancel the last queued unit (full refund).</p>' });
          if (bd.trains) card.push({ key: 'R', label: 'Rally', icon: null, act: 'rallyhint', tip: '<h5>Rally point</h5><p>Right-click the ground (or a crystal for Motes) to set where new units go.</p>' });
        }
      }
    }
    H.card = card;
    H.tip(null);
    const box = $('cmdCard'); box.innerHTML = '';
    for (const c of card) {
      const b = document.createElement('button');
      b.className = 'cb' + (c.locked ? ' locked' : '') + (c.on ? ' on' : '');
      b.innerHTML = `<span class="hk">${c.key}</span>${c.icon ? `<img src="${H.icon(c.icon[0], c.icon[1], Math.max(0, G.me), 26)}" width="26" height="26">` : `<span style="font-size:18px">${c.act === 'stop' ? '■' : c.act === 'cancel' ? '✕' : '⚑'}</span>`}<span>${c.label}</span>${c.cost ? `<span class="cost">${c.cost}</span>` : ''}`;
      b.onclick = () => Input.action(c.act);
      b.onmouseenter = ev => H.tip(c.tip, b);
      b.onmouseleave = () => H.tip(null);
      box.appendChild(b);
    }
  };

  H.tip = function (html, anchor) {
    const t = $('tip');
    if (!html) { t.classList.add('hidden'); return; }
    t.innerHTML = html; t.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - 270, r.left - 100)) + 'px';
    t.style.top = '0px';
    t.style.top = (r.top - t.offsetHeight - 8) + 'px';
  };

  // ------------------------------------------------------------------ end of match
  H.showEnd = function (G) {
    const w = G.world, me = G.me;
    let title, sub;
    if (G.mode === 'watch' || me < 0) { title = w.winner >= 0 ? Render.COL[w.winner].name + ' wins' : 'Draw'; sub = 'CPU vs CPU'; }
    else if (w.winner === me) { title = 'Victory'; sub = 'Every enemy structure has fallen.'; }
    else if (w.winner === -2) { title = 'Draw'; sub = ''; }
    else if (w.winner < 0) { title = 'Match ended'; sub = G.connMsg || ''; }
    else { title = 'Defeat'; sub = w.players[me].alive === 0 && w.blds.some(b => b.owner === me) ? 'You surrendered.' : 'Your lattice has been dismantled.'; }
    $('endTitle').textContent = title;
    $('endTitle').style.color = title === 'Victory' ? 'var(--good)' : title === 'Defeat' ? 'var(--bad)' : '';
    $('endSub').textContent = sub + (sub ? ' · ' : '') + 'Length ' + fmtTime(w.tick) + ' · final hash ' + w.hash(true);
    const rows = [['Lumen mined', 'mined'], ['Lumen spent', 'spent'], ['Units made', 'made'], ['Kills', 'kills'], ['Losses', 'lost'], ['Damage dealt', 'dmg']];
    $('endStats').innerHTML = `<tr><th></th><th style="color:var(--teal)">${esc(G.names[0])}</th><th style="color:var(--ember)">${esc(G.names[1])}</th></tr>` +
      rows.map(([l, k]) => `<tr><td>${l}</td><td>${w.players[0].st[k]}</td><td>${w.players[1].st[k]}</td></tr>`).join('');
    $('bEndSave').disabled = !G.lastReplay; $('bEndReplay').disabled = !G.lastReplay;
    H.show('end');
  };

  // ------------------------------------------------------------------ help table
  H.buildHelp = function () {
    const name = k => k === 'buildings' ? 'buildings' : TS.UKEY.get(k).name;
    $('unitTable').innerHTML = TS.UNITS.map(d => `<tr><td><img src="${H.icon('u', d.key, 0, 22)}" width="22" height="22" style="vertical-align:middle"> ${d.name}</td><td>${d.blurb}<br><span class="good">Strong:</span> ${d.strong.map(name).join(', ') || '—'} <span class="bad">Weak:</span> ${d.weak.map(name).join(', ') || '—'}</td><td class="lumen">${d.cost}</td></tr>`).join('');
  };

  return H;
})();
