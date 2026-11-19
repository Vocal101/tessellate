# Tessellate

An original 1v1 real-time strategy game for the browser. Two geometric lattices, **Teal** and **Ember**, mine Lumen, build production and fight across a seeded, symmetric map.

Under the hood it uses **deterministic lockstep networking**. Only player commands cross the network. Both peers run the identical integer-only simulation at 20 ticks per second, so replays are just a seed plus an input log.

**Play now:** https://vocal101.github.io/tessellate/

## Play

### Online

Open https://vocal101.github.io/tessellate/ in a desktop browser. It needs a mouse and keyboard.

### Download and play

No build step and no install. It is plain HTML, CSS and JavaScript (PeerJS is vendored in `lib/`).

```bash
git clone https://github.com/Vocal101/tessellate.git
cd tessellate
python scripts/devserver.py 8783
```

Then open <http://localhost:8783>. Any static file server works. Opening `index.html` straight from disk also works for offline play. You can also use **Code → Download ZIP** on GitHub.

### Modes

- **Play vs CPU**: pick Easy, Normal or Hard. You can type a map seed (a number or any text) or leave it blank for a random map.
- **Online 1v1**: one player clicks **Host a room** and shares the 5-letter code. The other player types it and clicks **Join**. Connections are peer to peer over WebRTC, and the public PeerJS server only does the handshake.
- **Watch CPU vs CPU**: spectate with full vision at 1–8× speed.
- **Replays**: every finished match is kept as "last match". You can also save it as a `.json` file from the end screen and load it later. Playback runs at 0.5–16×, you can click the track to seek, and you can switch vision between Teal, Ember or full. When playback reaches the end, the final state hash is checked against the recorded one (**✓ hash verified**).

## How to play

Destroy every enemy structure. Motes mine Lumen and carry it back to a Core. Spend it on buildings and units, and keep supply ahead with Conduits.

| Unit | Role | Strong vs | Weak vs |
|---|---|---|---|
| Mote | Worker: mines and builds | – | Runner |
| Pike | Sturdy melee line | Runner | Glint, Bastion |
| Glint | Ranged darts | Pike | Runner, Bastion |
| Runner | Very fast raider | Glint, Prism, Mote | Pike, Bastion |
| Bastion | Armored heavy | Pike, Glint, Runner | Prism |
| Prism | Long-range splash siege | Bastion, buildings | Runner |

Buildings:
- **Core** trains Motes, is the drop-off point and gives +10 supply.
- **Conduit** gives +8 supply.
- **Forge** trains Pike and Glint.
- **Foundry** trains Runner and Bastion, and needs a Forge.
- **Spire** trains Prism, and needs a Foundry.
- **Sentinel** is a defensive tower, and needs a Forge.

If a player has had no Core for a minute, their remaining buildings are revealed to the opponent.

### Controls

| Input | Action |
|---|---|
| Left drag / click | Select (Shift adds, double-click or Ctrl-click selects all of that type on screen) |
| Right click | Move, attack, mine, help build, return cargo, or set a rally point (with buildings selected) |
| `A` then click | Attack-move |
| `S` | Stop |
| `Q W E R T Y` | Command card: build menu for Motes, train for buildings (Shift trains 5) |
| `X` | Cancel the last queued unit |
| `Ctrl+1–9` / `Shift+1–9` / `1–9` | Set / add to / recall a control group (press twice to jump the camera) |
| Arrows, screen edge, middle drag | Scroll |
| Mouse wheel | Zoom |
| `Space` | Jump to the selection (pause and play in replays) |
| `.` | Next idle Mote |
| `P` | Pause (offline) |
| `Esc` / `F10` | Menu |
| Minimap | Left click to look, right click to move |

## Architecture

```
js/sim/fixed.js   integer sqrt, seeded PRNG (mulberry32), 32-bit state hasher
js/sim/defs.js    unit and building data
js/sim/map.js     seeded, 180°-symmetric map generator
js/sim/flow.js    flow-field pathfinding (Dijkstra per goal, cached, invalidated by nav version)
js/sim/world.js   World.step(cmds): commands → buildings → units → movement/separation → deaths → fog → victory
js/sim/ai.js      CPU opponent: returns command objects, sees only its own fog
js/lockstep.js    Session (input scheduling, stalls, hash exchange, desync detection), ReplayPlayer
js/render.js      canvas renderer, interpolates between ticks; minimap; icons
js/net.js         PeerJS host/join, ping
js/hud.js, input.js, ui.js, game.js   HUD, controls, menus, fixed-timestep loop
js/dev.js         ?dev test harness (window.T)
```

**Determinism rules for `js/sim/` and `js/lockstep.js`.** Integers only, positions are in 1/256 of a tile, and there is no `Math.random`, `Date`, trig or `sqrt`. Every RNG is seeded, entities are kept in id order, and damage resolves simultaneously. The renderer only reads the world. `npm test` scans these files for forbidden calls and checks that every number in the state is an integer.

**Lockstep.** A command typed during tick *t* is scheduled for tick *t + delay*: 2 ticks (100 ms) offline and 4 ticks (200 ms) online. It is sent to the peer straight away. A tick only runs once both players' command lists for it are present. Otherwise the game stalls and shows "Waiting for opponent…". Each input packet also carries the sender's state hash for an earlier tick. If the hashes ever differ, a red **DESYNC** banner shows the tick and both hashes, with a button that downloads a JSON state dump. The dump includes the replay, so it can be loaded back as a replay. The CPU opponent goes through exactly the same input path as a human.

**Background tabs.** Browsers pause `requestAnimationFrame` in hidden tabs. During an online match a timer keeps the simulation running, but not the renderer, so a hidden tab does not freeze the opponent. Hidden tabs still get throttled timers, so expect short stalls when one player alt-tabs.

## Tests

```bash
npm test
```

`tests/determinism.test.js` loads the same sim files the page uses and checks:

- `isqrt` is exact, and the RNG and map generator are reproducible. Maps are symmetric and both bases are connected.
- A source audit finds no floats, clocks or `Math.random` in the sim.
- The same seed and inputs give the same hash run after run. Feeding a recorded input log to a fresh world reproduces the final hash.
- Two worlds fed the same inputs are compared every tick through a full CPU-vs-CPU match (up to 20 game minutes) and never diverge. Every state number is an integer.
- Two `Session`s talk over a fake network with seeded latency and jitter. They stall, never desync, and end on identical hashes. A tampered peer is caught as a desync within a few ticks.
- Replays round-trip through JSON and verify. A tampered replay fails verification.
- Garbage and hostile commands, such as moving the other player's units, don't change state.
- Flow fields move 600 units across the map at about 1 ms per tick.
- On the CPU difficulty ladder, Hard beats Easy.

## Dev harness

Open `/?dev` to get `window.T`:

| Call | Does |
|---|---|
| `T.start({diff, seed, mode})` | Start a match (`mode: 'watch'` for CPU vs CPU) |
| `T.step(n)` / `T.run(sec)` | Advance n ticks synchronously through the real input path |
| `T.frames(n)` | Render n frames (handy when the tab is throttled) |
| `T.spawn(key, owner, tx, ty, n)` | Spawn units (this marks the world as tainted) |
| `T.cmd(c)` / `T.select(ids)` / `T.mine(kind)` | Issue commands, select, and list your entity ids |
| `T.hash(full)` / `T.dump()` / `T.state()` | Inspect state |
| `T.cpuVsCpu(min, seed, l0, l1)` | Run a headless match and verify its replay |
| `T.desync()` | Corrupt local state (to check desync detection online) |
| `await T.snap(name)` | Save a canvas JPEG through the dev server |

## License

MIT. Tessellate's name, units, art and look are original.
