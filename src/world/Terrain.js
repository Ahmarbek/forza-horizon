import * as THREE from 'three';
import { fbm, ridged, smoothstep } from './Noise.js';

/**
 * Terrain.js
 * ----------
 * 4 km × 4 km height-field world:
 *  - Base relief: rolling fBm hills, a hill range for the mountain pass and
 *    ridged mountains rising at the map border (natural world boundary)
 *  - Flat zones (city, festival site, junctions) are levelled to y = 0
 *  - Roads carve their own bed: every route gets a smoothed, grade-limited
 *    elevation profile and nearby terrain blends into it (cuttings/embankments)
 *  - One grid feeds both the render mesh and Rapier's heightfield collider,
 *    triangulated identically so wheels sit exactly on the visible ground
 *  - Custom ground shader: grass / dry grass / dirt / rock / snow by slope &
 *    altitude, gravel road shoulders, procedural bump detail
 */

export const WORLD_SIZE = 4096;
export const WORLD_HALF = WORLD_SIZE / 2;
const SEGMENTS = 512; // 8 m cells
const MASK_RES = 1024; // road/city mask texture (4 m / texel)

export class Terrain {
  constructor() {
    this.size = WORLD_SIZE;
    this.half = WORLD_HALF;
    this.seg = SEGMENTS;
    this.cell = WORLD_SIZE / SEGMENTS;
    this.n1 = SEGMENTS + 1;
    this.heights = new Float32Array(this.n1 * this.n1); // [iz * n1 + ix]
    this.flatZones = [];
  }

  /** Axis-aligned flat rectangle (y = 0) with a soft falloff. */
  addFlatRect(minX, minZ, maxX, maxZ, falloff = 120) {
    this.flatZones.push({ type: 'rect', minX, minZ, maxX, maxZ, falloff });
  }

  addFlatCircle(x, z, r, falloff = 80) {
    this.flatZones.push({ type: 'circle', x, z, r, falloff });
  }

  /** 1 inside flat zones → 0 far away. */
  flatWeight(x, z) {
    let w = 0;
    for (const f of this.flatZones) {
      let d;
      if (f.type === 'rect') {
        const dx = Math.max(f.minX - x, 0, x - f.maxX);
        const dz = Math.max(f.minZ - z, 0, z - f.maxZ);
        d = Math.hypot(dx, dz);
      } else {
        d = Math.max(0, Math.hypot(x - f.x, z - f.z) - f.r);
      }
      w = Math.max(w, 1 - smoothstep(0, f.falloff, d));
    }
    return w;
  }

  /** Natural relief before roads (metres). */
  baseHeight(x, z) {
    // rolling countryside
    let h = fbm(x / 820, z / 820, 5) * 42 + fbm(x / 230 + 40, z / 230 - 12, 4) * 7;
    h = Math.max(h, -6) + 6;
    // mountain-pass hill range (south-west)
    const mx = (x + 780) / 520, mz = (z + 640) / 470;
    h += Math.exp(-(mx * mx + mz * mz)) * (95 + fbm(x / 300, z / 300) * 25);
    // eastern hills
    const ex = (x - 1300) / 420, ez = (z + 200) / 700;
    h += Math.exp(-(ex * ex + ez * ez)) * 70;
    // border mountains
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const m = smoothstep(1720, 2040, edge);
    h += m * (170 + ridged(x / 700, z / 700) * 360);
    // flatten zones
    h *= 1 - this.flatWeight(x, z);
    return h;
  }

  /**
   * Build the height grid given routes (which receive elevation profiles).
   * @param {Route[]} routes
   */
  build(routes) {
    // 1) Route elevation profiles: sample base height, smooth, limit grade.
    for (const r of routes) {
      const n = r.count;
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) raw[i] = r.flat ? 0 : this.baseHeight(r.xs[i], r.zs[i]);
      let h = raw;
      const win = Math.max(4, Math.round(70 / r.spacing));
      for (let pass = 0; pass < 3; pass++) h = movingAverage(h, win, r.closed);
      // grade limit (9 %) forward & backward
      const maxStep = 0.09 * r.spacing;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n; i++) h[i] = clampTo(h[i], h[i - 1], maxStep);
        for (let i = n - 2; i >= 0; i--) h[i] = clampTo(h[i], h[i + 1], maxStep);
      }
      // keep flat-zone parts exactly level
      for (let i = 0; i < n; i++) {
        const fw = this.flatWeight(r.xs[i], r.zs[i]);
        if (fw > 0) h[i] *= 1 - fw;
      }
      r.setHeights(h);
    }

    // 2) Distance field from roads onto grid vertices (splat each sample)
    const n1 = this.n1, cell = this.cell, half = this.half;
    const dist = new Float32Array(n1 * n1).fill(1e9);
    const roadH = new Float32Array(n1 * n1);
    const roadHW = new Float32Array(n1 * n1);
    const reach = 60;
    const rc = Math.ceil(reach / cell);
    for (const r of routes) {
      if (!r.carves) continue;
      for (let i = 0; i < r.count; i++) {
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
          const w = smoothstep(hw + 9, hw + 48, dist[k]);
          h = roadH[k] + (h - roadH[k]) * w;
        }
        H[k] = h;
      }
    }
    this._dist = dist;
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
  createMesh() {
    const n1 = this.n1, cell = this.cell, half = this.half;
    const pos = new Float32Array(n1 * n1 * 3);
    for (let iz = 0; iz < n1; iz++) {
      for (let ix = 0; ix < n1; ix++) {
        const k = iz * n1 + ix;
        pos[k * 3] = -half + ix * cell;
        pos[k * 3 + 1] = this.heights[k];
        pos[k * 3 + 2] = -half + iz * cell;
      }
    }
    const idx = new Uint32Array(this.seg * this.seg * 6);
    let o = 0;
    for (let iz = 0; iz < this.seg; iz++) {
      for (let ix = 0; ix < this.seg; ix++) {
        const v00 = iz * n1 + ix, v10 = v00 + 1, v01 = v00 + n1, v11 = v01 + 1;
        idx[o++] = v00; idx[o++] = v01; idx[o++] = v10;
        idx[o++] = v10; idx[o++] = v01; idx[o++] = v11;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.createMaterial());
    mesh.receiveShadow = true;
    mesh.name = 'Terrain';
    this.mesh = mesh;
    return mesh;
  }

  /** Height texture for GPU grass placement (R32F, [iz][ix]). */
  heightTexture() {
    if (this._heightTex) return this._heightTex;
    const t = new THREE.DataTexture(this.heights, this.n1, this.n1, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    this._heightTex = t;
    return t;
  }

  /**
   * Mask texture: R = road proximity (1 on asphalt → 0 at 25 m),
   * G = paved urban area, B = forest density (for tinting).
   */
  buildMask(routes, cityRect) {
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
        const inCity = cityRect && x > cityRect.minX - 10 && x < cityRect.maxX + 10 && z > cityRect.minZ - 10 && z < cityRect.maxZ + 10;
        data[k * 4 + 1] = inCity ? 255 : 0;
        const forest = fbm(x / 600 + 11, z / 600 - 3, 3) * 0.5 + 0.5;
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
    return tex;
  }

  /** CPU lookup of the mask (0..1 per channel). */
  maskAt(x, z, channel = 0) {
    if (!this.maskData) return 0;
    const R = this.maskRes;
    const ix = Math.min(R - 1, Math.max(0, Math.floor(((x + this.half) / this.size) * R)));
    const iz = Math.min(R - 1, Math.max(0, Math.floor(((z + this.half) / this.size) * R)));
    return this.maskData[(iz * R + ix) * 4 + channel] / 255;
  }

  createMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    const uniforms = {
      uMask: { value: this.maskTexture },
      uWorld: { value: new THREE.Vector2(this.half, this.size) },
      uSnowLine: { value: 230 },
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
          uniform vec2 uWorld;
          uniform float uSnowLine;
          ${TERRAIN_NOISE}
          vec3 gTerrainAlbedo;
          float gTerrainRough;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec2 p = vWPos.xz;
            vec2 muv = (p + uWorld.x) / uWorld.y;
            vec4 mask = texture2D(uMask, muv);
            float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
            float macro = tfbm(p * 0.0025);
            float mid = tfbm(p * 0.03);
            float fine = tnoise(p * 0.9) * 0.6 + tnoise(p * 3.1) * 0.4;

            vec3 grassA = vec3(0.13, 0.24, 0.06);
            vec3 grassB = vec3(0.26, 0.35, 0.10);
            vec3 dryG   = vec3(0.42, 0.40, 0.20);
            vec3 dirt   = vec3(0.30, 0.24, 0.17);
            vec3 gravel = vec3(0.22, 0.21, 0.19);
            vec3 rock   = vec3(0.34, 0.33, 0.32);
            vec3 snow   = vec3(0.92, 0.94, 0.98);

            vec3 col = mix(grassA, grassB, smoothstep(0.25, 0.75, macro));
            col = mix(col, dryG, smoothstep(0.55, 0.85, mid) * 0.55 * (1.0 - mask.b));
            col = mix(col, grassA * 0.8, mask.b * 0.35);
            col = mix(col, dirt, smoothstep(0.62, 0.8, tfbm(p * 0.012 + 7.0)) * 0.6);
            // gravel shoulders along roads
            col = mix(col, gravel, smoothstep(0.84, 0.95, mask.r) * (0.7 + 0.3 * fine));
            col = mix(col, dirt * 0.8, smoothstep(0.6, 0.84, mask.r) * (1.0 - smoothstep(0.84, 0.95, mask.r)) * 0.45);
            // rock on steep slopes, rock strata tint
            float rockW = smoothstep(0.28, 0.45, slope + (mid - 0.5) * 0.15);
            vec3 rockC = rock * (0.8 + 0.35 * tfbm(vec2(p.x * 0.02, vWPos.y * 0.25)));
            col = mix(col, rockC, rockW);
            // snow caps
            float snowW = smoothstep(uSnowLine - 30.0, uSnowLine + 40.0, vWPos.y + mid * 60.0) * (1.0 - smoothstep(0.35, 0.6, slope));
            col = mix(col, snow, snowW);
            // urban paving under the city
            col = mix(col, vec3(0.36, 0.36, 0.37), mask.g);
            col *= 0.82 + 0.3 * fine;
            gTerrainAlbedo = col;
            gTerrainRough = mix(mix(0.95, 0.85, rockW), 0.55, snowW);
            diffuseColor.rgb *= col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gTerrainRough;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // procedural bump: finite-difference gradient of detail noise
            vec2 p = vWPos.xz;
            float e = 0.35;
            float h0 = tnoise(p * 0.9) + tnoise(p * 3.1) * 0.35;
            float hx = tnoise((p + vec2(e, 0.0)) * 0.9) + tnoise((p + vec2(e, 0.0)) * 3.1) * 0.35;
            float hz = tnoise((p + vec2(0.0, e)) * 0.9) + tnoise((p + vec2(0.0, e)) * 3.1) * 0.35;
            vec3 bumpW = normalize(vec3(-(hx - h0) / e * 0.16, 1.0, -(hz - h0) / e * 0.16));
            vec3 bumpV = normalize((viewMatrix * vec4(bumpW - vec3(0.0, 1.0, 0.0), 0.0)).xyz);
            float fadeB = 1.0 - smoothstep(20.0, 120.0, length(vViewPosition));
            normal = normalize(normal + bumpV * fadeB);
          }`);
    };
    return mat;
  }
}

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
