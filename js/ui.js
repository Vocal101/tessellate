// Tessellate — menus, lobby, pause and end screens; boots the game.
'use strict';
const UI = (() => {
  const $ = id => document.getElementById(id);
  const U = { diff: 'normal' };

  function seedValue() {
    const v = $('seedIn').value.trim();
    if (!v) return (Math.random() * 0xffffffff) >>> 0;
    return /^\d+$/.test(v) ? (+v >>> 0) : TS.seedFrom(v);
  }
  function msg(id, text, err) { const m = $(id); m.textContent = text || ''; m.classList.toggle('err', !!err); }

  U.togglePause = function () {
    if (!Game.world) return;
    const open = $('pause').classList.contains('hidden');
    if (open) {
      $('pauseTitle').textContent = Game.canPause() ? 'Paused' : 'Menu (the match keeps running)';
      $('bGG').classList.toggle('hidden', Game.me < 0 || Game.world.over);
      $('bResume').textContent = 'Resume';
      Hud.show('pause');
      if (Game.canPause()) Game.setPaused(true);
    } else {
      Hud.show(null);
      if (Game.canPause()) Game.setPaused(false);
    }
  };

  function openReplay(rep) {
    try { Game.startReplay(rep); }
    catch (e) { msg('repMsg', e.message || 'Could not open that replay.', true); Hud.show('menu'); }
  }

  U.init = function () {
    $('ver').textContent = TS.VERSION + '.0';
    Render.init($('view'));
    Input.init();
    Hud.buildHelp();
    Render.onAlert = () => { if (Game.mode === 'cpu' || Game.mode === 'online') { const t = performance.now(); if (!U.lastAlert || t - U.lastAlert > 6000) { U.lastAlert = t; Hud.toast('You are under attack'); } } };

    for (const b of $('diffSeg').children) b.onclick = () => { U.diff = b.dataset.v; for (const x of $('diffSeg').children) x.classList.toggle('on', x === b); };
    $('bPlay').onclick = () => Game.startCpu(U.diff, seedValue());
    $('bWatch').onclick = () => Game.startWatch(seedValue(), 'normal', 'hard');
    $('bHelp').onclick = () => Hud.show('help');
    $('bHelpClose').onclick = () => Hud.show('menu');

    // Online.
    $('bHost').onclick = () => {
      msg('netMsg', 'Opening a room…');
      Net.host((err, code) => {
        if (err) { msg('netMsg', err, true); return; }
        msg('netMsg', '');
        $('code').textContent = code; $('lobbyMsg').textContent = 'Share this code. The match starts as soon as your opponent joins.';
        Hud.show('lobby');
      }, cfg => Game.startOnline(cfg));
    };
    $('bJoin').onclick = () => {
      const code = $('joinIn').value;
      msg('netMsg', 'Connecting…');
      Net.join(code, (err, cfg) => {
        if (err) { msg('netMsg', err, true); return; }
        msg('netMsg', '');
        Game.startOnline(cfg);
      });
    };
    $('joinIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('bJoin').click(); });
    $('bCopy').onclick = () => { try { navigator.clipboard.writeText($('code').textContent); $('lobbyMsg').textContent = 'Copied!'; } catch (e) { /* ignore */ } };
    $('bCancel').onclick = () => { Net.close(); Hud.show('menu'); };

    // Replays.
    $('bLast').onclick = () => {
      const rep = Game.loadLastReplay();
      if (!rep) { msg('repMsg', 'No match recorded yet. Finish a match first.', true); return; }
      openReplay(rep);
    };
    $('bLoad').onclick = () => $('fileIn').click();
    $('fileIn').onchange = () => {
      const f = $('fileIn').files[0]; if (!f) return;
      f.text().then(t => {
        let rep; try { rep = JSON.parse(t); } catch (e) { msg('repMsg', 'That file is not valid JSON.', true); return; }
        if (rep && rep.replay && rep.state) rep = rep.replay;       // a desync dump also holds a replay
        openReplay(rep);
      });
      $('fileIn').value = '';
    };

    // In-game.
    $('hMenu').onclick = () => U.togglePause();
    $('bResume').onclick = () => U.togglePause();
    $('bGG').onclick = () => { Game.issue({ t: 'gg' }); U.togglePause(); };
    $('bQuit').onclick = () => {
      if (Game.session && !Game.world.over && Game.me >= 0) Game.issue({ t: 'gg' });
      Game.quit();
    };
    $('rbPlay').onclick = () => Game.setPaused(!Game.paused);
    $('rbVision').onchange = () => { Render.view = +$('rbVision').value; Render.memory.clear(); };
    $('rbTrack').onclick = e => {
      const r = $('rbTrack').getBoundingClientRect();
      Game.seek(Math.round((e.clientX - r.left) / r.width * Game.rp.rep.end));
    };

    // End screen.
    $('bEndReplay').onclick = () => { const rep = Game.lastReplay; Game.quit(); if (rep) openReplay(rep); };
    $('bEndSave').onclick = () => { if (Game.lastReplay) Game.download(Game.lastReplay, `tessellate-replay-${Game.lastReplay.seed}-${Game.lastReplay.end}.json`); };
    $('bEndMenu').onclick = () => Game.quit();

    if (!Net.available()) { $('bHost').disabled = true; $('bJoin').disabled = true; msg('netMsg', 'PeerJS failed to load: online play is unavailable.', true); }
    Hud.show('menu');
    Game.boot();
  };

  return U;
})();
window.addEventListener('DOMContentLoaded', UI.init);
