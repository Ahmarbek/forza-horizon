import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';
import { CITY_RECT, CITY_STREET_STEP, CITY_STREET_WIDTH } from './Roads.js';

const STYLE_PRESETS = {
  downtown: { tall: 1, signs: 1, warehouses: 0 },
  tokyo: { tall: 1.15, signs: 1, warehouses: 0 },
  harbor: { tall: 0.12, signs: 0.45, warehouses: 1 },
};

/** Tokyo landmark spots (block centres). */
export const TOKYO_TOWER = { x: -2012.5, z: -612.5 };
export const SCRAMBLE = { x: -1950, z: -300 };
export const GINKGO_X = -1825;

/**
 * City.js
 * -------
 * Street-grid towns: Tokyo City (districts: Downtown, Dockyards, Industrial,
 * Suburbs; Tokyo Tower, a scramble crossing, Ginkgo Avenue) and Ito harbour.
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
    this.tokyo = !!opts.tokyo;
    this.clear = opts.clear ?? null;
    this.extras = []; // containers / tanks / chimneys (Tokyo)
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
    if (this.tokyo) {
      this._buildDocks();
      this._buildIndustry();
      this._buildTokyoTower();
      this._buildScramble();
    }
    return this;
  }

  /** Tokyo district at x,z. */
  districtAt(x, z) {
    const R = this.rect;
    if (!this.tokyo) return this.name;
    if (x < R.minX + 250) return 'Dockyards';
    if (z < R.minZ + 250) return 'Industrial';
    if (x > R.maxX - 300 || z > R.maxZ - 250) return 'Suburbs';
    if (Math.abs(x - GINKGO_X) < 20) return 'Ginkgo Avenue';
    if (Math.hypot(x - SCRAMBLE.x, z - SCRAMBLE.z) < 90) return 'Shibuya Crossing';
    return 'Downtown';
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
    if (this.tokyo) {
      for (const b of this.blocks) {
        const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
        if (Math.abs(cx - TOKYO_TOWER.x) < 5 && Math.abs(cz - TOKYO_TOWER.z) < 5) b.park = b.tower = true;
        if (Math.abs(cx + 1637.5) < 5 && Math.abs(cz + 987.5) < 5) b.park = true; // a green square in the south
        const d = this.districtAt(cx, cz);
        b.district = d === 'Ginkgo Avenue' || d === 'Shibuya Crossing' ? 'Downtown' : d;
      }
    }
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
    const center = this.tokyo ? { x: -2000, z: -560 } : { x: (this.rect.minX + this.rect.maxX) / 2, z: (this.rect.minZ + this.rect.maxZ) / 2 };
    const list = [];
    const split = (lot, depth, district = 'Downtown') => {
      const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
      const minLot = district === 'Suburbs' ? 16 : 34;
      if (depth > 0 && (w > minLot || d > minLot) && rng() < 0.85) {
        const alongX = w > d ? rng() < 0.8 : rng() < 0.2;
        const t = 0.35 + rng() * 0.3;
        if (alongX) {
          const m = lot.minX + w * t;
          split({ ...lot, maxX: m }, depth - 1, district);
          split({ ...lot, minX: m }, depth - 1, district);
        } else {
          const m = lot.minZ + d * t;
          split({ ...lot, maxZ: m }, depth - 1, district);
          split({ ...lot, minZ: m }, depth - 1, district);
        }
        return;
      }
      const cx = (lot.minX + lot.maxX) / 2, cz = (lot.minZ + lot.maxZ) / 2;
      // keep lots under the elevated expressways open
      if (this.clear && this.clear(cx, cz, Math.max(w, d) / 2 + 3)) { this.openLots.push(lot); return; }
      const dc = Math.hypot(cx - center.x, cz - center.z);
      const downtown = Math.exp(-(dc * dc) / (330 * 330)) * this.style.tall;
      const setback = 1 + rng() * 2.5;
      const bw = w - setback * 2, bd = d - setback * 2;
      if (bw < 6 || bd < 6) return;
      const y0 = this.baseY + CURB_H;
      if (district === 'Dockyards') {
        // container yards and big sheds by the water
        if (rng() < 0.6) { this.containerLots.push(lot); return; }
        list.push({ x: cx, z: cz, w: bw, d: bd, h: 10 + rng() * 8, style: 4, y: y0 });
        return;
      }
      if (district === 'Industrial') {
        if (rng() < 0.35) { this.tankLots.push(lot); return; }
        list.push({ x: cx, z: cz, w: bw, d: bd, h: 9 + rng() * 14, style: 4, y: y0 });
        return;
      }
      if (district === 'Suburbs') {
        // low houses and small apartment blocks with pitched roofs
        const h = rng() < 0.75 ? 6.2 + rng() * 2.4 : 9 + rng() * 6;
        list.push({ x: cx, z: cz, w: bw, d: bd, h, style: rng() < 0.65 ? 2 : 3, y: y0, roof: h < 9.5 });
        return;
      }
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
    this.openLots = [];
    this.containerLots = [];
    this.tankLots = [];
    for (const b of this.blocks) {
      if (b.park) continue;
      const d = b.district ?? 'Downtown';
      split({ minX: b.minX + SIDEWALK, maxX: b.maxX - SIDEWALK, minZ: b.minZ + SIDEWALK, maxZ: b.maxZ - SIDEWALK }, d === 'Suburbs' ? 3 : 2, d);
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
    const tops = list.filter((b) => b.w > 14 && b.d > 14 && !b.roof);
    const ac = new THREE.InstancedMesh(acGeo, acMat, tops.length);
    tops.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.floor(rng() * 4) * Math.PI / 2);
      ac.setMatrixAt(i, m.compose(p.set(b.x + (rng() - 0.5) * b.w * 0.4, b.y + b.h, b.z + (rng() - 0.5) * b.d * 0.4), q, s.set(1, 1, 1)));
    });
    ac.castShadow = true;
    ac.computeBoundingSphere();
    this.scene.add(ac);

    // pitched tile roofs on the low houses (gable prism, unit size → scaled)
    const roofed = list.filter((b) => b.roof);
    if (roofed.length) {
      const shape = new THREE.Shape();
      shape.moveTo(-0.56, 0); shape.lineTo(0, 0.42); shape.lineTo(0.56, 0); shape.lineTo(-0.56, 0);
      const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.08, bevelEnabled: false }).translate(0, 0, -0.54);
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.15 });
      const rm = new THREE.InstancedMesh(roofGeo, roofMat, roofed.length);
      const rc = new THREE.Color();
      roofed.forEach((b, i) => {
        const alongX = b.w > b.d;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), alongX ? Math.PI / 2 : 0);
        const span = alongX ? b.d : b.w, len = alongX ? b.w : b.d;
        rm.setMatrixAt(i, m.compose(p.set(b.x, b.y + b.h, b.z), q, s.set(span, Math.min(span, 9), len)));
        rm.setColorAt(i, rc.set(['#3b4148', '#4a3a36', '#2f3d4f', '#5a4a3a', '#6b2f2a'][Math.floor(rng() * 5)]));
      });
      rm.castShadow = true;
      rm.receiveShadow = true;
      rm.computeBoundingSphere();
      this.scene.add(rm);
      this.instanceCount += roofed.length;
    }
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
        if (b.tower) continue;
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
      // Ginkgo Avenue: a tight double row of golden ginkgos down both sidewalks
      if (this.tokyo && b.district === 'Downtown') {
        for (const edge of [b.minX, b.maxX]) {
          if (Math.abs(Math.abs(edge - GINKGO_X) - this.sw / 2) > 1) continue;
          const x = edge + (edge < GINKGO_X ? -2.2 : 2.2);
          for (let z = b.minZ + 6; z < b.maxZ - 4; z += 10) this.treeSpots.push({ x, z, type: 'ginkgo' });
        }
      }
    }
  }

  // --------------------------------------------------------------- Dockyards
  _buildDocks() {
    const rng = this.rng;
    const boxes = [];
    // container stacks in rows on the yard lots
    for (const lot of this.containerLots) {
      const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
      const alongX = w > d;
      const L = 12.2, W = 2.44, H = 2.59;
      const rows = Math.floor((alongX ? d : w) / (W + 0.6));
      const cols = Math.floor((alongX ? w : d) / (L + 1.5));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (rng() < 0.18) continue;
        const stack = 1 + Math.floor(rng() * 4);
        for (let k = 0; k < stack; k++) {
          const a = (alongX ? lot.minX : lot.minZ) + 1 + c * (L + 1.5) + L / 2;
          const b = (alongX ? lot.minZ : lot.minX) + 0.5 + r * (W + 0.6) + W / 2;
          boxes.push({ x: alongX ? a : b, z: alongX ? b : a, y: this.baseY + CURB_H + k * H, yaw: alongX ? 0 : Math.PI / 2, h: stack * H });
        }
      }
    }
    const geo = new THREE.BoxGeometry(2.44, 2.59, 12.2).translate(0, 1.295, 0);
    // corrugated side texture
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 64; x++) { const v = 200 + 55 * Math.sin(x * 0.8); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 16); }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.35 });
    const im = new THREE.InstancedMesh(geo, mat, boxes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const pal = ['#b6402b', '#2b5d9c', '#d8a426', '#3d7d4a', '#8a8f96', '#c95a1c', '#1f4f7a', '#e0e0dc', '#6b2d5c'];
    boxes.forEach((b, i) => {
      q.setFromAxisAngle(up, b.yaw);
      im.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, sc));
      im.setColorAt(i, col.set(pal[Math.floor(rng() * pal.length)]));
      if (b.y < this.baseY + 1) this.physics.addStaticBox(p.set(b.x, b.y + b.h / 2, b.z), new THREE.Vector3(1.22, b.h / 2, 6.1), b.yaw);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    this.scene.add(im);
    this.instanceCount += boxes.length;

    // ship-to-shore gantry cranes along the quay, booms out over the water
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xd0442c, roughness: 0.55, metalness: 0.4 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.6, metalness: 0.3 });
    const legs = [], booms = [];
    const x0 = this.rect.minX - 72; // on the quay, between the dock strip and the water
    for (let z = this.rect.minZ + 120; z < this.rect.maxZ - 60; z += 230) {
      for (const [dx, dz] of [[-9, -8], [-9, 8], [9, -8], [9, 8]]) legs.push(new THREE.BoxGeometry(1.4, 38, 1.4).translate(x0 + dx, 19, z + dz));
      legs.push(new THREE.BoxGeometry(20, 1.6, 1.6).translate(x0, 20, z - 8), new THREE.BoxGeometry(20, 1.6, 1.6).translate(x0, 20, z + 8));
      booms.push(new THREE.BoxGeometry(95, 3, 3).translate(x0 - 30, 40, z - 5), new THREE.BoxGeometry(95, 3, 3).translate(x0 - 30, 40, z + 5));
      booms.push(new THREE.BoxGeometry(8, 7, 14).translate(x0 + 12, 43, z));
      booms.push(new THREE.CylinderGeometry(0.25, 0.25, 22, 5).translate(x0 - 55, 29, z));
      booms.push(new THREE.BoxGeometry(12, 2.6, 2.44).translate(x0 - 55, 17, z));
      for (const [dx, dz] of [[-9, -8], [-9, 8], [9, -8], [9, 8]]) this.physics.addStaticBox(p.set(x0 + dx, 19, z + dz), new THREE.Vector3(0.7, 19, 0.7), 0);
    }
    const lm = new THREE.Mesh(mergeGeometries(legs), craneMat);
    const bm = new THREE.Mesh(mergeGeometries(booms), whiteMat);
    for (const mm of [lm, bm]) { mm.castShadow = true; mm.receiveShadow = true; this.scene.add(mm); }
    // concrete quay edge along the water
    const quay = new THREE.Mesh(new THREE.BoxGeometry(6, 7, this.rect.maxZ - this.rect.minZ + 120), new THREE.MeshStandardMaterial({ color: 0x8f8c86, roughness: 0.9 }));
    quay.position.set(this.rect.minX - 103, this.baseY - 3.45, (this.rect.minZ + this.rect.maxZ) / 2);
    quay.receiveShadow = true;
    this.scene.add(quay);
    this.physics.addStaticBox(quay.position.clone().setY(this.baseY - 2.4), new THREE.Vector3(3, 3.5, (this.rect.maxZ - this.rect.minZ + 120) / 2), 0);
  }

  // --------------------------------------------------------------- Industry
  _buildIndustry() {
    const rng = this.rng;
    const tanks = [], chimneys = [];
    for (const lot of this.tankLots) {
      const w = lot.maxX - lot.minX, d = lot.maxZ - lot.minZ;
      const r = Math.min(w, d) / 4.6;
      if (r < 3) continue;
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        if (rng() < 0.2) continue;
        tanks.push({ x: lot.minX + w * (0.27 + i * 0.46), z: lot.minZ + d * (0.27 + j * 0.46), r: r * (0.8 + rng() * 0.2), h: 8 + rng() * 10 });
      }
    }
    for (const b of this.buildings) {
      if (b.style === 4 && b.z < this.rect.minZ + 250 && rng() < 0.3) chimneys.push({ x: b.x + b.w * 0.3, z: b.z + b.d * 0.3, h: 35 + rng() * 40, y: b.y });
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const tankGeo = mergeGeometries([
      new THREE.CylinderGeometry(1, 1, 1, 24).translate(0, 0.5, 0),
      new THREE.SphereGeometry(1, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.18, 1).translate(0, 1, 0),
    ]);
    const tm = new THREE.InstancedMesh(tankGeo, new THREE.MeshStandardMaterial({ color: 0xdfe2e4, roughness: 0.5, metalness: 0.5 }), tanks.length);
    tanks.forEach((t, i) => {
      tm.setMatrixAt(i, m.compose(p.set(t.x, this.baseY + CURB_H, t.z), q, sc.set(t.r, t.h, t.r)));
      this.physics.addStaticCylinder(p.set(t.x, this.baseY, t.z), t.r, t.h / 2);
    });
    // red-and-white chimneys with a stripe texture
    const c = document.createElement('canvas');
    c.width = 4; c.height = 64;
    const ctx = c.getContext('2d');
    for (let k = 0; k < 8; k++) { ctx.fillStyle = k % 2 ? '#f2f2ee' : '#c8321e'; ctx.fillRect(0, k * 8, 4, 8); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const cm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.75, 1.1, 1, 12, 1, true).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide }), chimneys.length);
    chimneys.forEach((ch, i) => cm.setMatrixAt(i, m.compose(p.set(ch.x, ch.y, ch.z), q, sc.set(1.6, ch.h, 1.6))));
    for (const im of [tm, cm]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); this.scene.add(im); }
    this.instanceCount += tanks.length + chimneys.length;
  }

  // ------------------------------------------------------------ Tokyo Tower
  _buildTokyoTower() {
    const { x, z } = TOKYO_TOWER;
    const y0 = this.baseY + CURB_H;
    const H = 170;
    const orange = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.5, metalness: 0.3, emissive: 0xff5a1f, emissiveIntensity: 0 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.55, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 });
    this.towerMats = [orange, white];
    const half = (t) => 21 * Math.pow(1 - t, 1.6) + 1.2; // half-width of the lattice at height fraction t
    const og = [], wg = [];
    const band = (t) => Math.floor(t * 9) % 2 === 1;
    // four corner legs, built from short straight pieces following the taper
    const N = 36;
    for (let k = 0; k < N; k++) {
      const t0 = k / N, t1 = (k + 1) / N;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = new THREE.Vector3(sx * half(t0), t0 * H, sz * half(t0));
        const b = new THREE.Vector3(sx * half(t1), t1 * H, sz * half(t1));
        const len = a.distanceTo(b);
        const g = new THREE.BoxGeometry(1.1 * (1 - t0 * 0.6), len, 1.1 * (1 - t0 * 0.6));
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const dir = b.clone().sub(a).normalize();
        const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        g.applyQuaternion(qq).translate(mid.x, mid.y, mid.z);
        (band((t0 + t1) / 2) ? wg : og).push(g);
      }
      // horizontal ring + X bracing on each face every other segment
      if (k % 2 === 0) {
        const hw = half(t0), y = t0 * H;
        for (const [ax, az, rot] of [[0, hw, 0], [0, -hw, 0], [hw, 0, Math.PI / 2], [-hw, 0, Math.PI / 2]]) {
          const g = new THREE.BoxGeometry(hw * 2, 0.45, 0.45).rotateY(rot).translate(ax, y, az);
          (band(t0) ? wg : og).push(g);
          const hw1 = half(t0 + 2 / N), y1 = (t0 + 2 / N) * H;
          for (const s2 of [-1, 1]) {
            const p0 = rot ? new THREE.Vector3(ax, y, -hw * s2) : new THREE.Vector3(-hw * s2, y, az);
            const p1 = rot ? new THREE.Vector3(Math.sign(ax) * hw1, y1, hw1 * s2) : new THREE.Vector3(hw1 * s2, y1, Math.sign(az) * hw1);
            const len = p0.distanceTo(p1);
            const g2 = new THREE.BoxGeometry(0.3, len, 0.3);
            g2.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize()));
            const mid = p0.clone().add(p1).multiplyScalar(0.5);
            g2.translate(mid.x, mid.y, mid.z);
            (band(t0) ? wg : og).push(g2);
          }
        }
      }
    }
    // an inset solid core in the same bands, so the tower reads as a spire from across the city
    // (the lattice members alone go sub-pixel beyond a few hundred metres)
    for (let k = 0; k < 18; k++) {
      const t0 = 0.12 + (k / 18) * 0.86, t1 = 0.12 + ((k + 1) / 18) * 0.86;
      const g = new THREE.CylinderGeometry(half(t1) * 0.72 * Math.SQRT2, half(t0) * 0.72 * Math.SQRT2, (t1 - t0) * H, 4, 1)
        .rotateY(Math.PI / 4).translate(0, ((t0 + t1) / 2) * H, 0);
      (band((t0 + t1) / 2) ? wg : og).push(g);
    }
    // arches between the legs at the base, the two observation decks, antenna
    for (const rot of [0, Math.PI / 2]) {
      const arch = new THREE.TorusGeometry(14, 0.8, 6, 20, Math.PI).rotateY(rot).translate(0, 4, 0);
      for (const off of [-1, 1]) og.push(arch.clone().translate(rot ? off * half(0.08) : 0, 0, rot ? 0 : off * half(0.08)));
    }
    const deck1 = new THREE.CylinderGeometry(half(0.44) + 3, half(0.44) + 2, 7, 8).rotateY(Math.PI / 8).translate(0, 0.44 * H + 3.5, 0);
    const deck2 = new THREE.CylinderGeometry(half(0.72) + 2, half(0.72) + 1.5, 4.5, 8).rotateY(Math.PI / 8).translate(0, 0.72 * H + 2.2, 0);
    wg.push(deck1, deck2);
    og.push(new THREE.CylinderGeometry(0.45, 0.9, 42, 8).translate(0, H + 21, 0));
    wg.push(new THREE.CylinderGeometry(1.2, 1.2, 5, 8).translate(0, H + 8, 0));
    const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0 });
    this.towerMats.push(glass);
    const win1 = new THREE.CylinderGeometry(half(0.44) + 3.1, half(0.44) + 3.1, 3, 8, 1, true).rotateY(Math.PI / 8).translate(0, 0.44 * H + 4, 0);
    const og2 = mergeGeometries(og.map((g) => g.index ? g.toNonIndexed() : g));
    const wg2 = mergeGeometries(wg.map((g) => g.index ? g.toNonIndexed() : g));
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(og2, orange), new THREE.Mesh(wg2, white), new THREE.Mesh(win1, glass));
    grp.position.set(x, y0, z);
    grp.rotation.y = 0.2;
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(grp);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const lx = sx * half(0.02), lz = sz * half(0.02);
      const c = Math.cos(0.2), sn = Math.sin(0.2);
      this.physics.addStaticBox(new THREE.Vector3(x + lx * c + lz * sn, y0 + 6, z - lx * sn + lz * c), new THREE.Vector3(2, 6, 2), 0.2);
    }
    this.landmarkTower = grp;
  }

  // -------------------------------------------------------- Scramble crossing
  _buildScramble() {
    const { x, z } = SCRAMBLE;
    const hs = this.sw / 2;
    // diagonal zebra bands across the intersection
    const stripes = [];
    for (const dir of [1, -1]) {
      const len = Math.hypot(this.sw, this.sw) - 4;
      for (let k = -len / 2; k < len / 2; k += 1.6) {
        const g = new THREE.PlaneGeometry(0.8, 4).rotateX(-Math.PI / 2).translate(k, 0, 0).rotateY(dir * Math.PI / 4);
        stripes.push(g.translate(x, this.baseY + 0.08, z));
      }
    }
    const zm = new THREE.Mesh(mergeGeometries(stripes), new THREE.MeshStandardMaterial({
      color: 0xf0f0e8, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    zm.receiveShadow = true;
    this.scene.add(zm);
    // giant video screens on the corner buildings, facing the crossing
    const screen = this._screenTexture();
    this.screenTex = screen;
    const mat = new THREE.MeshStandardMaterial({ map: screen, emissive: 0xffffff, emissiveMap: screen, emissiveIntensity: 1.3, roughness: 0.3 });
    this.screenMat = mat;
    const around = this.buildings.filter((b) => b.y < this.baseY + 1 && Math.abs(b.x - x) < 90 && Math.abs(b.z - z) < 90 && b.h > 16);
    let made = 0;
    for (const [qx, qz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cands = around.filter((b) => Math.sign(b.x - x) === qx && Math.sign(b.z - z) === qz);
      if (!cands.length) continue;
      const b = cands.reduce((a, c) => (Math.hypot(a.x - x, a.z - z) < Math.hypot(c.x - x, c.z - z) ? a : c));
      // the face pointing at the crossing along the longer street view
      const faceX = Math.abs(b.x - x) > Math.abs(b.z - z);
      const nx = faceX ? -qx : 0, nz = faceX ? 0 : -qz;
      const fw = faceX ? b.d : b.w;
      const w = Math.min(fw * 0.85, 26), h = Math.min(b.h - 8, w * 0.6);
      const g = new THREE.PlaneGeometry(w, h);
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(b.x + nx * (b.w / 2 + 0.3), this.baseY + 8 + h / 2, b.z + nz * (b.d / 2 + 0.3));
      mesh.rotation.y = Math.atan2(nx, nz);
      // offset each screen's content
      const uvs = g.attributes.uv;
      for (let i = 0; i < uvs.count; i++) uvs.setX(i, uvs.getX(i) * 0.25 + made * 0.25);
      this.scene.add(mesh);
      made++;
    }
  }

  /** A strip of four bright "adverts"; scrolled over time to fake video. */
  _screenTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const ctx = c.getContext('2d');
    const ads = [
      ['#ff2d8f', '#2de2ff', 'HORIZON', 'JAPAN'], ['#ffd23f', '#1b1d22', 'DRIFT', 'KINGS'],
      ['#2de2ff', '#ff2d8f', 'RAMEN', '24H'], ['#b6ff3b', '#1b1d22', 'SAKURA', 'FEST'],
    ];
    ads.forEach(([bg, fg, a, b], i) => {
      const x = i * 256;
      const g = ctx.createLinearGradient(x, 0, x + 256, 256);
      g.addColorStop(0, bg); g.addColorStop(1, '#101018');
      ctx.fillStyle = g; ctx.fillRect(x, 0, 256, 256);
      ctx.fillStyle = fg;
      for (let k = 0; k < 6; k++) { ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(x + 40 + k * 40, 200 - k * 18, 30 + k * 6, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.font = 'italic 800 64px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillText(a, x + 128, 110, 230);
      ctx.font = '800 40px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillText(b, x + 128, 165, 230);
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }

  /** Animate the video screens. */
  update(dt) {
    if (!this.screenTex) return;
    this._st = (this._st || 0) + dt;
    // hold each advert for a few seconds, then slide to the next
    const k = this._st / 4;
    const f = k - Math.floor(k);
    this.screenTex.offset.x = (Math.floor(k) + Math.min(1, f * 6) ) * 0.25;
    this.screenMat.emissiveIntensity = (1.1 + 0.2 * Math.sin(this._st * 7)) * (0.7 + (this._night || 0) * 1.2);
  }

  /** Night factor 0..1 drives windows, signs and lamps. */
  setNight(n) {
    this.uniforms.uNight.value = n;
    this._night = n;
    if (this.lampMaterial) this.lampMaterial.emissiveIntensity = 0.3 + n * 4;
    if (this.towerMats) {
      // Tokyo Tower lights up orange at night
      this.towerMats[0].emissiveIntensity = n * 0.9;
      this.towerMats[1].emissiveIntensity = n * 0.35;
      this.towerMats[2].emissiveIntensity = n * 1.5;
    }
  }

  contains(x, z, margin = 0) {
    const r = this.rect;
    return x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin;
  }
}
