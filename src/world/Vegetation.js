import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, fbm } from './Noise.js';
import { TERRAIN_NOISE } from './Terrain.js';

/**
 * Vegetation.js
 * -------------
 *  - Trees: broadleaf, pine and sakura built from alpha-tested leaf cards with
 *    spherical "soft" normals (the classic foliage lighting trick), trunks and
 *    branches from one atlas → a single material. Instanced per 512 m chunk so
 *    frustum culling works across the 4 km map.
 *  - Grass: GPU-placed blades on a camera-following lattice; heights come
 *    from the terrain height texture, roads/city are masked out, blades sway
 *    in the wind and receive shadows.
 */

const CHUNK = 512;

export class Vegetation {
  constructor(scene, physics, terrain) {
    this.scene = scene;
    this.physics = physics;
    this.terrain = terrain;
    this.rng = mulberry32(8080);
    this.treePositions = []; // flat [x, z, type] for maps
    this.instanceCount = 0;
  }

  // ================================================================ Atlas
  _atlas() {
    const S = 1024, H = 512;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const rnd = mulberry32(55);
    const leafCluster = (ox, oy, palette, count, shape) => {
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * H * 0.44;
        const x = ox + H / 2 + Math.cos(a) * r, y = oy + H / 2 + Math.sin(a) * r * 0.92;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rnd() * Math.PI * 2);
        ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
        ctx.beginPath();
        if (shape === 'needle') {
          ctx.fillRect(-1.5, -18, 3, 36);
        } else if (shape === 'petal') {
          for (let k = 0; k < 5; k++) {
            ctx.rotate((Math.PI * 2) / 5);
            ctx.ellipse(0, -7, 4.5, 7.5, 0, 0, Math.PI * 2);
          }
          ctx.fill();
          ctx.fillStyle = '#ffe9a8';
          ctx.beginPath();
          ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
        } else {
          ctx.ellipse(0, 0, 6 + rnd() * 5, 12 + rnd() * 7, 0, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.restore();
      }
    };
    // twigs under the leaves
    const twigs = (ox, oy, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      for (let i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.moveTo(ox + H / 2, oy + H / 2);
        const a = rnd() * Math.PI * 2;
        ctx.lineTo(ox + H / 2 + Math.cos(a) * H * 0.4, oy + H / 2 + Math.sin(a) * H * 0.4);
        ctx.stroke();
      }
    };
    twigs(0, 0, '#3b2c1e');
    leafCluster(0, 0, ['#2f5a1c', '#3e6d22', '#4f7d2a', '#27491a', '#5d8a33'], 2600, 'leaf');
    twigs(H, 0, '#3b2a22');
    leafCluster(H, 0, ['#ffc1d6', '#ffb0cb', '#ffd6e4', '#f7a3c0', '#ffe3ee'], 2200, 'petal');
    leafCluster(0, H, ['#1f3d1e', '#29502a', '#1a3319', '#35602f'], 3200, 'needle');
    // bark
    ctx.fillStyle = '#4a3a2c';
    ctx.fillRect(H, H, H, H);
    for (let i = 0; i < 900; i++) {
      const v = 40 + rnd() * 50;
      ctx.fillStyle = `rgb(${v + 20},${v + 8},${v - 6})`;
      ctx.fillRect(H + rnd() * H, H + rnd() * H, 3 + rnd() * 5, 20 + rnd() * 50);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // =========================================================== Tree shapes
  /** Card quad centred at c, facing n, uv region [u0,v0,u1,v1], soft normal from crown centre. */
  _card(c, size, n, region, crown, out) {
    const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(up, n).normalize().multiplyScalar(size / 2);
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize().multiplyScalar(size / 2);
    const corners = [
      c.clone().sub(t1).sub(t2), c.clone().add(t1).sub(t2), c.clone().add(t1).add(t2), c.clone().sub(t1).add(t2),
    ];
    const [u0, v0, u1, v1] = region;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const base = out.pos.length / 3;
    corners.forEach((p, i) => {
      out.pos.push(p.x, p.y, p.z);
      const sn = p.clone().sub(crown).normalize();
      out.nrm.push(sn.x, sn.y * 0.8 + 0.2, sn.z);
      out.uv.push(uvs[i][0], uvs[i][1]);
    });
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  _trunk(h, r0, r1, out, lean = new THREE.Vector3()) {
    const g = new THREE.CylinderGeometry(r1, r0, h, 7, 3, true).translate(0, h / 2, 0);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / h;
      pos.setX(i, pos.getX(i) + lean.x * y * y);
      pos.setZ(i, pos.getZ(i) + lean.z * y * y);
    }
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + uv.getX(i) * 0.5, 0.0 + uv.getY(i) * 0.5);
    g.computeVertexNormals();
    out.push(g);
  }

  _fromCards(cards) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cards.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(cards.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(cards.uv, 2));
    g.setIndex(cards.idx);
    return g;
  }

  _broadleaf(region, height, crownR, cards = 34) {
    const rnd = this.rng;
    const parts = [];
    this._trunk(height * 0.55, 0.32, 0.18, parts);
    // branches
    for (let i = 0; i < 4; i++) {
      const b = new THREE.CylinderGeometry(0.06, 0.12, crownR * 1.1, 5, 1, true).translate(0, crownR * 0.55, 0);
      b.rotateZ(0.8 + rnd() * 0.3).rotateY((i / 4) * Math.PI * 2 + rnd());
      b.translate(0, height * 0.45, 0);
      const uv = b.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.5 + uv.getX(k) * 0.5, uv.getY(k) * 0.5);
      parts.push(b);
    }
    const crown = new THREE.Vector3(0, height * 0.68, 0);
    const c = { pos: [], nrm: [], uv: [], idx: [] };
    for (let i = 0; i < cards; i++) {
      const dir = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.35) * 0.9, rnd() - 0.5).normalize();
      const p = crown.clone().add(new THREE.Vector3(dir.x * crownR, dir.y * crownR * 0.75, dir.z * crownR).multiplyScalar(0.55 + rnd() * 0.45));
      const n = dir.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.2)).normalize();
      this._card(p, crownR * (0.95 + rnd() * 0.5), n, region, crown, c);
    }
    parts.push(this._fromCards(c));
    return mergeGeometries(parts.map((g) => g.index ? g : g));
  }

  _pine(height) {
    const rnd = this.rng;
    const parts = [];
    this._trunk(height, 0.28, 0.08, parts);
    const c = { pos: [], nrm: [], uv: [], idx: [] };
    const whorls = 8;
    const region = [0, 0, 0.5, 0.5];
    for (let w = 0; w < whorls; w++) {
      const t = w / (whorls - 1);
      const y = height * (0.22 + t * 0.74);
      const r = (1 - t) * 3.0 + 0.5;
      const crown = new THREE.Vector3(0, y + 0.8, 0);
      const count = 7 - Math.floor(t * 3);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rnd() * 0.6 + w;
        const dir = new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize();
        const p = new THREE.Vector3(Math.cos(a) * r * 0.55, y, Math.sin(a) * r * 0.55);
        const n = new THREE.Vector3(dir.x * 0.3, 1, dir.z * 0.3).normalize();
        this._card(p, r * 1.35, n, region, crown, c);
        const n2 = new THREE.Vector3(-Math.sin(a), 0.25, Math.cos(a)).normalize();
        this._card(p.clone().add(new THREE.Vector3(0, 0.3, 0)), r * 1.1, n2, region, crown, c);
      }
    }
    parts.push(this._fromCards(c));
    return mergeGeometries(parts);
  }

  // ============================================================== Build
  build({ avoid, extraSpots = [], festivalCenter }) {
    const atlas = this._atlas();
    const mat = new THREE.MeshStandardMaterial({
      map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
    });
    // gentle wind sway on foliage (vertex height weighted)
    this.windUniform = { value: 0 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = this.windUniform;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float sway = max(0.0, position.y - 2.0) * 0.012;
          vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
          transformed.x += sin(uWind * 1.3 + ip.x * 0.05 + position.y * 0.3) * sway;
          transformed.z += cos(uWind * 1.1 + ip.z * 0.05) * sway * 0.7;`);
      // keep the soft crown normals on both sides of the leaf cards
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace(/\bnormal \*= faceDirection;/g, ''));
    };
    this.material = mat;

    const types = {
      broad: [this._broadleaf([0, 0.5, 0.5, 1], 9, 3.6), this._broadleaf([0, 0.5, 0.5, 1], 7, 2.8, 26)],
      sakura: [this._broadleaf([0.5, 0.5, 1, 1], 7, 3.8, 38), this._broadleaf([0.5, 0.5, 1, 1], 6, 3.2, 30)],
      pine: [this._pine(14), this._pine(10)],
    };

    // ---- Placement
    const t = this.terrain;
    const rnd = this.rng;
    const spots = [];
    const step = 17;
    for (let z = -t.half + 40; z < t.half - 40; z += step) {
      for (let x = -t.half + 40; x < t.half - 40; x += step) {
        const px = x + (rnd() - 0.5) * step, pz = z + (rnd() - 0.5) * step;
        const forest = t.maskAt(px, pz, 2);
        const n = fbm(px / 180, pz / 180, 3) * 0.5 + 0.5;
        const density = Math.pow(forest, 1.6) * 0.75 + n * 0.12 - 0.12;
        if (rnd() > density) continue;
        if (t.maskAt(px, pz, 0) > 0.02 || t.maskAt(px, pz, 1) > 0.5) continue;
        if (avoid && avoid(px, pz)) continue;
        const y = t.heightAt(px, pz);
        if (y > t.uniforms.uSnowLine.value - 50) continue;
        const nrm = t.normalAt(px, pz, new THREE.Vector3());
        if (nrm.y < 0.8) continue;
        const dFest = Math.hypot(px - festivalCenter.x, pz - festivalCenter.z);
        let type;
        if (dFest < 650 && rnd() < 0.55) type = 'sakura';
        else if (y > 70 || rnd() < 0.35) type = 'pine';
        else type = rnd() < 0.08 ? 'sakura' : 'broad';
        spots.push({ x: px, z: pz, y, type, s: 0.75 + rnd() * 0.6, r: rnd() * Math.PI * 2, v: Math.floor(rnd() * 2) });
      }
    }
    for (const e of extraSpots) {
      spots.push({ x: e.x, z: e.z, y: t.heightAt(e.x, e.z) + (e.y ?? 0.18), type: e.type, s: e.small ? 0.6 : 0.8 + rnd() * 0.3, r: rnd() * Math.PI * 2, v: e.small ? 1 : 0 });
    }

    // ---- Chunked instancing
    const buckets = new Map();
    for (const s of spots) {
      const key = `${Math.floor((s.x + t.half) / CHUNK)}_${Math.floor((s.z + t.half) / CHUNK)}_${s.type}_${s.v}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(s);
      this.treePositions.push(s.x, s.z, s.type === 'sakura' ? 1 : s.type === 'pine' ? 2 : 0);
      this.physics.addStaticCylinder(new THREE.Vector3(s.x, s.y, s.z), (s.type === 'pine' ? 0.3 : 0.35) * s.s, 2.5);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (const [key, list] of buckets) {
      const [, , type, v] = key.split('_');
      const mesh = new THREE.InstancedMesh(types[type][Number(v)], mat, list.length);
      list.forEach((s, i) => {
        q.setFromAxisAngle(up, s.r);
        mesh.setMatrixAt(i, m.compose(p.set(s.x, s.y - 0.1, s.z), q, sc.setScalar(s.s)));
        col.setHSL(0, 0, 0.82 + rnd() * 0.3);
        mesh.setColorAt(i, col);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }
    this.instanceCount += spots.length;
    this.treeCount = spots.length;
  }

  // ================================================================ Grass
  buildGrass(count = 42000) {
    const t = this.terrain;
    const blade = new THREE.BufferGeometry();
    // 5-vertex tapered blade (3 triangles), y 0..1
    const bp = [-0.5, 0, 0, 0.5, 0, 0, -0.35, 0.5, 0, 0.35, 0.5, 0, 0, 1, 0];
    blade.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
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
      uWorld: { value: new THREE.Vector3(t.half, t.size, t.n1) },
      uRadius: { value: 70 },
      uSnow: { value: t.uniforms.uSnowLine.value },
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
          uniform vec3 uWorld;
          uniform float uRadius;
          uniform float uSnow;
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
            return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
          }`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal = vec3(0.0, 1.0, 0.0);`)
        .replace('#include <begin_vertex>', `
          float D = uRadius * 2.0;
          vec2 rel = mod(aOff.xy * D - uCam.xz, D) - uRadius;
          vec2 wp = uCam.xz + rel;
          float dist = length(rel);
          vec4 mk = texture2D(uMask, (wp + uWorld.x) / uWorld.y);
          float h0 = hAt(wp);
          float slope = abs(hAt(wp + vec2(2.0, 0.0)) - h0) + abs(hAt(wp + vec2(0.0, 2.0)) - h0);
          float keep = (1.0 - smoothstep(0.02, 0.2, mk.r)) * (1.0 - mk.g) * (1.0 - smoothstep(0.6, 1.2, slope))
                     * (1.0 - smoothstep(uSnow - 60.0, uSnow - 20.0, h0));
          float clump = tnoise(wp * 0.08);
          keep *= smoothstep(0.18, 0.4, clump + aOff.w * 0.2);
          float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius, dist);
          float hgt = (0.35 + aOff.z * 0.55 + clump * 0.35) * keep * fade;
          float ang = aOff.w * 6.2831;
          vec3 side = vec3(cos(ang), 0.0, sin(ang)) * 0.07;
          float y = position.y;
          vec3 transformed = vec3(wp.x, h0, wp.y) + side * position.x * 2.0;
          transformed.y += y * hgt;
          float w = sin(uTime * 1.8 + wp.x * 0.12 + wp.y * 0.09) * 0.5 + sin(uTime * 3.1 + wp.x * 0.4) * 0.2;
          transformed.xz += vec2(0.28, 0.18) * w * y * y * hgt;
          vTip = y;
          vGrassCol = mix(vec3(0.12, 0.22, 0.05), vec3(0.3, 0.38, 0.1), tfbm(wp * 0.0025));
          vGrassCol = mix(vGrassCol, vec3(0.42, 0.4, 0.2), smoothstep(0.55, 0.85, tfbm(wp * 0.03)) * 0.5);`)
        ;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTip;\nvarying vec3 vGrassCol;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= vGrassCol * (0.55 + 0.75 * vTip);`)
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

  update(dt, camera) {
    this.windUniform.value += dt;
    if (this.grass) {
      this.grassUniforms.uCam.value.copy(camera.position);
      this.grassUniforms.uTime.value += dt;
    }
  }

  setGrassDensity(level) {
    if (!this.grass) return;
    const n = { off: 0, low: 18000, high: 42000 }[level] ?? 42000;
    this.grass.visible = n > 0;
    this.grass.geometry.instanceCount = n;
  }
}
