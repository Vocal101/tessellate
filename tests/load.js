// Loads the browser sim scripts into a fresh node vm context (exactly the files the page loads).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['js/sim/fixed.js', 'js/sim/defs.js', 'js/sim/map.js', 'js/sim/flow.js', 'js/sim/world.js', 'js/sim/ai.js', 'js/lockstep.js'];

// runInThisContext (not a separate vm context): globals like Math stay fast.
function load() {
  if (globalThis.TS && globalThis.TS.World) return globalThis.TS;
  for (const f of FILES) {
    const p = path.join(__dirname, '..', f);
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  }
  return globalThis.TS;
}
module.exports = { load, FILES };
