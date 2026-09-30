import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';
import { CITY_RECT, CITY_STREET_STEP, CITY_STREET_WIDTH } from './Roads.js';

const STYLE_PRESETS = {
  downtown: { tall: 1, signs: 1, warehouses: 0 },
  harbor: { tall: 0.12, signs: 0.45, warehouses: 1 },
};

/**
 * City.js
 * -------
 * "Neon City": a 1 km² downtown grid.
 *  - Asphalt base with painted lane lines, crosswalks and stop lines
 *  - Raised sidewalk blocks (with physics) and ~250 buildings on subdivided lots
 *  - One InstancedMesh for every building: facades are shaded procedurally
 *    (window grids aligned to each building, reflective curtain-wall glass,
 *    storefronts, windows lit at night, fake ambient occlusion at the base)
 *  - Neon blade signs, storefront signs and rooftop billboards (emissive
 *    atlas → bloom), rooftop AC units, street lights and traffic lights
 */

const SIDEWALK = 5;
const CURB_H = 0.18;

export class City {
  /**
   * @param {object} opts { name, rect, step, streetWidth, baseY, seed, style ('downtown'|'harbor'), parks: block indices }
   */
  constructor(scene, physics, renderer, opts = {}) {
    this.scene = scene;
    this.physics = physics;
    this.renderer = renderer;
    this.name = opts.name ?? 'Neon City';
    this.rect = opts.rect ?? CITY_RECT;
    this.step = opts.step ?? CITY_STREET_STEP;
    this.sw = opts.streetWidth ?? CITY_STREET_WIDTH;
    this.baseY = opts.baseY ?? 0;
    this.style = STYLE_PRESETS[opts.style ?? 'downtown'];
    this.parkIdx = opts.parks ?? [9, 27, 46, 58];
    this.rng = mulberry32(opts.seed ?? 4242);
    this.buildings = []; // {x,z,w,d,h,style}
    this.blocks = [];
    this.parks = [];
    this.treeSpots = [];
    this.instanceCount = 0;
    this.uniforms = { uNight: { value: 0 }, uTime: { value: 0 } };
  }

  build(asphaltTextures) {
    this._layoutBlocks();
    this._buildGround(asphaltTextures);
    this._buildSidewalks();
    this._buildBuildings();
    this._buildSigns();
    this._buildStreetFurniture();
    return this;
  }

  // ---------------------------------------------------------------- Layout
  _layoutBlocks() {
    const { minX, minZ, maxX, maxZ } = this.rect;
    const hs = this.sw / 2;
    for (let x = minX; x < maxX - 1; x += this.step) {
      for (let z = minZ; z < maxZ - 1; z += this.step) {
        this.blocks.push({ minX: x + hs, maxX: x + this.step - hs, minZ: z + hs, maxZ: z + this.step - hs });
      }
    }
    // a few blocks become parks
    for (const i of this.parkIdx) if (this.blocks[i]) this.blocks[i].park = true;
  }

  streetLines() {
    const xs = [], zs = [];
    for (let x = this.rect.minX; x <= this.rect.maxX + 1; x += this.step) xs.push(x);
    for (let z = this.rect.minZ; z <= this.rect.maxZ + 1; z += this.step) zs.push(z);
    return { xs, zs };
  }

  // ---------------------------------------------------------------- Ground
  _buildGround(tex) {
    const { minX, minZ, maxX, maxZ } = this.rect;
    const pad = 30;
    const W = maxX - minX + pad * 2, D = maxZ - minZ + pad * 2;
    // Markings canvas (0.5 m / px)
    const PX = 2;
    const c = document.createElement('canvas');
    c.width = Math.round(W * PX); c.height = Math.round(D * PX);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const X = (x) => (x - (minX - pad)) * PX, Z = (z) => (z - (minZ - pad)) * PX;
    const { xs, zs } = this.streetLines();
    const hs = this.sw / 2;
    ctx.fillStyle = 'rgba(240,240,232,0.95)';
    const dashH = (x0, x1, z) => { for (let x = x0; x < x1; x += 9) ctx.fillRect(X(x), Z(z) - 0.15 * PX, 4.5 * PX, 0.3 * PX); };
    const dashV = (z0, z1, x) => { for (let z = z0; z < z1; z += 9) ctx.fillRect(X(x) - 0.15 * PX, Z(z), 0.3 * PX, 4.5 * PX); };
    // centre dashes between intersections
    for (const z of zs) for (let i = 0; i < xs.length - 1; i++) dashH(xs[i] + hs + 6, xs[i + 1] - hs - 6, z);
    for (const x of xs) for (let i = 0; i < zs.length - 1; i++) dashV(zs[i] + hs + 6, zs[i + 1] - hs - 6, x);
    // crosswalks + stop lines at every intersection approach
    for (const x of xs) {
      for (const z of zs) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cx = x + dx * (hs + 3), cz = z + dz * (hs + 3);
          if (cx < minX - 1 || cx > maxX + 1 || cz < minZ - 1 || cz > maxZ + 1) continue;
          for (let k = -hs + 1; k < hs - 1; k += 1.6) {
            if (dx !== 0) ctx.fillRect(X(cx) - 2 * PX, Z(z + k), 4 * PX, 0.8 * PX);
            else ctx.fillRect(X(x + k), Z(cz) - 2 * PX, 0.8 * PX, 4 * PX);
          }
          // stop line on the approaching lane
          if (dx !== 0) ctx.fillRect(X(cx + dx * 3) - 0.25 * PX, Z(z + (dx > 0 ? 0.3 : -hs + 1)), 0.5 * PX, (hs - 1.3) * PX);
          else ctx.fillRect(X(x + (dz > 0 ? -hs + 1 : 0.3)), Z(cz + dz * 3) - 0.25 * PX, (hs - 1.3) * PX, 0.5 * PX);
        }
      }
    }
    const marks = new THREE.CanvasTexture(c);
    marks.colorSpace = THREE.SRGBColorSpace;
    marks.anisotropy = 8;
    marks.flipY = false;

    const base = tex.plain.clone();
    base.needsUpdate = true;
    base.repeat.set(W / 14, D / 14);
    const rough = tex.roughness.clone(); rough.repeat.copy(base.repeat); rough.needsUpdate = true;
    const norm = tex.normal.clone(); norm.repeat.copy(base.repeat); norm.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map: base, roughnessMap: rough, normalMap: norm, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const origin = new THREE.Vector4(minX - pad, minZ - pad, W, D);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMarks = { value: marks };
      sh.uniforms.uOrigin = { value: origin };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCityUv;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvec4 cwp = modelMatrix * vec4(transformed, 1.0);\nvCityUv = (cwp.xz - uOriginV.xy) / uOriginV.zw;')
        .replace('#include <common>', '#include <common>\nuniform vec4 uOriginV;');
      sh.uniforms.uOriginV = sh.uniforms.uOrigin;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCityUv;\nuniform sampler2D uMarks;\nfloat gMark;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec4 mk = texture2D(uMarks, vCityUv);
          gMark = mk.a;
          diffuseColor.rgb = mix(diffuseColor.rgb, mk.rgb, mk.a);`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, gMark);');
    };
    const g = new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(minX - pad + W / 2, this.baseY + 0.04, minZ - pad + D / 2);
    mesh.receiveShadow = true;
    mesh.name = 'CityStreets';
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------- Sidewalks
  _buildSidewalks() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#9a9894';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i++) {
      const v = 130 + Math.random() * 40;
      ctx.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    ctx.strokeStyle = 'rgba(70,68,64,0.8)';
    ctx.lineWidth = 2;
    for (let k = 0; k <= 256; k += 64) {
      ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, k); ctx.lineTo(256, k); ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    const walkMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
    const parkMat = new THREE.MeshStandardMaterial({ color: 0x3f5f2a, roughness: 0.95 });

    const geos = [], parkGeos = [];
    for (const b of this.blocks) {
      const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
      const g = new THREE.BoxGeometry(w, CURB_H, d);
      // world-scaled UVs (2 m tiles)
      const uv = g.attributes.uv, pos = g.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / 4, (pos.getZ(i) + d / 2) / 4 + pos.getY(i));
      g.translate((b.minX + b.maxX) / 2, this.baseY + CURB_H / 2, (b.minZ + b.maxZ) / 2);
      geos.push(g);
      this.physics.addStaticBox(new THREE.Vector3((b.minX + b.maxX) / 2, this.baseY + CURB_H / 2, (b.minZ + b.maxZ) / 2), new THREE.Vector3(w / 2, CURB_H / 2, d / 2), 0);
      if (b.park) {
        const pg = new THREE.PlaneGeometry(w - SIDEWALK * 2, d - SIDEWALK * 2).rotateX(-Math.PI / 2);
        pg.translate((b.minX + b.maxX) / 2, this.baseY + CURB_H + 0.01, (b.minZ + b.maxZ) / 2);
        parkGeos.push(pg);
        this.parks.push(b);
      }
    }
    const walks = new THREE.Mesh(mergeGeometries(geos), walkMat);
    walks.receiveShadow = true;
    this.scene.add(walks);
    if (parkGeos.length) {
      const parks = new THREE.Mesh(mergeGeometries(parkGeos), parkMat);
      parks.receiveShadow = true;
      this.scene.add(parks);
    }
  }

  // ------------------------------------------------------------- Buildings
  _buildBuildings() {
    const rng = this.rng;
    const center = { x: (this.rect.minX + this.rect.maxX) / 2, z: (this.rect.minZ + this.rect.maxZ) / 2 };
    const list = [];
    const split = (lot, depth) => {
      const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
      if (depth > 0 && (w > 34 || d > 34) && rng() < 0.85) {
        const alongX = w > d ? rng() < 0.8 : rng() < 0.2;
        const t = 0.35 + rng() * 0.3;
        if (alongX) {
          const m = lot.minX + w * t;
          split({ ...lot, maxX: m }, depth - 1);
          split({ ...lot, minX: m }, depth - 1);
        } else {
          const m = lot.minZ + d * t;
          split({ ...lot, maxZ: m }, depth - 1);
          split({ ...lot, minZ: m }, depth - 1);
        }
        return;
      }
      const cx = (lot.minX + lot.maxX) / 2, cz = (lot.minZ + lot.maxZ) / 2;
      const dc = Math.hypot(cx - center.x, cz - center.z);
      const downtown = Math.exp(-(dc * dc) / (330 * 330)) * this.style.tall;
      const setback = 1 + rng() * 2.5;
      const bw = w - setback * 2, bd = d - setback * 2;
      if (bw < 8 || bd < 8) return;
      const y0 = this.baseY + CURB_H;
      // harbour: the blocks nearest the sea are warehouses and sheds
      if (this.style.warehouses && cx > this.rect.maxX - this.step * 1.1 && rng() < 0.8) {
        list.push({ x: cx, z: cz, w: bw, d: bd, h: 8 + rng() * 6, style: 4, y: y0 });
        return;
      }
      let h = (10 + rng() * 22) * (this.style.tall < 1 ? 0.55 : 1) + downtown * (40 + rng() * 150);
      let style;
      if (h > 90) style = rng() < 0.7 ? 0 : 1; // glass tower / office
      else if (h > 40) style = rng() < 0.5 ? 1 : 2; // office / residential
      else style = rng() < 0.55 ? 3 : 2; // shop-house / residential
      h = Math.round(h / 3.6) * 3.6 + 1.2;
      list.push({ x: cx, z: cz, w: bw, d: bd, h, style, y: y0 });
      // setback tier on towers
      if (h > 70 && rng() < 0.6) {
        const s = 0.6 + rng() * 0.2;
        list.push({ x: cx, z: cz, w: bw * s, d: bd * s, h: h * (0.15 + rng() * 0.25), style, y: y0 + h });
      }
    };
    for (const b of this.blocks) {
      if (b.park) continue;
      split({ minX: b.minX + SIDEWALK, maxX: b.maxX - SIDEWALK, minZ: b.minZ + SIDEWALK, maxZ: b.maxZ - SIDEWALK }, 2);
    }
    this.buildings = list;

    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const style = new Float32Array(list.length);
    const seed = new Float32Array(list.length);
    const mat = this._facadeMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    const palettes = [
      ['#6f7f8f', '#5d6f7d', '#7c8c96', '#4f6070'], // glass towers (frame colour)
      ['#b7b1a6', '#9c9892', '#c9c3b6', '#8c8a86'], // office stone
      ['#c8b49c', '#a89a8a', '#d6ccbc', '#9b8878', '#b9a58e'], // residential
      ['#d9d2c6', '#7d6f64', '#bfae97', '#6b5e57', '#e0d8cf'], // shop-house
      ['#7f8d96', '#9a6b4f', '#5d7a8a', '#a5a9ad', '#8e4d3c'], // warehouse
    ];
    list.forEach((b, i) => {
      mesh.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d)));
      const pal = palettes[b.style];
      mesh.setColorAt(i, col.set(pal[Math.floor(rng() * pal.length)]));
      style[i] = b.style;
      seed[i] = rng() * 100;
      this.physics.addStaticBox(p.set(b.x, b.y + b.h / 2, b.z), new THREE.Vector3(b.w / 2, b.h / 2, b.d / 2), 0);
      b.top = b.y + b.h;
    });
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'Buildings';
    this.scene.add(mesh);
    this.buildingMesh = mesh;
    this.instanceCount += list.length;

    // Rooftop units
    const acGeo = mergeGeometries([
      new THREE.BoxGeometry(3, 1.6, 2.2).translate(0, 0.8, 0),
      new THREE.CylinderGeometry(1.2, 1.2, 2.6, 12).translate(4, 1.3 + 1.2, 0),
      new THREE.CylinderGeometry(0.12, 0.12, 1.2, 6).translate(4, 0.6, 0),
    ]);
    const acMat = new THREE.MeshStandardMaterial({ color: 0x8e9196, roughness: 0.6, metalness: 0.4 });
    const tops = list.filter((b) => b.w > 14 && b.d > 14);
    const ac = new THREE.InstancedMesh(acGeo, acMat, tops.length);
    tops.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.floor(rng() * 4) * Math.PI / 2);
      ac.setMatrixAt(i, m.compose(p.set(b.x + (rng() - 0.5) * b.w * 0.4, b.y + b.h, b.z + (rng() - 0.5) * b.d * 0.4), q, s.set(1, 1, 1)));
    });
    ac.castShadow = true;
    ac.computeBoundingSphere();
    this.scene.add(ac);
  }

  _facadeMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.0 });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = u.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aStyle;
          attribute float aSeed;
          varying vec3 vBLocal;
          varying vec3 vBSize;
          varying vec3 vBNrm;
          varying float vBStyle;
          varying float vBSeed;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 bScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vBSize = bScale;
          vBLocal = (position + vec3(0.5, 0.0, 0.5)) * bScale;
          vBNrm = normal;
          vBStyle = aStyle;
          vBSeed = aSeed;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight;
          varying vec3 vBLocal;
          varying vec3 vBSize;
          varying vec3 vBNrm;
          varying float vBStyle;
          varying float vBSeed;
          float bh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float gWin; float gLit; float gGlassy; float gRoof; float gFar; vec3 gLitCol;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            gRoof = step(0.5, abs(vBNrm.y));
            // facade coordinates: u along the face, v up
            float faceW = abs(vBNrm.x) > 0.5 ? vBSize.z : vBSize.x;
            float u = abs(vBNrm.x) > 0.5 ? vBLocal.z : vBLocal.x;
            float v = vBLocal.y;
            int st = int(vBStyle + 0.5);
            float floorH = st == 2 ? 3.0 : (st == 4 ? 20.0 : 3.6);
            float colTarget = st == 0 ? 1.6 : (st == 1 ? 3.2 : (st == 2 ? 3.6 : (st == 4 ? 6.0 : 4.2)));
            float cols = max(1.0, floor(faceW / colTarget + 0.5));
            float colW = faceW / cols;
            vec2 g = vec2(u / colW, v / floorH);
            vec2 cell = floor(g);
            vec2 f = fract(g);
            float mx = st == 0 ? 0.04 : (st == 1 ? 0.14 : (st == 4 ? 0.1 : 0.22));
            float my0 = st == 0 ? 0.06 : (st == 4 ? (vBSize.y - 2.2) / floorH : 0.28);
            float my1 = st == 0 ? 0.96 : (st == 4 ? (vBSize.y - 1.1) / floorH : 0.84);
            // anti-aliased window mask; fades to average coverage when tiny on screen
            vec2 fw = fwidth(g) * 1.2;
            float wx = smoothstep(mx - fw.x, mx + fw.x, f.x) * (1.0 - smoothstep(1.0 - mx - fw.x, 1.0 - mx + fw.x, f.x));
            float wy = smoothstep(my0 - fw.y, my0 + fw.y, f.y) * (1.0 - smoothstep(my1 - fw.y, my1 + fw.y, f.y));
            float avgCov = (1.0 - 2.0 * mx) * (my1 - my0);
            float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));
            float win = mix(wx * wy, avgCov, far);
            gFar = far;
            // storefronts on the ground floor
            float ground = 1.0 - step(4.4, v);
            if (st >= 2 && st < 4) win = mix(win, step(0.05, f.x) * step(f.x, 0.95) * step(0.03, v / 4.4) * step(v / 4.4, 0.8), ground);
            // keep corners solid
            float edge = step(0.8, u) * step(u, faceW - 0.8);
            win *= edge * (1.0 - gRoof);
            float face = floor(vBNrm.x * 2.0 + vBNrm.z * 3.0 + 5.0);
            float r = bh(cell + vec2(vBSeed, face * 17.0));
            float r2 = bh(cell.yx * 1.7 + vec2(face, vBSeed));
            gWin = win;
            gGlassy = st == 0 ? 1.0 : 0.6;
            gLit = mix(step(0.52, r), 0.45, gFar) * uNight + ground * uNight * step(2.5, vBStyle) * step(vBStyle, 3.5) * 1.5;
            gLitCol = mix(vec3(1.0, 0.78, 0.5), vec3(0.75, 0.85, 1.0), step(0.8, r2));
            vec3 wall = diffuseColor.rgb;
            // horizontal banding on offices, subtle grime towards the base
            if (st == 1) wall *= 0.92 + 0.08 * step(0.85, fract(v / floorH));
            if (st == 4) {
              // corrugated cladding + a big roller door on each face
              wall *= 0.86 + 0.14 * smoothstep(0.2, 0.8, abs(sin(u * 9.0)));
              float door = step(abs(u - faceW * 0.5), min(3.2, faceW * 0.3)) * step(v, 5.2);
              wall = mix(wall, vec3(0.32, 0.33, 0.34) * (0.9 + 0.1 * step(0.5, fract(v * 3.0))), door);
            }
            vec3 glass = st == 0 ? vec3(0.08, 0.12, 0.16) : vec3(0.05, 0.06, 0.07);
            glass *= 0.8 + 0.4 * r2;
            vec3 c = mix(wall, glass, win);
            c *= 0.62 + 0.38 * smoothstep(0.0, 3.5, v); // fake AO at street level
            if (gRoof > 0.5) c = vec3(0.3, 0.3, 0.31) * (0.8 + 0.2 * bh(floor(vBLocal.xz)));
            diffuseColor.rgb = c;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.06, gWin);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = mix(metalnessFactor, 0.75 * gGlassy, gWin);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gLitCol * gWin * gLit * 0.55;`);
    };
    return mat;
  }

  // ----------------------------------------------------------------- Signs
  _signAtlas() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    const names = ['RAMEN', 'KARAOKE', 'HOTEL', 'SAKURA', 'NEON 24', 'ARCADE', 'SUSHI', 'CAFE',
      'GAMES', 'BAR', 'TOKIO', 'DRIFT', 'MOTEL', 'NOODLE', 'CLUB', 'PIZZA'];
    const colors = ['#ff2d8f', '#2de2ff', '#ffd23f', '#b6ff3b', '#ff6a3d', '#8b5cff', '#ffffff', '#ff4d5e'];
    for (let i = 0; i < 16; i++) {
      const x = (i % 4) * 256, y = Math.floor(i / 4) * 256;
      const col = colors[i % colors.length];
      ctx.fillStyle = i % 3 === 0 ? '#101018' : i % 3 === 1 ? '#1d0f1a' : '#0b1620';
      ctx.fillRect(x + 4, y + 4, 248, 248);
      ctx.strokeStyle = col;
      ctx.lineWidth = 8;
      ctx.shadowColor = col;
      ctx.shadowBlur = 18;
      ctx.strokeRect(x + 14, y + 14, 228, 228);
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const name = names[i];
      if (i % 2 === 0) {
        // vertical blade sign lettering
        const letters = name.replace(' ', '').slice(0, 6).split('');
        const fs = Math.min(40, 200 / letters.length);
        ctx.font = `800 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
        letters.forEach((ch, k) => ctx.fillText(ch, x + 128, y + 40 + k * (180 / letters.length) + fs / 2));
      } else {
        ctx.font = `italic 800 56px "Barlow Condensed", "Arial Narrow", sans-serif`;
        ctx.fillText(name, x + 128, y + 128, 220);
      }
      ctx.shadowBlur = 0;
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  _buildSigns() {
    const rng = this.rng;
    const atlas = this._signAtlas();
    const mat = new THREE.MeshStandardMaterial({
      map: atlas, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 1.2, roughness: 0.4, side: THREE.DoubleSide,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = u.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = (uv + aCell) * 0.25;\n#endif\n#ifdef USE_EMISSIVEMAP\nvEmissiveMapUv = (uv + aCell) * 0.25;\n#endif');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.6 + uNight * 1.6;');
    };
    const blades = [], boards = [], bills = [];
    for (const b of this.buildings) {
      if (b.y > this.baseY + 1) continue; // skip upper tiers
      if (b.style === 4) continue;
      // street-facing faces: pick the face closest to a street line
      const faces = [
        { nx: 1, nz: 0, px: b.x + b.w / 2, pz: b.z, len: b.d },
        { nx: -1, nz: 0, px: b.x - b.w / 2, pz: b.z, len: b.d },
        { nx: 0, nz: 1, px: b.x, pz: b.z + b.d / 2, len: b.w },
        { nx: 0, nz: -1, px: b.x, pz: b.z - b.d / 2, len: b.w },
      ];
      for (const f of faces) {
        if ((b.style === 3 || (b.style === 2 && rng() < 0.3)) && rng() < this.style.signs + 0.2) {
          if (rng() < 0.75) {
            const along = (rng() - 0.5) * f.len * 0.6;
            const px = f.px + f.nx * 0.9 + (f.nz !== 0 ? along : 0), pz = f.pz + f.nz * 0.9 + (f.nx !== 0 ? along : 0);
            blades.push({ x: px, z: pz, y: this.baseY + 6 + rng() * Math.max(0, Math.min(10, b.h - 10)), yaw: Math.atan2(f.nx, f.nz) + Math.PI / 2, cell: Math.floor(rng() * 8) * 2 });
          }
          if (rng() < 0.8) {
            const px = f.px + f.nx * 0.12, pz = f.pz + f.nz * 0.12;
            boards.push({ x: px, z: pz, y: this.baseY + 4.6, yaw: Math.atan2(f.nx, f.nz), w: Math.min(f.len * 0.7, 14), cell: Math.floor(rng() * 8) * 2 + 1 });
          }
        }
      }
      if (b.h > 60 && rng() < 0.35) {
        const f = faces[Math.floor(rng() * 4)];
        bills.push({ x: f.px + f.nx * 0.2, z: f.pz + f.nz * 0.2, y: this.baseY + b.h - 12, yaw: Math.atan2(f.nx, f.nz), w: Math.min(f.len * 0.8, 24), cell: Math.floor(rng() * 16) });
      }
    }
    const make = (list, w, h, dynamicW) => {
      if (!list.length) return;
      const g = new THREE.PlaneGeometry(1, 1);
      const cells = new Float32Array(list.length * 2);
      const mesh = new THREE.InstancedMesh(g, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      list.forEach((it, i) => {
        q.setFromAxisAngle(up, it.yaw);
        const sw = dynamicW ? it.w : w;
        mesh.setMatrixAt(i, m.compose(p.set(it.x, it.y, it.z), q, s.set(sw, dynamicW ? sw * (h / w) : h, 1)));
        cells[i * 2] = it.cell % 4;
        cells[i * 2 + 1] = 3 - Math.floor(it.cell / 4);
      });
      g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      this.instanceCount += list.length;
    };
    make(blades, 1.8, 6.5, false);
    make(boards, 8, 1.8, true);
    make(bills, 20, 9, true);
  }

  // -------------------------------------------------------- Street furniture
  _buildStreetFurniture() {
    const { xs, zs } = this.streetLines();
    const hs = this.sw / 2;
    const { minX, minZ, maxX, maxZ } = this.rect;
    const lamps = [];
    const lights = [];
    // lamps along both sides of each street, every 32 m, skipping intersections
    for (const x of xs) {
      for (let z = minZ + 20; z < maxZ - 10; z += 32) {
        if (zs.some((zz) => Math.abs(zz - z) < hs + 6)) continue;
        lamps.push({ x: x - hs - 0.8, z, yaw: Math.PI / 2 }, { x: x + hs + 0.8, z, yaw: -Math.PI / 2 });
      }
    }
    for (const z of zs) {
      for (let x = minX + 20; x < maxX - 10; x += 32) {
        if (xs.some((xx) => Math.abs(xx - x) < hs + 6)) continue;
        lamps.push({ x, z: z - hs - 0.8, yaw: 0 }, { x, z: z + hs + 0.8, yaw: Math.PI });
      }
    }
    for (const x of xs) for (const z of zs) {
      lights.push({ x: x - hs - 0.8, z: z - hs - 0.8, yaw: 0 }, { x: x + hs + 0.8, z: z + hs + 0.8, yaw: Math.PI });
    }
    // keep lamps inside the city footprint and off the park lawns
    const inside = (l) => l.x > minX - hs - 2 && l.x < maxX + hs + 2 && l.z > minZ - hs - 2 && l.z < maxZ + hs + 2;

    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.1, 0.14, 8, 8).translate(0, 4, 0),
      new THREE.BoxGeometry(0.1, 0.1, 2.4).translate(0, 7.9, 1.1),
    ]);
    const headGeo = new THREE.BoxGeometry(0.5, 0.14, 0.9).translate(0, 7.8, 2.2);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.5, metalness: 0.7 });
    this.lampMaterial = new THREE.MeshStandardMaterial({ color: 0xfff4dc, emissive: 0xffe2b0, emissiveIntensity: 0.3, roughness: 0.3 });
    const L = lamps.filter(inside);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, L.length);
    const heads = new THREE.InstancedMesh(headGeo, this.lampMaterial, L.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    L.forEach((l, i) => {
      q.setFromAxisAngle(up, l.yaw);
      m.compose(p.set(l.x, this.baseY + CURB_H, l.z), q, s);
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      this.physics.addStaticCylinder(p.set(l.x, this.baseY, l.z), 0.18, 4);
    });
    poles.castShadow = true;
    poles.computeBoundingSphere();
    heads.computeBoundingSphere();
    this.scene.add(poles, heads);
    this.lampPositions = L;

    // Traffic lights
    const tlGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.12, 6, 8).translate(0, 3, 0),
      new THREE.BoxGeometry(0.1, 0.1, 5).translate(0, 5.8, 2.4),
      new THREE.BoxGeometry(0.45, 1.2, 0.35).translate(0, 5.3, 4.6),
    ]);
    const tlMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.5 });
    const lensGeo = new THREE.CircleGeometry(0.13, 12);
    const T = lights.filter(inside);
    const tl = new THREE.InstancedMesh(tlGeo, tlMat, T.length);
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 2.2, toneMapped: true });
    const lens = new THREE.InstancedMesh(lensGeo, lensMat, T.length);
    const c = new THREE.Color();
    T.forEach((l, i) => {
      q.setFromAxisAngle(up, l.yaw);
      m.compose(p.set(l.x, this.baseY + CURB_H, l.z), q, s);
      tl.setMatrixAt(i, m);
      const state = i % 3;
      const lensOff = new THREE.Vector3(0, 5.3 + (state === 0 ? 0.35 : state === 1 ? 0 : -0.35), 4.6 - 0.18).applyQuaternion(q);
      const lq = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI));
      lens.setMatrixAt(i, new THREE.Matrix4().compose(p.set(l.x, this.baseY + CURB_H, l.z).add(lensOff), lq, s));
      lens.setColorAt(i, c.set(state === 0 ? '#ff2a1a' : state === 1 ? '#ffb000' : '#20ff70'));
      this.physics.addStaticCylinder(p.set(l.x, this.baseY, l.z), 0.16, 3);
    });
    tl.castShadow = true;
    tl.computeBoundingSphere();
    lens.computeBoundingSphere();
    this.scene.add(tl, lens);
    this.instanceCount += L.length + T.length;

    // Sidewalk trees (every 24 m on alternate streets) + park trees
    for (const b of this.blocks) {
      if (b.park) {
        for (let k = 0; k < 14; k++) {
          this.treeSpots.push({
            x: b.minX + SIDEWALK + 4 + this.rng() * (b.maxX - b.minX - SIDEWALK * 2 - 8),
            z: b.minZ + SIDEWALK + 4 + this.rng() * (b.maxZ - b.minZ - SIDEWALK * 2 - 8),
            type: this.rng() < 0.5 ? 'sakura' : 'broad',
          });
        }
        continue;
      }
      for (let x = b.minX + 12; x < b.maxX - 8; x += 24) {
        this.treeSpots.push({ x, z: b.minZ + 2.2, type: 'broad', small: true }, { x, z: b.maxZ - 2.2, type: 'broad', small: true });
      }
    }
  }

  /** Night factor 0..1 drives windows, signs and lamps. */
  setNight(n) {
    this.uniforms.uNight.value = n;
    if (this.lampMaterial) this.lampMaterial.emissiveIntensity = 0.3 + n * 4;
  }

  contains(x, z, margin = 0) {
    const r = this.rect;
    return x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin;
  }
}
