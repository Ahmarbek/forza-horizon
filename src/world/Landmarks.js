import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';
import { SEA_LEVEL, LAKE, coastLine } from './Terrain.js';
import { AIRFIELD, MINATO_RECT, MINATO_Y } from './Roads.js';

/**
 * Landmarks.js
 * ------------
 * Hand-placed set pieces that give each region an identity:
 *  - Wind farm on the north-west downs (animated rotors, blinking beacons)
 *  - Five-storey pagoda on Lake Sakura's west shore + a vermilion torii
 *    standing in the lake
 *  - Minato harbour: breakwater, lighthouse (rotating beam at night),
 *    fishing boats bobbing at their moorings, beach umbrellas
 *  - Sakura Village: traditional farmhouses (minka) and a small shrine
 *  - Summit observatory dome
 *  - Airfield hangars and control tower
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
    this._village();
    this._observatory();
    this._airfield();
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
      const x = 1150 + rnd() * 1100, z = 1750 + rnd() * 1400;
      if (this.roads.nearest(x, z).d2 < 70 * 70) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 190)) continue;
      const y = this._h(x, z);
      if (y < 25) continue;
      spots.push({ x, z, y, yaw: -0.6 + (rnd() - 0.5) * 0.2, speed: 0.9 + rnd() * 0.3, phase: rnd() * 6 });
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
    this.labels.push({ text: 'WIND FARM', x: 1700, z: 2450 });
    this.animated.push((dt, t) => {
      const T = this.turbines;
      T.spots.forEach((s, i) => {
        _q.setFromEuler(_e.set(0, s.yaw, t * s.speed + s.phase, 'YXZ'));
        _p.set(s.x, s.y + 72.5, s.z).addScaledVector(_p2.set(Math.sin(s.yaw), 0, Math.cos(s.yaw)), 0);
        T.rotors.setMatrixAt(i, _m.compose(_p, _q, _s));
      });
      T.rotors.instanceMatrix.needsUpdate = true;
      this.redBeacon.emissiveIntensity = (Math.sin(t * 3) > 0.6 ? 6 : 0.3);
    });
  }

  // -------------------------------------------------- Pagoda + torii (lake)
  _pagodaAndTorii() {
    const px = -640, pz = 2690;
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

    // torii standing in the lake
    const torii = this._toriiGeometry(15, 12);
    const tx = 360, tz = 2430;
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
    this.labels.push({ text: 'LAKE SAKURA', x: LAKE.x, z: LAKE.z + 40 });
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
    const z0 = -650;
    const cx = coastLine(z0);
    const x0 = cx - 70, x1 = cx + 360;
    const len = x1 - x0;
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
      block.setMatrixAt(i, _m.compose(_p.set(x0 + 40 + (i / 80) * (len - 40), pierY - 3.2 + this.rng() * 1.5, z0 - 8.5 - this.rng() * 2.5), _q, _s.set(1, 1, 1)));
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
    lh.position.set(x1 - 8, pierY, z0);
    this._add(lh);
    this.physics.addStaticCylinder(_p.set(x1 - 8, pierY, z0), 3.2, 12);
    // rotating light beam (visible at night)
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beamGeo = new THREE.ConeGeometry(9, 140, 20, 1, true).rotateZ(Math.PI / 2).translate(70, 0, 0);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(x1 - 8, pierY + 25.8, z0);
    this.scene.add(beam);
    this.beam = beam;
    this.animated.push((dt, t) => {
      beam.rotation.y = t * 0.9;
      beamMat.opacity = 0.16 * this.night;
      beam.visible = this.night > 0.05;
    });
    this.clearSpots.push({ x: cx, z: z0, r: 40 });
    this.labels.push({ text: 'MINATO BAY', x: (MINATO_RECT.minX + MINATO_RECT.maxX) / 2, z: MINATO_RECT.maxZ + 70 });

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
      const bz = z0 + 40 + this.rng() * 520;
      const bx = coastLine(bz) + 60 + this.rng() * 220;
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

  // --------------------------------------------------------------- Village
  _village() {
    const houses = [];
    const rnd = this.rng;
    const lane = this.roads.all.find((r) => r.id === 'c-village-ew');
    if (lane) {
      for (let i = 20; i < lane.count - 20; i += 7) {
        for (const side of [-1, 1]) {
          if (rnd() < 0.45) continue;
          const off = side * (lane.width / 2 + 9 + rnd() * 10);
          const x = lane.xs[i] + lane.tz[i] * off, z = lane.zs[i] - lane.tx[i] * off;
          if (this.roads.nearest(x, z).d2 < 11 * 11) continue;
          if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 16)) continue;
          houses.push({ x, z, yaw: Math.atan2(lane.tx[i], lane.tz[i]) + (rnd() < 0.5 ? 0 : Math.PI / 2), s: 0.85 + rnd() * 0.35 });
        }
      }
    }
    // minka: plastered walls on a dark timber frame, heavy hip roof
    const walls = new THREE.BoxGeometry(10, 3.4, 7).translate(0, 1.7, 0);
    const frame = mergeGeometries([
      new THREE.BoxGeometry(10.3, 0.35, 7.3).translate(0, 3.35, 0),
      new THREE.BoxGeometry(10.3, 0.5, 7.3).translate(0, 0.25, 0),
    ]);
    const roof = new THREE.CylinderGeometry(1.2, 7.2, 3.6, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, 0.78).translate(0, 5.2, 0);
    const wm = new THREE.InstancedMesh(walls, this.mats.plaster, houses.length);
    const fm = new THREE.InstancedMesh(frame, this.mats.darkWood, houses.length);
    const rm = new THREE.InstancedMesh(roof, this.mats.roofTile, houses.length);
    houses.forEach((h, i) => {
      const y = this._h(h.x, h.z);
      _q.setFromAxisAngle(UP, h.yaw);
      _m.compose(_p.set(h.x, y - 0.2, h.z), _q, _s.set(h.s, h.s, h.s));
      wm.setMatrixAt(i, _m); fm.setMatrixAt(i, _m); rm.setMatrixAt(i, _m);
      this.physics.addStaticBox(_p.set(h.x, y + 1.7, h.z), new THREE.Vector3(5 * h.s, 1.9, 3.5 * h.s), h.yaw);
      this.clearSpots.push({ x: h.x, z: h.z, r: 9 });
    });
    for (const im of [wm, fm, rm]) { im.computeBoundingSphere(); this._add(im); }
    this.villageHouses = houses;
    this.labels.push({ text: 'SAKURA VILLAGE', x: 1650, z: -2330 });
  }

  // ----------------------------------------------------------- Observatory
  _observatory() {
    const r = this.roads.routes.summit;
    const i = r.count - 1;
    const x = r.xs[i] + r.tz[i] * 34, z = r.zs[i] - r.tx[i] * 34;
    const y = this._h(x, z);
    const g = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 8, 32), this.mats.white);
    drum.position.y = 4;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(9.2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), this.mats.steel);
    dome.position.y = 8;
    const slit = new THREE.Mesh(new THREE.BoxGeometry(2, 9.5, 8), this.mats.glass);
    slit.position.set(0, 11.5, 3);
    slit.rotation.x = -0.5;
    const annex = new THREE.Mesh(new THREE.BoxGeometry(16, 5, 10), this.mats.white);
    annex.position.set(13, 2.5, 0);
    g.add(drum, dome, slit, annex);
    g.position.set(x, y - 0.5, z);
    this._add(g);
    this.physics.addStaticCylinder(_p.set(x, y - 0.5, z), 9, 6);
    this.physics.addStaticBox(_p.set(x + 13, y + 2, z), new THREE.Vector3(8, 2.5, 5), 0);
    this.clearSpots.push({ x, z, r: 30 });
    this.labels.push({ text: 'SUMMIT OBSERVATORY', x, z: z - 70 });
  }

  // --------------------------------------------------------------- Airfield
  _airfield() {
    const A = AIRFIELD;
    const zH = A.minZ - 70;
    const y = this.terrain.baseHeight((A.minX + A.maxX) / 2, A.minZ);
    // arched hangars
    const archShape = new THREE.Shape();
    archShape.moveTo(-22, 0);
    archShape.absarc(0, 0, 22, Math.PI, 0, true);
    archShape.lineTo(-22, 0);
    const hangarGeo = new THREE.ExtrudeGeometry(archShape, { depth: 40, bevelEnabled: false, curveSegments: 24 }).translate(0, 0, -20);
    hangarGeo.scale(1, 0.55, 1);
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0x8c949c, roughness: 0.45, metalness: 0.6 });
    for (let k = 0; k < 3; k++) {
      const hx = A.minX + 260 + k * 70;
      const h = new THREE.Mesh(hangarGeo, hangarMat);
      h.position.set(hx, y, zH);
      this._add(h);
      this.physics.addStaticBox(_p.set(hx, y + 6, zH), new THREE.Vector3(22, 6, 20), 0);
    }
    // control tower
    const tw = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(5, 22, 5), this.mats.white);
    shaft.position.y = 11;
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 4.2, 4, 8), this.mats.glass);
    cab.position.y = 24;
    const roofT = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.6, 8), this.mats.white);
    roofT.position.y = 26.3;
    tw.add(shaft, cab, roofT);
    tw.position.set(A.minX + 520, y, zH + 10);
    this._add(tw);
    this.physics.addStaticBox(_p.set(A.minX + 520, y + 11, zH + 10), new THREE.Vector3(2.5, 11, 2.5), 0);
    // runway edge lights (glow at night)
    const lights = [];
    for (let x = A.minX + 20; x < A.maxX - 10; x += 30) for (const z of [2678, 2722]) lights.push([x, z]);
    const lm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), this.lightMat, lights.length);
    lights.forEach(([lx, lz], i) => lm.setMatrixAt(i, _m.compose(_p.set(lx, y + 0.15, lz), _q.identity(), _s.set(1, 1, 1))));
    lm.computeBoundingSphere();
    this._add(lm, false);
    this.clearSpots.push({ x: A.minX + 350, z: zH, r: 140 });
    this.labels.push({ text: 'AIRFIELD', x: (A.minX + A.maxX) / 2, z: A.maxZ + 60 });
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
    for (const [za, zb] of [[-1350, -900], [-60, 480]]) {
      for (let z = za; z < zb; z += 14) {
        if (this.rng() < 0.4) continue;
        const x = coastLine(z) - 70 - this.rng() * 40;
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
    this.labels.push({ text: 'SUNSET BEACH', x: coastLine(200) - 60, z: 200 });
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
export { MINATO_Y };
