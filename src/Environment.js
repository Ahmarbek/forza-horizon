import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createPetalMaterial } from './Shaders.js';
import { Terrain } from './world/Terrain.js';
import { RoadNetwork, CITY_RECT } from './world/Roads.js';
import { City } from './world/City.js';
import { Vegetation } from './world/Vegetation.js';
import { Atmosphere } from './world/Atmosphere.js';
import { mulberry32 } from './world/Noise.js';

/**
 * Environment.js
 * --------------
 * Assembles the 4 km open world:
 *  - Atmosphere (physical sky, clouds, sun/moon, fog, IBL)
 *  - Terrain (hills, border mountains, road cuttings) + heightfield physics
 *  - Road network (Festival Loop, Horizon Highway, Fuji Pass, connectors)
 *  - Neon City downtown
 *  - Forests, sakura groves and GPU grass
 *  - Festival site: plaza, gantry, cones, danger-sign ramps, stunt zones,
 *    race checkpoint gates, falling petals, distant Fuji backdrop
 */

const FESTIVAL_ZONE = { minX: -420, minZ: -480, maxX: 620, maxZ: 380 };
const PLAZA = { minX: -45, maxX: 45, minZ: -110, maxZ: -10 };
const FESTIVAL_CENTER = { x: 200, z: -60 };

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Environment {
  constructor(scene, physics, renderer) {
    this.scene = scene;
    this.physics = physics;
    this.renderer = renderer;
    this.rng = mulberry32(1337);
    this.time = 0;
    this.cones = [];
    this.gates = [];
    this.instanceCount = 0;
    this.clearZones = [];
    this.mapBounds = { minX: -2048, maxX: 2048, minZ: -2048, maxZ: 2048 };
  }

  /** Heavy: builds everything. `progress(frac, label)` is awaited between steps. */
  async build(progress = async () => {}) {
    const { scene, physics, renderer } = this;

    await progress(0.22, 'Painting the sky…');
    this.atmo = new Atmosphere(scene, renderer);

    await progress(0.3, 'Shaping 16 km² of terrain…');
    const terrain = new Terrain();
    this.terrain = terrain;
    terrain.addFlatRect(FESTIVAL_ZONE.minX, FESTIVAL_ZONE.minZ, FESTIVAL_ZONE.maxX, FESTIVAL_ZONE.maxZ, 170);
    terrain.addFlatRect(CITY_RECT.minX - 40, CITY_RECT.minZ - 40, CITY_RECT.maxX + 40, CITY_RECT.maxZ + 40, 170);
    const roads = new RoadNetwork(scene, physics, renderer, terrain);
    this.roads = roads;
    this.routes = roads.routes;
    for (const [x, z] of roads.junctions()) terrain.addFlatCircle(x, z, 30, 110);
    this._defineRamps();
    terrain.build(roads.all);
    terrain.buildMask(roads.all, CITY_RECT);
    scene.add(terrain.createMesh());
    physics.addHeightfield(terrain.seg, terrain.physicsHeights(), terrain.size, terrain);

    await progress(0.42, 'Paving 20 km of road…');
    roads.build();
    this.instanceCount += roads.instanceCount;
    this._setStarts();

    await progress(0.52, 'Raising Neon City…');
    this.city = new City(scene, physics, renderer).build(roads.textures);
    this.instanceCount += this.city.instanceCount;

    await progress(0.6, 'Setting up the festival…');
    this._buildPlaza();
    this._buildGantry();
    this._buildRamps();
    this._buildCones();
    this._buildRaceFurniture();
    this._buildStunts();
    this._buildBackdrop();
    this._buildPetals();

    await progress(0.7, 'Growing forests and sakura groves…');
    this.veg = new Vegetation(scene, physics, terrain);
    const fest = this.routes.festival;
    const sakuraRows = [];
    for (let i = 0; i < fest.count; i += Math.round(22 / fest.spacing)) {
      for (const side of [-1, 1]) {
        const off = side * (fest.width / 2 + 10 + this.rng() * 5);
        const x = fest.xs[i] + fest.tz[i] * off, z = fest.zs[i] - fest.tx[i] * off;
        if (this.inPlaza(x, z, 10) || this.inClearZone(x, z)) continue;
        if (roads.nearest(x, z, (r) => r !== fest).d2 < 20 * 20) continue;
        sakuraRows.push({ x, z, type: 'sakura' });
      }
    }
    this.veg.build({
      festivalCenter: FESTIVAL_CENTER,
      extraSpots: [...this.city.treeSpots, ...sakuraRows],
      avoid: (x, z) => this.inPlaza(x, z, 12) || this.inClearZone(x, z) || this.city.contains(x, z, 25),
    });
    this.veg.buildGrass();
    this.instanceCount += this.veg.instanceCount;
    this.treePositions = this.veg.treePositions;

    this.setTimeOfDay(38);
    return this;
  }

  // ------------------------------------------------------------ Helpers
  heightAt(x, z) {
    let h = this.terrain.heightAt(x, z);
    if (this.city && this.city.contains(x, z)) h = Math.max(h, 0.04);
    return h;
  }

  inPlaza(x, z, margin = 0) {
    return x > PLAZA.minX - margin && x < PLAZA.maxX + margin && z > PLAZA.minZ - margin && z < PLAZA.maxZ + margin;
  }

  inClearZone(x, z) {
    for (const c of this.clearZones) {
      const dx = x - c.x, dz = z - c.z;
      const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz;
      if (Math.abs(lx) < c.hw && lz > c.z0 && lz < c.z1) return true;
    }
    return false;
  }

  /** Nearest drivable road for resets: { route, index }. */
  nearestRoad(x, z) {
    // inside the city, snap to the closest street centre-line instead
    if (this.city.contains(x, z, 5)) {
      const { xs, zs } = this.city.streetLines();
      let best = null;
      for (const sx of xs) { const d = Math.abs(x - sx); if (!best || d < best.d) best = { d, x: sx, z: THREE.MathUtils.clamp(z, CITY_RECT.minZ, CITY_RECT.maxZ), yaw: z > 0 ? 0 : Math.PI }; }
      for (const sz of zs) { const d = Math.abs(z - sz); if (d < best.d) best = { d, x: THREE.MathUtils.clamp(x, CITY_RECT.minX, CITY_RECT.maxX), z: sz, yaw: Math.PI / 2 }; }
      return { point: new THREE.Vector3(best.x + 4, 0.2, best.z + 4), yaw: best.yaw };
    }
    const n = this.roads.nearest(x, z);
    const p = n.route.point(n.index, 0, new THREE.Vector3());
    return { point: p, yaw: n.route.yaw(n.index), route: n.route, index: n.index };
  }

  _setStarts() {
    const r = this.routes;
    r.festival.startIndex = r.festival.nearestIndex(0, -30);
    r.city.startIndex = r.city.nearestIndex(-1375, 800);
    r.highway.startIndex = r.highway.nearestIndex(870, -150);
    r.mountain.startIndex = r.mountain.nearestIndex(-470, -300);
    this.startPosition = new THREE.Vector3(0, 1.2, -75);
    this.startYaw = 0;
  }

  // -------------------------------------------------------------- Plaza
  _buildPlaza() {
    const tex = this.roads.textures;
    const w = PLAZA.maxX - PLAZA.minX, d = PLAZA.maxZ - PLAZA.minZ;
    const map = tex.plain.clone(); map.repeat.set(w / 12, d / 12); map.needsUpdate = true;
    const rough = tex.roughness.clone(); rough.repeat.copy(map.repeat); rough.needsUpdate = true;
    const normal = tex.normal.clone(); normal.repeat.copy(map.repeat); normal.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map, roughnessMap: rough, normalMap: normal, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
    plaza.position.set((PLAZA.minX + PLAZA.maxX) / 2, 0.03, (PLAZA.minZ + PLAZA.maxZ) / 2);
    plaza.receiveShadow = true;
    this.scene.add(plaza);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.75 });
    const lines = [];
    for (let i = -2; i <= 2; i++) if (i !== 0) lines.push(new THREE.PlaneGeometry(0.25, 7).rotateX(-Math.PI / 2).translate(i * 4.5, 0.045, -80));
    lines.push(new THREE.PlaneGeometry(22, 0.5).rotateX(-Math.PI / 2).translate(0, 0.045, -71));
    this.scene.add(new THREE.Mesh(mergeGeometries(lines), lineMat));
  }

  _buildGantry() {
    const W = this.routes.festival.width;
    const group = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2e36, roughness: 0.4, metalness: 0.8 });
    const z = -30;
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 9, 1.2), steel);
      p.position.set(sx * (W / 2 + 2.5), 4.5, z);
      p.castShadow = true;
      group.add(p);
      this.physics.addStaticBox(p.position, new THREE.Vector3(0.6, 4.5, 0.6), 0);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W + 6, 1.4, 1.4), steel);
    beam.position.set(0, 9, z);
    beam.castShadow = true;
    group.add(beam);
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      const grd = ctx.createLinearGradient(0, 0, 1024, 0);
      grd.addColorStop(0, '#ff2d8f'); grd.addColorStop(1, '#ff8a2d');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 1024, 128);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 88;
      do { ctx.font = `italic 800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`; size -= 4; }
      while (ctx.measureText('HORIZON SAKURA FESTIVAL').width > 960 && size > 30);
      ctx.fillText('HORIZON SAKURA FESTIVAL', 512, 68);
    };
    draw();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.gantryMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.0, roughness: 0.5 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(W + 4, (W + 4) / 8), this.gantryMat);
    sign.position.set(0, 9, z - 0.72);
    sign.rotation.y = Math.PI;
    const sign2 = sign.clone();
    sign2.position.z = z + 0.72;
    sign2.rotation.y = 0;
    group.add(sign, sign2);
    this.scene.add(group);
    document.fonts?.ready?.then(() => { draw(); tex.needsUpdate = true; });
  }

  // -------------------------------------------------------------- Ramps
  _defineRamps() {
    this.ramps = [
      { id: 'ramp-west', name: 'Sakura Leap', x: -130, z: -170, yaw: 0, width: 9, length: 15, height: 3.4 },
      { id: 'ramp-north', name: 'Fuji Sky Jump', x: -250, z: 70, yaw: Math.PI / 2, width: 9, length: 16, height: 4.2 },
    ];
    for (const r of this.ramps) {
      this.clearZones.push({ x: r.x, z: r.z, cos: Math.cos(r.yaw), sin: Math.sin(r.yaw), hw: 22, z0: -110, z1: 130 });
    }
  }

  _buildRamps() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#16181f';
    for (let y = -128; y < 256; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y + 64); ctx.lineTo(64, y); ctx.lineTo(128, y + 64);
      ctx.lineTo(128, y + 96); ctx.lineTo(64, y + 32); ctx.lineTo(0, y + 96);
      ctx.closePath(); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3d45, roughness: 0.8, metalness: 0.3 });
    for (const r of this.ramps) {
      const hw = r.width / 2, l = r.length, h = r.height;
      // wedge: slope, back, sides (outward winding)
      const v = [
        -hw, 0, 0, hw, h, l, hw, 0, 0, -hw, 0, 0, -hw, h, l, hw, h, l,
        -hw, 0, l, hw, h, l, -hw, h, l, -hw, 0, l, hw, 0, l, hw, h, l,
        hw, 0, 0, hw, h, l, hw, 0, l,
        -hw, 0, 0, -hw, 0, l, -hw, h, l,
      ];
      const uv = [0, 0, 1, l / 4, 1, 0, 0, 0, 0, l / 4, 1, l / 4, ...new Array(24).fill(0)];
      const g = new THREE.BufferGeometry();
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
      const sign = makeSignMesh('DANGER SIGN', r.name, '#ffd23f', '#16181f');
      const side = new THREE.Vector3(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
      const fwd = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      sign.position.set(r.x, 0, r.z).addScaledVector(side, hw + 4).addScaledVector(fwd, -12);
      sign.rotation.y = r.yaw + Math.PI;
      this.scene.add(sign);
    }
  }

  // -------------------------------------------------------------- Cones
  _buildCones() {
    const geo = mergeGeometries([
      new THREE.ConeGeometry(0.28, 0.76, 16),
      new THREE.BoxGeometry(0.62, 0.05, 0.62).translate(0, -0.355, 0),
    ]);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a12, roughness: 0.5 });
    const positions = [];
    for (let i = 0; i < 9; i++) positions.push([22 + (i % 2) * 3, -100 + i * 9]);
    for (let i = 0; i < 9; i++) positions.push([-24 - (i % 2) * 3, -100 + i * 9]);
    const W = this.routes.festival.width;
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) positions.push([sx * (W / 2 + 0.8), -34 + k * 4]);
    this.coneMesh = new THREE.InstancedMesh(geo, mat, positions.length);
    this.coneMesh.castShadow = true;
    this.coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coneMesh.frustumCulled = false;
    positions.forEach(([x, z], i) => {
      const body = this.physics.addDynamicCone(_p.set(x, 0.04, z));
      this.cones.push({ body, x, z, knocked: false });
      this.coneMesh.setMatrixAt(i, _m4.compose(_p.set(x, 0.42, z), _q.identity(), _s.set(1, 1, 1)));
    });
    this.scene.add(this.coneMesh);
  }

  _syncCones() {
    let knocked = 0;
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      if (!c.body) continue;
      const t = c.body.translation();
      const r = c.body.rotation();
      this.coneMesh.setMatrixAt(i, _m4.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1)));
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
      c.body.setTranslation({ x: c.x, y: 0.42, z: c.z }, true);
      c.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  // --------------------------------------------------- Race gates
  _buildRaceFurniture() {
    // chequered start/finish strips on every race route
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
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    for (const r of Object.values(this.routes)) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(r.width, 1.6).rotateX(-Math.PI / 2), mat);
      const i = r.startIndex;
      strip.position.set(r.xs[i], r.ys[i] + 0.09, r.zs[i]);
      strip.rotation.y = r.yaw(i);
      strip.receiveShadow = true;
      this.scene.add(strip);
    }
    this.checkpointGroup = new THREE.Group();
    this.checkpointGroup.visible = false;
    this.scene.add(this.checkpointGroup);
    this.gateMatIdle = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0x2de2ff, emissiveIntensity: 0.6, roughness: 0.4 });
    this.gateMatNext = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0xffd23f, emissiveIntensity: 3.5, roughness: 0.4 });
    this.gateMatFinish = new THREE.MeshStandardMaterial({ color: 0x222633, emissive: 0xff2d8f, emissiveIntensity: 3.5, roughness: 0.4 });
  }

  showCheckpoints(route, indices) {
    for (const g of this.gates) this.checkpointGroup.remove(g.mesh);
    this.gates = [];
    if (!route) { this.checkpointGroup.visible = false; return; }
    const W = route.width;
    const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
    const beamGeo = new THREE.BoxGeometry(W + 4, 0.5, 0.5);
    for (const idx of indices) {
      const grp = new THREE.Group();
      grp.position.set(route.xs[idx], route.ys[idx], route.zs[idx]);
      grp.rotation.y = route.yaw(idx);
      const a = new THREE.Mesh(postGeo, this.gateMatIdle);
      a.position.set(W / 2 + 2, 3.5, 0);
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

  setActiveCheckpoint(i, isFinish = false) {
    this.gates.forEach((g, k) => {
      const m = k === i ? (isFinish ? this.gateMatFinish : this.gateMatNext) : this.gateMatIdle;
      g.parts.forEach((p) => (p.material = m));
      g.mesh.visible = k === i || k === (i + 1) % this.gates.length;
    });
  }

  hideCheckpoints() {
    this.showCheckpoints(null, []);
  }

  // -------------------------------------------------------------- Stunts
  _buildStunts() {
    const R = this.routes;
    const at = (route, x, z) => route.nearestIndex(x, z);
    this.stunts = [
      { id: 'trap-gantry', type: 'trap', name: 'Gantry Speed Trap', route: R.festival, index: at(R.festival, 0, 25), stars: [90, 115, 135] },
      { id: 'trap-east', type: 'trap', name: 'Riverside Trap', route: R.festival, index: at(R.festival, 320, 90), stars: [75, 95, 115] },
      { id: 'zone-lakeside', type: 'zone', name: 'Lakeside Speed Zone', route: R.festival, index: at(R.festival, 250, 240), end: at(R.festival, 300, 40), stars: [70, 90, 105] },
      { id: 'drift-temple', type: 'drift', name: 'Temple Drift Zone', route: R.festival, index: at(R.festival, 150, -250), end: at(R.festival, -10, -260), stars: [6000, 14000, 25000] },
      { id: 'trap-skyline', type: 'trap', name: 'Skyline Speed Trap', route: R.highway, index: at(R.highway, -800, 1720), stars: [120, 145, 165] },
      { id: 'zone-coast', type: 'zone', name: 'Coastal Speed Zone', route: R.highway, index: at(R.highway, 880, 0), end: at(R.highway, 820, 700), stars: [100, 125, 145] },
      { id: 'drift-fuji', type: 'drift', name: 'Fuji Pass Drift Zone', route: R.mountain, index: at(R.mountain, -520, -700), end: at(R.mountain, -700, -1020), stars: [8000, 18000, 32000] },
      { id: 'trap-neon', type: 'trap', name: 'Neon Speed Trap', route: R.city, index: at(R.city, -1000, 625), stars: [70, 90, 110] },
    ];
    for (const r of this.ramps) this.stunts.push({ id: r.id, type: 'jump', name: r.name, ramp: r, stars: [40, 70, 100] });

    const colors = { trap: '#2de2ff', zone: '#2de2ff', drift: '#b36bff' };
    const labels = { trap: 'SPEED TRAP', zone: 'SPEED ZONE', drift: 'DRIFT ZONE' };
    for (const st of this.stunts) {
      if (st.type === 'jump') continue;
      const r = st.route;
      const lineMat = new THREE.MeshBasicMaterial({ color: colors[st.type], transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      const addLine = (i) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(r.width, 0.8).rotateX(-Math.PI / 2), lineMat);
        m.position.set(r.xs[i], r.ys[i] + 0.1, r.zs[i]);
        m.rotation.y = r.yaw(i);
        this.scene.add(m);
      };
      addLine(st.index);
      if (st.end != null) addLine(st.end);
      const sign = makeSignMesh(labels[st.type], st.name, colors[st.type], '#0b0d14');
      r.point(st.index - 14 / r.spacing, -(r.width / 2 + 4), sign.position);
      sign.position.y = this.heightAt(sign.position.x, sign.position.z);
      sign.rotation.y = r.yaw(st.index) + Math.PI;
      this.scene.add(sign);
    }
  }

  // ----------------------------------------------------------- Backdrop
  _buildBackdrop() {
    // Distant Fuji + outer ranges beyond the playable border mountains
    const rng = this.rng;
    const geos = [];
    const snow = new THREE.Color('#eef2fb');
    const rock = new THREE.Color('#58647a');
    const forest = new THREE.Color('#2c4234');
    const colorize = (g, base, height, snowLine) => {
      const pos = g.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const h = (pos.getY(i) - base) / height;
        if (h > snowLine) c.copy(snow);
        else c.copy(forest).lerp(rock, THREE.MathUtils.smoothstep(h, 0.05, snowLine));
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      return g;
    };
    const profile = [];
    const H = 1500, Rr = 2600;
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      profile.push(new THREE.Vector2(i === 28 ? 90 : Rr * Math.pow(1 - t, 1.9) + 120 * (1 - t) + 90, t * H));
    }
    profile.push(new THREE.Vector2(0, H - 20));
    const fuji = new THREE.LatheGeometry(profile, 72).toNonIndexed();
    fuji.translate(400, -40, 4300);
    geos.push(colorize(fuji, -40, H, 0.6));
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2 + rng() * 0.08;
      const dist = 3000 + rng() * 800;
      const h = 350 + rng() * 650;
      const r = 700 + rng() * 600;
      const g = new THREE.ConeGeometry(r, h, 14, 4, true).toNonIndexed();
      const gp = g.attributes.position;
      for (let k = 0; k < gp.count; k++) {
        const x = gp.getX(k), yy = gp.getY(k), z = gp.getZ(k);
        const top = yy > h / 2 - 1e-3;
        const hv = Math.sin(Math.round(x) * 12.9898 + Math.round(yy) * 78.233 + Math.round(z) * 37.719 + i) * 43758.5453;
        const j = top ? 0 : (hv - Math.floor(hv)) - 0.5;
        gp.setX(k, x * (1 + j * 0.3));
        gp.setZ(k, z * (1 + j * 0.3));
      }
      g.translate(0, h / 2 - 60, 0);
      colorize(g, -60, h, 0.72);
      g.translate(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
      geos.push(g);
    }
    const merged = mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g; }));
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------- Petals
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

  // ------------------------------------------------------- Time & update
  setTimeOfDay(elevationDeg) {
    this.atmo.setTimeOfDay(elevationDeg);
    const n = this.atmo.night;
    const dusk = THREE.MathUtils.smoothstep(-elevationDeg, -12, 2); // lamps on a bit before sunset
    const lamps = Math.max(n, dusk * 0.6);
    this.roads.lampMaterial.emissiveIntensity = 0.3 + lamps * 5;
    this.city.setNight(lamps);
    if (this.gantryMat) this.gantryMat.emissiveIntensity = 1 + lamps * 2.5;
    this.night = n;
    this.lampLevel = lamps;
  }

  setShadowQuality(size) {
    this.atmo.setShadowQuality(size);
  }

  /** Returns number of cones knocked this frame. */
  update(dt, focus, camera) {
    this.time += dt;
    this.atmo.update(dt, camera, focus);
    this.atmo.updateEnvironment(dt);
    this.veg.update(dt, camera);
    const pu = this.petals.material.uniforms;
    pu.uTime.value = this.time;
    pu.uCenter.value.copy(camera.position);
    this.petals.visible = Math.hypot(camera.position.x - FESTIVAL_CENTER.x, camera.position.z - FESTIVAL_CENTER.z) < 900;
    if (this.gates.length) {
      const pulse = 2.5 + Math.sin(this.time * 6) * 1.2;
      this.gateMatNext.emissiveIntensity = pulse;
      this.gateMatFinish.emissiveIntensity = pulse;
    }
    return this._syncCones();
  }

  /** Shaded-relief map image of the world (cached). */
  mapCanvas() {
    if (this._mapCanvas) return this._mapCanvas;
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const t = this.terrain;
    const px = t.size / S;
    const light = new THREE.Vector3(-0.5, 0.8, -0.4).normalize();
    const n = new THREE.Vector3();
    for (let iy = 0; iy < S; iy++) {
      for (let ix = 0; ix < S; ix++) {
        // map is drawn north-up and mirrored X to match the minimap
        const x = t.half - (ix + 0.5) * px, z = t.half - (iy + 0.5) * px;
        const h = t.heightAt(x, z);
        t.normalAt(x, z, n);
        const shade = 0.55 + 0.6 * Math.max(0, n.dot(light));
        const forest = t.maskAt(x, z, 2);
        let r = 58 - forest * 14, g = 84 - forest * 10, b = 52 - forest * 8;
        if (h > 150) { const k = Math.min(1, (h - 150) / 120); r += (120 - r) * k; g += (118 - g) * k; b += (116 - b) * k; }
        if (h > 230) { const k = Math.min(1, (h - 230) / 60); r += (225 - r) * k; g += (230 - g) * k; b += (238 - b) * k; }
        if (t.maskAt(x, z, 1) > 0.5) { r = 70; g = 72; b = 78; }
        const o = (iy * S + ix) * 4;
        img.data[o] = r * shade; img.data[o + 1] = g * shade; img.data[o + 2] = b * shade; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // city blocks
    const X = (x) => (t.half - x) / px, Y = (z) => (t.half - z) / px;
    ctx.fillStyle = '#9a9aa2';
    for (const b of this.city.blocks) ctx.fillRect(X(b.maxX), Y(b.maxZ), (b.maxX - b.minX) / px, (b.maxZ - b.minZ) / px);
    ctx.fillStyle = '#c8c8d0';
    for (const b of this.city.buildings) if (b.y < 1) ctx.fillRect(X(b.x + b.w / 2), Y(b.z + b.d / 2), b.w / px, b.d / px);
    this._mapCanvas = c;
    return c;
  }
}

/** Roadside billboard: two posts + a canvas-textured panel facing -Z. */
export function makeSignMesh(title, subtitle, bg, fg) {
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
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5, side: THREE.DoubleSide })
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
