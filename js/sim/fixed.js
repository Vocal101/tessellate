// Tessellate — deterministic core helpers.
// Everything in js/sim/ runs inside the lockstep simulation: integers only, no Math.random,
// no Date, no trig. JS numbers are IEEE doubles, so integer add/sub/mul below 2^53 and
// Math.trunc/Math.floor of integer quotients give identical results on every machine.
(function () {
  'use strict';
  const TS = globalThis.TS || (globalThis.TS = {});

  TS.SUB = 256;          // sim units per tile
  TS.HZ = 20;            // sim ticks per second
  TS.TICK_MS = 50;
  TS.VERSION = 1;        // bump when the sim changes: replays and peers must match

  // 8 directions, clockwise from east. Opposite of d is (d + 4) & 7.
  TS.DX = [1, 1, 0, -1, -1, -1, 0, 1];
  TS.DY = [0, 1, 1, 1, 0, -1, -1, -1];

  // Integer division that truncates toward zero.
  TS.idiv = (a, b) => Math.trunc(a / b);

  // Integer square root (floor). Digit-by-digit on 32-bit ints; Newton on larger values.
  TS.isqrt = function (n) {
    if (n <= 0) return 0;
    if (n < 0x40000000) {
      let res = 0, bit = 1 << 28;
      while (bit > n) bit >>= 2;
      while (bit !== 0) {
        if (n >= res + bit) { n -= res + bit; res = (res >> 1) + bit; } else res >>= 1;
        bit >>= 2;
      }
      return res;
    }
    let x = 32768;
    while (x * x <= n) x *= 2;                 // x > sqrt(n), exact power of two
    for (;;) {
      const y = Math.floor((x + Math.floor(n / x)) / 2);
      if (y >= x) return x;
      x = y;
    }
  };

  // Seeded PRNG (mulberry32). All state is a single uint32.
  class Rng {
    constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
    next() {
      let t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    }
    int(n) { return n > 0 ? this.next() % n : 0; }
    range(a, b) { return a + this.int(b - a + 1); }
    pick(arr) { return arr[this.int(arr.length)]; }
  }
  TS.Rng = Rng;

  // 32-bit streaming hash over int32 values.
  class Hasher {
    constructor() { this.h = 0x811c9dc5 | 0; this.n = 0; }
    add(v) {
      let h = this.h ^ (v | 0);
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 13;
      this.h = Math.imul(h, 0x5bd1e995);
      this.n++;
      return this;
    }
    addArr(a) { this.add(a.length); for (let i = 0; i < a.length; i++) this.add(a[i]); return this; }
    hex() {
      let h = this.h ^ this.n;
      h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
      return (h >>> 0).toString(16).padStart(8, '0');
    }
  }
  TS.Hasher = Hasher;

  // String → uint32 seed (FNV-1a), for room codes or typed seeds.
  TS.seedFrom = function (s) {
    let h = 0x811c9dc5;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
})();
