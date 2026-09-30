import * as THREE from 'three';
import { mulberry32, fbm } from './Noise.js';
import { TERRAIN_NOISE, LAKE } from './Terrain.js';
import { ChunkedInstances } from './Instancing.js';

/**
 * Vegetation.js
 * -------------
 *  - Trees are grown procedurally from a small species library:
 *      broadleaf (zelkova-like), Japanese cedar (sugi), cherry (sakura) and
 *      red maple (momiji). Each variant is a real branching skeleton — curved,
 *      tapering trunk and limbs as tubes — with leaf clusters of alpha-tested
 *      cards at the branch tips. Per-vertex ambient occlusion darkens the crown
 *      interior, "soft" crown normals + a back-lit translucency term light the
 *      foliage like a volume, and a wind weight lets trunks lean, branches sway
 *      and leaves flutter.
 *  - LOD: trees within ~230 m of the camera are drawn as full models (rebuilt
 *    as the camera moves; they cast shadows). Every tree also has an impostor:
 *    each variant is rendered from 8 directions into an atlas at start-up and
 *    far trees are camera-facing billboards that pick the matching view.
 *  - Boulders on slopes, cliffs and shores for extra ground detail.
 *  - Grass: GPU-placed blades on a camera-following lattice; heights come
 *    from the terrain height texture, roads/towns/water are masked out, blades
 *    sway in the wind and receive shadows.
 */

const NEAR_RADIUS = 230;
const GRID = 64;
const FRAME = 192; // impostor frame size (px)
const VIEWS = 8; // impostor views around each variant
const ATLAS = 2048;

// Atlas regions [u0, v0, u1, v1] (texture v is bottom-up)
const REGION = {
  leaf: [0, 0.5, 0.5, 1],
  sakura: [0.5, 0.5, 1, 1],
  needle: [0, 0, 0.5, 0.5],
  maple: [0.5, 0.25, 0.75, 0.5],
  bark: [0.75, 0, 1, 0.5],
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class Vegetation {
  constructor(scene, physics, terrain) {
    this.scene = scene;
    this.physics = physics;
    this.terrain = terrain;
    this.rng = mulberry32(8080);
    this.treePositions = []; // flat [x, z, type] for maps
    this.instanceCount = 0;
    this._lastRebuild = new THREE.Vector3(1e9, 0, 1e9);
    this.sun = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(1, 1, 1) };
  }

  // ================================================================ Atlas
  _atlas() {
    const S = 2048;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const rnd = mulberry32(55);
    // canvas y is top-down, so texture region v0..v1 maps to canvas rows (1-v1)..(1-v0)
    const rect = (r) => ({ x: r[0] * S, y: (1 - r[3]) * S, w: (r[2] - r[0]) * S, h: (r[3] - r[1]) * S });
    const leafShape = (len, wid) => {
      ctx.beginPath();
      ctx.moveTo(0, -len);
      ctx.quadraticCurveTo(wid, -len * 0.35, 0, len * 0.15);
      ctx.quadraticCurveTo(-wid, -len * 0.35, 0, -len);
      ctx.fill();
    };
    const sprig = (R, palette, opts) => {
      const cx = R.x + R.w / 2, cy = R.y + R.h / 2, rad = Math.min(R.w, R.h) * 0.46;
      // twigs radiating from the middle
      ctx.strokeStyle = opts.twig;
      for (let i = 0; i < opts.twigs; i++) {
        const a = rnd() * Math.PI * 2, l = rad * (0.5 + rnd() * 0.45);
        ctx.lineWidth = 2 + rnd() * 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx + Math.cos(a + 0.3) * l * 0.5, cy + Math.sin(a + 0.3) * l * 0.5, cx + Math.cos(a) * l, cy + Math.sin(a) * l);
        ctx.stroke();
      }
      for (let i = 0; i < opts.count; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.pow(rnd(), 0.6) * rad;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.95;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a + Math.PI / 2 + (rnd() - 0.5) * 1.2);
        const base = palette[Math.floor(rnd() * palette.length)];
        // darker towards the centre of the sprig (self-shadowing)
        const shade = 0.7 + 0.3 * (r / rad) + (rnd() - 0.5) * 0.15;
        ctx.fillStyle = shadeHex(base, shade);
        const s = opts.size * (0.7 + rnd() * 0.6);
        if (opts.shape === 'petal') {
          for (let k = 0; k < 5; k++) {
            ctx.rotate((Math.PI * 2) / 5);
            ctx.beginPath();
            ctx.ellipse(0, -s * 0.55, s * 0.36, s * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = '#f7d56b';
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2);
          ctx.fill();
        } else if (opts.shape === 'needle') {
          ctx.fillRect(-s * 0.06, -s, s * 0.12, s * 2);
          ctx.rotate(0.5);
          ctx.fillRect(-s * 0.05, -s * 0.8, s * 0.1, s * 1.6);
        } else if (opts.shape === 'maple') {
          for (let k = -2; k <= 2; k++) {
            ctx.save();
            ctx.rotate(k * 0.55);
            leafShape(s * (k === 0 ? 1 : 0.75), s * 0.32);
            ctx.restore();
          }
        } else {
          leafShape(s, s * 0.45);
          ctx.strokeStyle = shadeHex(base, shade * 0.7);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, -s * 0.9);
          ctx.lineTo(0, s * 0.1);
          ctx.stroke();
        }
        ctx.restore();
      }
    };
    // 4 sprigs per foliage region (2×2) so neighbouring cards don't look identical
    const quad = (region, palette, opts) => {
      const R = rect(region);
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        sprig({ x: R.x + (i * R.w) / 2, y: R.y + (j * R.h) / 2, w: R.w / 2, h: R.h / 2 }, palette, opts);
      }
    };
    quad(REGION.leaf, ['#2c5219', '#3a6620', '#4b7a28', '#27461a', '#5a8a30', '#6b9a38'], { count: 900, size: 17, twigs: 10, twig: '#3b2c1e' });
    quad(REGION.sakura, ['#ffc6d9', '#ffb3ca', '#ffd9e6', '#f7a1bd', '#ffe6ef', '#fbd0dd'], { count: 700, size: 15, twigs: 10, twig: '#4a3028', shape: 'petal' });
    quad(REGION.needle, ['#1d3a1c', '#264a25', '#183018', '#30592c', '#223f20'], { count: 1300, size: 20, twigs: 6, twig: '#3a2a1e', shape: 'needle' });
    sprig(rect(REGION.maple), ['#c2361e', '#d8501f', '#e57a25', '#a8261a', '#f09a2a'], { count: 380, size: 16, twigs: 7, twig: '#3b261c', shape: 'maple' });
    // bark strip
    const B = rect(REGION.bark);
    ctx.fillStyle = '#4a3a2e';
    ctx.fillRect(B.x, B.y, B.w, B.h);
    for (let i = 0; i < 2600; i++) {
      const v = 38 + rnd() * 48;
      ctx.fillStyle = `rgb(${v + 18},${v + 8},${v - 4})`;
      ctx.fillRect(B.x + rnd() * B.w, B.y + rnd() * B.h, 2 + rnd() * 5, 18 + rnd() * 60);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 400; i++) ctx.fillRect(B.x + rnd() * B.w, B.y + rnd() * B.h, 1.5, 30 + rnd() * 80);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  // ======================================================== Tree skeletons
  /** Tube along points with radii; uv in the bark strip; wind weight per ring. */
  _tube(out, pts, radii, radial, winds) {
    const [u0, v0, u1, v1] = REGION.bark;
    const n = pts.length;
    const base = out.pos.length / 3;
    const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3(), ref = new THREE.Vector3(1, 0, 0);
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
      tan.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      ref.set(1, 0, 0);
      if (Math.abs(tan.dot(ref)) > 0.9) ref.set(0, 0, 1);
      nrm.crossVectors(tan, ref).normalize();
      bin.crossVectors(tan, nrm).normalize();
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        const px = nrm.x * dx + bin.x * dy, py = nrm.y * dx + bin.y * dy, pz = nrm.z * dx + bin.z * dy;
        out.pos.push(pts[i].x + px * radii[i], pts[i].y + py * radii[i], pts[i].z + pz * radii[i]);
        out.nrm.push(px, py, pz);
        out.uv.push(u0 + (u1 - u0) * (k / radial), v0 + ((len * 0.35) % 1) * (v1 - v0));
        const ao = 0.55 + 0.25 * Math.min(1, pts[i].y / 6);
        out.col.push(ao, ao, ao);
        out.wind.push(winds[i]);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = base + i * (radial + 1) + k, b = a + radial + 1;
        out.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Leaf card at c facing n; soft normal from the crown; AO from depth in the crown. */
  _card(out, c, size, n, region, crown, crownR) {
    const up = Math.abs(n.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(up, n).normalize().multiplyScalar(size / 2);
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize().multiplyScalar(size / 2);
    const rnd = this.rng;
    // pick one of the 2×2 sprig variants inside the region
    let [u0, v0, u1, v1] = region;
    if (region !== REGION.maple) {
      const s = Math.floor(rnd() * 4);
      const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
      u0 += (s % 2) * hu; v0 += Math.floor(s / 2) * hv; u1 = u0 + hu; v1 = v0 + hv;
    }
    const corners = [c.clone().sub(t1).sub(t2), c.clone().add(t1).sub(t2), c.clone().add(t1).add(t2), c.clone().sub(t1).add(t2)];
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const base = out.pos.length / 3;
    const rel = c.clone().sub(crown);
    const depth = Math.min(1, rel.length() / crownR);
    const top = rel.y / crownR;
    const ao = THREE.MathUtils.clamp(0.42 + 0.45 * depth + 0.2 * top, 0.35, 1.05);
    corners.forEach((p, i) => {
      out.pos.push(p.x, p.y, p.z);
      const sn = p.clone().sub(crown).normalize();
      out.nrm.push(sn.x, sn.y * 0.8 + 0.25, sn.z);
      out.uv.push(uvs[i][0], uvs[i][1]);
      out.col.push(ao, ao, ao);
      out.wind.push(1);
    });
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  _geometry(out) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(out.wind, 1));
    g.setIndex(out.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  _curve(p0, dir, len, lift, segs, jitter) {
    const rnd = this.rng;
    const pts = [p0.clone()];
    const d = dir.clone().normalize();
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = p0.clone().addScaledVector(d, len * t);
      p.y += lift * t * t * len;
      p.x += (rnd() - 0.5) * jitter * len;
      p.z += (rnd() - 0.5) * jitter * len;
      pts.push(p);
    }
    return pts;
  }

  /** Broadleaf / maple / sakura: trunk splitting into limbs, sub-branches, leaf clusters. */
  _deciduous({ H, trunkFrac, limbs, spread, limbLen, region, clusterCards, cardSize, droop = 0, crownFlat = 1 }) {
    const rnd = this.rng;
    const out = { pos: [], nrm: [], uv: [], col: [], wind: [], idx: [] };
    const trunkH = H * trunkFrac;
    const r0 = H * 0.032;
    const lean = V((rnd() - 0.5) * 0.25, 1, (rnd() - 0.5) * 0.25);
    const trunk = this._curve(V(0, -0.3, 0), lean, trunkH + 0.3, 0, 5, 0.05);
    this._tube(out, trunk, trunk.map((_, i) => r0 * (1 - (i / 5) * 0.4) * (i === 0 ? 1.35 : 1)), 8, trunk.map((p) => Math.pow(Math.max(0, p.y) / H, 2) * 0.25));
    const top = trunk[trunk.length - 1];
    const crown = V(top.x, trunkH + (H - trunkH) * 0.42, top.z);
    const crownR = Math.max(H - trunkH, limbLen * H * 0.9) * 0.62;
    const clusters = [];
    for (let l = 0; l < limbs; l++) {
      const yaw = (l / limbs) * Math.PI * 2 + rnd() * 0.8;
      const pitch = spread[0] + rnd() * (spread[1] - spread[0]);
      const dir = V(Math.cos(yaw) * Math.sin(pitch), Math.cos(pitch), Math.sin(yaw) * Math.sin(pitch));
      const start = trunk[Math.min(trunk.length - 1, 3 + Math.floor(rnd() * 3))].clone();
      const L = H * limbLen * (0.8 + rnd() * 0.35);
      const limb = this._curve(start, dir, L, 0.22 - droop, 4, 0.06);
      const lr = r0 * 0.62;
      this._tube(out, limb, limb.map((_, i) => lr * (1 - i / 4.6)), 6, limb.map((_, i) => 0.25 + (i / 4) * 0.45));
      clusters.push(limb[4]);
      // sub-branches off the outer half of the limb
      const subs = 2 + Math.floor(rnd() * 3);
      for (let s = 0; s < subs; s++) {
        const at = limb[2 + Math.floor(rnd() * 2)];
        const sy = yaw + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6);
        const sp = pitch * (0.6 + rnd() * 0.5);
        const sd = V(Math.cos(sy) * Math.sin(sp), Math.cos(sp) - droop * 0.6, Math.sin(sy) * Math.sin(sp));
        const sl = L * (0.4 + rnd() * 0.25);
        const sb = this._curve(at, sd, sl, 0.18 - droop, 3, 0.08);
        this._tube(out, sb, sb.map((_, i) => lr * 0.45 * (1 - i / 3.4)), 4, sb.map((_, i) => 0.55 + i * 0.15));
        clusters.push(sb[3], sb[2]);
      }
      clusters.push(limb[3]);
    }
    // leader continuing up the middle
    clusters.push(V(top.x, H * 0.92, top.z), crown.clone().add(V(0, crownR * 0.4, 0)));
    for (const c of clusters) {
      c.y = crown.y + (c.y - crown.y) * crownFlat;
      const n = clusterCards + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const off = V(rnd() - 0.5, (rnd() - 0.4) * 0.8, rnd() - 0.5).multiplyScalar(cardSize * 1.3);
        const p = c.clone().add(off);
        const outward = p.clone().sub(crown).normalize();
        const nn = outward.add(V(rnd() - 0.5, rnd() - 0.3, rnd() - 0.5).multiplyScalar(1.3)).normalize();
        this._card(out, p, cardSize * (0.75 + rnd() * 0.55), nn, region, crown, crownR);
      }
    }
    return { geometry: this._geometry(out), height: H, radius: crownR * 1.25 };
  }

  /** Japanese cedar: straight trunk, drooping whorls of needle sprays, conical crown. */
  _conifer({ H, width }) {
    const rnd = this.rng;
    const out = { pos: [], nrm: [], uv: [], col: [], wind: [], idx: [] };
    const trunk = [];
    for (let i = 0; i <= 6; i++) trunk.push(V((rnd() - 0.5) * 0.08 * i, -0.3 + ((H + 0.3) * i) / 6, (rnd() - 0.5) * 0.08 * i));
    const r0 = H * 0.022;
    this._tube(out, trunk, trunk.map((_, i) => r0 * (1 - i / 6.3) * (i === 0 ? 1.3 : 1)), 7, trunk.map((p) => Math.pow(Math.max(0, p.y) / H, 2) * 0.3));
    const whorls = Math.round(H / 1.25);
    for (let w = 0; w < whorls; w++) {
      const t = w / (whorls - 1);
      const y = H * (0.2 + t * 0.78);
      const L = width * Math.pow(1 - t, 0.85) + 0.5;
      const count = Math.max(3, Math.round(7 - t * 3));
      for (let b = 0; b < count; b++) {
        const a = (b / count) * Math.PI * 2 + rnd() * 0.7 + w * 2.39;
        const dir = V(Math.cos(a), -0.28 - rnd() * 0.15, Math.sin(a));
        const br = this._curve(V(0, y, 0), dir, L, 0.1, 2, 0.08);
        if (L > 1.2) this._tube(out, br, br.map((_, i) => r0 * 0.28 * (1 - i / 2.4)), 3, br.map((_, i) => 0.4 + i * 0.25));
        // needle sprays along the branch: a flat card + a crossing card
        for (let k = 1; k <= 2; k++) {
          const p = br[k];
          const sz = L * (k === 2 ? 0.9 : 1.1) + 0.6;
          const axis = V(0, p.y + 0.6, 0);
          const flatN = V(dir.x * 0.25, 1, dir.z * 0.25).normalize();
          this._card(out, p, sz, flatN, REGION.needle, axis, width + 1);
          const sideN = V(-Math.sin(a), 0.35, Math.cos(a)).normalize();
          this._card(out, p.clone().add(V(0, 0.25, 0)), sz * 0.8, sideN, REGION.needle, axis, width + 1);
        }
      }
    }
    // tip
    this._card(out, V(0, H + 0.2, 0), 1.6, V(0.3, 0.2, 1).normalize(), REGION.needle, V(0, H - 1, 0), 2);
    this._card(out, V(0, H + 0.2, 0), 1.6, V(1, 0.2, -0.3).normalize(), REGION.needle, V(0, H - 1, 0), 2);
    return { geometry: this._geometry(out), height: H + 1, radius: width + 1 };
  }

  _buildVariants() {
    const variants = [
      { type: 'broad', ...this._deciduous({ H: 12, trunkFrac: 0.38, limbs: 5, spread: [0.45, 0.8], limbLen: 0.38, region: REGION.leaf, clusterCards: 9, cardSize: 2.5 }) },
      { type: 'broad', ...this._deciduous({ H: 9.5, trunkFrac: 0.36, limbs: 5, spread: [0.5, 0.9], limbLen: 0.4, region: REGION.leaf, clusterCards: 9, cardSize: 2.3 }) },
      { type: 'broad', ...this._deciduous({ H: 14, trunkFrac: 0.45, limbs: 6, spread: [0.35, 0.7], limbLen: 0.33, region: REGION.leaf, clusterCards: 8, cardSize: 2.6 }) },
      { type: 'pine', ...this._conifer({ H: 19, width: 3.4 }) },
      { type: 'pine', ...this._conifer({ H: 14, width: 3.0 }) },
      { type: 'pine', ...this._conifer({ H: 23, width: 3.8 }) },
      { type: 'sakura', ...this._deciduous({ H: 8, trunkFrac: 0.28, limbs: 4, spread: [0.85, 1.15], limbLen: 0.55, region: REGION.sakura, clusterCards: 8, cardSize: 1.9, droop: 0.12, crownFlat: 0.7 }) },
      { type: 'sakura', ...this._deciduous({ H: 6.5, trunkFrac: 0.3, limbs: 3, spread: [0.8, 1.1], limbLen: 0.6, region: REGION.sakura, clusterCards: 8, cardSize: 1.7, droop: 0.1, crownFlat: 0.7 }) },
      { type: 'maple', ...this._deciduous({ H: 8.5, trunkFrac: 0.35, limbs: 4, spread: [0.55, 0.95], limbLen: 0.42, region: REGION.maple, clusterCards: 8, cardSize: 1.6 }) },
      { type: 'maple', ...this._deciduous({ H: 7, trunkFrac: 0.32, limbs: 4, spread: [0.6, 1.0], limbLen: 0.45, region: REGION.maple, clusterCards: 8, cardSize: 1.5 }) },
    ];
    variants.forEach((v, i) => { v.index = i; });
    this.variants = variants;
    this.byType = { broad: [0, 1, 2], pine: [3, 4, 5], sakura: [6, 7], maple: [8, 9] };
    return variants;
  }

  // =========================================================== Materials
  _foliageMaterial(atlas, instanced) {
    const mat = new THREE.MeshStandardMaterial({
      map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true,
    });
    const shared = this.shared || (this.shared = {
      uWind: { value: 0 },
      uSunDir: { value: this.sun.dir },
      uSunCol: { value: this.sun.color },
    });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, shared);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uWind;
          attribute float aWind;
          varying float vLeaf;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 ip = vec3(0.0);
            #ifdef USE_INSTANCING
              ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
            #endif
            float ph = ip.x * 0.043 + ip.z * 0.031;
            float h = max(0.0, position.y);
            // whole-tree lean + branch sway + leaf flutter
            float gust = 0.6 + 0.4 * sin(uWind * 0.35 + ph * 0.3);
            float sway = h * h * 0.0009 * gust;
            transformed.x += sin(uWind * 1.1 + ph) * sway;
            transformed.z += cos(uWind * 0.9 + ph * 1.3) * sway * 0.7;
            float fl = aWind * aWind * 0.06;
            transformed.x += sin(uWind * 5.3 + position.y * 2.1 + position.x * 1.7 + ph) * fl;
            transformed.y += sin(uWind * 6.1 + position.z * 2.3 + ph) * fl * 0.6;
            transformed.z += cos(uWind * 4.7 + position.x * 1.9 + ph) * fl;
            vLeaf = step(0.99, aWind);
          }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uSunDir;
          uniform vec3 uSunCol;
          varying float vLeaf;`)
        // keep the soft crown normals on both sides of the leaf cards (bark stays two-sided)
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/\bnormal \*= faceDirection;/g, 'normal *= mix(faceDirection, 1.0, vLeaf);'))
        .replace('#include <alphatest_fragment>', `
          // alpha-tested leaves lose coverage in the mips: relax the cut-off with distance
          if (diffuseColor.a < mix(0.5, 0.18, smoothstep(15.0, 160.0, length(vViewPosition)))) discard;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            // light shining through the leaves when looking towards the sun
            vec3 Vw = normalize(-vViewPosition);
            vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
            float back = pow(clamp(dot(Vw, -Lv), 0.0, 1.0), 3.0);
            float wrap = clamp(dot(normal, Lv) * 0.5 + 0.5, 0.0, 1.0);
            totalEmissiveRadiance += diffuseColor.rgb * uSunCol * (back * 0.55 + wrap * 0.06) * vLeaf;
          }`);
    };
    mat.customProgramCacheKey = () => (instanced ? 'foliage-i' : 'foliage');
    return mat;
  }

  // ============================================================ Impostors
  /** Render every variant from VIEWS directions into one atlas (HDR, alpha). */
  _bakeImpostors(renderer, atlasTex) {
    const rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { type: THREE.HalfFloatType, generateMipmaps: true });
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    const scene = new THREE.Scene();
    const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
    key.position.set(0.4, 1, 0.55);
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a4a2a, 1.1);
    scene.add(key, hemi);
    const mat = this._foliageMaterial(atlasTex, false);
    const mesh = new THREE.Mesh(undefined, mat);
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const cols = Math.floor(ATLAS / FRAME);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.enabled;
    const prevAuto = renderer.autoClear;
    renderer.shadowMap.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    this.variants.forEach((v, vi) => {
      mesh.geometry = v.geometry;
      const bb = v.geometry.boundingBox;
      const size = Math.max(bb.max.y - bb.min.y, Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z)) * 1.04;
      const cy = (bb.max.y + bb.min.y) / 2;
      v.imp = { size, cy };
      cam.left = -size / 2; cam.right = size / 2; cam.top = size / 2; cam.bottom = -size / 2;
      cam.updateProjectionMatrix();
      for (let k = 0; k < VIEWS; k++) {
        const f = vi * VIEWS + k;
        const a = (k / VIEWS) * Math.PI * 2;
        cam.position.set(Math.sin(a) * 80, cy, Math.cos(a) * 80);
        cam.lookAt(0, cy, 0);
        key.position.set(Math.sin(a + 0.9) * 0.5, 1, Math.cos(a + 0.9) * 0.5);
        rt.viewport.set((f % cols) * FRAME, Math.floor(f / cols) * FRAME, FRAME, FRAME);
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
    });
    rt.viewport.set(0, 0, ATLAS, ATLAS);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.shadowMap.enabled = prevShadow;
    renderer.autoClear = prevAuto;
    mat.dispose();
    this.impostorRT = rt;
    return rt.texture;
  }

  _impostorMaterial(tex) {
    this.impUniforms = {
      uAtlas: { value: tex },
      uCam: { value: new THREE.Vector3() },
      uNear: { value: NEAR_RADIUS - 12 },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uCols: { value: Math.floor(ATLAS / FRAME) },
      uFrame: { value: FRAME / ATLAS },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    };
    return new THREE.ShaderMaterial({
      name: 'TreeImpostor',
      uniforms: this.impUniforms,
      fog: true,
      vertexShader: /* glsl */ `
        attribute vec4 aTree;   // x, y, z, scale
        attribute vec3 aInfo;   // yaw, variant, tint
        attribute vec2 aSize;   // quad size, centre height (unscaled)
        uniform vec3 uCam;
        uniform float uNear;
        uniform float uCols;
        uniform float uFrame;
        varying vec2 vUv;
        varying float vTint;
        #include <fog_pars_vertex>
        void main() {
          vec3 base = aTree.xyz;
          vec3 toCam = cameraPosition - base;
          vec3 toRebuild = uCam - base;
          float s = aTree.w;
          // near trees are drawn as full models
          if (length(toRebuild.xz) < uNear) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float ang = atan(toCam.x, toCam.z) - aInfo.x;
          float k = mod(floor(ang / 6.2831853 * ${VIEWS}.0 + 0.5), ${VIEWS}.0);
          float frame = aInfo.y * ${VIEWS}.0 + k;
          vec2 cell = vec2(mod(frame, uCols), floor(frame / uCols));
          vUv = (cell + uv) * uFrame;
          vTint = aInfo.z;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
          vec3 p = base + right * (uv.x - 0.5) * aSize.x * s + vec3(0.0, ((uv.y - 0.5) * aSize.x + aSize.y) * s, 0.0);
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        uniform vec3 uLight;
        varying vec2 vUv;
        varying float vTint;
        #include <fog_pars_fragment>
        void main() {
          vec4 c = texture2D(uAtlas, vUv);
          if (c.a < 0.35) discard;
          gl_FragColor = vec4(c.rgb / max(c.a, 0.001) * uLight * vTint, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
  }

  // ============================================================== Build
  build({ avoid, extraSpots = [], festivalCenter, renderer }) {
    const atlas = this._atlas();
    this._buildVariants();
    this.material = this._foliageMaterial(atlas, true);
    this.windUniform = this.shared.uWind;

    // ---- Placement
    const t = this.terrain;
    const rnd = this.rng;
    const spots = [];
    const step = 15;
    for (let z = -t.half + 40; z < t.half - 40; z += step) {
      for (let x = -t.half + 40; x < t.half - 40; x += step) {
        const px = x + (rnd() - 0.5) * step, pz = z + (rnd() - 0.5) * step;
        const forest = t.maskAt(px, pz, 2);
        const n = fbm(px / 180, pz / 180, 3) * 0.5 + 0.5;
        const density = Math.pow(forest, 1.6) * 0.72 + n * 0.1 - 0.12;
        if (rnd() > density) continue;
        if (t.maskAt(px, pz, 0) > 0.02 || t.maskAt(px, pz, 1) > 0.5) continue;
        if (avoid && avoid(px, pz)) continue;
        const y = t.heightAt(px, pz);
        if (y > t.snowLine - 40) continue;
        const nrm = t.normalAt(px, pz, new THREE.Vector3());
        if (nrm.y < 0.8) continue;
        const dFest = Math.hypot(px - festivalCenter.x, pz - festivalCenter.z);
        let type;
        if (dFest < 650 && rnd() < 0.55) type = 'sakura';
        else if (y > 80 || (y > 35 && rnd() < 0.5) || rnd() < 0.2) type = 'pine';
        else { const r = rnd(); type = r < 0.06 ? 'sakura' : r < 0.14 ? 'maple' : 'broad'; }
        spots.push({ x: px, z: pz, y, type, s: 0.8 + rnd() * 0.45, r: rnd() * Math.PI * 2 });
      }
    }
    for (const e of extraSpots) {
      spots.push({ x: e.x, z: e.z, y: t.heightAt(e.x, e.z) + (e.y ?? 0.18), type: e.type, s: e.small ? 0.62 : 0.85 + rnd() * 0.3, r: rnd() * Math.PI * 2 });
    }
    for (const s of spots) {
      const list = this.byType[s.type] || this.byType.broad;
      s.v = list[Math.floor(rnd() * list.length)];
      s.tint = 0.84 + rnd() * 0.3;
      this.treePositions.push(s.x, s.z, s.type === 'sakura' ? 1 : s.type === 'pine' ? 2 : s.type === 'maple' ? 3 : 0);
      this.physics.addStaticCylinder(new THREE.Vector3(s.x, s.y, s.z), (s.type === 'pine' ? 0.3 : 0.35) * s.s, 2.5);
    }
    this.spots = spots;

    // ---- Spatial grid for the near-model rebuilds
    this.grid = new Map();
    for (const s of spots) {
      const k = `${Math.floor(s.x / GRID)},${Math.floor(s.z / GRID)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(s);
    }
    // ---- Near models: one InstancedMesh per variant (capacity grows as needed)
    this.near = this.variants.map((v) => this._nearMesh(v, 64));

    // ---- Far impostors: every tree, culled near the camera in the shader
    const impTex = renderer ? this._bakeImpostors(renderer, atlas) : null;
    if (impTex) {
      const quad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.attributes.position);
      g.setAttribute('uv', quad.attributes.uv);
      const aTree = new Float32Array(spots.length * 4), aInfo = new Float32Array(spots.length * 3), aSize = new Float32Array(spots.length * 2);
      spots.forEach((s, i) => {
        const v = this.variants[s.v];
        aTree.set([s.x, s.y - 0.1, s.z, s.s], i * 4);
        aInfo.set([s.r, s.v, s.tint], i * 3);
        aSize.set([v.imp.size, v.imp.cy], i * 2);
      });
      g.setAttribute('aTree', new THREE.InstancedBufferAttribute(aTree, 4));
      g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 3));
      g.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 2));
      g.instanceCount = spots.length;
      const imp = new THREE.Mesh(g, this._impostorMaterial(impTex));
      imp.frustumCulled = false;
      imp.name = 'TreeImpostors';
      this.scene.add(imp);
      this.impostors = imp;
    }

    this._buildRocks(avoid);
    this.instanceCount += spots.length;
    this.treeCount = spots.length;
    // soft shade on the ground around every tree (terrain AO beyond shadow range)
    const shade = new Float32Array(spots.length * 3);
    spots.forEach((s, i) => { shade[i * 3] = s.x; shade[i * 3 + 1] = s.z; shade[i * 3 + 2] = s.s; });
    this.terrain.splatTreeShade(shade);
  }

  _nearMesh(v, capacity) {
    const m = new THREE.InstancedMesh(v.geometry, this.material, capacity);
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _col.setScalar(1));
    this.scene.add(m);
    return m;
  }

  /** Refill the near-model instance buffers with trees around the camera. */
  _rebuildNear(cam) {
    const lists = this.variants.map(() => []);
    const cx = Math.floor(cam.x / GRID), cz = Math.floor(cam.z / GRID);
    const r = Math.ceil(NEAR_RADIUS / GRID) + 1;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const cell = this.grid.get(`${cx + dx},${cz + dz}`);
      if (!cell) continue;
      for (const s of cell) {
        const ddx = s.x - cam.x, ddz = s.z - cam.z;
        if (ddx * ddx + ddz * ddz < NEAR_RADIUS * NEAR_RADIUS) lists[s.v].push(s);
      }
    }
    lists.forEach((list, vi) => {
      let mesh = this.near[vi];
      if (list.length > mesh.instanceMatrix.count) {
        this.scene.remove(mesh);
        mesh.dispose();
        mesh = this._nearMesh(this.variants[vi], Math.ceil(list.length * 1.5));
        this.near[vi] = mesh;
      }
      list.forEach((s, i) => {
        _q.setFromAxisAngle(_up, s.r);
        mesh.setMatrixAt(i, _m.compose(_pp.set(s.x, s.y - 0.1, s.z), _q, _sc.setScalar(s.s)));
        mesh.setColorAt(i, _col.setScalar(s.tint));
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  // ================================================================ Rocks
  _buildRocks(avoid) {
    const t = this.terrain;
    const rnd = mulberry32(606);
    const variants = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const n = 1 + fbm(x * 1.3 + v * 7, z * 1.3 + y * 0.9, 3) * 0.28;
        pos.setXYZ(i, x * n * (1.2 + v * 0.15), y * n * (0.62 - v * 0.08), z * n);
      }
      g.computeVertexNormals();
      variants.push(g);
    }
    const spots = [[], [], []];
    for (let k = 0, placed = 0; k < 26000 && placed < 5400; k++) {
      const x = (rnd() - 0.5) * (t.size - 200), z = (rnd() - 0.5) * (t.size - 200);
      const nrm = t.normalAt(x, z, _n);
      const slope = 1 - nrm.y;
      const shore = t.mask2At(x, z, 0);
      const h = t.heightAt(x, z);
      const want = slope > 0.18 ? 0.5 : shore > 0.5 && h > (t.waterLevel ?? -2) - 1 ? 0.2 : h > 150 ? 0.08 : 0.012;
      if (rnd() > want) continue;
      if (t.maskAt(x, z, 0) > 0.05 || t.maskAt(x, z, 1) > 0.3 || (avoid && avoid(x, z))) continue;
      if (t.isWater(x, z, 1.5)) continue;
      const s = 0.5 + Math.pow(rnd(), 3) * (slope > 0.18 ? 4 : 1.8);
      spots[k % 3].push({ x, z, y: h - s * 0.25, s, r: rnd() * Math.PI * 2, t: rnd() });
      placed++;
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    this.rockChunks = variants.map((g, vi) => {
      for (const s of spots[vi]) if (s.s > 1.4) this.physics.addStaticCylinder(_pp.set(s.x, s.y, s.z), s.s * 0.9, s.s * 0.35);
      this.instanceCount += spots[vi].length;
      return new ChunkedInstances(this.scene, g, mat, spots[vi], {
        chunk: 384, maxDistance: 1400, colors: true,
        write: (s, m, c) => {
          _q.setFromEuler(_e.set(s.t * 0.4, s.r, (s.t - 0.5) * 0.3));
          m.compose(_pp.set(s.x, s.y, s.z), _q, _sc.setScalar(s.s));
          c.setHSL(0.08, 0.06 + s.t * 0.08, 0.34 + s.t * 0.22);
        },
      });
    });
    this.rockCount = spots[0].length + spots[1].length + spots[2].length;
  }

  // ================================================================ Grass
  buildGrass(count = 52000) {
    const t = this.terrain;
    const blade = new THREE.BufferGeometry();
    // 7-vertex tapered, slightly curved blade (5 triangles), y 0..1
    const bp = [-0.5, 0, 0, 0.5, 0, 0, -0.42, 0.35, 0.02, 0.42, 0.35, 0.02, -0.28, 0.68, 0.06, 0.28, 0.68, 0.06, 0, 1, 0.12];
    blade.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(21).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
    const geo = new THREE.InstancedBufferGeometry().copy(blade);
    geo.instanceCount = count;
    const off = new Float32Array(count * 4);
    const r = mulberry32(31337);
    for (let i = 0; i < count; i++) {
      off[i * 4] = r(); off[i * 4 + 1] = r(); off[i * 4 + 2] = r(); off[i * 4 + 3] = r();
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));

    this.grassUniforms = {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uHeight: { value: t.heightTexture() },
      uMask: { value: t.maskTexture },
      uMask2: { value: t.mask2Texture },
      uWorld: { value: new THREE.Vector3(t.half, t.size, t.n1) },
      uRadius: { value: 75 },
      uSnow: { value: t.snowLine },
      uSea: { value: t.waterLevel ?? -2 },
      uLake: { value: LAKE.level },
    };
    const u = this.grassUniforms;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aOff;
          uniform vec3 uCam;
          uniform float uTime;
          uniform sampler2D uHeight;
          uniform sampler2D uMask;
          uniform sampler2D uMask2;
          uniform vec3 uWorld;
          uniform float uRadius;
          uniform float uSnow;
          uniform float uSea;
          uniform float uLake;
          varying float vTip;
          varying vec3 vGrassCol;
          ${TERRAIN_NOISE}
          float hAt(vec2 p) {
            vec2 g = (p + uWorld.x) / uWorld.y * (uWorld.z - 1.0);
            vec2 i = floor(g); vec2 f = fract(g);
            float n = uWorld.z;
            float h00 = texture2D(uHeight, (i + 0.5) / n).r;
            float h10 = texture2D(uHeight, (i + vec2(1.5, 0.5)) / n).r;
            float h01 = texture2D(uHeight, (i + vec2(0.5, 1.5)) / n).r;
            float h11 = texture2D(uHeight, (i + 1.5) / n).r;
            if (f.x + f.y <= 1.0) return h00 + (h10 - h00) * f.x + (h01 - h00) * f.y;
            return h11 * (f.x + f.y - 1.0) + h10 * (1.0 - f.y) + h01 * (1.0 - f.x);
          }`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal = vec3(0.0, 1.0, 0.0);`)
        .replace('#include <begin_vertex>', `
          float D = uRadius * 2.0;
          vec2 rel = mod(aOff.xy * D - uCam.xz, D) - uRadius;
          vec2 wp = uCam.xz + rel;
          float dist = length(rel);
          vec2 muv = (wp + uWorld.x) / uWorld.y;
          vec4 mk = texture2D(uMask, muv);
          vec4 mk2 = texture2D(uMask2, muv);
          float h0 = hAt(wp);
          float slope = abs(hAt(wp + vec2(2.0, 0.0)) - h0) + abs(hAt(wp + vec2(0.0, 2.0)) - h0);
          float keep = (1.0 - smoothstep(0.02, 0.2, mk.r)) * (1.0 - mk.g) * (1.0 - smoothstep(0.6, 1.2, slope))
                     * (1.0 - smoothstep(uSnow - 60.0, uSnow - 20.0, h0))
                     * (1.0 - smoothstep(0.25, 0.5, mk2.r) * max(1.0 - smoothstep(uSea + 3.0, uSea + 6.0, h0),
                                                                   step(1500.0, wp.y) * (1.0 - smoothstep(uLake + 1.6, uLake + 3.0, h0))))
                     * (1.0 - smoothstep(0.4, 0.7, mk2.g));
          float clump = tnoise(wp * 0.08);
          keep *= smoothstep(0.15, 0.38, clump + aOff.w * 0.2);
          float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius, dist);
          float hgt = (0.2 + aOff.z * 0.38 + clump * 0.28) * keep * fade;
          float ang = aOff.w * 6.2831;
          vec3 side = vec3(cos(ang), 0.0, sin(ang)) * 0.075;
          vec3 fwd = vec3(-sin(ang), 0.0, cos(ang));
          float y = position.y;
          vec3 transformed = vec3(wp.x, h0, wp.y) + side * position.x * 2.0 + fwd * position.z * hgt;
          transformed.y += y * hgt;
          float gust = 0.55 + 0.45 * sin(uTime * 0.6 + wp.x * 0.012 + wp.y * 0.01);
          float w = sin(uTime * 1.8 + wp.x * 0.12 + wp.y * 0.09) * 0.5 + sin(uTime * 3.1 + wp.x * 0.4) * 0.2;
          transformed.xz += vec2(0.3, 0.2) * w * gust * y * y * hgt;
          vTip = y;
          vGrassCol = mix(vec3(0.1, 0.19, 0.045), vec3(0.2, 0.28, 0.07), tfbm(wp * 0.0025));
          vGrassCol = mix(vGrassCol, vec3(0.34, 0.33, 0.16), smoothstep(0.55, 0.85, tfbm(wp * 0.03)) * 0.45);
          vGrassCol *= 0.85 + 0.3 * aOff.z;
          vGrassCol *= 1.0 - mk2.b * 0.3;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTip;\nvarying vec3 vGrassCol;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= vGrassCol * (0.85 + 0.45 * vTip);`)
        .replace('#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace(/\bnormal \*= faceDirection;/g, ''));
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'Grass';
    this.grass = mesh;
    this.scene.add(mesh);
    return mesh;
  }

  /** Sun direction/colour (translucency) and the light level for impostors. */
  setLighting(sunDir, sunColor, impostorLight) {
    this.sun.dir.copy(sunDir);
    this.sun.color.copy(sunColor);
    if (this.impUniforms) this.impUniforms.uLight.value.copy(impostorLight);
  }

  update(dt, camera) {
    this.windUniform.value += dt;
    const cam = camera.position;
    if (this.near && (Math.abs(cam.x - this._lastRebuild.x) > 18 || Math.abs(cam.z - this._lastRebuild.z) > 18)) {
      this._rebuildNear(cam);
      this._lastRebuild.copy(cam);
    }
    if (this.impUniforms) this.impUniforms.uCam.value.copy(this._lastRebuild);
    if (this.rockChunks && (this._rockT = (this._rockT || 0) + dt) > 0.5) {
      this._rockT = 0;
      for (const rc of this.rockChunks) rc.update(cam);
    }
    if (this.grass) {
      this.grassUniforms.uCam.value.copy(cam);
      this.grassUniforms.uTime.value += dt;
    }
  }

  setGrassDensity(level) {
    if (!this.grass) return;
    const n = { off: 0, low: 22000, high: 52000 }[level] ?? 52000;
    this.grass.visible = n > 0;
    this.grass.geometry.instanceCount = n;
  }
}

function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _n = new THREE.Vector3();
const _e = new THREE.Euler();
