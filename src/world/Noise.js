/**
 * Noise.js — small deterministic noise toolkit (2D gradient noise + fBm)
 * shared by terrain, vegetation and city generation.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of 2 ints → [0,1). */
export function hash2(ix, iz, seed = 0) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const GRAD = new Float32Array(512);
(function initGradients() {
  const rnd = mulberry32(20260930);
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    GRAD[i * 2] = Math.cos(a);
    GRAD[i * 2 + 1] = Math.sin(a);
  }
})();
const PERM = new Uint8Array(512);
(function initPerm() {
  const rnd = mulberry32(777);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function grad(ix, iz, x, z) {
  const g = PERM[(PERM[ix & 255] + iz) & 511] * 2;
  return GRAD[g] * x + GRAD[g + 1] * z;
}

/** 2D gradient (Perlin-style) noise, roughly in [-0.7, 0.7]. */
export function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = grad(ix, iz, fx, fz);
  const b = grad(ix + 1, iz, fx - 1, fz);
  const c = grad(ix, iz + 1, fx, fz - 1);
  const d = grad(ix + 1, iz + 1, fx - 1, fz - 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion, ~[-1, 1]. */
export function fbm(x, z, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, z) * amp;
    norm += amp;
    amp *= gain;
    x = x * lacunarity + 17.3;
    z = z * lacunarity - 9.1;
  }
  return (sum / norm) * 1.6;
}

/** Ridged multifractal for mountain crests, ~[0, 1]. */
export function ridged(x, z, octaves = 5) {
  let sum = 0, amp = 0.5, freq = 1, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x * freq, z * freq) * 1.4);
    n *= n;
    sum += n * amp * prev;
    prev = n;
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
