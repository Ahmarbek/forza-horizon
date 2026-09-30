import * as THREE from 'three';
import { fbm, ridged, smoothstep, mulberry32 } from './Noise.js';

/**
 * Terrain.js
 * ----------
 * 8 km × 8 km height-field world:
 *  - Rolling countryside around the festival, a hill range for Fuji Pass,
 *    the snowy Summit massif (south-east), the wind-farm downs (north-west),
 *    Kiso forest foothills (east) and ridged border ranges on three sides
 *  - The west side falls away into the ocean: coastal lowlands, sandy beaches,
 *    a stretch of sea cliffs and a sloping sea bed
 *  - Lake Sakura sits in a basin in the north with shelving shores
 *  - Flat zones (towns, festival, airfield, junctions) are levelled
 *  - Roads carve their own bed: every route gets a smoothed, grade-limited
 *    elevation profile and nearby terrain blends into it; where a road crosses
 *    water the profile lifts onto a bridge deck and the terrain is left alone
 *  - One grid feeds both the render meshes and Rapier's heightfield collider,
 *    triangulated identically so wheels sit exactly on the visible ground
 *  - Rendering: 16 × 16 tiles with 4 distance LODs (skirted so seams never
 *    show) and a ground shader that blends grass / dry grass / dirt / rock /
 *    sand / snow detail textures by slope, altitude, shore and farmland masks
 */

export const WORLD_SIZE = 8192;
export const WORLD_HALF = WORLD_SIZE / 2;
const SEGMENTS = 1024; // 8 m cells
const MASK_RES = 2048; // road / urban / forest mask (4 m per texel)
const MASK2_RES = 1024; // shore / farmland / tree-shade mask (8 m per texel)
const TILE_CELLS = 64; // 512 m render tiles
const LOD_STEPS = [1, 2, 4, 8];

export const SEA_LEVEL = -2;
export const COAST_X = 2780;
export const LAKE = { x: 200, z: 2750, r: 430, level: 8 };
export const FARMLAND = { minX: 900, maxX: 2350, minZ: -3250, maxZ: -1750 };

/** x of the shoreline at a given z (sea lies at larger x). */
export function coastLine(z) {
  return COAST_X + 170 * fbm(z / 1300, 7.7, 3) + 70 * Math.sin(z / 640);
}

/** Lake radius in a given direction (irregular shoreline). */
export function lakeRadius(angle) {
  return LAKE.r * (1 + 0.17 * fbm(Math.cos(angle) * 1.3 + 5, Math.sin(angle) * 1.3 - 2, 3));
}

/** 0..1 how "cliffy" the coast is at z (a northern stretch of sea cliffs). */
function cliffFactor(z) {
  return smoothstep(700, 1300, z) * (1 - smoothstep(2500, 3100, z));
}

export class Terrain {
  constructor() {
    this.size = WORLD_SIZE;
    this.half = WORLD_HALF;
    this.seg = SEGMENTS;
    this.cell = WORLD_SIZE / SEGMENTS;
    this.n1 = SEGMENTS + 1;
    this.heights = new Float32Array(this.n1 * this.n1); // [iz * n1 + ix]
    this.flatZones = [];
    this.waterLevel = SEA_LEVEL;
    this.snowLine = 230;
    this.lake = LAKE;
  }

  /** Axis-aligned flat rectangle with a soft falloff; y = 'auto' levels to the local average. */
  addFlatRect(minX, minZ, maxX, maxZ, falloff = 120, y = 0) {
    const z = { type: 'rect', minX, minZ, maxX, maxZ, falloff, y };
    if (y === 'auto') {
      let s = 0, n = 0;
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
        s += this._rawHeight(minX + ((maxX - minX) * i) / 4, minZ + ((maxZ - minZ) * j) / 4); n++;
      }
      z.y = s / n;
    }
    this.flatZones.push(z);
    return z;
  }

  addFlatCircle(x, z, r, falloff = 80, y = 'auto', junction = false) {
    const zone = { type: 'circle', x, z, r, falloff, y, junction, claimed: false };
    if (y === 'auto') {
      // average of the surrounding (already levelled) ground, so a junction
      // next to a town or another junction agrees with it
      let s = 0, n = 0;
      for (let a = 0; a < 8; a++) { s += this.baseHeight(x + Math.cos(a) * r * 0.6, z + Math.sin(a) * r * 0.6); n++; }
      s += this.baseHeight(x, z) * 2; n += 2;
      zone.y = s / n;
    }
    this.flatZones.push(zone);
    return zone;
  }

  /** { w: 0..1, y } of the strongest flat zone at x,z. */
  _flat(x, z) {
    let w = 0, y = 0;
    for (const f of this.flatZones) {
      // while a road is being profiled, junctions it hasn't claimed yet don't bend it
      if (f.junction && !f.claimed && this._ignoreUnclaimed) continue;
      let d;
      if (f.type === 'rect') {
        const dx = Math.max(f.minX - x, 0, x - f.maxX);
        const dz = Math.max(f.minZ - z, 0, z - f.maxZ);
        if (dx > f.falloff || dz > f.falloff) continue;
        d = Math.hypot(dx, dz);
      } else {
        const dd = Math.hypot(x - f.x, z - f.z);
        if (dd > f.r + f.falloff) continue;
        d = Math.max(0, dd - f.r);
      }
      const k = 1 - smoothstep(0, f.falloff, d);
      if (k > w) { w = k; y = f.y; }
    }
    _flatOut.w = w; _flatOut.y = y;
    return _flatOut;
  }

  flatWeight(x, z) {
    return this._flat(x, z).w;
  }

  farmWeight(x, z) {
    const F = FARMLAND;
    const dx = Math.max(F.minX - x, 0, x - F.maxX);
    const dz = Math.max(F.minZ - z, 0, z - F.maxZ);
    const edge = fbm(x / 300 + 4, z / 300, 2) * 60;
    return 1 - smoothstep(0, 140, Math.hypot(dx, dz) + edge);
  }

  isFarmland(x, z) {
    return this.farmWeight(x, z) > 0.55;
  }

  /** Natural relief (metres) before flat zones and roads. */
  _rawHeight(x, z) {
    // rolling countryside
    let h = fbm(x / 820, z / 820, 5) * 42 + fbm(x / 230 + 40, z / 230 - 12, 4) * 7;
    h = Math.max(h, -6) + 6;
    // Fuji Pass hill range (south-east of the festival)
    const mx = (x + 780) / 520, mz = (z + 640) / 470;
    h += Math.exp(-(mx * mx + mz * mz)) * (95 + fbm(x / 300, z / 300) * 25);
    // eastern downs between the festival and the coast
    const ex = (x - 1180) / 380, ez = (z - 420) / 520;
    h += Math.exp(-(ex * ex + ez * ez)) * 48;
    // Summit massif
    const sx = (x + 1650) / 850, sz = (z + 3050) / 760;
    h += Math.exp(-(sx * sx + sz * sz)) * (240 + ridged(x / 520 + 3, z / 520) * 200);
    // wind-farm downs
    const wx = (x - 1650) / 650, wz = (z - 2350) / 750;
    h += Math.exp(-(wx * wx + wz * wz)) * 62;
    // Kiso forest foothills
    const kx = (x + 2800) / 700, kz = (z - 300) / 1300;
    h += Math.exp(-(kx * kx + kz * kz)) * 48;
    // border ranges north / east / south (the west opens to the ocean)
    const edge = Math.max(smoothstep(3250, 3950, z), smoothstep(3250, 3950, -x), smoothstep(3150, 3950, -z));
    if (edge > 0) h += edge * (170 + ridged(x / 700, z / 700) * 430);
    // farmland: gentle terraces
    const fw = this.farmWeight(x, z);
    if (fw > 0) h += (h * 0.25 + 5 - h) * fw;
    h = this._lakeBasin(x, z, h);
    h = this._coast(x, z, h);
    return h;
  }

  _lakeBasin(x, z, h) {
    const dx = x - LAKE.x, dz = z - LAKE.z;
    const d = Math.hypot(dx, dz);
    if (d > LAKE.r * 1.25 + 750) return h;
    const R = lakeRadius(Math.atan2(dz, dx));
    const L = LAKE.level;
    // the land around the basin stays a few metres above the water
    const rim = 1 - smoothstep(R + 150, R + 700, d);
    const minLand = L + 2.5 + Math.max(0, d - R) * 0.03;
    if (h < minLand) h += (minLand - h) * rim;
    if (d < R + 50) {
      const shore = smoothstep(R + 50, R - 4, d);
      h += (L + 0.7 - h) * shore;
      if (d < R) h = Math.min(h, L + 0.7 - (R - d) * 0.085);
      h = Math.max(h, L - 13);
    }
    return h;
  }

  _coast(x, z, h) {
    const dx = x - coastLine(z);
    if (dx < -650) return h;
    const c = cliffFactor(z);
    // lowlands: hills ease down towards the shore
    const low = Math.min(h, 4 + Math.max(0, -dx - 120) * 0.045);
    const toLow = smoothstep(-650, -140, dx);
    let normal = h + (low - h) * toLow;
    // beach: gentle slope into the sea, then the sea bed
    if (dx > -150) {
      const beach = dx < 30 ? 2.4 + ((SEA_LEVEL - 1.2 - 2.4) * (dx + 150)) / 180 : SEA_LEVEL - 1.2 - (dx - 30) * 0.06;
      normal += (beach - normal) * smoothstep(-150, -105, dx);
    }
    if (c <= 0) return Math.max(normal, SEA_LEVEL - 48);
    // cliffs: a raised coastal shelf that drops straight to a narrow beach
    let cliff;
    if (dx < -55) cliff = Math.max(Math.min(h, 60), 24 + fbm(z / 90, 2.1, 2) * 4);
    else if (dx < -18) cliff = 1.8 + (24 - 1.8) * smoothstep(-18, -55, dx) + fbm(z / 17, dx / 9, 2) * 2.5;
    else if (dx < 20) cliff = 1.8 + ((SEA_LEVEL - 1.2 - 1.8) * (dx + 18)) / 38;
    else cliff = SEA_LEVEL - 1.2 - (dx - 20) * 0.07;
    const blend = c * smoothstep(-650, -300, dx);
    return Math.max(normal + (cliff - normal) * blend, SEA_LEVEL - 48);
  }

  /** Natural relief with flat zones applied. */
  baseHeight(x, z) {
    let h = this._rawHeight(x, z);
    const f = this._flat(x, z);
    if (f.w > 0) h += (f.y - h) * f.w;
    return h;
  }

  /** Water surface height under x,z (lake or sea) or null if dry land. */
  waterLevelAt(x, z) {
    const dx = x - LAKE.x, dz = z - LAKE.z;
    const d = Math.hypot(dx, dz);
    if (d < LAKE.r * 1.3 && d < lakeRadius(Math.atan2(dz, dx)) + 2) return LAKE.level;
    if (x > coastLine(z) - 60) return SEA_LEVEL;
    return null;
  }

  /** true if x,z is under water (using the final terrain). */
  isWater(x, z, margin = 0) {
    const wl = this.waterLevelAt(x, z);
    return wl != null && this.heightAt(x, z) < wl - margin;
  }

  /**
   * Build the height grid given routes (which receive elevation profiles).
   * @param {Route[]} routes
   */
  build(routes) {
    // 1) Route elevation profiles: sample base height, smooth, limit grade.
    //    Samples over water are lifted onto a bridge deck.
    // Routes arrive in priority order (main roads before connectors). A junction
    // takes its height from the first road that reaches it; later roads meet it.
    this._ignoreUnclaimed = true;
    for (const r of routes) {
      const n = r.count;
      const raw = new Float32Array(n);
      const wet = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const x = r.xs[i], z = r.zs[i];
        if (r.flat) { raw[i] = r.flatY ?? 0; continue; }
        let h = this.baseHeight(x, z);
        const wl = this.waterLevelAt(x, z);
        if (wl != null && h < wl + 1.5) { h = wl + (r.deckHeight ?? 6.5); wet[i] = 1; }
        raw[i] = h;
      }
      let h = raw;
      const win = Math.max(4, Math.round((r.smooth ?? 70) / r.spacing));
      for (let pass = 0; pass < 3; pass++) h = movingAverage(h, win, r.closed);
      // bridges stay level across the water
      for (let i = 0; i < n; i++) if (wet[i]) h[i] = Math.max(h[i], raw[i]);
      // keep flat-zone parts level (junctions, towns) and pin them …
      const fixed = new Uint8Array(n);
      const pinW = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const f = this._flat(r.xs[i], r.zs[i]);
        if (f.w > 0 && !wet[i]) h[i] += (f.y - h[i]) * f.w;
        if (f.w > 0.97 || r.flat) fixed[i] = 1;
        pinW[i] = wet[i] ? 0 : f.w;
      }
      // … then limit the grade between the pins, forward & backward, so nothing
      // is left as a step (hills in between get cut down instead)
      const maxStep = (r.maxGrade ?? 0.09) * r.spacing;
      const laps = r.closed ? 2 : 1; // loops: sweep round twice so the seam agrees too
      for (let pass = 0; pass < 3; pass++) {
        // last pass ignores the pins: where two pins are too steep to join, the
        // step is spread out instead of being left in the road
        const pin = pass < 2;
        for (let k = 1; k < n * laps; k++) { const i = k % n; if (!pin || !fixed[i]) h[i] = clampTo(h[i], h[(i - 1 + n) % n], maxStep); }
        for (let k = n * laps - 2; k >= 0; k--) { const i = k % n; if (!pin || !fixed[i]) h[i] = clampTo(h[i], h[(i + 1) % n], maxStep); }
      }
      // vertical curves: round off crests and dips so fast cars don't take off.
      // Junctions/towns/bridges fade back in by their flat-zone weight (no steps),
      // then one last grade clamp.
      if (!r.flat) {
        const vc = Math.max(3, Math.round(30 / r.spacing));
        let sm = movingAverage(h, vc, r.closed);
        sm = movingAverage(sm, vc, r.closed);
        for (let i = 0; i < n; i++) {
          h[i] = sm[i] + (h[i] - sm[i]) * pinW[i];
          if (wet[i]) h[i] = Math.max(h[i], raw[i] - 3); // decks keep clearance over the water
        }
        for (let k = 1; k < n * laps; k++) { const i = k % n; h[i] = clampTo(h[i], h[(i - 1 + n) % n], maxStep); }
        for (let k = n * laps - 2; k >= 0; k--) { const i = k % n; h[i] = clampTo(h[i], h[(i + 1) % n], maxStep); }
      }
      r.setHeights(h);
      if (!r.flat) {
        for (const z of this.flatZones) {
          if (!z.junction || z.claimed) continue;
          const i = r.nearestIndex(z.x, z.z);
          if (r.lastDistanceSq < (r.width / 2 + 25) ** 2) { z.y = r.ys[i]; z.claimed = true; }
        }
      }
      // bridge spans: over water (or where the deck floats well above ground)
      const bridge = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (r.flat) continue;
        const g = this.baseHeight(r.xs[i], r.zs[i]);
        const wl = this.waterLevelAt(r.xs[i], r.zs[i]);
        if ((wl != null && g < wl + 1.2) || r.ys[i] - g > 9) bridge[i] = 1;
      }
      // grow spans a little so abutments sit on dry ground
      const grow = Math.round(12 / r.spacing);
      const b2 = bridge.slice();
      for (let i = 0; i < n; i++) if (bridge[i]) for (let k = -grow; k <= grow; k++) b2[r._wrap(i + k)] = 1;
      // drop tiny spans (little culverts over creeks)
      let hasBridge = false;
      for (let i = 0; i < n;) {
        if (!b2[i]) { i++; continue; }
        let j = i; while (j < n && b2[j]) j++;
        if ((j - i) * r.spacing < 45) for (let k = i; k < j; k++) b2[k] = 0; else hasBridge = true;
        i = j;
      }
      r.bridge = hasBridge ? b2 : null;
    }

    this._ignoreUnclaimed = false;

    // 2) Distance field from roads onto grid vertices (splat each sample)
    const n1 = this.n1, cell = this.cell, half = this.half;
    const dist = new Float32Array(n1 * n1).fill(1e9);
    const roadH = new Float32Array(n1 * n1);
    const roadHW = new Float32Array(n1 * n1);
    for (const r of routes) {
      if (!r.carves) continue;
      // deep cuttings/embankments need a wider footprint so their banks stay ≤ ~40°
      let maxDiff = 0;
      for (let i = 0; i < r.count; i += 4) maxDiff = Math.max(maxDiff, Math.abs(this.baseHeight(r.xs[i], r.zs[i]) - r.ys[i]));
      const reach = Math.min(170, 60 + maxDiff * 1.1);
      const rc = Math.ceil(reach / cell);
      for (let i = 0; i < r.count; i++) {
        if (r.bridge && r.bridge[i]) continue;
        const x = r.xs[i], z = r.zs[i];
        // local grade so each vertex gets the exact height along the road
        const ia = r._wrap(i - 1), ib = r._wrap(i + 1);
        const along = Math.hypot(r.xs[ib] - r.xs[ia], r.zs[ib] - r.zs[ia]) || 1;
        const grade = (r.ys[ib] - r.ys[ia]) / along;
        const tx = r.tx[i], tz = r.tz[i];
        const cx = Math.round((x + half) / cell), cz = Math.round((z + half) / cell);
        for (let dz = -rc; dz <= rc; dz++) {
          const iz = cz + dz;
          if (iz < 0 || iz >= n1) continue;
          for (let dx = -rc; dx <= rc; dx++) {
            const ix = cx + dx;
            if (ix < 0 || ix >= n1) continue;
            const vx = -half + ix * cell, vz = -half + iz * cell;
            const d = Math.hypot(vx - x, vz - z);
            const k = iz * n1 + ix;
            if (d < dist[k]) {
              dist[k] = d;
              roadH[k] = r.ys[i] + ((vx - x) * tx + (vz - z) * tz) * grade;
              roadHW[k] = r.width / 2;
            }
          }
        }
      }
    }

    // 3) Final heights
    const H = this.heights;
    for (let iz = 0; iz < n1; iz++) {
      const z = -half + iz * cell;
      for (let ix = 0; ix < n1; ix++) {
        const x = -half + ix * cell;
        const k = iz * n1 + ix;
        let h = this.baseHeight(x, z);
        if (dist[k] < 1e8) {
          const hw = roadHW[k];
          // bank width grows with the height difference (cut/fill slope ~40°)
          const bank = Math.max(39, Math.abs(h - roadH[k]) * 1.25);
          const w = smoothstep(hw + 7, hw + 7 + bank, dist[k]);
          h = roadH[k] + (h - roadH[k]) * w;
        }
        H[k] = h;
      }
    }
  }

  // ------------------------------------------------------------ Queries
  /** Height at x,z using the same triangulation as Rapier's heightfield. */
  heightAt(x, z) {
    const u = (x + this.half) / this.cell, v = (z + this.half) / this.cell;
    let ix = Math.floor(u), iz = Math.floor(v);
    if (ix < 0) ix = 0; else if (ix >= this.seg) ix = this.seg - 1;
    if (iz < 0) iz = 0; else if (iz >= this.seg) iz = this.seg - 1;
    const fu = Math.min(1, Math.max(0, u - ix)), fv = Math.min(1, Math.max(0, v - iz));
    const n1 = this.n1, H = this.heights;
    const h00 = H[iz * n1 + ix], h10 = H[iz * n1 + ix + 1];
    const h01 = H[(iz + 1) * n1 + ix], h11 = H[(iz + 1) * n1 + ix + 1];
    if (fu + fv <= 1) return h00 + (h10 - h00) * fu + (h01 - h00) * fv;
    return h11 * (fu + fv - 1) + h10 * (1 - fv) + h01 * (1 - fu);
  }

  normalAt(x, z, out) {
    const e = 2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Rapier heightfield layout: heights[ix * (n+1) + iz]. */
  physicsHeights() {
    const n1 = this.n1;
    const out = new Float32Array(n1 * n1);
    for (let iz = 0; iz < n1; iz++)
      for (let ix = 0; ix < n1; ix++) out[ix * n1 + iz] = this.heights[iz * n1 + ix];
    return out;
  }

  // -------------------------------------------------------------- Render
  /** Group of LOD tiles; call update(cameraPosition) every frame. */
  createMesh() {
    const group = new THREE.Group();
    group.name = 'Terrain';
    const material = this.createMaterial();
    this.material = material;
    const tiles = [];
    const T = this.seg / TILE_CELLS;
    this._indexCache = LOD_STEPS.map((step) => this._tileIndex(TILE_CELLS / step));
    for (let tz = 0; tz < T; tz++) {
      for (let tx = 0; tx < T; tx++) {
        const tile = {
          tx, tz, lods: new Array(LOD_STEPS.length), level: -1,
          cx: -this.half + (tx + 0.5) * TILE_CELLS * this.cell,
          cz: -this.half + (tz + 0.5) * TILE_CELLS * this.cell,
        };
        tile.lods[LOD_STEPS.length - 1] = this._tileGeometry(tx, tz, LOD_STEPS.length - 1);
        const mesh = new THREE.Mesh(tile.lods[LOD_STEPS.length - 1], material);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        tile.mesh = mesh;
        tile.level = LOD_STEPS.length - 1;
        group.add(mesh);
        tiles.push(tile);
      }
    }
    this.tiles = tiles;
    this.mesh = group;
    return group;
  }

  /** Pick each tile's LOD from its distance to the camera (hysteresis-free, cheap). */
  update(cam) {
    if (!this.tiles) return;
    const tileSize = TILE_CELLS * this.cell;
    for (const t of this.tiles) {
      const dx = Math.max(0, Math.abs(cam.x - t.cx) - tileSize / 2);
      const dz = Math.max(0, Math.abs(cam.z - t.cz) - tileSize / 2);
      const d = Math.hypot(dx, dz);
      const level = d < 380 ? 0 : d < 1100 ? 1 : d < 2400 ? 2 : 3;
      if (level === t.level) continue;
      if (!t.lods[level]) t.lods[level] = this._tileGeometry(t.tx, t.tz, level);
      t.mesh.geometry = t.lods[level];
      t.level = level;
      // free full-resolution geometry that is far away again
      if (level >= 2 && t.lods[0]) { t.lods[0].dispose(); t.lods[0] = null; }
    }
  }

  _tileIndex(n) {
    // grid (n+1)² vertices followed by a skirt ring of 4n vertices
    const v = n + 1;
    const idx = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * v + i, b = a + 1, c = a + v, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // skirt: walk the border clockwise, pairing each border vertex with its dropped copy
    const border = this._borderOrder(n);
    const base = v * v;
    for (let k = 0; k < border.length; k++) {
      const a = border[k], b = border[(k + 1) % border.length];
      const a2 = base + k, b2 = base + ((k + 1) % border.length);
      idx.push(a, b, a2, b, b2, a2);
    }
    const arr = v * v + border.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    return new THREE.BufferAttribute(arr, 1);
  }

  _borderOrder(n) {
    const v = n + 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push(i); // bottom row →
    for (let j = 0; j < n; j++) out.push(j * v + n); // right column ↑
    for (let i = n; i > 0; i--) out.push(n * v + i); // top row ←
    for (let j = n; j > 0; j--) out.push(j * v); // left column ↓
    return out;
  }

  _tileGeometry(tx, tz, level) {
    const step = LOD_STEPS[level];
    const n = TILE_CELLS / step;
    const v = n + 1;
    const border = this._borderOrder(n);
    const count = v * v + border.length;
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const n1 = this.n1, H = this.heights, cell = this.cell, half = this.half;
    const ix0 = tx * TILE_CELLS, iz0 = tz * TILE_CELLS;
    const hAt = (ix, iz) => H[Math.min(this.seg, Math.max(0, iz)) * n1 + Math.min(this.seg, Math.max(0, ix))];
    for (let j = 0; j < v; j++) {
      for (let i = 0; i < v; i++) {
        const ix = ix0 + i * step, iz = iz0 + j * step;
        const k = j * v + i;
        pos[k * 3] = -half + ix * cell;
        pos[k * 3 + 1] = hAt(ix, iz);
        pos[k * 3 + 2] = -half + iz * cell;
        // normal from the full-resolution grid so every LOD is lit the same
        const hx = hAt(ix + 1, iz) - hAt(ix - 1, iz);
        const hz = hAt(ix, iz + 1) - hAt(ix, iz - 1);
        const l = Math.hypot(hx, 2 * cell, hz);
        nrm[k * 3] = -hx / l; nrm[k * 3 + 1] = (2 * cell) / l; nrm[k * 3 + 2] = -hz / l;
      }
    }
    const drop = 4 + step * 3;
    border.forEach((b, k) => {
      const o = (v * v + k) * 3;
      pos[o] = pos[b * 3]; pos[o + 1] = pos[b * 3 + 1] - drop; pos[o + 2] = pos[b * 3 + 2];
      nrm[o] = nrm[b * 3]; nrm[o + 1] = nrm[b * 3 + 1]; nrm[o + 2] = nrm[b * 3 + 2];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(this._indexCache[level]);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Height texture for GPU grass placement / water depth (R32F, [iz][ix]). */
  heightTexture() {
    if (this._heightTex) return this._heightTex;
    const t = new THREE.DataTexture(this.heights, this.n1, this.n1, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    this._heightTex = t;
    return t;
  }

  /**
   * Mask textures.
   *  mask  (4 m): R = road proximity (1 on asphalt → 0 at 22 m), G = paved urban
   *               area, B = forest density
   *  mask2 (8 m): R = shore (beach / lake edge), G = farmland, B = tree shade
   */
  buildMask(routes, pavedRects = []) {
    const R = MASK_RES;
    const data = new Uint8Array(R * R * 4);
    const px = this.size / R;
    const road = new Float32Array(R * R).fill(1e9);
    for (const r of routes) {
      if (!r.render && !r.carves) continue;
      const hw = r.width / 2;
      const reach = hw + 26;
      const rc = Math.ceil(reach / px);
      for (let i = 0; i < r.count; i += 1) {
        const cx = Math.floor((r.xs[i] + this.half) / px), cz = Math.floor((r.zs[i] + this.half) / px);
        for (let dz = -rc; dz <= rc; dz++) {
          const iz = cz + dz;
          if (iz < 0 || iz >= R) continue;
          for (let dx = -rc; dx <= rc; dx++) {
            const ix = cx + dx;
            if (ix < 0 || ix >= R) continue;
            const x = -this.half + (ix + 0.5) * px, z = -this.half + (iz + 0.5) * px;
            const d = Math.hypot(x - r.xs[i], z - r.zs[i]) - hw;
            const k = iz * R + ix;
            if (d < road[k]) road[k] = d;
          }
        }
      }
    }
    for (let iz = 0; iz < R; iz++) {
      for (let ix = 0; ix < R; ix++) {
        const k = iz * R + ix;
        const x = -this.half + (ix + 0.5) * px, z = -this.half + (iz + 0.5) * px;
        const d = road[k];
        data[k * 4] = Math.round(255 * (1 - smoothstep(0, 22, d)));
        let paved = 0;
        for (const p of pavedRects) {
          if (x > p.minX - 10 && x < p.maxX + 10 && z > p.minZ - 10 && z < p.maxZ + 10) { paved = 255; break; }
        }
        data[k * 4 + 1] = paved;
        const forest = fbm(x / 600 + 11, z / 600 - 3, 3) * 0.5 + 0.5 + this._forestBias(x, z);
        data[k * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, forest)));
        data[k * 4 + 3] = 255;
      }
    }
    this.maskData = data;
    this.maskRes = R;
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this.maskTexture = tex;

    // second mask: shore + farmland (tree shade is splatted later by the vegetation)
    const R2 = MASK2_RES;
    const d2 = new Uint8Array(R2 * R2 * 4);
    const px2 = this.size / R2;
    for (let iz = 0; iz < R2; iz++) {
      for (let ix = 0; ix < R2; ix++) {
        const k = iz * R2 + ix;
        const x = -this.half + (ix + 0.5) * px2, z = -this.half + (iz + 0.5) * px2;
        let shore = smoothstep(-210, -120, x - coastLine(z));
        const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
        if (ld < LAKE.r * 1.5) shore = Math.max(shore, 1 - smoothstep(4, 30, ld - lakeRadius(Math.atan2(z - LAKE.z, x - LAKE.x))));
        d2[k * 4] = Math.round(255 * shore);
        d2[k * 4 + 1] = Math.round(255 * this.farmWeight(x, z));
        d2[k * 4 + 2] = 0;
        d2[k * 4 + 3] = 255;
      }
    }
    this.mask2Data = d2;
    this.mask2Res = R2;
    const tex2 = new THREE.DataTexture(d2, R2, R2, THREE.RGBAFormat);
    tex2.magFilter = THREE.LinearFilter;
    tex2.minFilter = THREE.LinearMipmapLinearFilter;
    tex2.generateMipmaps = true;
    tex2.needsUpdate = true;
    this.mask2Texture = tex2;
    return tex;
  }

  /** Extra forest density per region (Kiso forest is dense, farmland/beach bare). */
  _forestBias(x, z) {
    const kx = (x + 2750) / 800, kz = (z - 300) / 1500;
    let b = Math.exp(-(kx * kx + kz * kz)) * 0.55;
    b -= this.farmWeight(x, z) * 0.8;
    const dx = x - coastLine(z);
    b -= smoothstep(-500, -200, dx) * 0.6;
    return b;
  }

  /** Darken the ground under/around trees (called by the vegetation). */
  splatTreeShade(points) {
    if (!this.mask2Data) return;
    const R2 = this.mask2Res, d = this.mask2Data, px2 = this.size / R2;
    for (let i = 0; i < points.length; i += 3) {
      const ix = Math.floor((points[i] + this.half) / px2), iz = Math.floor((points[i + 1] + this.half) / px2);
      const rad = points[i + 2];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= R2 || z >= R2) continue;
        const k = (z * R2 + x) * 4 + 2;
        const w = dx === 0 && dz === 0 ? 120 : 45;
        d[k] = Math.min(255, d[k] + w * rad);
      }
    }
    this.mask2Texture.needsUpdate = true;
  }

  /** CPU lookup of the mask (0..1 per channel). */
  maskAt(x, z, channel = 0) {
    if (!this.maskData) return 0;
    const R = this.maskRes;
    const ix = Math.min(R - 1, Math.max(0, Math.floor(((x + this.half) / this.size) * R)));
    const iz = Math.min(R - 1, Math.max(0, Math.floor(((z + this.half) / this.size) * R)));
    return this.maskData[(iz * R + ix) * 4 + channel] / 255;
  }

  mask2At(x, z, channel = 0) {
    if (!this.mask2Data) return 0;
    const R = this.mask2Res;
    const ix = Math.min(R - 1, Math.max(0, Math.floor(((x + this.half) / this.size) * R)));
    const iz = Math.min(R - 1, Math.max(0, Math.floor(((z + this.half) / this.size) * R)));
    return this.mask2Data[(iz * R + ix) * 4 + channel] / 255;
  }

  createMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    const tex = createGroundTextures();
    const uniforms = {
      uMask: { value: this.maskTexture },
      uMask2: { value: this.mask2Texture },
      uWorld: { value: new THREE.Vector2(this.half, this.size) },
      uSnowLine: { value: this.snowLine },
      uSea: { value: SEA_LEVEL },
      uLake: { value: LAKE.level },
      uTexA: { value: tex.a },
      uTexB: { value: tex.b },
      uTime: { value: 0 },
    };
    this.uniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          varying vec3 vWNrm;
          uniform sampler2D uMask;
          uniform sampler2D uMask2;
          uniform sampler2D uTexA;
          uniform sampler2D uTexB;
          uniform vec2 uWorld;
          uniform float uSnowLine;
          uniform float uSea;
          uniform float uLake;
          ${TERRAIN_NOISE}
          float gTerrainRough;
          float gTerrainWet;
          float gBump;
          // anti-tiling: blend two rotated/offset samples by a low-frequency noise
          float fine0(vec2 p) { return tnoise(p * 0.21); }
          vec4 texAT(sampler2D t, vec2 p) {
            float n = tnoise(p * 0.07);
            vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p + vec2(0.37, 0.71);
            return mix(texture2D(t, p), texture2D(t, q), smoothstep(0.35, 0.65, n));
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec2 p = vWPos.xz;
            vec2 muv = (p + uWorld.x) / uWorld.y;
            vec4 mask = texture2D(uMask, muv);
            vec4 mask2 = texture2D(uMask2, muv);
            float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
            float macro = tfbm(p * 0.0025);
            float mid = tfbm(p * 0.03);
            float camD = length(vViewPosition);
            // detail textures: A = grass (rgb) + height (a), B = dirt / rock / sand packed
            vec2 tp = p * 0.17;
            vec4 grassT = texAT(uTexA, tp);
            vec4 rockT = texAT(uTexB, vec2(p.x * 0.11 + vWPos.y * 0.06, p.y * 0.11 - vWPos.y * 0.04));
            vec4 dirtT = texAT(uTexB, tp * 0.8 + 0.5);
            float detailFade = 1.0 - smoothstep(60.0, 260.0, camD);

            vec3 grassA = vec3(0.1, 0.18, 0.05);
            vec3 grassB = vec3(0.2, 0.27, 0.085);
            vec3 dryG   = vec3(0.37, 0.34, 0.19);
            vec3 dirt   = vec3(0.31, 0.25, 0.18);
            vec3 gravel = vec3(0.24, 0.23, 0.21);
            vec3 rock   = vec3(0.36, 0.35, 0.34);
            vec3 snow   = vec3(0.8, 0.83, 0.88);
            vec3 sand   = vec3(0.6, 0.53, 0.4);

            vec3 col = mix(grassA, grassB, smoothstep(0.25, 0.75, macro));
            col = mix(col, dryG, smoothstep(0.55, 0.85, mid) * 0.5 * (1.0 - mask.b));
            // forest floor: darker, browner under dense woodland (reads as canopy from afar)
            col = mix(col, vec3(0.075, 0.1, 0.04), smoothstep(0.45, 0.9, mask.b) * 0.55);
            col = mix(col, vec3(0.2, 0.18, 0.1) * 0.8, mask2.b * 0.25);
            col *= mix(vec3(1.0), grassT.rgb * 2.0, detailFade * 0.45);
            float dirtW = smoothstep(0.62, 0.8, tfbm(p * 0.012 + 7.0)) * 0.6;
            col = mix(col, dirt * mix(1.0, dirtT.g * 1.9, detailFade), dirtW);
            // gravel shoulders along roads
            col = mix(col, gravel * (0.75 + 0.5 * dirtT.r), smoothstep(0.84, 0.95, mask.r));
            col = mix(col, dirt * 0.85, smoothstep(0.6, 0.84, mask.r) * (1.0 - smoothstep(0.84, 0.95, mask.r)) * 0.45);
            // farmland: patchwork of fields (crops, bare soil, flooded rice paddies)
            float farm = mask2.g;
            gTerrainWet = 0.0;
            if (farm > 0.01) {
              // fields: 3 skewed strips per block with varying sizes, rows along each field
              vec2 fp = mat2(0.94, -0.34, 0.34, 0.94) * p;
              vec2 fs = vec2(96.0, 64.0);
              vec2 fc = floor(fp / fs);
              vec2 ff = fract(fp / fs);
              float split = 0.3 + 0.4 * thash(fc + 11.0);
              float sub = step(split, ff.x);
              vec2 cellId = fc * 2.0 + vec2(sub, 0.0);
              float fh = thash(cellId + 3.1);
              float lx = sub > 0.5 ? (ff.x - split) / (1.0 - split) : ff.x / split;
              float bw = fwidth(ff.x) * 1.5 + 0.02;
              float bund = 1.0 - smoothstep(0.0, bw, lx) * smoothstep(0.0, bw, 1.0 - lx) * smoothstep(0.0, bw * 1.5, ff.y) * smoothstep(0.0, bw * 1.5, 1.0 - ff.y);
              float rowsA = fp.y * (fh < 0.5 ? 1.8 : 2.6);
              float rows = 0.5 + 0.5 * sin(rowsA) * (1.0 - smoothstep(0.02, 0.2, fwidth(rowsA) * 0.3));
              vec3 crop = mix(vec3(0.13, 0.25, 0.06), vec3(0.23, 0.33, 0.09), rows) * (0.85 + 0.3 * thash(cellId));
              vec3 soil = mix(vec3(0.24, 0.18, 0.12), vec3(0.31, 0.23, 0.16), rows);
              vec3 canola = mix(vec3(0.55, 0.5, 0.1), vec3(0.28, 0.36, 0.08), rows * 0.5);
              vec3 paddy = mix(vec3(0.08, 0.11, 0.1), vec3(0.16, 0.3, 0.08), smoothstep(0.55, 0.95, rows) * 0.8);
              vec3 fcol = fh < 0.46 ? crop : fh < 0.62 ? soil : fh < 0.67 ? canola : paddy;
              float wet = fh >= 0.67 ? (1.0 - bund) * (1.0 - smoothstep(0.55, 0.95, rows) * 0.7) : 0.0;
              fcol = mix(fcol, vec3(0.17, 0.26, 0.08), bund);
              // at a distance, fade towards the average so the patchwork doesn't alias
              float far = smoothstep(250.0, 1400.0, camD);
              fcol = mix(fcol, vec3(0.17, 0.24, 0.08), far * 0.6);
              wet *= 1.0 - far * 0.7;
              float fw = farm * (1.0 - smoothstep(0.35, 0.6, mask.r)) * (1.0 - smoothstep(0.12, 0.25, slope));
              col = mix(col, fcol * mix(1.0, grassT.g * 1.6, detailFade * 0.5), fw);
              gTerrainWet = wet * fw;
            }
            // rock on steep slopes, rock strata tint
            float rockW = smoothstep(0.28, 0.45, slope + (mid - 0.5) * 0.15);
            vec3 rockC = rock * (0.75 + 0.35 * tfbm(vec2(p.x * 0.02, vWPos.y * 0.25))) * mix(1.0, rockT.b * 2.0, detailFade);
            col = mix(col, rockC, rockW);
            // beaches and shores: dry sand above, dark wet sand at the waterline
            float shore = mask2.r;
            float sandW = shore * (1.0 - smoothstep(2.6, 4.0, vWPos.y - uSea)) * (1.0 - rockW * 0.7);
            float lakeSand = step(1500.0, p.y) * (1.0 - smoothstep(1.2, 2.4, vWPos.y - uLake)) * step(uLake - 14.0, vWPos.y) * shore;
            sandW = max(sandW, lakeSand);
            col = mix(col, sand * mix(1.0, dirtT.a * 1.8, detailFade), sandW);
            float wetSand = max(1.0 - smoothstep(0.1, 0.9, vWPos.y - uSea), step(1500.0, p.y) * (1.0 - smoothstep(0.1, 0.8, vWPos.y - uLake))) * sandW;
            col *= 1.0 - wetSand * 0.45;
            gTerrainWet = max(gTerrainWet, wetSand);
            // snow caps
            float snowW = smoothstep(uSnowLine - 30.0, uSnowLine + 40.0, vWPos.y + mid * 60.0) * (1.0 - smoothstep(0.3, 0.52, slope + (fine0(p) - 0.5) * 0.25));
            col = mix(col, snow * (0.9 + 0.1 * macro), snowW);
            // urban paving
            col = mix(col, vec3(0.36, 0.36, 0.37), mask.g);
            // shade under trees (soft AO beyond the shadow range)
            col *= 1.0 - mask2.b * 0.38;
            float fine = tnoise(p * 0.9) * 0.6 + tnoise(p * 3.1) * 0.4;
            col *= 0.86 + 0.24 * fine;
            gBump = mix(grassT.a, rockT.a, rockW) * (1.0 - snowW) * (1.0 - mask.g) * (1.0 - sandW * 0.5);
            gTerrainRough = mix(mix(0.95, 0.82, rockW), 0.5, snowW);
            gTerrainRough = mix(gTerrainRough, 0.12, gTerrainWet);
            diffuseColor.rgb *= col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gTerrainRough;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // detail bump: screen-space derivative of the texture height + macro noise
            vec2 p = vWPos.xz;
            float e = 0.35;
            float h0 = tnoise(p * 0.9) + tnoise(p * 3.1) * 0.35;
            float hx = tnoise((p + vec2(e, 0.0)) * 0.9) + tnoise((p + vec2(e, 0.0)) * 3.1) * 0.35;
            float hz = tnoise((p + vec2(0.0, e)) * 0.9) + tnoise((p + vec2(0.0, e)) * 3.1) * 0.35;
            vec3 bumpW = normalize(vec3(-(hx - h0) / e * 0.14, 1.0, -(hz - h0) / e * 0.14));
            vec3 bumpV = normalize((viewMatrix * vec4(bumpW - vec3(0.0, 1.0, 0.0), 0.0)).xyz);
            float fadeB = 1.0 - smoothstep(20.0, 140.0, length(vViewPosition));
            normal = normalize(normal + bumpV * fadeB * (1.0 - gTerrainWet));
            // texture height bump (derivative based)
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
            float dhx = dFdx(gBump), dhy = dFdy(gBump);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
            float det = dot(dpx, r1);
            vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
            normal = normalize(abs(det) * normal - grad * 0.9 * fadeB * (1.0 - gTerrainWet));
          }`);
    };
    return mat;
  }
}

const _flatOut = { w: 0, y: 0 };

// Shared GLSL noise for terrain / grass
export const TERRAIN_NOISE = /* glsl */ `
  float thash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(thash(i), thash(i + vec2(1.0, 0.0)), u.x),
               mix(thash(i + vec2(0.0, 1.0)), thash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float tfbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * tnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
`;

// ---------------------------------------------------------------------------
// Procedural tileable ground detail textures
// ---------------------------------------------------------------------------
/** Periodic value noise on an s×s grid (wraps seamlessly). */
function tileNoise(size, cells, seed) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, iy = Math.floor(fy), ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, ix = Math.floor(fx), tx = fx - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const a = g[(iy % cells) * cells + (ix % cells)], b = g[(iy % cells) * cells + ((ix + 1) % cells)];
      const c = g[((iy + 1) % cells) * cells + (ix % cells)], d = g[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
      out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

function fractal(size, seed, octaves) {
  const out = new Float32Array(size * size);
  let amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(size, 4 << o, seed + o * 31);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

let GROUND_TEX = null;
/**
 * A: grass — rgb = blade/clump colour variation around 0.5 grey, a = height
 * B: r = gravel grit, g = dirt, b = rock, a = sand (each ~0.5 mean)
 */
export function createGroundTextures() {
  if (GROUND_TEX) return GROUND_TEX;
  const S = 512;
  const rnd = mulberry32(4711);
  // --- grass: clumpy fractal + fine blade streaks
  const clump = fractal(S, 11, 5);
  const blades = new Float32Array(S * S);
  for (let i = 0; i < 26000; i++) {
    const x = Math.floor(rnd() * S), y = Math.floor(rnd() * S);
    const len = 3 + Math.floor(rnd() * 6), v = 0.4 + rnd() * 0.6;
    const dx = rnd() < 0.5 ? 1 : -1;
    for (let k = 0; k < len; k++) {
      const xx = (x + Math.floor((k * dx) / 3) + S) % S, yy = (y + k) % S;
      blades[yy * S + xx] = Math.max(blades[yy * S + xx], v * (1 - k / len));
    }
  }
  const a = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const c = clump[i], b = blades[i];
    const l = 0.38 + c * 0.25 + b * 0.18;
    a[i * 4] = Math.min(255, 255 * l * 0.95);
    a[i * 4 + 1] = Math.min(255, 255 * (l + 0.02));
    a[i * 4 + 2] = Math.min(255, 255 * l * 0.9);
    a[i * 4 + 3] = Math.min(255, 255 * (c * 0.6 + b * 0.4));
  }
  // --- dirt / gravel / rock / sand
  const grit = fractal(S, 21, 6);
  const pebbles = new Float32Array(S * S);
  for (let i = 0; i < 4200; i++) {
    const cx = rnd() * S, cy = rnd() * S, r = 1 + rnd() * 3.5, v = 0.3 + rnd() * 0.7;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d > 1) continue;
      const k = ((y + S) % S) * S + ((x + S) % S);
      pebbles[k] = Math.max(pebbles[k], v * Math.sqrt(1 - d * d));
    }
  }
  const strata = fractal(S, 41, 5);
  const ripples = fractal(S, 51, 3);
  const b = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const gr = grit[i] * 0.6 + pebbles[i] * 0.5;
      const dirt = 0.35 + grit[i] * 0.35 + pebbles[i] * 0.25;
      const rk = 0.3 + strata[i] * 0.45 + 0.12 * Math.sin((y / S) * Math.PI * 16 + strata[i] * 6);
      const sd = 0.45 + 0.1 * Math.sin((x / S) * Math.PI * 24 + ripples[i] * 5) + grit[i] * 0.15;
      b[i * 4] = Math.min(255, gr * 255);
      b[i * 4 + 1] = Math.min(255, dirt * 255);
      b[i * 4 + 2] = Math.min(255, Math.max(0, rk) * 255);
      b[i * 4 + 3] = Math.min(255, sd * 255);
    }
  }
  const make = (data) => {
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  GROUND_TEX = { a: make(a), b: make(b) };
  return GROUND_TEX;
}

function movingAverage(src, win, closed) {
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -win; k <= win; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      s += src[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

function clampTo(v, ref, step) {
  return Math.min(ref + step, Math.max(ref - step, v));
}
