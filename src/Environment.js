import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createPetalMaterial } from './Shaders.js';
import { Terrain, WORLD_HALF, SEA_LEVEL, LAKE, ISLAND, coastLine } from './world/Terrain.js';
import { RoadNetwork, CITY_RECT, CITY_STREET_STEP, CITY_STREET_WIDTH, ITO_RECT, ITO_STEP, ITO_STREET_WIDTH, ITO_Y } from './world/Roads.js';
import { City } from './world/City.js';
import { Vegetation } from './world/Vegetation.js';
import { Atmosphere } from './world/Atmosphere.js';
import { Water } from './world/Water.js';
import { Landmarks } from './world/Landmarks.js';
import { Countryside } from './world/Countryside.js';
import { SurfaceMap } from './world/Surfaces.js';
import { SURFACE } from './Vehicle.js';
import { installHeightFog, patchFogMaterials } from './world/Fog.js';
import { mulberry32 } from './world/Noise.js';
import { regionName, REGIONS } from './world/Regions.js';

/**
 * Environment.js
 * --------------
 * Assembles the 8 km open world, a compact "Horizon Japan":
 *  - Atmosphere (physical sky, clouds, sun/moon, fog, IBL)
 *  - Terrain (east coast, Legend Island, rice plains, crater lake, Alps) +
 *    heightfield physics
 *  - Road network: Festival Loop, Horizon Expressway, the elevated C1 loop
 *    over Tokyo with its link and the Tokyo Bay Bridge, Ito coast road,
 *    Ohtani Pass, Haruna touge, Shimanoyama lake loop, Sotoyama Skyline,
 *    Nangan forest trail, Legend Island circuit, farm lanes — and the surface
 *    map that tells tyres what they drive on
 *  - Tokyo City (downtown, docks, industrial, suburbs) and Ito harbour town
 *  - Ocean and the crater lake, landmarks and countryside dressing
 *  - Forests, sakura groves and GPU grass
 *  - Festival site: plaza, gantry, cones, danger-sign ramps, stunt zones,
 *    race checkpoint gates, falling petals, distant Mt. Fuji backdrop
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
    this.mapBounds = { minX: -WORLD_HALF, maxX: WORLD_HALF, minZ: -WORLD_HALF, maxZ: WORLD_HALF };
  }

  /** Heavy: builds everything. `progress(frac, label)` is awaited between steps. */
  async build(progress = async () => {}) {
    const { scene, physics, renderer } = this;
    const timings = [];
    let t0 = performance.now();
    const mark = (label) => { const t = performance.now(); timings.push(`${label} ${Math.round(t - t0)}ms`); t0 = t; };
    const step = async (frac, text) => { await progress(frac, text); t0 = performance.now(); };

    await step(0.2, 'Painting the sky…');
    installHeightFog();
    this.atmo = new Atmosphere(scene, renderer);

    await step(0.25, 'Shaping 67 km² of terrain…');
    const terrain = new Terrain();
    this.terrain = terrain;
    terrain.addFlatRect(FESTIVAL_ZONE.minX, FESTIVAL_ZONE.minZ, FESTIVAL_ZONE.maxX, FESTIVAL_ZONE.maxZ, 170, 0);
    // Tokyo reaches the sea wall (docks + dock strip), so its flat zone runs out to the quay
    terrain.addFlatRect(CITY_RECT.minX - 90, CITY_RECT.minZ - 40, CITY_RECT.maxX + 40, CITY_RECT.maxZ + 40, 170, 0);
    terrain.addFlatRect(ITO_RECT.minX - 30, ITO_RECT.minZ - 30, ITO_RECT.maxX + 30, ITO_RECT.maxZ + 30, 150, ITO_Y);
    // Legend Island festival grounds on the island's crown
    this.legendZone = terrain.addFlatCircle(ISLAND.x - 30, ISLAND.z, 120, 70, 'auto');
    const roads = new RoadNetwork(scene, physics, renderer, terrain);
    this.roads = roads;
    this.routes = roads.routes;
    roads.pierBlocked = (x, z) => this._inCityStreet(x, z);
    for (const [x, z] of roads.junctions()) terrain.addFlatCircle(x, z, 30, 110, 'auto', true);
    this._defineRamps();
    terrain.build(roads.all);
    mark('terrain');
    terrain.buildMask(roads.all, [CITY_RECT, ITO_RECT, { minX: CITY_RECT.minX - 100, maxX: CITY_RECT.minX, minZ: CITY_RECT.minZ - 60, maxZ: CITY_RECT.maxZ + 60 }]);
    mark('masks');
    scene.add(terrain.createMesh());
    physics.addHeightfield(terrain.seg, terrain.physicsHeights(), terrain.size, terrain);
    physics.groundHeight = (x, z) => terrain.heightAt(x, z);
    mark('terrain mesh + physics');

    await step(0.38, 'Paving 60 km of road…');
    roads.build();
    this.instanceCount += roads.instanceCount;
    this._setStarts();
    this._buildSurfaces();
    mark('roads');

    await step(0.48, 'Raising Tokyo City and Ito…');
    const elevated = this.roads.all.filter((r) => r.elevated);
    this.city = new City(scene, physics, renderer, {
      name: 'Tokyo City', rect: CITY_RECT, step: CITY_STREET_STEP, streetWidth: CITY_STREET_WIDTH, style: 'tokyo', seed: 4242,
      parks: [], tokyo: true,
      // lots under the expressways stay open (parking under the viaduct)
      clear: (x, z, pad) => elevated.some((r) => { r.nearestIndex(x, z); return r.lastDistanceSq < (r.width / 2 + pad) ** 2 && r.ys[r.nearestIndex(x, z)] > 4; }),
    }).build(roads.textures);
    this.ito = new City(scene, physics, renderer, {
      name: 'Ito', rect: ITO_RECT, step: ITO_STEP, streetWidth: ITO_STREET_WIDTH,
      baseY: ITO_Y, seed: 777, style: 'harbor', parks: [5],
    }).build(roads.textures);
    this.cities = [this.city, this.ito];
    for (const c of this.cities) this.instanceCount += c.instanceCount;
    mark('cities');

    await step(0.56, 'Filling the lake and the ocean…');
    this.water = new Water(scene, terrain).build();
    this.landmarks = new Landmarks(scene, physics, terrain, roads).build();
    this.landmarks.legendStage(this.legendZone);
    mark('water + landmarks');

    await step(0.6, 'Building villages, power lines and the Shinkansen…');
    this.countryside = new Countryside({
      scene, physics, terrain, roads,
      avoid: (x, z) => this.cities.some((c) => c.contains(x, z, 40)) || this.landmarks.blocks(x, z)
        || (x > FESTIVAL_ZONE.minX - 40 && x < FESTIVAL_ZONE.maxX + 40 && z > FESTIVAL_ZONE.minZ - 40 && z < FESTIVAL_ZONE.maxZ + 40)
        || Math.hypot(x - this.legendZone.x, z - this.legendZone.z) < 170,
    }).build();
    this.instanceCount += this.countryside.instanceCount;
    this.labels = [...this.landmarks.labels, ...this.countryside.labels];
    this.regions = REGIONS;
    mark('countryside');

    await step(0.62, 'Setting up the festival…');
    this._buildPlaza();
    this._buildGantry();
    this._buildRamps();
    this._buildCones();
    this._buildRaceFurniture();
    this._buildStunts();
    this._buildBackdrop();
    this._buildPetals();
    mark('festival');

    await step(0.7, 'Growing forests and sakura groves…');
    this.veg = new Vegetation(scene, physics, terrain);
    const fest = this.routes.festival;
    const sakuraRows = [];
    for (let i = 0; i < fest.count; i += Math.round(22 / fest.spacing)) {
      for (const side of [-1, 1]) {
        const off = side * (fest.width / 2 + 10 + this.rng() * 5);
        const x = fest.xs[i] + fest.tz[i] * off, z = fest.zs[i] - fest.tx[i] * off;
        if (this.inPlaza(x, z, 10) || this.inClearZone(x, z) || this.landmarks.blocks(x, z)) continue;
        if (roads.nearest(x, z, (r) => r !== fest).d2 < 20 * 20) continue;
        sakuraRows.push({ x, z, type: 'sakura' });
      }
    }
    // cherry trees along the lake shore road
    const lake = this.routes.lake;
    for (let i = 0; i < lake.count; i += Math.round(26 / lake.spacing)) {
      if (lake.bridge && lake.bridge[i]) continue;
      for (const side of [-1, 1]) {
        const off = side * (lake.width / 2 + 6 + this.rng() * 4);
        const x = lake.xs[i] + lake.tz[i] * off, z = lake.zs[i] - lake.tx[i] * off;
        if (terrain.isWater(x, z, -1) || this.landmarks.blocks(x, z)) continue;
        if (roads.nearest(x, z, (r) => r !== lake).d2 < 14 * 14) continue;
        sakuraRows.push({ x, z, type: 'sakura' });
      }
    }
    const extraSpots = [...sakuraRows, ...this.countryside.treeSpots, ...this.landmarks.treeSpots];
    for (const c of this.cities) extraSpots.push(...c.treeSpots);
    this.veg.build({
      renderer,
      festivalCenter: FESTIVAL_CENTER,
      extraSpots,
      avoid: (x, z) => this.inPlaza(x, z, 12) || this.inClearZone(x, z)
        || this.cities.some((c) => c.contains(x, z, 25)) || this.landmarks.blocks(x, z) || this.countryside.blocks(x, z)
        || this.countryside.nearRail(x, z) || this._nearElevated(x, z)
        || terrain.isWater(x, z, -1.5) || terrain.mask2At(x, z, 0) > 0.35
        || (terrain.mask2At(x, z, 1) > 0.5 && this.rng() < 0.93),
    });
    this.veg.buildGrass();
    this.instanceCount += this.veg.instanceCount;
    this.treePositions = this.veg.treePositions;
    mark('vegetation');

    this.setTimeOfDay(38);
    patchFogMaterials(scene);
    console.info('[Environment] build timings: ' + timings.join(' · '));
    return this;
  }

  // ------------------------------------------------------------ Helpers
  heightAt(x, z) {
    let h = this.terrain.heightAt(x, z);
    if (this.cities) for (const c of this.cities) if (c.contains(x, z)) h = Math.max(h, c.baseY + 0.04);
    return h;
  }

  /** How deep x,y,z is under water (≤ 0 when dry). */
  waterDepthAt(x, y, z) {
    const wl = this.terrain.waterLevelAt(x, z);
    return wl == null ? 0 : wl - y;
  }

  cityAt(x, z, margin = 0) {
    return this.cities?.find((c) => c.contains(x, z, margin)) ?? null;
  }

  /** Region name for the HUD banner (the ten regions of the map, plus towns and districts). */
  regionAt(x, z) {
    if (this.city && this.city.contains(x, z, 20)) return `Tokyo City · ${this.city.districtAt(x, z)}`;
    if (this.ito && this.ito.contains(x, z, 20)) return 'Ito Harbour';
    if (x > FESTIVAL_ZONE.minX && x < FESTIVAL_ZONE.maxX && z > FESTIVAL_ZONE.minZ && z < FESTIVAL_ZONE.maxZ) return 'Horizon Festival';
    return regionName(x, z);
  }

  /** true under/next to an elevated expressway (no trees growing through the deck). */
  _nearElevated(x, z) {
    if (!this._elevHash) {
      this._elevHash = new Map();
      for (const r of this.roads.all) {
        if (!r.elevated) continue;
        for (let i = 0; i < r.count; i += 3) {
          const k = `${Math.floor(r.xs[i] / 30)},${Math.floor(r.zs[i] / 30)}`;
          if (!this._elevHash.has(k)) this._elevHash.set(k, []);
          this._elevHash.get(k).push(r.xs[i], r.zs[i], r.width / 2 + 9);
        }
      }
    }
    const cx = Math.floor(x / 30), cz = Math.floor(z / 30);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = this._elevHash.get(`${cx + a},${cz + b}`);
      if (l) for (let i = 0; i < l.length; i += 3) if (Math.hypot(l[i] - x, l[i + 1] - z) < l[i + 2]) return true;
    }
    return false;
  }

  /** true inside a Tokyo street (no expressway piers there). */
  _inCityStreet(x, z) {
    const R = CITY_RECT;
    if (x < R.minX - 12 || x > R.maxX + 12 || z < R.minZ - 12 || z > R.maxZ + 12) return false;
    const hs = CITY_STREET_WIDTH / 2 + 2.5;
    const fx = ((x - R.minX) % CITY_STREET_STEP + CITY_STREET_STEP) % CITY_STREET_STEP;
    const fz = ((z - R.minZ) % CITY_STREET_STEP + CITY_STREET_STEP) % CITY_STREET_STEP;
    return fx < hs || fx > CITY_STREET_STEP - hs || fz < hs || fz > CITY_STREET_STEP - hs;
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

  /** Nearest drivable road for resets: { point, yaw, route?, index? }. */
  nearestRoad(x, z, y = null) {
    // up on an expressway deck: stay on it
    if (y != null) {
      for (const r of this.roads.all) {
        if (!r.elevated) continue;
        const i = r.nearestIndex(x, z);
        if (r.lastDistanceSq < (r.width / 2 + 4) ** 2 && y > r.ys[i] - 4 && r.ys[i] > 3) {
          return { point: r.point(i, 0, new THREE.Vector3()), yaw: r.yaw(i), route: r, index: i };
        }
      }
    }
    // inside a town, snap to the closest street centre-line instead
    const city = this.cityAt(x, z, 5);
    if (city) {
      const { xs, zs } = city.streetLines();
      const R = city.rect;
      let best = null;
      for (const sx of xs) { const d = Math.abs(x - sx); if (!best || d < best.d) best = { d, x: sx, z: THREE.MathUtils.clamp(z, R.minZ, R.maxZ), yaw: z > (R.minZ + R.maxZ) / 2 ? Math.PI : 0 }; }
      for (const sz of zs) { const d = Math.abs(z - sz); if (d < best.d) best = { d, x: THREE.MathUtils.clamp(x, R.minX, R.maxX), z: sz, yaw: Math.PI / 2 }; }
      return { point: new THREE.Vector3(best.x + 3, city.baseY + 0.2, best.z + 3), yaw: best.yaw };
    }
    const n = this.roads.nearest(x, z, (r) => r.render || r.flat);
    const p = n.route.point(n.index, 0, new THREE.Vector3());
    return { point: p, yaw: n.route.yaw(n.index), route: n.route, index: n.index };
  }

  _setStarts() {
    const r = this.routes;
    r.festival.startIndex = r.festival.nearestIndex(0, -30);
    r.city.startIndex = r.city.nearestIndex(-1575, -1000);
    r.highway.startIndex = r.highway.nearestIndex(-1070, -900);
    r.mountain.startIndex = r.mountain.nearestIndex(-100, 400);
    r.c1.startIndex = r.c1.nearestIndex(-1900, -1112);
    r.lake.startIndex = r.lake.nearestIndex(2400, 1420);
    r.rally.startIndex = r.rally.nearestIndex(300, -2500);
    r.ito.startIndex = r.ito.nearestIndex(-2450, -2450);
    r.island.startIndex = r.island.nearestIndex(-3700, -290);
    // open routes: sprint start and finish
    for (const k of ['coast', 'touge', 'summit', 'docks']) {
      r[k].startIndex = Math.round(45 / r[k].spacing);
      r[k].finishIndex = r[k].count - 1 - Math.round(30 / r[k].spacing);
    }
    this.startPosition = new THREE.Vector3(0, 1.2, -75);
    this.startYaw = 0;
  }

  /** Tyre surfaces: roads, shoulders, towns; terrain classified on demand. */
  _buildSurfaces() {
    const S = new SurfaceMap(this.terrain);
    for (const r of this.roads.all) {
      if (r.type === 'dirt') S.paintRoute(r, SURFACE.dirt, SURFACE.grass, 1.5);
      else if (r.render) S.paintRoute(r, SURFACE.asphalt, SURFACE.gravel, r.type === 'runway' ? 1 : 2.4);
    }
    // street circuits + paved areas
    for (const R of [CITY_RECT, ITO_RECT]) S.paintRect(R.minX - 12, R.minZ - 12, R.maxX + 12, R.maxZ + 12, SURFACE.asphalt);
    S.paintRect(CITY_RECT.minX - 90, CITY_RECT.minZ, CITY_RECT.minX, CITY_RECT.maxZ, SURFACE.concrete); // quay
    S.paintRect(PLAZA.minX, PLAZA.minZ, PLAZA.maxX, PLAZA.maxZ, SURFACE.asphalt);
    const L = this.legendZone;
    S.paintRect(L.x - 80, L.z - 60, L.x + 80, L.z + 60, SURFACE.asphalt);
    // re-assert asphalt on the main roads over any shoulder paint
    for (const r of this.roads.all) if (r.render && r.type !== 'dirt') S.paintRoute(r, SURFACE.asphalt, SURFACE.asphalt, 0);
    this.surfaces = S;
    this.physics.surfaceAt = (x, z) => S.at(x, z);
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
      { id: 'ramp-west', name: 'Sakura Leap', x: -130, z: -170, yaw: 0, width: 9, length: 15, height: 3.4, y: 0 },
      { id: 'ramp-north', name: 'Fuji Sky Jump', x: -250, z: 70, yaw: Math.PI / 2, width: 9, length: 16, height: 4.2, y: 0 },
      { id: 'ramp-docks', name: 'Dockyard Launch', x: -2745, z: 175, yaw: 0, width: 10, length: 18, height: 5.2, y: 0 },
      { id: 'ramp-legend', name: 'Legend Leap', x: this.legendZone.x + 20, z: this.legendZone.z - 95, yaw: Math.PI / 2, width: 10, length: 16, height: 4.6, y: this.legendZone.y },
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
      mesh.position.set(r.x, r.y + 0.01, r.z);
      mesh.rotation.y = r.yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.physics.addRamp(r);
      const sign = makeSignMesh('DANGER SIGN', r.name, '#ffd23f', '#16181f');
      const side = new THREE.Vector3(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
      const fwd = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      sign.position.set(r.x, r.y, r.z).addScaledVector(side, hw + 4).addScaledVector(fwd, -12);
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
    const C = (id) => this.roads.all.find((r) => r.id === id);
    this.stunts = [
      { id: 'trap-gantry', type: 'trap', name: 'Gantry Speed Trap', route: R.festival, index: at(R.festival, 0, 25), stars: [90, 115, 135] },
      { id: 'trap-east', type: 'trap', name: 'Riverside Trap', route: R.festival, index: at(R.festival, 320, 90), stars: [75, 95, 115] },
      { id: 'zone-lakeside', type: 'zone', name: 'Festival Speed Zone', route: R.festival, index: at(R.festival, 250, 240), end: at(R.festival, 300, 40), stars: [70, 90, 105] },
      { id: 'drift-temple', type: 'drift', name: 'Temple Drift Zone', route: R.festival, index: at(R.festival, 150, -250), end: at(R.festival, -10, -260), stars: [6000, 14000, 25000] },
      { id: 'trap-skyline', type: 'trap', name: 'Expressway Speed Trap', route: R.highway, index: at(R.highway, -1100, 1000), stars: [120, 145, 165] },
      { id: 'zone-hokubu', type: 'zone', name: 'Hokubu Plains Speed Zone', route: R.highway, index: at(R.highway, -450, 1482), end: at(R.highway, 300, 1500), stars: [110, 135, 155] },
      { id: 'drift-ohtani', type: 'drift', name: 'Ohtani Pass Drift Zone', route: R.mountain, index: at(R.mountain, -160, 1000), end: at(R.mountain, -760, 960), stars: [8000, 18000, 32000] },
      { id: 'trap-c1', type: 'trap', name: 'C1 Speed Trap', route: R.c1, index: at(R.c1, -1850, -1112), stars: [100, 125, 145] },
      { id: 'zone-c1', type: 'zone', name: 'C1 Speed Zone', route: R.c1, index: at(R.c1, -2387, -780), end: at(R.c1, -2387, -420), stars: [90, 112, 130] },
      { id: 'trap-neon', type: 'trap', name: 'Shibuya Speed Trap', route: R.city, index: at(R.city, -1950, -150), stars: [70, 90, 110] },
      { id: 'trap-cliff', type: 'trap', name: 'Ito Cliffs Speed Trap', route: R.coast, index: at(R.coast, -2150, -3200), stars: [105, 128, 148] },
      { id: 'zone-beach', type: 'zone', name: 'Ito Seaside Speed Zone', route: R.coast, index: at(R.coast, -2400, -1550), end: at(R.coast, -2480, -1800), stars: [100, 122, 142] },
      { id: 'trap-bridge', type: 'trap', name: 'Lake Loop Speed Trap', route: R.lake, index: at(R.lake, 2470, 1560), stars: [90, 110, 128] },
      { id: 'drift-haruna', type: 'drift', name: 'Haruna Drift Zone', route: R.touge, index: at(R.touge, 1600, 900), end: at(R.touge, 1850, 1250), stars: [9000, 20000, 36000] },
      { id: 'drift-summit', type: 'drift', name: 'Sotoyama Hairpins Drift Zone', route: R.summit, index: at(R.summit, -120, 2420), end: at(R.summit, -450, 2880), stars: [9000, 20000, 36000] },
      { id: 'drift-kiso', type: 'drift', name: 'Nangan Forest Drift Zone', route: R.rally, index: at(R.rally, 500, -2450), end: at(R.rally, 1500, -3050), stars: [9000, 20000, 34000] },
      { id: 'zone-runway', type: 'zone', name: 'Dock Strip Speed Zone', route: R.docks, index: at(R.docks, -2752, -1100), end: at(R.docks, -2752, 0), stars: [120, 150, 175] },
      { id: 'trap-legend', type: 'trap', name: 'Legend Island Speed Trap', route: R.island, index: at(R.island, -3700, -290), stars: [85, 105, 125] },
      { id: 'trap-bay', type: 'trap', name: 'Bay Bridge Speed Trap', route: C('c-bay-bridge'), index: at(C('c-bay-bridge'), -3000, -489), stars: [115, 140, 160] },
      { id: 'trap-harbour', type: 'trap', name: 'Ito Harbour Speed Trap', route: R.ito, index: at(R.ito, -2250, -2250), stars: [65, 85, 100] },
      { id: 'trap-farm', type: 'trap', name: 'Minamino Paddies Speed Trap', route: C('c-fest-minamino'), index: at(C('c-fest-minamino'), 1300, -500), stars: [90, 110, 130] },
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
      const si = r._wrap(Math.round(st.index - 14 / r.spacing));
      r.point(si, -(r.width / 2 + 4), sign.position);
      sign.position.y = r.bridge && r.bridge[si] ? r.ys[si] : this.heightAt(sign.position.x, sign.position.z);
      sign.rotation.y = r.yaw(st.index) + Math.PI;
      this.scene.add(sign);
    }
  }

  // ----------------------------------------------------------- Backdrop
  _buildBackdrop() {
    // Mt. Fuji and outer ranges far beyond the playable border mountains.
    // Unfogged but tinted towards the horizon colour so they read as distant.
    const snow = new THREE.Color('#eef2fb');
    const rock = new THREE.Color('#5a667c');
    const forest = new THREE.Color('#2f4538');
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
    const H = 3700, Rr = 7200;
    for (let i = 0; i <= 36; i++) {
      const t = i / 36;
      profile.push(new THREE.Vector2(i === 36 ? 260 : Rr * Math.pow(1 - t, 1.9) + 300 * (1 - t) + 260, t * H));
    }
    profile.push(new THREE.Vector2(0, H - 60));
    const fuji = new THREE.LatheGeometry(profile, 128);
    // gentle ridges down the flanks
    const fp = fuji.attributes.position;
    for (let k = 0; k < fp.count; k++) {
      const x = fp.getX(k), y = fp.getY(k), z = fp.getZ(k);
      const a = Math.atan2(z, x);
      const f = 1 + Math.sin(a * 23) * 0.025 * (1 - y / H) + Math.sin(a * 7 + 1) * 0.03 * (1 - y / H);
      fp.setX(k, x * f); fp.setZ(k, z * f);
    }
    fuji.translate(12500, -80, -1800); // west, beyond the border range (Tokyo looks out to sea)
    fuji.deleteAttribute('uv');
    colorize(fuji, -80, H, 0.55);
    fuji.computeVertexNormals();
    const ring = this._farTerrainRing();
    ring.computeVertexNormals();
    // far mountains get the same height fog as everything else (aerial perspective)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    for (const g of [fuji, ring]) {
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -2;
      this.scene.add(mesh);
    }
  }

  /**
   * Far terrain: a polar grid from just outside the playable square out to
   * 16 km, continuing the world's own relief (border ranges, coast) and
   * rising into big ridged mountains. Vertex-coloured forest/rock/snow.
   */
  _farTerrainRing() {
    const t = this.terrain;
    const A = 480, Rn = 60;
    const pos = [], col = [];
    const c = new THREE.Color();
    const forest = new THREE.Color('#2e4a33'), rock = new THREE.Color('#5d6470'), snow = new THREE.Color('#e4e9f2'), sea = new THREE.Color('#1d3d52');
    const heightAt = (x, z, r0, r) => {
      let h = t._rawHeight(x, z);
      const grow = THREE.MathUtils.smoothstep(r, r0 + 200, r0 + 4500);
      if (x > coastLine(z) + 300) h += grow * (ridgedFar(x / 2600, z / 2600) * 1700 + 150);
      return h;
    };
    const grid = [];
    for (let j = 0; j <= Rn; j++) {
      const row = [];
      for (let i = 0; i < A; i++) {
        const a = (i / A) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const r0 = (WORLD_HALF + 30) / Math.max(Math.abs(ca), Math.abs(sa));
        const f = j / Rn;
        const r = r0 + (16000 - r0) * f * f;
        const x = ca * r, z = sa * r;
        row.push([x, heightAt(x, z, r0, r), z]);
      }
      grid.push(row);
    }
    const idx = [];
    for (let j = 0; j <= Rn; j++) {
      for (let i = 0; i < A; i++) {
        const v = grid[j][i];
        pos.push(v[0], v[1], v[2]);
        const h = v[1];
        if (h < SEA_LEVEL + 1) c.copy(sea);
        else if (h > 950) c.copy(snow);
        else c.copy(forest).lerp(rock, THREE.MathUtils.smoothstep(h, 250, 950));
        col.push(c.r, c.g, c.b);
        if (j < Rn) {
          const a0 = j * A + i, b0 = j * A + ((i + 1) % A), c0 = (j + 1) * A + i, d0 = (j + 1) * A + ((i + 1) % A);
          idx.push(a0, c0, b0, b0, c0, d0);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
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
    for (const c of this.cities) c.setNight(lamps);
    this.landmarks.setNight(lamps);
    this.countryside?.setNight(lamps);
    this.water.setNight(n);
    if (this.gantryMat) this.gantryMat.emissiveIntensity = 1 + lamps * 2.5;
    if (this.veg) {
      const a = this.atmo;
      const sunCol = a.sun.color.clone().multiplyScalar(a.sun.intensity * 0.3);
      const imp = a.sun.color.clone().multiplyScalar(a.sun.intensity * 0.26).add(a.hemi.color.clone().multiplyScalar(a.hemi.intensity * 1.1));
      this.veg.setLighting(a._lightDir || a.sunDir, sunCol, imp);
    }
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
    this.terrain.update(camera.position);
    this.veg.update(dt, camera);
    this.water.update(dt);
    this.landmarks.update(dt);
    for (const c of this.cities) c.update?.(dt);
    this.countryside.update(dt, camera.position);
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
        const o = (iy * S + ix) * 4;
        const wl = t.waterLevelAt(x, z);
        if (wl != null && h < wl) {
          const depth = Math.min(1, (wl - h) / 25);
          img.data[o] = 28 - depth * 14; img.data[o + 1] = 78 - depth * 36; img.data[o + 2] = 108 - depth * 30; img.data[o + 3] = 255;
          continue;
        }
        t.normalAt(x, z, n);
        const shade = 0.55 + 0.6 * Math.max(0, n.dot(light));
        const forest = t.maskAt(x, z, 2);
        let r = 58 - forest * 16, g = 84 - forest * 10, b = 52 - forest * 8;
        const farm = t.mask2At(x, z, 1);
        if (farm > 0.4) { r += (104 - r) * 0.45; g += (112 - g) * 0.45; b += (58 - b) * 0.45; }
        if (t.mask2At(x, z, 0) > 0.4 && h < wl_or(t, x, z) + 3.5) { r = 196; g = 180; b = 138; }
        if (h > 150) { const k = Math.min(1, (h - 150) / 120); r += (120 - r) * k; g += (118 - g) * k; b += (116 - b) * k; }
        if (h > 230) { const k = Math.min(1, (h - 230) / 60); r += (225 - r) * k; g += (230 - g) * k; b += (238 - b) * k; }
        if (t.maskAt(x, z, 1) > 0.5) { r = 70; g = 72; b = 78; }
        img.data[o] = r * shade; img.data[o + 1] = g * shade; img.data[o + 2] = b * shade; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // town blocks and buildings
    const X = (x) => (t.half - x) / px, Y = (z) => (t.half - z) / px;
    for (const city of this.cities) {
      ctx.fillStyle = '#9a9aa2';
      for (const b of city.blocks) ctx.fillRect(X(b.maxX), Y(b.maxZ), (b.maxX - b.minX) / px, (b.maxZ - b.minZ) / px);
      ctx.fillStyle = '#c8c8d0';
      for (const b of city.buildings) if (b.y < city.baseY + 1) ctx.fillRect(X(b.x + b.w / 2), Y(b.z + b.d / 2), Math.max(1, b.w / px), Math.max(1, b.d / px));
    }
    this._mapCanvas = c;
    return c;
  }
}

function ridgedFar(x, z) {
  let sum = 0, amp = 0.55, freq = 1, prev = 1;
  for (let i = 0; i < 5; i++) {
    const n = Math.sin(x * freq * 1.7 + Math.sin(z * freq * 1.3) * 1.9) * Math.cos(z * freq * 1.1 + Math.sin(x * freq * 0.9) * 1.7);
    let r = 1 - Math.abs(n);
    r *= r;
    sum += r * amp * prev;
    prev = r;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

function wl_or(t, x, z) {
  return t.waterLevelAt(x, z) ?? SEA_LEVEL;
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
