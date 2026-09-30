import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';
import { SEA_LEVEL, LAKE, ISLAND, coastLine } from './Terrain.js';
import { ITO_RECT, ITO_Y } from './Roads.js';

/**
 * Landmarks.js
 * ------------
 * Hand-placed set pieces that give each region an identity:
 *  - Wind farm on the western downs (animated rotors, blinking beacons)
 *  - Five-storey pagoda on Lake Haruna's shore + a vermilion torii standing
 *    in the lake
 *  - Ito harbour: breakwater, lighthouse (rotating beam at night), fishing
 *    boats bobbing at their moorings, beach umbrellas on the Ito coast
 *  - Sotoyama ski resort: lodges, a hotel and two moving chairlifts
 *  - Legend Island festival stage with giant screens
 *  - Festival Ferris wheel (slowly turning, lit at night)
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class Landmarks {
  constructor(scene, physics, terrain, roads) {
    this.scene = scene;
    this.physics = physics;
    this.terrain = terrain;
    this.roads = roads;
    this.rng = mulberry32(9001);
    this.animated = [];
    this.nightMaterials = [];
    this.clearSpots = []; // {x, z, r} kept free of trees
    this.labels = []; // map labels { text, x, z }
    this.treeSpots = []; // extra trees to plant (Legend Island groves)
    this.time = 0;
    this.mats = {
      white: new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.55 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x9b978f, roughness: 0.88 }),
      vermilion: new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.5 }),
      darkWood: new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.8 }),
      roofTile: new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.6, metalness: 0.2 }),
      plaster: new THREE.MeshStandardMaterial({ color: 0xe6dfcf, roughness: 0.85 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.4, metalness: 0.7 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.1, metalness: 0.6 }),
    };
    this.lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe0a0, emissiveIntensity: 0.2 });
    this.redBeacon = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 1 });
    this.nightMaterials.push(this.lightMat);
  }

  build() {
    this._windFarm();
    this._pagodaAndTorii();
    this._harbour();
    this._skiResort();
    this._ferrisWheel();
    this._beachUmbrellas();
    return this;
  }

  _h(x, z) {
    return this.terrain.heightAt(x, z);
  }

  _add(obj, shadow = true) {
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = shadow; o.receiveShadow = true; } });
    this.scene.add(obj);
    return obj;
  }

  // ------------------------------------------------------------ Wind farm
  _windFarm() {
    const spots = [];
    const rnd = this.rng;
    for (let k = 0; k < 400 && spots.length < 14; k++) {
      const x = 2450 + rnd() * 1000, z = -1300 + rnd() * 2000;
      if (this.roads.nearest(x, z).d2 < 70 * 70) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 190)) continue;
      const y = this._h(x, z);
      if (y < 25) continue;
      spots.push({ x, z, y, yaw: 2.4 + (rnd() - 0.5) * 0.2, speed: 0.9 + rnd() * 0.3, phase: rnd() * 6 });
    }
    const towerGeo = mergeGeometries([
      new THREE.CylinderGeometry(1.1, 2.1, 72, 16).translate(0, 36, 0),
      new THREE.BoxGeometry(3, 3.2, 9).translate(0, 73, -1.5),
    ]);
    const hub = new THREE.SphereGeometry(1.6, 12, 8).scale(1, 1, 1.5).translate(0, 0, 3.4);
    const blade = new THREE.BoxGeometry(1.8, 30, 0.35).translate(0, 16.5, 3.4);
    const bladeGeos = [hub];
    for (let b = 0; b < 3; b++) bladeGeos.push(blade.clone().rotateZ((b / 3) * Math.PI * 2));
    const rotorGeo = mergeGeometries(bladeGeos);
    const towers = new THREE.InstancedMesh(towerGeo, this.mats.white, spots.length);
    const rotors = new THREE.InstancedMesh(rotorGeo, this.mats.white, spots.length);
    const beacons = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 6), this.redBeacon, spots.length);
    spots.forEach((s, i) => {
      _q.setFromAxisAngle(UP, s.yaw);
      towers.setMatrixAt(i, _m.compose(_p.set(s.x, s.y - 1, s.z), _q, _s));
      beacons.setMatrixAt(i, _m.compose(_p.set(s.x, s.y + 75, s.z - 1.5), _q, _s));
      this.physics.addStaticCylinder(_p.set(s.x, s.y - 1, s.z), 2, 36);
      this.clearSpots.push({ x: s.x, z: s.z, r: 16 });
    });
    rotors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const im of [towers, rotors, beacons]) { im.computeBoundingSphere(); this._add(im); }
    beacons.castShadow = false;
    this.turbines = { spots, rotors, angle: 0 };
    this.labels.push({ text: 'WIND FARM', x: 2950, z: -250 });
    this.animated.push((dt, t) => {
      const T = this.turbines;
      T.spots.forEach((s, i) => {
        _q.setFromEuler(_e.set(0, s.yaw, t * s.speed + s.phase, 'YXZ'));
        _p.set(s.x, s.y + 72.5, s.z).addScaledVector(_p2.set(Math.sin(s.yaw), 0, Math.cos(s.yaw)), 0);
        T.rotors.setMatrixAt(i, _m.compose(_p, _q, _s.set(1, 1, 1)));
      });
      T.rotors.instanceMatrix.needsUpdate = true;
      this.redBeacon.emissiveIntensity = (Math.sin(t * 3) > 0.6 ? 6 : 0.3);
    });
  }

  // -------------------------------------------------- Pagoda + torii (lake)
  _pagodaAndTorii() {
    const px = LAKE.x + 560, pz = LAKE.z + 120;
    const y0 = this._h(px, pz);
    const g = new THREE.Group();
    // stone platform
    const base = new THREE.Mesh(new THREE.BoxGeometry(18, 1.6, 18), this.mats.concrete);
    base.position.y = 0.3;
    g.add(base);
    let y = 1.1, w = 10;
    for (let tier = 0; tier < 5; tier++) {
      const h = tier === 0 ? 5 : 3.6;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), tier % 2 ? this.mats.plaster : this.mats.vermilion);
      body.position.y = y + h / 2;
      g.add(body);
      // flared roof: flattened pyramid + dark eave slab
      const eave = new THREE.Mesh(new THREE.BoxGeometry(w + 5.2, 0.45, w + 5.2), this.mats.darkWood);
      eave.position.y = y + h + 0.2;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry((w + 1) * 0.45, (w + 5.6) * 0.72, 1.6, 4, 1).rotateY(Math.PI / 4), this.mats.roofTile);
      roof.position.y = y + h + 1.1;
      g.add(eave, roof);
      y += h + 1.9;
      w *= 0.84;
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.35, 9, 8), this.mats.steel);
    spire.position.y = y + 4.2;
    g.add(spire);
    for (let r = 0; r < 7; r++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.12, 6, 12).rotateX(Math.PI / 2), this.mats.steel);
      ring.position.y = y + 1.5 + r * 0.9;
      g.add(ring);
    }
    g.position.set(px, y0, pz);
    g.rotation.y = 0.35;
    this._add(g);
    this.physics.addStaticBox(_p.set(px, y0 + 10, pz), new THREE.Vector3(8, 10, 8), 0.35);
    this.clearSpots.push({ x: px, z: pz, r: 26 });
    this.labels.push({ text: 'PAGODA', x: px, z: pz - 60 });
    this.pagoda = { x: px, z: pz };

    // torii standing in the lake
    const torii = this._toriiGeometry(15, 12);
    const tx = LAKE.x + 190, tz = LAKE.z - 170;
    const bed = this._h(tx, tz);
    const tm = new THREE.Mesh(torii, this.mats.vermilion);
    tm.position.set(tx, Math.min(bed, LAKE.level - 1.5), tz);
    tm.scale.y = (LAKE.level + 14 - tm.position.y) / 15;
    tm.rotation.y = 0.5;
    this._add(tm);
    // second, smaller torii at the pagoda approach
    const t2 = new THREE.Mesh(this._toriiGeometry(7.5, 6), this.mats.vermilion);
    t2.position.set(px + 34, this._h(px + 34, pz - 12), pz - 12);
    t2.rotation.y = 0.35 + Math.PI / 2;
    this._add(t2);
    this.physics.addStaticCylinder(_p.set(px + 34 + Math.cos(0.35) * 2.6, t2.position.y, pz - 12 - Math.sin(0.35) * 2.6), 0.4, 3.5);
    this.physics.addStaticCylinder(_p.set(px + 34 - Math.cos(0.35) * 2.6, t2.position.y, pz - 12 + Math.sin(0.35) * 2.6), 0.4, 3.5);
    this.labels.push({ text: 'LAKE HARUNA', x: LAKE.x, z: LAKE.z + 40 });
  }

  _toriiGeometry(h, span) {
    const r = h * 0.045;
    const parts = [
      new THREE.CylinderGeometry(r, r * 1.15, h, 12).translate(-span / 2, h / 2, 0),
      new THREE.CylinderGeometry(r, r * 1.15, h, 12).translate(span / 2, h / 2, 0),
      new THREE.BoxGeometry(span + h * 0.55, h * 0.07, h * 0.09).translate(0, h * 0.97, 0), // kasagi
      new THREE.BoxGeometry(span + h * 0.2, h * 0.05, h * 0.06).translate(0, h * 0.8, 0), // nuki
      new THREE.BoxGeometry(h * 0.05, h * 0.16, h * 0.05).translate(0, h * 0.88, 0),
    ];
    return mergeGeometries(parts);
  }

  // --------------------------------------------------------------- Harbour
  _harbour() {
    // Ito: the breakwater runs out east into the Pacific from the town
    const z0 = (ITO_RECT.minZ + ITO_RECT.maxZ) / 2 + 20;
    const cx = coastLine(z0);
    const x1 = cx - 360, x0 = cx + 70;
    const len = x0 - x1;
    // breakwater: concrete pier out to sea (driveable)
    const pierY = SEA_LEVEL + 3.2;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(len, 6, 14), this.mats.concrete);
    pier.position.set((x0 + x1) / 2, pierY - 3, z0);
    this._add(pier);
    this.physics.addStaticBox(pier.position.clone(), new THREE.Vector3(len / 2, 3, 7), 0);
    // tetrapod-ish armour blocks along the seaward side
    const block = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), this.mats.concrete, 80);
    for (let i = 0; i < 80; i++) {
      _q.setFromEuler(_e.set(this.rng() * 3, this.rng() * 3, this.rng() * 3));
      block.setMatrixAt(i, _m.compose(_p.set(x0 - 40 - (i / 80) * (len - 40), pierY - 3.2 + this.rng() * 1.5, z0 - 8.5 - this.rng() * 2.5), _q, _s.set(1, 1, 1)));
    }
    block.computeBoundingSphere();
    this._add(block);
    // lighthouse at the end
    const lh = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.2, 24, 20, 6), this.mats.white);
    tower.position.y = 12;
    const bands = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.9, 3, 20), this.mats.vermilion);
    bands.position.y = 8;
    const bands2 = bands.clone();
    bands2.position.y = 16;
    bands2.scale.set(0.9, 1, 0.9);
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.5, 20), this.mats.darkWood);
    gallery.position.y = 24.3;
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 16), this.lightMat);
    lamp.position.y = 25.8;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 2.4, 16), this.mats.vermilion);
    cap.position.y = 28.2;
    lh.add(tower, bands, bands2, gallery, lamp, cap);
    lh.position.set(x1 + 8, pierY, z0);
    this._add(lh);
    this.physics.addStaticCylinder(_p.set(x1 + 8, pierY, z0), 3.2, 12);
    // rotating light beam (visible at night)
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beamGeo = new THREE.ConeGeometry(9, 140, 20, 1, true).rotateZ(Math.PI / 2).translate(70, 0, 0);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(x1 + 8, pierY + 25.8, z0);
    this.scene.add(beam);
    this.beam = beam;
    this.animated.push((dt, t) => {
      beam.rotation.y = t * 0.9;
      beamMat.opacity = 0.16 * this.night;
      beam.visible = this.night > 0.05;
    });
    this.clearSpots.push({ x: cx, z: z0, r: 40 });
    this.labels.push({ text: 'ITO HARBOUR', x: (ITO_RECT.minX + ITO_RECT.maxX) / 2, z: ITO_RECT.maxZ + 70 });

    // fishing boats moored off the town
    const hull = new THREE.CylinderGeometry(1.6, 1.2, 9, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).rotateX(Math.PI);
    const boatGeo = mergeGeometries([
      hull.toNonIndexed(),
      new THREE.BoxGeometry(2.4, 1.8, 3).translate(0, 0.9, -1.2).toNonIndexed(),
      new THREE.CylinderGeometry(0.08, 0.08, 5, 5).translate(0, 2.6, 1.8).toNonIndexed(),
    ]);
    const boatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const boats = [];
    for (let i = 0; i < 12; i++) {
      const bz = z0 - 260 + this.rng() * 520;
      const bx = coastLine(bz) - 60 - this.rng() * 220;
      boats.push({ x: bx, z: bz, yaw: this.rng() * Math.PI * 2, ph: this.rng() * 6 });
    }
    const bm = new THREE.InstancedMesh(boatGeo, boatMat, boats.length);
    const col = new THREE.Color();
    boats.forEach((b, i) => bm.setColorAt(i, col.set(['#f2f2f2', '#2c5aa0', '#c8321e', '#f2c14e', '#2f8f6b'][i % 5])));
    bm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bm.computeBoundingSphere();
    this._add(bm);
    this.animated.push((dt, t) => {
      boats.forEach((b, i) => {
        _q.setFromEuler(_e.set(Math.sin(t * 0.9 + b.ph) * 0.05, b.yaw + Math.sin(t * 0.2 + b.ph) * 0.1, Math.sin(t * 1.1 + b.ph) * 0.08));
        bm.setMatrixAt(i, _m.compose(_p.set(b.x, SEA_LEVEL + 0.3 + Math.sin(t * 1.3 + b.ph) * 0.15, b.z), _q, _s.set(1, 1, 1)));
      });
      bm.instanceMatrix.needsUpdate = true;
      bm.computeBoundingSphere();
    });
  }

  // ------------------------------------------------------------- Ski resort
  _skiResort() {
    const r = this.roads.routes.summit;
    const i = r.count - 1;
    const bx = r.xs[i] - 70, bz = r.zs[i] + 60;
    const y0 = this._h(bx, bz);
    this.resort = { x: bx, z: bz };
    // lodges: timber chalets with steep roofs, and a big hotel
    const chalet = (x, z, w, d, h, yaw) => {
      const y = this._h(x, z);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mats.darkWood);
      body.position.y = h / 2;
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 - 1, 0); shape.lineTo(0, w * 0.55); shape.lineTo(w / 2 + 1, 0); shape.lineTo(-w / 2 - 1, 0);
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: d + 2, bevelEnabled: false }).translate(0, 0, -(d + 2) / 2), this.mats.snowRoof);
      roof.position.y = h;
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, h * 0.4), this.lightMat);
      win.position.set(0, h * 0.55, d / 2 + 0.05);
      g.add(body, roof, win);
      g.position.set(x, y - 0.3, z);
      g.rotation.y = yaw;
      this._add(g);
      this.physics.addStaticBox(_p.set(x, y + h / 2, z), new THREE.Vector3(w / 2, h / 2, d / 2), yaw);
      this.clearSpots.push({ x, z, r: Math.max(w, d) * 0.8 });
    };
    this.mats.snowRoof = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.75 });
    chalet(bx, bz + 40, 36, 18, 14, 0.2);
    chalet(bx + 45, bz + 10, 14, 12, 7, 0.9);
    chalet(bx - 45, bz + 15, 16, 12, 8, -0.5);
    chalet(bx + 20, bz - 30, 12, 10, 6, 0.3);
    chalet(bx - 25, bz - 35, 12, 10, 6, -0.2);
    // two chairlifts climbing the slopes behind the resort
    const lifts = [[[bx + 25, bz + 70], [bx + 200, bz + 620]], [[bx - 40, bz + 70], [bx - 330, bz + 560]]];
    const towerGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.35, 0.5, 1, 8).translate(0, 0.5, 0),
    ]);
    const armGeo = new THREE.BoxGeometry(6, 0.4, 0.5);
    const towers = [], arms = [];
    this.lifts = [];
    for (const [[ax, az], [cx, cz]] of lifts) {
      const L = Math.hypot(cx - ax, cz - az);
      const n = Math.max(3, Math.round(L / 70));
      const yaw = Math.atan2(cx - ax, cz - az);
      const line = [];
      for (let k = 0; k <= n; k++) {
        const x = ax + ((cx - ax) * k) / n, z = az + ((cz - az) * k) / n;
        const y = this._h(x, z);
        const H = k === 0 || k === n ? 6 : 10;
        towers.push({ x, y, z, H });
        arms.push({ x, y: y + H, z, yaw });
        line.push(new THREE.Vector3(x, y + H - 0.6, z));
        this.physics.addStaticCylinder(_p.set(x, y, z), 0.5, H / 2);
        this.clearSpots.push({ x, z, r: 6 });
      }
      this.lifts.push({ line, yaw, L });
    }
    const tm = new THREE.InstancedMesh(towerGeo, this.mats.steel, towers.length);
    towers.forEach((t, k) => tm.setMatrixAt(k, _m.compose(_p.set(t.x, t.y, t.z), _q.identity(), _s.set(1, t.H, 1))));
    const am = new THREE.InstancedMesh(armGeo, this.mats.steel, arms.length);
    arms.forEach((a, k) => { _q.setFromAxisAngle(UP, a.yaw); am.setMatrixAt(k, _m.compose(_p.set(a.x, a.y, a.z), _q, _s.set(1, 1, 1))); });
    for (const im of [tm, am]) { im.castShadow = true; im.computeBoundingSphere(); this._add(im); }
    // cables (two per lift, up and down) and moving chairs
    const cableGeos = [];
    for (const lf of this.lifts) {
      for (const side of [-1, 1]) {
        const off = new THREE.Vector3(Math.cos(lf.yaw) * 2.6 * side, 0, -Math.sin(lf.yaw) * 2.6 * side);
        const pts = lf.line.map((p) => p.clone().add(off));
        cableGeos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 4, 0.06, 4, false));
      }
    }
    const cm = new THREE.Mesh(mergeGeometries(cableGeos), this.mats.steel);
    this.scene.add(cm);
    const chairGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.04, 0.04, 2.2, 4).translate(0, -1.1, 0).toNonIndexed(),
      new THREE.BoxGeometry(1.8, 0.12, 0.6).translate(0, -2.2, 0).toNonIndexed(),
      new THREE.BoxGeometry(1.8, 0.6, 0.1).translate(0, -1.9, -0.3).toNonIndexed(),
    ]);
    const perLift = 18;
    const chairs = new THREE.InstancedMesh(chairGeo, new THREE.MeshStandardMaterial({ color: 0x2b6cb0, roughness: 0.5 }), perLift * 2 * this.lifts.length);
    chairs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    chairs.frustumCulled = false;
    this.scene.add(chairs);
    this.animated.push((dt, t) => {
      let k = 0;
      for (const lf of this.lifts) {
        for (const side of [-1, 1]) {
          for (let c = 0; c < perLift; c++) {
            let u = ((t * 2.2) / lf.L + c / perLift) % 1;
            if (side < 0) u = 1 - u;
            const f = u * (lf.line.length - 1);
            const i0 = Math.floor(f), i1 = Math.min(lf.line.length - 1, i0 + 1);
            _p.lerpVectors(lf.line[i0], lf.line[i1], f - i0);
            _p.x += Math.cos(lf.yaw) * 2.6 * side; _p.z -= Math.sin(lf.yaw) * 2.6 * side;
            _q.setFromAxisAngle(UP, lf.yaw + (side < 0 ? Math.PI : 0));
            chairs.setMatrixAt(k++, _m.compose(_p, _q, _s.set(1, 1, 1)));
          }
        }
      }
      chairs.instanceMatrix.needsUpdate = true;
    });
    this.labels.push({ text: 'SKI RESORT', x: bx, z: bz + 140 });
  }

  /** Legend Island festival grounds: stage, giant screens, flags. */
  legendStage(zone) {
    const { x, z, y } = zone;
    const g = new THREE.Group();
    const truss = this.mats.steel;
    // stage deck + roof truss
    const deck = new THREE.Mesh(new THREE.BoxGeometry(46, 2, 22), this.mats.concrete);
    deck.position.set(0, 1, 0);
    g.add(deck);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 22, 1.2), truss);
      post.position.set(sx * 22, 11, sz * 10);
      g.add(post);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(48, 1.6, 24), truss);
    roof.position.y = 22;
    g.add(roof);
    // screens either side of the stage + a big one on top
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const ctx = c.getContext('2d');
    const grd = ctx.createLinearGradient(0, 0, 512, 256);
    grd.addColorStop(0, '#ff2d8f'); grd.addColorStop(1, '#ffb13d');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'italic 800 84px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.fillText('LEGEND', 256, 120);
    ctx.font = '800 54px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.fillText('ISLAND', 256, 185);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const scr = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.1 });
    this.nightMaterials.push(scr);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 8), scr);
      m.position.set(sx * 32, 12, 2);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), truss);
      leg.position.set(sx * 32, 4, 1.5);
      g.add(m, leg);
    }
    const big = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), scr);
    big.position.set(0, 29, 0);
    g.add(big);
    // flags around the grounds
    const flagCols = [0xff2d8f, 0x2de2ff, 0xffd23f, 0xb6ff3b];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const fx = Math.cos(a) * 90, fz = Math.sin(a) * 70;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 10, 5), truss);
      pole.position.set(fx, 5, fz);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 4), new THREE.MeshStandardMaterial({ color: flagCols[k % 4], side: THREE.DoubleSide }));
      flag.position.set(fx + 0.6, 7.5, fz);
      g.add(pole, flag);
    }
    g.position.set(x - 60, y, z);
    g.rotation.y = Math.PI / 2;
    this._add(g);
    this.physics.addStaticBox(_p.set(x - 60, y + 1, z), new THREE.Vector3(11, 1, 23), Math.PI / 2);
    this.clearSpots.push({ x: x - 60, z, r: 40 });
    this.labels.push({ text: 'LEGEND FESTIVAL', x, z: z + 150 });

    // festival tents in an arc facing the stage
    const tents = [];
    for (let k = 0; k < 16; k++) {
      const a = -1.05 + (k / 15) * 2.1;
      tents.push({ x: x + 55 * Math.cos(a) + 25, z: z + 85 * Math.sin(a), yaw: a + Math.PI / 2, c: k % 5 });
    }
    const tentGeo = mergeGeometries([
      new THREE.BoxGeometry(6, 2.4, 6).translate(0, 1.2, 0).toNonIndexed(),
      new THREE.ConeGeometry(4.6, 2.2, 4).rotateY(Math.PI / 4).translate(0, 3.5, 0).toNonIndexed(),
    ]);
    const tm = new THREE.InstancedMesh(tentGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), tents.length);
    const col = new THREE.Color();
    tents.forEach((tn, k) => {
      const ty = this._h(tn.x, tn.z);
      _q.setFromAxisAngle(UP, tn.yaw);
      tm.setMatrixAt(k, _m.compose(_p.set(tn.x, ty, tn.z), _q, _s.set(1, 1, 1)));
      tm.setColorAt(k, col.set(['#ff2d8f', '#f4f4f4', '#2de2ff', '#ffd23f', '#f4f4f4'][tn.c]));
      this.physics.addStaticBox(_p.set(tn.x, ty + 1.2, tn.z), new THREE.Vector3(3, 1.2, 3), tn.yaw);
      this.clearSpots.push({ x: tn.x, z: tn.z, r: 6 });
    });
    tm.computeBoundingSphere();
    this._add(tm);
    // grandstand beside the island circuit's start straight
    const r = this.roads.routes.island;
    const si = r.nearestIndex(-3700, -290);
    const yaw = Math.atan2(r.tx[si], r.tz[si]);
    const side = -1;
    const gx = r.xs[si] + r.tz[si] * side * (r.width / 2 + 16), gz = r.zs[si] - r.tx[si] * side * (r.width / 2 + 16);
    const gy = this._h(gx, gz);
    const stand = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(70, 1, 3), k % 2 ? this.mats.white : this.mats.concrete);
      step.position.set(0, 0.5 + k * 1.1, k * 2.6);
      stand.add(step);
    }
    const sroof = new THREE.Mesh(new THREE.BoxGeometry(72, 0.5, 18), this.mats.steel);
    sroof.position.set(0, 12, 6);
    sroof.rotation.x = -0.12;
    stand.add(sroof);
    for (const px of [-34, 0, 34]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 12, 0.6), this.mats.steel); post.position.set(px, 6, 15); stand.add(post); }
    stand.position.set(gx, gy, gz);
    stand.rotation.y = yaw + Math.PI / 2 * 0 + (side < 0 ? Math.PI / 2 : -Math.PI / 2);
    this._add(stand);
    this.physics.addStaticBox(_p.set(gx, gy + 3, gz), new THREE.Vector3(35, 3, 8), stand.rotation.y);
    this.clearSpots.push({ x: gx, z: gz, r: 40 });
    // sakura and pine groves across the island (clear of the circuit and the grounds)
    for (let k = 0; k < 320; k++) {
      const a = this.rng() * Math.PI * 2, d = Math.sqrt(this.rng()) * (ISLAND.r - 55);
      const tx = ISLAND.x + Math.cos(a) * d, tz = ISLAND.z + Math.sin(a) * d;
      if (Math.hypot(tx - x, tz - z) < 135 || this.blocks(tx, tz)) continue;
      r.nearestIndex(tx, tz);
      if (r.lastDistanceSq < (r.width / 2 + 7) ** 2) continue;
      const bb = this.roads.all.find((q) => q.id === 'c-bay-bridge');
      bb.nearestIndex(tx, tz);
      if (bb.lastDistanceSq < (bb.width / 2 + 10) ** 2) continue;
      this.treeSpots.push({ x: tx, z: tz, type: this.rng() < 0.6 ? 'sakura' : 'pine' });
    }
  }

  // ------------------------------------------------------------ Ferris wheel
  _ferrisWheel() {
    const cx = 205, cz = -40, R = 24;
    const y0 = this._h(cx, cz);
    const g = new THREE.Group();
    const legGeo = new THREE.CylinderGeometry(0.5, 0.7, R + 6, 8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this.mats.steel);
      leg.position.set(sx * 7, (R + 6) / 2 - 0.5, sz * 3.2);
      leg.rotation.z = -sx * 0.27;
      g.add(leg);
    }
    const wheel = new THREE.Group();
    wheel.position.y = R + 5;
    const rimGeo = new THREE.TorusGeometry(R, 0.35, 8, 72);
    for (const z of [-1.6, 1.6]) { const rim = new THREE.Mesh(rimGeo, this.mats.white); rim.position.z = z; wheel.add(rim); }
    const spokes = [];
    for (let k = 0; k < 16; k++) {
      spokes.push(new THREE.CylinderGeometry(0.12, 0.12, R, 5).translate(0, R / 2, 1.6).rotateZ((k / 16) * Math.PI * 2));
      spokes.push(new THREE.CylinderGeometry(0.12, 0.12, R, 5).translate(0, R / 2, -1.6).rotateZ((k / 16) * Math.PI * 2));
    }
    wheel.add(new THREE.Mesh(mergeGeometries(spokes), this.mats.white));
    // lights on the rim (bloom at night)
    const bulbs = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      bulbs.push(new THREE.SphereGeometry(0.28, 6, 4).translate(Math.cos(a) * R, Math.sin(a) * R, 1.9));
    }
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff5fa8, emissiveIntensity: 0.3 });
    this.nightMaterials.push(bulbMat);
    wheel.add(new THREE.Mesh(mergeGeometries(bulbs), bulbMat));
    g.add(wheel);
    // gondolas hang from the rim and stay level
    const gondolaGeo = mergeGeometries([
      new THREE.CylinderGeometry(1.3, 1.1, 1.8, 8).translate(0, -1.9, 0),
      new THREE.ConeGeometry(1.4, 0.7, 8).translate(0, -0.7, 0),
    ]);
    const gondolaMat = new THREE.MeshStandardMaterial({ color: 0xff7ab8, roughness: 0.5 });
    const gondolas = new THREE.InstancedMesh(gondolaGeo, gondolaMat, 16);
    const gcol = new THREE.Color();
    for (let k = 0; k < 16; k++) gondolas.setColorAt(k, gcol.set(['#ff7ab8', '#2de2ff', '#ffd23f', '#b6ff3b'][k % 4]));
    gondolas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.add(gondolas);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 4.4, 12).rotateX(Math.PI / 2), this.mats.steel);
    hub.position.y = R + 5;
    g.add(hub);
    g.position.set(cx, y0, cz);
    g.rotation.y = 0.9;
    this._add(g);
    gondolas.frustumCulled = false;
    this.physics.addStaticBox(_p.set(cx, y0 + 4, cz), new THREE.Vector3(9, 4, 5), 0.9);
    this.clearSpots.push({ x: cx, z: cz, r: 32 });
    this.animated.push((dt, t) => {
      const a = t * 0.06;
      wheel.rotation.z = a;
      for (let k = 0; k < 16; k++) {
        const ang = a + (k / 16) * Math.PI * 2;
        gondolas.setMatrixAt(k, _m.compose(_p.set(Math.cos(ang) * R, R + 5 + Math.sin(ang) * R, 0), _q.identity(), _s.set(1, 1, 1)));
      }
      gondolas.instanceMatrix.needsUpdate = true;
    });
  }

  // ----------------------------------------------------------------- Beach
  _beachUmbrellas() {
    const spots = [];
    for (const [za, zb] of [[-1850, -1500], [-3150, -2750]]) {
      for (let z = za; z < zb; z += 14) {
        if (this.rng() < 0.4) continue;
        const x = coastLine(z) + 70 + this.rng() * 40;
        const y = this._h(x, z);
        if (y < SEA_LEVEL + 0.5 || y > SEA_LEVEL + 4.5) continue;
        spots.push({ x, y, z, c: Math.floor(this.rng() * 5), tilt: (this.rng() - 0.5) * 0.3 });
      }
    }
    const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5).translate(0, 1.25, 0);
    const canopy = new THREE.ConeGeometry(1.5, 0.6, 12, 1, true).translate(0, 2.5, 0);
    const pm = new THREE.InstancedMesh(pole, this.mats.white, spots.length);
    const cm = new THREE.InstancedMesh(canopy, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, side: THREE.DoubleSide }), spots.length);
    const col = new THREE.Color();
    spots.forEach((s, i) => {
      _q.setFromEuler(_e.set(s.tilt, 0, s.tilt * 0.5));
      _m.compose(_p.set(s.x, s.y, s.z), _q, _s.set(1, 1, 1));
      pm.setMatrixAt(i, _m); cm.setMatrixAt(i, _m);
      cm.setColorAt(i, col.set(['#ff5a5a', '#2de2ff', '#ffd23f', '#ff7ab8', '#f4f4f4'][s.c]));
    });
    for (const im of [pm, cm]) { im.computeBoundingSphere(); this._add(im); }
    this.labels.push({ text: 'ITO BEACH', x: coastLine(-2950) + 160, z: -2950 });
  }

  setNight(n) {
    this.night = n;
    for (const m of this.nightMaterials) m.emissiveIntensity = 0.2 + n * 5;
  }

  update(dt) {
    this.time += dt;
    for (const fn of this.animated) fn(dt, this.time);
  }

  /** true if (x,z) is inside a landmark's footprint (no trees there). */
  blocks(x, z) {
    for (const c of this.clearSpots) if (Math.abs(x - c.x) < c.r && Math.abs(z - c.z) < c.r && Math.hypot(x - c.x, z - c.z) < c.r) return true;
    return false;
  }
}

const _p2 = new THREE.Vector3();
export { ITO_Y };
