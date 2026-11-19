// Tessellate — unit and building definitions (sim data; integers only).
// Distances are sim units (256 per tile), times are ticks (20 per second), speeds are units per tick.
(function () {
  'use strict';
  const TS = globalThis.TS;
  const T = TS.SUB;

  // cls: worker | light | armored. bonus: damage % against a unit key or class (default 100).
  const UNITS = [
    { key: 'mote', name: 'Mote', role: 'Worker', cls: 'worker', hp: 40, armor: 0, dmg: 5, cd: 20, range: 40, sight: 7,
      speed: 28, r: 70, cost: 50, time: 240, sup: 1, hot: 'Q',
      blurb: 'Gathers Lumen and raises structures.', strong: [], weak: ['runner'] },
    { key: 'pike', name: 'Pike', role: 'Line infantry', cls: 'light', hp: 120, armor: 1, dmg: 10, cd: 20, range: 40, sight: 7,
      speed: 25, r: 80, cost: 60, time: 300, sup: 1, hot: 'Q', bonus: { runner: 260 },
      blurb: 'Sturdy melee wall. Skewers fast raiders.', strong: ['runner'], weak: ['glint', 'bastion'] },
    { key: 'glint', name: 'Glint', role: 'Ranged', cls: 'light', hp: 60, armor: 0, dmg: 9, cd: 24, range: 5 * T, sight: 8,
      speed: 25, r: 74, cost: 75, time: 320, sup: 1, hot: 'W', bonus: { pike: 170 },
      blurb: 'Fires light darts from range. Shreds slow infantry.', strong: ['pike'], weak: ['runner', 'bastion'] },
    { key: 'runner', name: 'Runner', role: 'Raider', cls: 'light', hp: 80, armor: 0, dmg: 8, cd: 12, range: 40, sight: 8,
      speed: 42, r: 78, cost: 80, time: 280, sup: 1, hot: 'Q', bonus: { glint: 220, prism: 260, mote: 220 },
      blurb: 'Very fast. Dives backlines, workers and siege.', strong: ['glint', 'prism', 'mote'], weak: ['pike', 'bastion'] },
    { key: 'bastion', name: 'Bastion', role: 'Heavy', cls: 'armored', hp: 400, armor: 4, dmg: 18, cd: 30, range: 50, sight: 7,
      speed: 16, r: 118, cost: 175, time: 480, sup: 3, hot: 'W',
      blurb: 'Armored hexagon. Shrugs off light hits.', strong: ['pike', 'glint', 'runner'], weak: ['prism'] },
    { key: 'prism', name: 'Prism', role: 'Siege', cls: 'light', hp: 90, armor: 0, dmg: 28, cd: 60, range: 7 * T, minRange: 2 * T,
      splash: 160, sight: 9, speed: 18, r: 100, cost: 150, time: 460, sup: 2, hot: 'Q', bonus: { armored: 260, building: 300 },
      blurb: 'Long-range beam with splash. Cracks armor and buildings.', strong: ['bastion', 'buildings'], weak: ['runner'] },
  ];

  const BLDS = [
    { key: 'core', name: 'Core', hp: 1600, armor: 2, w: 4, h: 4, cost: 400, time: 1200, sight: 10, sup: 10, trains: ['mote'], drop: true, hot: 'Y',
      blurb: 'Trains Motes. Workers return Lumen here. +10 supply.' },
    { key: 'conduit', name: 'Conduit', hp: 320, armor: 1, w: 2, h: 2, cost: 100, time: 300, sight: 5, sup: 8, hot: 'Q',
      blurb: 'Raises supply by 8.' },
    { key: 'forge', name: 'Forge', hp: 750, armor: 1, w: 3, h: 3, cost: 150, time: 500, sight: 6, trains: ['pike', 'glint'], hot: 'W',
      blurb: 'Trains Pikes and Glints.' },
    { key: 'foundry', name: 'Foundry', hp: 850, armor: 1, w: 3, h: 3, cost: 200, time: 600, sight: 6, trains: ['runner', 'bastion'], req: 'forge', hot: 'E',
      blurb: 'Trains Runners and Bastions. Needs a Forge.' },
    { key: 'spire', name: 'Spire', hp: 650, armor: 1, w: 3, h: 3, cost: 225, time: 650, sight: 7, trains: ['prism'], req: 'foundry', hot: 'R',
      blurb: 'Trains Prisms. Needs a Foundry.' },
    { key: 'sentinel', name: 'Sentinel', hp: 450, armor: 2, w: 2, h: 2, cost: 125, time: 400, sight: 9, req: 'forge', hot: 'T',
      atk: { dmg: 12, cd: 20, range: 6 * T }, blurb: 'Defensive tower. Needs a Forge.' },
  ];

  UNITS.forEach((u, i) => { u.tid = i; });
  BLDS.forEach((b, i) => { b.tid = i; b.cls = 'building'; b.trainIds = (b.trains || []).map(k => UNITS.findIndex(u => u.key === k)); });

  TS.UNITS = UNITS;
  TS.BLDS = BLDS;
  TS.UKEY = new Map(UNITS.map(u => [u.key, u]));
  TS.BKEY = new Map(BLDS.map(b => [b.key, b]));

  // Damage multiplier (percent) of attacker def a against target def t.
  TS.mult = function (a, t) {
    const b = a.bonus;
    if (!b) return 100;
    if (t.key in b) return b[t.key];
    if (t.cls in b) return b[t.cls];
    return 100;
  };

  TS.MAX_SUP = 150;
  TS.CARRY = 8;
  TS.MINE_T = 28;
  TS.START_RES = 150;
  TS.START_WORKERS = 5;
})();
