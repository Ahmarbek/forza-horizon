import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createSkyMaterial,
  createGroundMaterial,
  createPetalMaterial,
} from './Shaders.js';

/**
 * Environment.js
 * --------------
 * Procedural world: ground, Festival Loop track (spline ribbon with procedural
 * asphalt maps), start gantry, instanced roadside objects (pines, sakura,
 * street lights, barriers), dynamic cones, distant mountains, sky and lighting.
 */

export const ROAD_WIDTH = 14;
const TRACK_SAMPLES = 720;
const PLAZA = { minX: -45, maxX: 45, minZ: -110, maxZ: -10 };

// Festival Loop control points (x, z) — a closed, flowing circuit.
const TRACK_POINTS = [
  [0, -170], [0, 40], [30, 170], [120, 250], [250, 240], [330, 150], [300, 40],
  [340, -60], [440, -120], [460, -250], [370, -340], [230, -330], [150, -250],
  [60, -300], [-10, -260],
];

/** Small deterministic RNG so the world is identical every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of a position (so duplicated vertices jitter identically). */
function hash3(x, y, z) {
  const k = Math.sin(Math.round(x * 10) * 12.9898 + Math.round(y * 10) * 78.233 + Math.round(z * 10) * 37.719) * 43758.5453;
  return k - Math.floor(k);
}

// Scratch
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

export class Environment {
  constructor(scene, physics, renderer) {
    this.scene = scene;
    this.physics = physics;
    this.renderer = renderer;
    this.rng = mulberry32(1337);
    this.time = 0;

    this.trackSamples = []; // Vector3 centre-line
    this.trackTangents = [];
    this.trackPoints2D = null; // Float32Array [x0,z0,x1,z1,...] for maps
    this.treePositions = []; // [x,z,type] for world map
    this.cones = []; // { body, mesh index, home }
    this.coneMesh = null;
    this.bounds = { minX: -600, maxX: 800, minZ: -700, maxZ: 600 };
    this.mapBounds = { minX: -320, maxX: 520, minZ: -420, maxZ: 320 };

    this.startPosition = new THREE.Vector3(0, 1.2, -75);
    this.startYaw = 0; // facing +Z along the start straight

    this.instanceCount = 0;
  }

  build() {
    this._buildLights();
    this._buildSky();
    this._buildGround();
    this._buildTrack();
    this._buildPlaza();
    this._buildGantry();
    this._buildMountains();
    this._buildRamps();
    this._buildTrees();
    this._buildStreetLights();
    this._buildBarriers();
    this._buildCones();
    this._buildPetals();
    this._buildRaceFurniture();
    this._buildStunts();
    this.setTimeOfDay(38);
    return this;
  }

  // ---------------------------------------------------------------- Lights
  _buildLights() {
    const sun = new THREE.DirectionalLight(0xffffff, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
    sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.sunDir = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a5a3a, 1.1);
    this.scene.add(this.hemi);

    this.scene.fog = new THREE.FogExp2(0xbfd9f2, 0.00055);
  }

  setShadowQuality(size) {
    const enabled = size > 0;
    this.renderer.shadowMap.enabled = enabled;
    this.sun.castShadow = enabled;
    if (enabled) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    // Materials must recompile when the shadow map toggles.
    this.scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => (m.needsUpdate = true));
      }
    });
  }

  /** elevationDeg: 4 (sunset) … 60 (high noon) */
  setTimeOfDay(elevationDeg) {
    this.elevation = elevationDeg;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(-35);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    const day = THREE.MathUtils.smoothstep(elevationDeg, 5, 35);
    const sunset = 1 - day;

    const sunColor = new THREE.Color('#ff9a52').lerp(new THREE.Color('#fff4e0'), day);
    this.sun.color.copy(sunColor);
    this.sun.intensity = THREE.MathUtils.lerp(1.8, 3.4, day);
    this.hemi.intensity = THREE.MathUtils.lerp(0.55, 1.15, day);
    this.hemi.color.set('#ffc9a8').lerp(new THREE.Color('#bfd9ff'), day);

    const u = this.sky.material.uniforms;
    u.uSunDir.value.copy(this.sunDir);
    u.uZenith.value.set('#35507f').lerp(new THREE.Color('#2a6ad8'), day);
    u.uHorizon.value.set('#ffb58a').lerp(new THREE.Color('#c4dcf2'), day);
    u.uSunColor.value.copy(sunColor);
    u.uSunset.value = sunset;
    u.uGround.value.copy(u.uHorizon.value).multiplyScalar(0.7);

    this.scene.fog.color.copy(u.uHorizon.value);

    if (this.lampMaterial) this.lampMaterial.emissiveIntensity = THREE.MathUtils.lerp(8, 0.4, day);
  }

  // ------------------------------------------------------------------- Sky
  _buildSky() {
    const geo = new THREE.SphereGeometry(4000, 48, 24);
    this.sky = new THREE.Mesh(geo, createSkyMaterial());
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  // ---------------------------------------------------------------- Ground
  _buildGround() {
    const geo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(geo, createGroundMaterial());
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.physics.createGround(3000);
  }

  // ----------------------------------------------------------------- Track
  _buildTrack() {
    const pts = TRACK_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.curve = curve;
    this.trackLength = curve.getLength();

    const spaced = curve.getSpacedPoints(TRACK_SAMPLES);
    spaced.pop(); // closed: last == first
    this.trackSamples = spaced;
    this.trackPoints2D = new Float32Array(spaced.length * 2);
    for (let i = 0; i < spaced.length; i++) {
      const t = i / spaced.length;
      this.trackTangents.push(curve.getTangentAt(t).setY(0).normalize());
      this.trackPoints2D[i * 2] = spaced[i].x;
      this.trackPoints2D[i * 2 + 1] = spaced[i].z;
    }

    const maps = createAsphaltMaps(this.renderer);
    this.asphaltMaps = maps;

    const roadMat = new THREE.MeshStandardMaterial({
      map: maps.color,
      roughnessMap: maps.roughness,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const road = new THREE.Mesh(
      this._ribbon(-ROAD_WIDTH / 2, ROAD_WIDTH / 2, 0.02, ROAD_WIDTH),
      roadMat
    );
    road.receiveShadow = true;
    this.scene.add(road);

    // Curbs (red/white rumble strips) on both edges
    const curbTex = createCurbTexture();
    const curbMat = new THREE.MeshStandardMaterial({
      map: curbTex,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const hw = ROAD_WIDTH / 2;
    const curbs = mergeGeometries([
      this._ribbon(-hw - 1.1, -hw, 0.03, 2.2),
      this._ribbon(hw, hw + 1.1, 0.03, 2.2),
    ]);
    const curbMesh = new THREE.Mesh(curbs, curbMat);
    curbMesh.receiveShadow = true;
    this.scene.add(curbMesh);
  }

  /** Build a flat ribbon between lateral offsets a..b along the track. */
  _ribbon(a, b, y, vRepeat) {
    const n = this.trackSamples.length;
    const positions = new Float32Array((n + 1) * 2 * 3);
    const normals = new Float32Array((n + 1) * 2 * 3);
    const uvs = new Float32Array((n + 1) * 2 * 2);
    const indices = [];
    const side = new THREE.Vector3();
    let dist = 0;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = this.trackSamples[k];
      const t = this.trackTangents[k];
      if (i > 0) dist += p.distanceTo(this.trackSamples[(i - 1) % n]);
      side.crossVectors(_up, t).normalize(); // left-hand side
      const o = i * 6;
      positions[o] = p.x + side.x * a; positions[o + 1] = y; positions[o + 2] = p.z + side.z * a;
      positions[o + 3] = p.x + side.x * b; positions[o + 4] = y; positions[o + 5] = p.z + side.z * b;
      normals[o + 1] = 1; normals[o + 4] = 1;
      const v = dist / vRepeat;
      uvs[i * 4] = 0; uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = v;
      if (i < n) {
        const q = i * 2;
        indices.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(indices);
    // Fix winding so faces point up
    g.computeVertexNormals();
    const nrm = g.attributes.normal;
    if (nrm.getY(0) < 0) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i += 3) { const tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp; }
      g.computeVertexNormals();
    }
    return g;
  }

  /** Distance from (x,z) to the track centre-line (coarse). */
  distanceToTrack(x, z) {
    let best = Infinity;
    const s = this.trackPoints2D;
    for (let i = 0; i < s.length; i += 4) {
      const dx = s[i] - x, dz = s[i + 1] - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** Areas kept free of trees (ramp run-ups and landings). */
  inClearZone(x, z) {
    for (const c of this.clearZones) {
      const dx = x - c.x, dz = z - c.z;
      const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz;
      if (Math.abs(lx) < c.hw && lz > c.z0 && lz < c.z1) return true;
    }
    return false;
  }

  /** Nearest track sample index; searches around `hint` when given. */
  nearestIndex(x, z, hint = -1, window = 40) {
    const s = this.trackPoints2D;
    const n = s.length / 2;
    let best = 0, bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const dx = s[i * 2] - x, dz = s[i * 2 + 1] - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    for (let k = -window; k <= window; k++) {
      const i = (hint + k + n) % n;
      const dx = s[i * 2] - x, dz = s[i * 2 + 1] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    // Far from the hinted section (e.g. after a reset): do a full search.
    return bestD > 900 ? this.nearestIndex(x, z, -1) : best;
  }

  /** Point on the track at sample `index` offset `lateral` metres to the left. */
  trackPoint(index, lateral, out) {
    const n = this.trackSamples.length;
    const i = ((Math.round(index) % n) + n) % n;
    const p = this.trackSamples[i], t = this.trackTangents[i];
    return out.set(p.x + t.z * lateral, 0, p.z - t.x * lateral);
  }

  trackYaw(index) {
    const n = this.trackSamples.length;
    const t = this.trackTangents[((Math.round(index) % n) + n) % n];
    return Math.atan2(t.x, t.z);
  }

  inPlaza(x, z, margin = 0) {
    return x > PLAZA.minX - margin && x < PLAZA.maxX + margin && z > PLAZA.minZ - margin && z < PLAZA.maxZ + margin;
  }

  // ----------------------------------------------------------------- Plaza
  _buildPlaza() {
    const w = PLAZA.maxX - PLAZA.minX, d = PLAZA.maxZ - PLAZA.minZ;
    const tex = this.asphaltMaps.plain.clone();
    tex.needsUpdate = true;
    tex.repeat.set(w / 12, d / 12);
    const rough = this.asphaltMaps.roughness.clone();
    rough.repeat.copy(tex.repeat);
    rough.needsUpdate = true;
    const normal = this.asphaltMaps.normal.clone();
    normal.repeat.copy(tex.repeat);
    normal.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughnessMap: rough,
      normalMap: normal,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const plaza = new THREE.Mesh(geo, mat);
    plaza.position.set((PLAZA.minX + PLAZA.maxX) / 2, 0.012, (PLAZA.minZ + PLAZA.maxZ) / 2);
    plaza.receiveShadow = true;
    this.scene.add(plaza);

    // Painted grid boxes
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.75 });
    const lines = [];
    for (let i = -2; i <= 2; i++) {
      const g = new THREE.PlaneGeometry(0.25, 7);
      g.rotateX(-Math.PI / 2);
      g.translate(i * 4.5, 0.025, -80);
      if (i !== 0) lines.push(g);
    }
    const bar = new THREE.PlaneGeometry(22, 0.5);
    bar.rotateX(-Math.PI / 2);
    bar.translate(0, 0.025, -71);
    lines.push(bar);
    this.scene.add(new THREE.Mesh(mergeGeometries(lines), lineMat));
  }

  // ---------------------------------------------------------------- Gantry
  _buildGantry() {
    const group = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2e36, roughness: 0.45, metalness: 0.7 });
    const pillarGeo = new THREE.BoxGeometry(1.2, 9, 1.2);
    const beamGeo = new THREE.BoxGeometry(ROAD_WIDTH + 6, 1.4, 1.4);
    const z = -30;
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(pillarGeo, steel);
      p.position.set(sx * (ROAD_WIDTH / 2 + 2.5), 4.5, z);
      p.castShadow = true;
      group.add(p);
      this.physics.addStaticBox(p.position, new THREE.Vector3(0.6, 4.5, 0.6), 0);
    }
    const beam = new THREE.Mesh(beamGeo, steel);
    beam.position.set(0, 9, z);
    beam.castShadow = true;
    group.add(beam);

    // Neon sign
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createLinearGradient(0, 0, 1024, 0);
    grd.addColorStop(0, '#ff2d8f'); grd.addColorStop(1, '#ff8a2d');
    const drawSign = () => {
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 1024, 128);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Shrink the font until the label fits (fallback fonts are wider)
      let size = 88;
      do {
        ctx.font = `italic 800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
        size -= 4;
      } while (ctx.measureText('HORIZON SAKURA FESTIVAL').width > 960 && size > 30);
      ctx.fillText('HORIZON SAKURA FESTIVAL', 512, 68);
    };
    drawSign();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const signMat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.3, roughness: 0.5,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH + 4, (ROAD_WIDTH + 4) / 8), signMat);
    sign.position.set(0, 9, z - 0.72);
    sign.rotation.y = Math.PI;
    const sign2 = sign.clone();
    sign2.position.z = z + 0.72;
    sign2.rotation.y = 0;
    group.add(sign, sign2);
    this.scene.add(group);
    // The sign uses a web font that may still be loading; redraw once ready.
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        drawSign();
        tex.needsUpdate = true;
      });
    }
  }

  // ------------------------------------------------------------- Mountains
  _buildMountains() {
    const geos = [];
    const rng = this.rng;
    const snow = new THREE.Color('#f4f7ff');
    const rock = new THREE.Color('#4d5a6e');
    const forest = new THREE.Color('#2e4a36');

    const colorize = (g, height, snowLine) => {
      const pos = g.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const h = pos.getY(i) / height;
        if (h > snowLine + (rng() - 0.5) * 0.08) c.copy(snow);
        else c.copy(forest).lerp(rock, THREE.MathUtils.smoothstep(h, 0.1, snowLine));
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      return g;
    };

    // "Fuji": concave lathe profile
    const profile = [];
    const H = 720, R = 1300;
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const r = R * Math.pow(1 - t, 1.8) + 70 * (1 - t) + 60;
      profile.push(new THREE.Vector2(i === 24 ? 55 : r, t * H));
    }
    profile.push(new THREE.Vector2(0, H - 12));
    const fuji = new THREE.LatheGeometry(profile, 64).toNonIndexed();
    const fp = fuji.attributes.position;
    for (let i = 0; i < fp.count; i++) {
      const y = fp.getY(i);
      // position-hashed jitter: shared vertices move together (no cracks)
      const n = 1 + (hash3(fp.getX(i), y, fp.getZ(i)) - 0.5) * 0.05 * (y / H);
      fp.setX(i, fp.getX(i) * n);
      fp.setZ(i, fp.getZ(i) * n);
    }
    fuji.translate(250, -10, 2300);
    geos.push(colorize(fuji, H + 1e-3, 0.62));

    // Ring of rolling hills
    for (let i = 0; i < 34; i++) {
      const ang = (i / 34) * Math.PI * 2 + rng() * 0.1;
      const dist = 1500 + rng() * 500;
      const h = 120 + rng() * 260;
      const r = 300 + rng() * 300;
      const g = new THREE.ConeGeometry(r, h, 14, 4, true).toNonIndexed();
      const gp = g.attributes.position;
      const seed = i * 17.3;
      for (let k = 0; k < gp.count; k++) {
        const x = gp.getX(k), yy = gp.getY(k), z = gp.getZ(k);
        const top = yy > h / 2 - 1e-3; // keep apex shared
        const j = top ? 0 : hash3(x + seed, yy, z) - 0.5;
        gp.setX(k, x * (1 + j * 0.3));
        gp.setZ(k, z * (1 + j * 0.3));
        gp.setY(k, yy + (top ? 0 : (hash3(z, x + seed, yy) - 0.5) * h * 0.08));
      }
      g.translate(0, h / 2, 0);
      colorize(g, h, 1.2);
      g.translate(Math.cos(ang) * dist + 150, -5, Math.sin(ang) * dist - 50);
      geos.push(g);
    }
    const merged = mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g; }));
    merged.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    const mountains = new THREE.Mesh(merged, mat);
    this.scene.add(mountains);
  }

  // ----------------------------------------------------------------- Trees
  _buildTrees() {
    const rng = this.rng;
    // --- Geometry
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3, 6);
    trunkGeo.translate(0, 1.5, 0);
    const pineCrown = mergeGeometries([
      new THREE.ConeGeometry(2.2, 4.2, 7).translate(0, 4.2, 0),
      new THREE.ConeGeometry(1.7, 3.6, 7).translate(0, 6.0, 0),
      new THREE.ConeGeometry(1.1, 3.0, 7).translate(0, 7.8, 0),
    ]);
    const sakuraTrunk = new THREE.CylinderGeometry(0.22, 0.38, 3.2, 6);
    sakuraTrunk.translate(0, 1.6, 0);
    const blob = (r, x, y, z) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z);
    const sakuraCrown = mergeGeometries([
      blob(2.4, 0, 4.4, 0), blob(1.8, 1.7, 4.0, 0.6), blob(1.7, -1.6, 4.1, -0.5),
      blob(1.6, 0.4, 5.6, -1.2), blob(1.5, -0.6, 3.8, 1.6),
    ]);

    const barkMat = new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 0.95 });
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x2c5a2e, roughness: 0.9, flatShading: true });
    const sakuraMat = new THREE.MeshStandardMaterial({
      color: 0xffc2da, roughness: 0.85, flatShading: true, emissive: 0x3a1020, emissiveIntensity: 0.25,
    });

    // --- Placement
    const pines = [], sakuras = [];
    const tryPlace = (list, count, minD, maxD, spread) => {
      let guard = 0;
      while (list.length < count && guard++ < count * 40) {
        let x, z;
        if (spread === 'road') {
          const i = Math.floor(rng() * this.trackSamples.length);
          const p = this.trackSamples[i], t = this.trackTangents[i];
          const side = rng() < 0.5 ? -1 : 1;
          const off = ROAD_WIDTH / 2 + minD + rng() * (maxD - minD);
          x = p.x + -t.z * off * side; z = p.z + t.x * off * side;
        } else {
          x = THREE.MathUtils.lerp(this.bounds.minX, this.bounds.maxX, rng());
          z = THREE.MathUtils.lerp(this.bounds.minZ, this.bounds.maxZ, rng());
        }
        if (this.inPlaza(x, z, 8) || this.inClearZone(x, z)) continue;
        if (this.distanceToTrack(x, z) < ROAD_WIDTH / 2 + 5) continue;
        list.push({ x, z, s: 0.8 + rng() * 0.6, r: rng() * Math.PI * 2 });
      }
    };
    tryPlace(sakuras, 170, 6, 18, 'road');
    tryPlace(pines, 260, 0, 0, 'field');

    const makeInstanced = (geo, mat, list) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      m.castShadow = true;
      m.receiveShadow = true;
      list.forEach((t, i) => {
        _q.setFromAxisAngle(_up, t.r);
        _s.setScalar(t.s);
        _p.set(t.x, 0, t.z);
        m.setMatrixAt(i, _m4.compose(_p, _q, _s));
      });
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      this.scene.add(m);
      this.instanceCount += list.length;
      return m;
    };
    makeInstanced(trunkGeo, barkMat, pines);
    makeInstanced(pineCrown, pineMat, pines);
    makeInstanced(sakuraTrunk, barkMat, sakuras);
    const sk = makeInstanced(sakuraCrown, sakuraMat, sakuras);
    // subtle per-instance tint variation
    const c = new THREE.Color();
    sakuras.forEach((_, i) => sk.setColorAt(i, c.setHSL(0.93 + rng() * 0.04, 0.7, 0.82 + rng() * 0.1)));
    sk.instanceColor.needsUpdate = true;

    for (const t of pines) {
      this.physics.addStaticCylinder(_p.set(t.x, 0, t.z), 0.35 * t.s, 2.5);
      this.treePositions.push(t.x, t.z, 0);
    }
    for (const t of sakuras) {
      this.physics.addStaticCylinder(_p.set(t.x, 0, t.z), 0.45 * t.s, 2.5);
      this.treePositions.push(t.x, t.z, 1);
    }
  }

  // ---------------------------------------------------------- Street lights
  _buildStreetLights() {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.16, 8, 8).translate(0, 4, 0),
      new THREE.BoxGeometry(0.12, 0.12, 3.2).translate(0, 7.9, 1.5),
    ]);
    const headGeo = new THREE.BoxGeometry(0.5, 0.14, 1.0).translate(0, 7.8, 3.0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x70757e, roughness: 0.5, metalness: 0.6 });
    this.lampMaterial = new THREE.MeshStandardMaterial({
      color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 0.4, roughness: 0.3,
    });

    const spacing = 42;
    const n = this.trackSamples.length;
    const step = Math.max(1, Math.round(spacing / (this.trackLength / n)));
    const list = [];
    for (let i = 0; i < n; i += step) {
      const p = this.trackSamples[i], t = this.trackTangents[i];
      const side = (i / step) % 2 === 0 ? 1 : -1;
      const off = ROAD_WIDTH / 2 + 2.6;
      // side vector (left) = (-t.z, 0, t.x)
      const x = p.x - t.z * off * side, z = p.z + t.x * off * side;
      if (this.inPlaza(x, z, 2)) continue;
      // Arm (+Z local) must point toward the road centre
      const yaw = Math.atan2(p.x - x, p.z - z);
      list.push({ x, z, yaw });
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, list.length);
    const heads = new THREE.InstancedMesh(headGeo, this.lampMaterial, list.length);
    poles.castShadow = true;
    list.forEach((l, i) => {
      _q.setFromEuler(_e.set(0, l.yaw, 0));
      _m4.compose(_p.set(l.x, 0, l.z), _q, _s.set(1, 1, 1));
      poles.setMatrixAt(i, _m4);
      heads.setMatrixAt(i, _m4);
      this.physics.addStaticCylinder(_p, 0.2, 4);
    });
    poles.computeBoundingSphere();
    heads.computeBoundingSphere();
    this.scene.add(poles, heads);
    this.lampPositions = list;
    this.instanceCount += list.length;
  }

  // -------------------------------------------------------------- Barriers
  _buildBarriers() {
    // Armco-style barrier segment 4 m long, textured with chevrons
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#e0162b';
    for (let x = -64; x < 256; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x + 32, 0); ctx.lineTo(x + 64, 32); ctx.lineTo(x + 32, 64);
      ctx.lineTo(x, 64); ctx.lineTo(x + 32, 32);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const geo = new THREE.BoxGeometry(0.35, 0.9, 4.0);
    // Remap side UVs so chevrons run along the length
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.1 });

    const n = this.trackSamples.length;
    const segLen = 4.2;
    const step = Math.max(1, Math.round(segLen / (this.trackLength / n)));
    const list = [];
    for (let i = 0; i < n; i += step) {
      const tPrev = this.trackTangents[(i - 6 + n) % n];
      const tNext = this.trackTangents[(i + 6) % n];
      const cross = tPrev.x * tNext.z - tPrev.z * tNext.x; // signed turn
      const turn = Math.abs(cross);
      if (turn < 0.09) continue;
      const p = this.trackSamples[i], t = this.trackTangents[i];
      // outer side of the corner: turning left (cross<0 in this frame) => outer is right
      const outer = cross > 0 ? -1 : 1;
      const off = ROAD_WIDTH / 2 + 3.2;
      const x = p.x - t.z * off * outer, z = p.z + t.x * off * outer;
      if (this.inPlaza(x, z, 4)) continue;
      list.push({ x, z, yaw: Math.atan2(t.x, t.z) });
    }
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const half = new THREE.Vector3(0.18, 0.45, 2.0);
    list.forEach((b, i) => {
      _q.setFromEuler(_e.set(0, b.yaw, 0));
      _p.set(b.x, 0.45, b.z);
      mesh.setMatrixAt(i, _m4.compose(_p, _q, _s.set(1, 1, 1)));
      this.physics.addStaticBox(_p, half, b.yaw);
    });
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
    this.barrierCount = list.length;
    this.instanceCount += list.length;
  }

  // ----------------------------------------------------------------- Cones
  _buildCones() {
    const geo = mergeGeometries([
      new THREE.ConeGeometry(0.28, 0.76, 12).translate(0, 0, 0),
      new THREE.BoxGeometry(0.62, 0.05, 0.62).translate(0, -0.355, 0),
    ]);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a12, roughness: 0.55 });
    const positions = [];
    // Slalom through the plaza, off the main racing line
    for (let i = 0; i < 9; i++) positions.push([22 + (i % 2) * 3, -100 + i * 9]);
    for (let i = 0; i < 9; i++) positions.push([-24 - (i % 2) * 3, -100 + i * 9]);
    // Gate around the gantry
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) positions.push([sx * (ROAD_WIDTH / 2 + 0.8), -34 + k * 4]);

    this.coneMesh = new THREE.InstancedMesh(geo, mat, positions.length);
    this.coneMesh.castShadow = true;
    this.coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coneMesh.frustumCulled = false;
    positions.forEach(([x, z], i) => {
      const body = this.physics.addDynamicCone(_p.set(x, 0, z));
      this.cones.push({ body, x, z, knocked: false });
      _m4.compose(_p.set(x, 0.38, z), _q.identity(), _s.set(1, 1, 1));
      this.coneMesh.setMatrixAt(i, _m4);
    });
    this.scene.add(this.coneMesh);
    this.instanceCount += positions.length;
  }

  /** Sync dynamic cone instances; returns number of cones newly knocked over. */
  _syncCones() {
    let knocked = 0;
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      if (!c.body) continue;
      const t = c.body.translation();
      const r = c.body.rotation();
      _p.set(t.x, t.y, t.z);
      _q.set(r.x, r.y, r.z, r.w);
      this.coneMesh.setMatrixAt(i, _m4.compose(_p, _q, _s.set(1, 1, 1)));
      if (!c.knocked) {
        const dx = t.x - c.x, dz = t.z - c.z;
        if (dx * dx + dz * dz > 0.5) { c.knocked = true; knocked++; }
      }
    }
    this.coneMesh.instanceMatrix.needsUpdate = true;
    return knocked;
  }

  resetCones() {
    for (const c of this.cones) {
      c.knocked = false;
      if (!c.body) continue;
      c.body.setTranslation({ x: c.x, y: 0.38, z: c.z }, true);
      c.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  // ---------------------------------------------------------------- Petals
  _buildPetals() {
    const count = 900;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (this.rng() - 0.5) * 60;
      pos[i * 3 + 1] = this.rng() * 22;
      pos[i * 3 + 2] = (this.rng() - 0.5) * 60;
      seed[i] = this.rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.petals = new THREE.Points(geo, createPetalMaterial());
    this.petals.frustumCulled = false;
    this.petals.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.scene.add(this.petals);
  }

  // ----------------------------------------------------------------- Ramps
  _buildRamps() {
    this.clearZones = [];
    this.ramps = [
      { id: 'ramp-west', name: 'Sakura Leap', x: -130, z: -170, yaw: 0, width: 9, length: 15, height: 3.4 },
      { id: 'ramp-north', name: 'Fuji Sky Jump', x: -250, z: 70, yaw: Math.PI / 2, width: 9, length: 16, height: 4.2 },
    ];
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#16181f';
    for (let y = -128; y < 128; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y + 64); ctx.lineTo(64, y); ctx.lineTo(128, y + 64);
      ctx.lineTo(128, y + 96); ctx.lineTo(64, y + 32); ctx.lineTo(0, y + 96);
      ctx.closePath(); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3d45, roughness: 0.8, metalness: 0.3 });

    for (const r of this.ramps) {
      const hw = r.width / 2, l = r.length, h = r.height;
      // Wedge: slope (top), two triangular sides, back face
      const g = new THREE.BufferGeometry();
      const v = [
        // slope
        -hw, 0, 0, hw, 0, 0, hw, h, l, -hw, 0, 0, hw, h, l, -hw, h, l,
        // back
        -hw, 0, l, -hw, h, l, hw, h, l, -hw, 0, l, hw, h, l, hw, 0, l,
        // sides
        hw, 0, 0, hw, 0, l, hw, h, l,
        -hw, 0, 0, -hw, h, l, -hw, 0, l,
      ];
      const uv = [0, 0, 1, 0, 1, l / 4, 0, 0, 1, l / 4, 0, l / 4, ...new Array(24).fill(0)];
      // Flip winding (listed clockwise above) so faces point outward
      for (let t = 0; t < v.length / 9; t++) {
        for (let k = 0; k < 3; k++) {
          const i1 = t * 9 + 3 + k, i2 = t * 9 + 6 + k;
          [v[i1], v[i2]] = [v[i2], v[i1]];
        }
        const u1 = t * 6 + 2, u2 = t * 6 + 4;
        [uv[u1], uv[u2]] = [uv[u2], uv[u1]];
        [uv[u1 + 1], uv[u2 + 1]] = [uv[u2 + 1], uv[u1 + 1]];
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.addGroup(0, 6, 0);
      g.addGroup(6, 12, 1);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, [topMat, sideMat]);
      mesh.position.set(r.x, 0.01, r.z);
      mesh.rotation.y = r.yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.physics.addRamp(r);

      // Danger sign board beside the run-up
      const sign = makeSignMesh('DANGER SIGN', r.name, '#ffd23f', '#16181f');
      const side = new THREE.Vector3(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
      const fwd = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      sign.position.set(r.x, 0, r.z).addScaledVector(side, hw + 4).addScaledVector(fwd, -12);
      sign.rotation.y = r.yaw + Math.PI;
      this.scene.add(sign);

      this.clearZones.push({ x: r.x, z: r.z, cos: Math.cos(r.yaw), sin: Math.sin(r.yaw), hw: 22, z0: -110, z1: 120 });
    }
  }

  // --------------------------------------------------- Race gates & grid
  _buildRaceFurniture() {
    const n = this.trackSamples.length;
    this.sampleSpacing = this.trackLength / n;
    this.startIndex = this.nearestIndex(0, -30);

    // Chequered start/finish strip under the gantry
    const c = document.createElement('canvas');
    c.width = 256; c.height = 32;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_WIDTH, 1.6).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    );
    const sp = this.trackSamples[this.startIndex];
    strip.position.set(sp.x, 0.035, sp.z);
    strip.rotation.y = this.trackYaw(this.startIndex);
    strip.receiveShadow = true;
    this.scene.add(strip);

    // Checkpoint arches (shown during events only)
    this.checkpointGroup = new THREE.Group();
    this.checkpointGroup.visible = false;
    this.scene.add(this.checkpointGroup);
    this.gateMatIdle = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0x2de2ff, emissiveIntensity: 0.6, roughness: 0.4 });
    this.gateMatNext = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0xffd23f, emissiveIntensity: 3.5, roughness: 0.4 });
    this.gateMatFinish = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0xff2d8f, emissiveIntensity: 3.5, roughness: 0.4 });
    this.gates = [];
  }

  /** Show checkpoint gates at the given sample indices. */
  showCheckpoints(indices) {
    for (const g of this.gates) this.checkpointGroup.remove(g.mesh);
    this.gates = [];
    const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
    const beamGeo = new THREE.BoxGeometry(ROAD_WIDTH + 4, 0.5, 0.5);
    for (const idx of indices) {
      const grp = new THREE.Group();
      const p = this.trackSamples[idx];
      grp.position.set(p.x, 0, p.z);
      grp.rotation.y = this.trackYaw(idx);
      const a = new THREE.Mesh(postGeo, this.gateMatIdle);
      a.position.set(ROAD_WIDTH / 2 + 2, 3.5, 0);
      const b = a.clone();
      b.position.x = -a.position.x;
      const beam = new THREE.Mesh(beamGeo, this.gateMatIdle);
      beam.position.y = 7;
      grp.add(a, b, beam);
      this.checkpointGroup.add(grp);
      this.gates.push({ index: idx, mesh: grp, parts: [a, b, beam] });
    }
    this.checkpointGroup.visible = indices.length > 0;
  }

  /** Highlight gate `i` as next (and optionally as the finish). */
  setActiveCheckpoint(i, isFinish = false) {
    this.gates.forEach((g, k) => {
      const m = k === i ? (isFinish ? this.gateMatFinish : this.gateMatNext) : this.gateMatIdle;
      g.parts.forEach((p) => (p.material = m));
      g.mesh.visible = k === i || k === (i + 1) % this.gates.length;
    });
  }

  hideCheckpoints() {
    this.showCheckpoints([]);
  }

  /** Starting-grid slot k (0 = pole): position + yaw behind the start line. */
  gridSlot(k, out) {
    const back = 10 + Math.floor(k / 2) * 9;
    const idx = this.startIndex - back / this.sampleSpacing;
    const lateral = k % 2 === 0 ? 3.2 : -3.2;
    this.trackPoint(idx, lateral, out);
    out.y = 1.0;
    return this.trackYaw(idx);
  }

  // ---------------------------------------------------------------- Stunts
  _buildStunts() {
    const idx = (x, z) => this.nearestIndex(x, z);
    this.stunts = [
      { id: 'trap-gantry', type: 'trap', name: 'Gantry Speed Trap', index: idx(0, 25), stars: [90, 115, 135] },
      { id: 'trap-east', type: 'trap', name: 'Riverside Trap', index: idx(320, 90), stars: [75, 95, 115] },
      { id: 'zone-lakeside', type: 'zone', name: 'Lakeside Speed Zone', index: idx(250, 240), end: idx(300, 40), stars: [70, 90, 105] },
      { id: 'drift-temple', type: 'drift', name: 'Temple Drift Zone', index: idx(150, -250), end: idx(-10, -260), stars: [6000, 14000, 25000] },
    ];
    for (const r of this.ramps) {
      this.stunts.push({ id: r.id, type: 'jump', name: r.name, ramp: r, stars: [40, 70, 100] });
    }

    const colors = { trap: '#2de2ff', zone: '#2de2ff', drift: '#b36bff', jump: '#ffd23f' };
    const labels = { trap: 'SPEED TRAP', zone: 'SPEED ZONE', drift: 'DRIFT ZONE' };
    for (const st of this.stunts) {
      if (st.type === 'jump') continue;
      const col = colors[st.type];
      const lineMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false });
      const addLine = (i) => {
        const p = this.trackSamples[i];
        const m = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH, 0.8).rotateX(-Math.PI / 2), lineMat);
        m.position.set(p.x, 0.04, p.z);
        m.rotation.y = this.trackYaw(i);
        this.scene.add(m);
      };
      addLine(st.index);
      if (st.end != null) addLine(st.end);
      const sign = makeSignMesh(labels[st.type], st.name, col, '#0b0d14');
      this.trackPoint(st.index - 12 / this.sampleSpacing, -(ROAD_WIDTH / 2 + 4), sign.position);
      sign.rotation.y = this.trackYaw(st.index) + Math.PI;
      this.scene.add(sign);
    }
  }

  // ---------------------------------------------------------------- Update
  /** Returns number of cones knocked this frame. */
  update(dt, focus, camera) {
    this.time += dt;
    // Keep the shadow frustum centred on the car
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();

    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.uTime.value = this.time;
    const pu = this.petals.material.uniforms;
    pu.uTime.value = this.time;
    pu.uCenter.value.copy(camera.position);

    if (this.gates.length) {
      const pulse = 2.5 + Math.sin(this.time * 6) * 1.2;
      this.gateMatNext.emissiveIntensity = pulse;
      this.gateMatFinish.emissiveIntensity = pulse;
    }
    return this._syncCones();
  }
}

// ===========================================================================
// Procedural asphalt texture set (colour / roughness / normal)
// ===========================================================================
function createAsphaltMaps(renderer) {
  const S = 512;
  const rng = mulberry32(99);

  // Height field: layered noise + aggregate stones
  const height = new Float32Array(S * S);
  const grid = (n) => {
    const g = new Float32Array((n + 1) * (n + 1));
    for (let i = 0; i < g.length; i++) g[i] = rng();
    // make tileable
    for (let i = 0; i <= n; i++) { g[i * (n + 1) + n] = g[i * (n + 1)]; g[n * (n + 1) + i] = g[i]; }
    return g;
  };
  const octaves = [[8, 0.35], [32, 0.25], [128, 0.2]];
  for (const [n, amp] of octaves) {
    const g = grid(n);
    for (let y = 0; y < S; y++) {
      const fy = (y / S) * n, iy = Math.floor(fy), ty = fy - iy;
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * n, ix = Math.floor(fx), tx = fx - ix;
        const a = g[iy * (n + 1) + ix], b = g[iy * (n + 1) + ix + 1];
        const c = g[(iy + 1) * (n + 1) + ix], d = g[(iy + 1) * (n + 1) + ix + 1];
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        height[y * S + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
  }
  for (let i = 0; i < S * S; i++) height[i] += (rng() - 0.5) * 0.22; // grit

  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    return c;
  };

  // --- Plain colour (used by the plaza)
  const plainC = makeCanvas();
  const pctx = plainC.getContext('2d');
  const pimg = pctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const h = height[i];
    const v = 52 + h * 38 + (rng() < 0.01 ? 40 : 0);
    pimg.data[i * 4] = v; pimg.data[i * 4 + 1] = v + 1; pimg.data[i * 4 + 2] = v + 4; pimg.data[i * 4 + 3] = 255;
  }
  pctx.putImageData(pimg, 0, 0);
  // oil / tyre stains
  for (let k = 0; k < 14; k++) {
    const x = rng() * S, y = rng() * S, r = 20 + rng() * 60;
    const g = pctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(10,10,12,0.28)'); g.addColorStop(1, 'rgba(10,10,12,0)');
    pctx.fillStyle = g; pctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // --- Road colour: plain + lane markings (u across width, v along length)
  const roadC = makeCanvas();
  const rctx = roadC.getContext('2d');
  rctx.drawImage(plainC, 0, 0);
  // darker racing line wear
  const wear = rctx.createLinearGradient(0, 0, S, 0);
  wear.addColorStop(0.2, 'rgba(0,0,0,0)'); wear.addColorStop(0.35, 'rgba(0,0,0,0.18)');
  wear.addColorStop(0.65, 'rgba(0,0,0,0.18)'); wear.addColorStop(0.8, 'rgba(0,0,0,0)');
  rctx.fillStyle = wear; rctx.fillRect(0, 0, S, S);
  rctx.fillStyle = 'rgba(240,240,236,0.92)';
  const lw = S * 0.018;
  rctx.fillRect(S * 0.035, 0, lw, S); // edge lines
  rctx.fillRect(S * 0.965 - lw, 0, lw, S);
  rctx.fillRect(S * 0.5 - lw / 2, 0, lw, S * 0.45); // centre dash
  // lane arrows ghosting / cracks
  rctx.strokeStyle = 'rgba(20,20,22,0.5)';
  rctx.lineWidth = 1.2;
  for (let k = 0; k < 10; k++) {
    let x = rng() * S, y = rng() * S;
    rctx.beginPath(); rctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) { x += (rng() - 0.5) * 30; y += (rng() - 0.5) * 30; rctx.lineTo(x, y); }
    rctx.stroke();
  }

  // --- Roughness
  const roughC = makeCanvas();
  const gctx = roughC.getContext('2d');
  const gimg = gctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = THREE.MathUtils.clamp(170 + height[i] * 70, 0, 255);
    gimg.data[i * 4] = v; gimg.data[i * 4 + 1] = v; gimg.data[i * 4 + 2] = v; gimg.data[i * 4 + 3] = 255;
  }
  gctx.putImageData(gimg, 0, 0);

  // --- Normal (Sobel on height, wrapping)
  const normC = makeCanvas();
  const nctx = normC.getContext('2d');
  const nimg = nctx.createImageData(S, S);
  const H = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
  const strength = 2.2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * S + x) * 4;
      nimg.data[o] = (nx * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const aniso = renderer.capabilities.getMaxAnisotropy();
  const wrap = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, aniso);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    color: wrap(roadC, true),
    plain: wrap(plainC, true),
    roughness: wrap(roughC, false),
    normal: wrap(normC, false),
  };
}

/** Roadside billboard: two posts + a canvas-textured panel facing -Z. */
function makeSignMesh(title, subtitle, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = fg;
  ctx.fillRect(12, 12, 488, 232);
  ctx.fillStyle = bg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'italic 800 76px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(title, 256, 100, 460);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 40px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(subtitle.toUpperCase(), 256, 180, 460);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const grp = new THREE.Group();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 3),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.6, side: THREE.DoubleSide })
  );
  panel.position.y = 5;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x555a63, metalness: 0.6, roughness: 0.4 });
  const postGeo = new THREE.CylinderGeometry(0.1, 0.1, 5, 8).translate(0, 2.5, 0);
  const a = new THREE.Mesh(postGeo, postMat);
  a.position.x = 2.4;
  const b = new THREE.Mesh(postGeo, postMat);
  b.position.x = -2.4;
  grp.add(panel, a, b);
  grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return grp;
}

function createCurbTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#f4f4f4' : '#d61a2c';
    ctx.fillRect(0, i * 16, 8, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}
