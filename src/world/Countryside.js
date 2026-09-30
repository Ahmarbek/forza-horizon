import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';
import { ChunkedInstances } from './Instancing.js';
import { snowLineAt } from './Terrain.js';

/**
 * Countryside.js
 * --------------
 * Everything that makes rural Japan look lived-in, generated along the road
 * network so the map is never empty:
 *  - Hamlets: clusters of modern two-storey houses and old minka farmhouses
 *    beside country roads and out in the rice plains, with vending machines
 *  - Utility poles with sagging wires along every country road
 *  - High-voltage pylon lines striding across the plains towards Tokyo
 *  - The Shinkansen: an elevated viaduct from Tokyo across Hokubu into the
 *    Shimanoyama hills, with a bullet train running back and forth
 * All instanced and spatially chunked so it culls.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** Shinkansen alignment (x, z): Tokyo terminal → Hokubu → tunnel into Shimanoyama. */
export const SHINKANSEN = [
  [-1850, 330], [-1650, 620], [-1350, 950], [-950, 1250], [-450, 1560], [150, 1680], [700, 1650], [1150, 1560], [1420, 1450],
];

export class Countryside {
  /**
   * @param {object} o { scene, physics, terrain, roads, avoid(x,z) }
   */
  constructor({ scene, physics, terrain, roads, avoid }) {
    this.scene = scene;
    this.physics = physics;
    this.terrain = terrain;
    this.roads = roads;
    this.avoid = avoid || (() => false);
    this.rng = mulberry32(2026);
    this.instanceCount = 0;
    this.houses = [];
    this.treeSpots = []; // windbreak trees around farmsteads (grown by the vegetation)
    this.clearSpots = [];
    this.labels = [];
    this.chunked = [];
    this._indexRoads();
  }

  build() {
    this._buildShinkansen();
    this._buildHamlets();
    this._buildFarmDressing();
    this._buildUtilityPoles();
    this._buildPylons();
    return this;
  }

  // ------------------------------------------------------------ Road index
  /** Spatial hash of road samples for fast "distance to nearest road" queries. */
  _indexRoads() {
    const C = 40;
    this.cellSize = C;
    this.grid = new Map();
    for (const r of this.roads.all) {
      if (!r.render && !r.flat) continue;
      for (let i = 0; i < r.count; i += 2) {
        if (r.elevated && r.bridge && r.bridge[i]) continue;
        const k = `${Math.floor(r.xs[i] / C)},${Math.floor(r.zs[i] / C)}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(r.xs[i], r.zs[i], r.width / 2);
      }
    }
  }

  /** Distance from x,z to the nearest road edge (∞ beyond ~80 m). */
  roadEdgeDist(x, z) {
    const C = this.cellSize;
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    let best = Infinity;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const l = this.grid.get(`${cx + a},${cz + b}`);
      if (!l) continue;
      for (let i = 0; i < l.length; i += 3) {
        const d = Math.hypot(l[i] - x, l[i + 1] - z) - l[i + 2];
        if (d < best) best = d;
      }
    }
    return best;
  }

  _slopeOk(x, z, minY = 0.93) {
    return this.terrain.normalAt(x, z, _a).y > minY;
  }

  _free(x, z, r) {
    for (const h of this.houses) if (Math.abs(h.x - x) < r && Math.abs(h.z - z) < r) return false;
    return true;
  }

  /** true near the Shinkansen viaduct (keeps tall trees from growing through the deck). */
  nearRail(x, z) {
    if (!this.train) return false;
    const { pts, portal } = this.train;
    if (!this._railBox) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const p of pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
      this._railBox = [a - 20, b + 20, c - 20, d + 20];
    }
    const [a, b, c, d] = this._railBox;
    if (x < a || x > b || z < c || z > d) return false;
    for (let i = 0; i <= portal; i += 2) if (Math.abs(pts[i].x - x) < 14 && Math.abs(pts[i].z - z) < 14) return true;
    return false;
  }

  blocks(x, z) {
    for (const c of this.clearSpots) if (Math.abs(x - c.x) < c.r && Math.abs(z - c.z) < c.r) return true;
    return false;
  }

  // ---------------------------------------------------------------- Hamlets
  _buildHamlets() {
    const t = this.terrain, rnd = this.rng;
    const houses = this.houses;
    const tryHouse = (x, z, yaw, kind) => {
      if (t.isWater(x, z, -2) || this.avoid(x, z) || this.blocks(x, z)) return false;
      if (this.roadEdgeDist(x, z) < 8) return false;
      if (!this._free(x, z, 15)) return false;
      if (!this._slopeOk(x, z)) return false;
      const y = t.heightAt(x, z);
      if (y > snowLineAt(z) - 30 || y < 0.5) return false;
      houses.push({ x, z, y, yaw, kind, s: 0.85 + rnd() * 0.35, c: Math.floor(rnd() * 6) });
      return true;
    };
    // clusters beside the country roads
    for (const r of this.roads.all) {
      if (!r.render || r.elevated || r.type === 'highway' || r.type === 'circuit' || r.type === 'runway') continue;
      const step = Math.max(1, Math.round(210 / r.spacing));
      for (let i = Math.floor(rnd() * step); i < r.count; i += step) {
        if (r.bridge && r.bridge[i]) continue;
        const x0 = r.xs[i], z0 = r.zs[i];
        const farm = t.farmWeight(x0, z0);
        const forest = t.maskAt(x0, z0, 2);
        if (rnd() > 0.5 + farm * 0.45 - forest * 0.3) continue;
        const n = 4 + Math.floor(rnd() * (6 + farm * 8));
        let made = 0;
        for (let k = 0; k < n * 5 && made < n; k++) {
          const along = (rnd() - 0.5) * 170;
          const side = rnd() < 0.5 ? -1 : 1;
          const lat = side * (r.width / 2 + 12 + rnd() * 60);
          const j = r._wrap(i + Math.round(along / r.spacing));
          const x = r.xs[j] + r.tz[j] * lat, z = r.zs[j] - r.tx[j] * lat;
          const yaw = Math.atan2(r.tx[j], r.tz[j]) + (rnd() < 0.7 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.15;
          if (tryHouse(x, z, yaw, rnd() < 0.3 ? 'minka' : 'house')) made++;
        }
        // a vending machine or two at the roadside
        if (made > 2) {
          for (let v = 0; v < 1 + (rnd() < 0.4 ? 1 : 0); v++) {
            const j = r._wrap(i + Math.round((rnd() - 0.5) * 60 / r.spacing));
            const side = rnd() < 0.5 ? -1 : 1;
            const lat = side * (r.width / 2 + 2.6);
            const x = r.xs[j] + r.tz[j] * lat, z = r.zs[j] - r.tx[j] * lat;
            if (this.roadEdgeDist(x, z) < 1.8 || t.isWater(x, z, -1)) continue;
            (this.vending ||= []).push({ x, z, y: t.heightAt(x, z), yaw: Math.atan2(r.tx[j], r.tz[j]) + (side > 0 ? -Math.PI / 2 : Math.PI / 2), c: Math.floor(rnd() * 4) });
          }
        }
      }
    }
    // lone farmsteads out in the rice plains
    for (let z = -3600; z < 3000; z += 170) {
      for (let x = -3000; x < 3600; x += 170) {
        const px = x + (rnd() - 0.5) * 150, pz = z + (rnd() - 0.5) * 150;
        if (t.farmWeight(px, pz) < 0.6 || rnd() > 0.3) continue;
        const k = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < k; j++) tryHouse(px + (rnd() - 0.5) * 40, pz + (rnd() - 0.5) * 40, Math.floor(rnd() * 4) * Math.PI / 2 + 0.34, rnd() < 0.5 ? 'minka' : 'house');
      }
    }

    // ---- meshes
    const house = houses.filter((h) => h.kind === 'house');
    const minka = houses.filter((h) => h.kind === 'minka');
    // modern two-storey house: siding body with windows, gable roof, balcony
    const bodyTex = this._houseTexture();
    const bodyMat = new THREE.MeshStandardMaterial({ map: bodyTex, roughness: 0.8 });
    const body = new THREE.BoxGeometry(8.5, 6, 7).translate(0, 3, 0);
    const shape = new THREE.Shape();
    shape.moveTo(-4.9, 0); shape.lineTo(0, 2.6); shape.lineTo(4.9, 0); shape.lineTo(-4.9, 0);
    const roof = new THREE.ExtrudeGeometry(shape, { depth: 7.9, bevelEnabled: false }).translate(0, 5.95, -3.95);
    const balcony = new THREE.BoxGeometry(4, 0.2, 1.3).translate(-1.5, 3.1, 4.1);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.2 });
    const wallCols = ['#f1ede4', '#e4dccb', '#cfd3d6', '#d9c9b0', '#b9b7b0', '#f4f1ea'];
    const roofCols = ['#2f3a4a', '#3d3f44', '#5a3a2e', '#2d4a5a', '#4a4f55', '#6b2f2a'];
    this._instanced(house, [
      [body, bodyMat, (h, c) => c.set(wallCols[h.c])],
      [roof, roofMat, (h, c) => c.set(roofCols[(h.c * 7) % 6])],
      [balcony, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.5 })],
    ]);
    // minka: plaster walls on a dark timber frame under a heavy hip roof
    const plaster = new THREE.MeshStandardMaterial({ color: 0xe6dfcf, roughness: 0.85 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.8 });
    const tile = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.6, metalness: 0.2 });
    this._instanced(minka, [
      [new THREE.BoxGeometry(10, 3.4, 7).translate(0, 1.7, 0), plaster],
      [mergeGeometries([new THREE.BoxGeometry(10.3, 0.35, 7.3).translate(0, 3.35, 0), new THREE.BoxGeometry(10.3, 0.5, 7.3).translate(0, 0.25, 0)]), wood],
      [new THREE.CylinderGeometry(1.2, 7.2, 3.6, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, 0.78).translate(0, 5.2, 0), tile],
    ]);
    for (const h of houses) {
      const hx = h.kind === 'house' ? 4.3 : 5, hz = h.kind === 'house' ? 3.5 : 3.5;
      this.physics.addStaticBox(_p.set(h.x, h.y + 2, h.z), new THREE.Vector3(hx * h.s, 2.4, hz * h.s), h.yaw);
      this.clearSpots.push({ x: h.x, z: h.z, r: 8 * h.s });
    }
    // vending machines (lit front panel)
    const vend = this.vending || [];
    const vendMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const panelMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.2 });
    this.vendPanel = panelMat;
    const vendCols = ['#d7262e', '#1f5fb5', '#f2f2f2', '#2a8f4c'];
    this._instanced(vend.map((v) => ({ ...v, s: 1 })), [
      [new THREE.BoxGeometry(1, 1.85, 0.8).translate(0, 0.925, 0), vendMat, (v, c) => c.set(vendCols[v.c])],
      [new THREE.PlaneGeometry(0.8, 1.1).translate(0, 1.2, 0.41), panelMat],
    ], false);
    for (const v of vend) this.physics.addStaticBox(_p.set(v.x, v.y + 0.9, v.z), new THREE.Vector3(0.5, 0.9, 0.4), v.yaw);
    this.instanceCount += houses.length + vend.length;
  }

  // ------------------------------------------------------------ Farm dressing
  /** Windbreak trees round the farmsteads, plastic greenhouses, sheds and little shrines. */
  _buildFarmDressing() {
    const t = this.terrain, rnd = this.rng;
    const sheds = [], tunnels = [], torii = [];
    for (const h of this.houses) {
      const farm = t.farmWeight(h.x, h.z);
      // yashikirin: a few trees shading each farmhouse
      const nt = 1 + Math.floor(rnd() * (farm > 0.5 ? 4 : 2));
      for (let k = 0; k < nt; k++) {
        const a = rnd() * Math.PI * 2, d = 11 + rnd() * 8;
        const x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
        if (this.roadEdgeDist(x, z) < 4 || t.isWater(x, z, -1)) continue;
        this.treeSpots.push({ x, z, type: rnd() < 0.25 ? 'pine' : rnd() < 0.2 ? 'sakura' : 'broad' });
      }
      // a corrugated shed beside most farmhouses
      if (farm > 0.3 && rnd() < 0.6) {
        const a = h.yaw + (rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
        const x = h.x + Math.sin(a) * 10, z = h.z + Math.cos(a) * 10;
        if (this.roadEdgeDist(x, z) > 5 && this._free(x, z, 6)) sheds.push({ x, z, y: t.heightAt(x, z), yaw: h.yaw, s: 0.8 + rnd() * 0.4 });
      }
      // vinyl greenhouse tunnels out in the fields
      if (farm > 0.5 && rnd() < 0.18) {
        const yaw = h.yaw + (rnd() < 0.5 ? 0 : Math.PI / 2);
        const cx = h.x + Math.sin(h.yaw + 1.2) * 45, cz = h.z + Math.cos(h.yaw + 1.2) * 45;
        const n = 3 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const off = (k - (n - 1) / 2) * 8;
          const x = cx + Math.cos(yaw) * off, z = cz - Math.sin(yaw) * off;
          if (this.roadEdgeDist(x, z) < 26 || !this._free(x, z, 12) || !this._slopeOk(x, z, 0.97) || t.isWater(x, z, -1)) continue;
          tunnels.push({ x, z, y: t.heightAt(x, z), yaw, s: 1 });
        }
      }
    }
    // shrines at the edge of some hamlets, where the woods begin
    for (let k = 0; k < this.houses.length; k += 9) {
      const h = this.houses[k];
      const a = rnd() * Math.PI * 2;
      const x = h.x + Math.cos(a) * 40, z = h.z + Math.sin(a) * 40;
      if (this.roadEdgeDist(x, z) < 8 || !this._free(x, z, 14) || t.isWater(x, z, -1) || !this._slopeOk(x, z)) continue;
      torii.push({ x, z, y: t.heightAt(x, z), yaw: a, s: 1 });
      this.clearSpots.push({ x, z, r: 8 });
    }
    const shedGeo = mergeGeometries([
      new THREE.BoxGeometry(6, 3.2, 4.5).translate(0, 1.6, 0),
      new THREE.BoxGeometry(6.6, 0.25, 5.2).rotateX(0.18).translate(0, 3.45, 0),
    ]);
    const tin = new THREE.MeshStandardMaterial({ color: 0x8c9296, roughness: 0.55, metalness: 0.5 });
    this._instanced(sheds, [[shedGeo, tin, (sh, c) => c.set(['#8c9296', '#6f8f9c', '#9c6f58', '#b0b3b0'][Math.floor(sh.s * 10) % 4])]]);
    for (const sh of sheds) this.physics.addStaticBox(_p.set(sh.x, sh.y + 1.6, sh.z), new THREE.Vector3(3 * sh.s, 1.6, 2.25 * sh.s), sh.yaw);
    // greenhouse: half-cylinder of milky plastic over hoops
    const tunnelGeo = new THREE.CylinderGeometry(3, 3, 32, 12, 1, true, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2).translate(0, 0.2, 0);
    const plastic = new THREE.MeshStandardMaterial({ color: 0xeef2f0, roughness: 0.35, transparent: true, opacity: 0.82, side: THREE.DoubleSide });
    this._instanced(tunnels, [[tunnelGeo, plastic]], false);
    for (const tu of tunnels) this.physics.addStaticBox(_p.set(tu.x, tu.y + 1.5, tu.z), new THREE.Vector3(3, 1.5, 16), tu.yaw);
    // torii + tiny shrine (hokora)
    const vermilion = new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.5 });
    const toriiGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.22, 0.26, 5, 8).translate(-2, 2.5, 0),
      new THREE.CylinderGeometry(0.22, 0.26, 5, 8).translate(2, 2.5, 0),
      new THREE.BoxGeometry(5.8, 0.35, 0.45).translate(0, 4.9, 0),
      new THREE.BoxGeometry(4.8, 0.25, 0.3).translate(0, 4.1, 0),
    ]);
    this._instanced(torii, [
      [toriiGeo, vermilion],
      [mergeGeometries([new THREE.BoxGeometry(1.4, 1.3, 1.2).translate(0, 0.65, -5), new THREE.ConeGeometry(1.25, 0.8, 4).rotateY(Math.PI / 4).translate(0, 1.7, -5)]),
        new THREE.MeshStandardMaterial({ color: 0x6b4a34, roughness: 0.8 })],
    ]);
    for (const to of torii) for (const sd of [-1, 1]) this.physics.addStaticCylinder(_p.set(to.x + Math.cos(to.yaw) * 2 * sd, to.y, to.z - Math.sin(to.yaw) * 2 * sd), 0.26, 2.5);
    this.instanceCount += sheds.length + tunnels.length + torii.length * 2;
  }

  /** Instanced parts sharing one transform per item: [[geometry, material, colorFn?], ...]. */
  _instanced(items, parts, shadow = true) {
    if (!items.length) return;
    for (const [geo, mat, colorFn] of parts) {
      const ci = new ChunkedInstances(this.scene, geo, mat, items, {
        chunk: 400, colors: !!colorFn, castShadow: shadow, maxDistance: 2600,
        write: (h, mm, c) => {
          _q.setFromAxisAngle(UP, h.yaw);
          mm.compose(_p.set(h.x, h.y - 0.15, h.z), _q, _s.set(h.s, h.s, h.s));
          if (colorFn) colorFn(h, c);
        },
      });
      this.chunked.push(ci);
    }
  }

  _houseTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 128);
    // horizontal siding lines
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < 128; y += 6) ctx.fillRect(0, y, 256, 1);
    // two floors of windows + a door
    const win = (x, y, w, h) => {
      ctx.fillStyle = '#5b5f63'; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, '#2c3e50'); g.addColorStop(1, '#6f8ca3');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x + w / 2 - 1, y, 2, h);
    };
    win(28, 18, 50, 30); win(150, 18, 60, 30); win(28, 76, 60, 34); win(170, 76, 40, 30);
    ctx.fillStyle = '#6b4a34'; ctx.fillRect(110, 70, 30, 58);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // ------------------------------------------------------------ Utility poles
  _buildUtilityPoles() {
    const t = this.terrain;
    const poles = [], wires = [];
    const J = this.roads.junctions();
    const nearJ = (x, z) => J.some(([jx, jz]) => Math.abs(x - jx) < 22 && Math.abs(z - jz) < 22);
    for (const r of this.roads.all) {
      if (!r.render || r.elevated || r.type === 'highway' || r.type === 'runway') continue;
      const side = (r.id.length % 2) ? 1 : -1;
      const step = Math.max(1, Math.round(34 / r.spacing));
      let prev = null;
      for (let i = 0; i < r.count; i += step) {
        const off = side * (r.width / 2 + 3.4);
        const x = r.xs[i] + r.tz[i] * off, z = r.zs[i] - r.tx[i] * off;
        const skip = (r.bridge && r.bridge[i]) || nearJ(x, z) || t.isWater(x, z, -0.5) || this.roadEdgeDist(x, z) < 2.2
          || this.avoid(x, z) || Math.abs(t.heightAt(x, z) - r.ys[i]) > 2.5;
        if (skip) { prev = null; continue; }
        const y = t.heightAt(x, z);
        const pole = { x, y, z, yaw: Math.atan2(r.tx[i], r.tz[i]) };
        poles.push(pole);
        if (prev && Math.hypot(prev.x - x, prev.z - z) < 48) {
          // three wires: the two cross-arm ends and a lower telecom line
          for (const [lat, h] of [[-0.75, 8.6], [0.75, 8.6], [0, 6.9]]) {
            const ax = prev.x + Math.cos(prev.yaw) * lat, az = prev.z - Math.sin(prev.yaw) * lat;
            const bx = x + Math.cos(pole.yaw) * lat, bz = z - Math.sin(pole.yaw) * lat;
            this._catenary(wires, ax, prev.y + h, az, bx, y + h, bz, 0.7, 3);
          }
        }
        prev = pole;
      }
    }
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.13, 0.19, 9.2, 7).translate(0, 4.6, 0),
      new THREE.BoxGeometry(1.9, 0.12, 0.12).translate(0, 8.5, 0),
      new THREE.CylinderGeometry(0.28, 0.28, 0.9, 8).translate(0.45, 7.6, 0.28), // transformer drum
    ]);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9b9a95, roughness: 0.85 });
    this.chunked.push(new ChunkedInstances(this.scene, poleGeo, poleMat, poles, {
      chunk: 350, maxDistance: 1500,
      write: (p, mm) => { _q.setFromAxisAngle(UP, p.yaw); mm.compose(_p.set(p.x, p.y, p.z), _q, _s.set(1, 1, 1)); },
    }));
    for (const p of poles) this.physics.addStaticCylinder(_p.set(p.x, p.y, p.z), 0.2, 4.5);
    this._wires(wires, 0.022, 0x1d1f22, 1100);
    this.instanceCount += poles.length + wires.length;
  }

  /** Sagging cable from a to b as `segs` straight pieces pushed onto `list`. */
  _catenary(list, ax, ay, az, bx, by, bz, sag, segs) {
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      const x = ax + (bx - ax) * u, z = az + (bz - az) * u;
      const y = ay + (by - ay) * u - sag * 4 * u * (1 - u);
      list.push({ x: (px + x) / 2, z: (pz + z) / 2, ax: px, ay: py, az: pz, bx: x, by: y, bz: z });
      px = x; py = y; pz = z;
    }
  }

  _wires(list, radius, color, maxDistance) {
    if (!list.length) return;
    const geo = new THREE.CylinderGeometry(radius, radius, 1, 3).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.4 });
    this.chunked.push(new ChunkedInstances(this.scene, geo, mat, list, {
      chunk: 350, castShadow: false, receiveShadow: false, maxDistance,
      write: (w, mm) => {
        _a.set(w.ax, w.ay, w.az); _b.set(w.bx, w.by, w.bz);
        const len = _a.distanceTo(_b);
        _q.setFromUnitVectors(Y, _b.sub(_a).normalize());
        mm.compose(_a, _q, _s.set(1, len, 1));
      },
    }));
  }

  // ------------------------------------------------------------------ Pylons
  _buildPylons() {
    const t = this.terrain;
    const lines = [
      [[3950, -700], [2900, -650], [1900, -150], [900, 350], [100, 60], [-600, -120], [-1180, -250]],
      [[3950, 1100], [2900, 900], [1500, 400], [600, 1250], [-300, 1000], [-1000, 520], [-1250, 380]],
      [[1600, -3900], [1500, -2900], [900, -1700], [200, -1150], [-500, -1050], [-1180, -1050]],
    ];
    const towers = [], cables = [];
    for (const line of lines) {
      // resample the polyline every ~330 m
      const pts = [];
      for (let k = 0; k < line.length - 1; k++) {
        const [x0, z0] = line[k], [x1, z1] = line[k + 1];
        const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 330));
        for (let j = 0; j < n; j++) pts.push([x0 + ((x1 - x0) * j) / n, z0 + ((z1 - z0) * j) / n]);
      }
      pts.push(line[line.length - 1]);
      let prev = null;
      for (const [x0, z0] of pts) {
        // nudge off roads, houses and water
        let x = x0, z = z0, ok = false;
        for (let k = 0; k < 8 && !ok; k++) {
          ok = this.roadEdgeDist(x, z) > 14 && this._free(x, z, 18) && !t.isWater(x, z, -1) && !this.avoid(x, z);
          if (!ok) { x = x0 + (this.rng() - 0.5) * 70; z = z0 + (this.rng() - 0.5) * 70; }
        }
        if (!ok) { prev = null; continue; }
        const y = t.heightAt(x, z);
        const yaw = prev ? Math.atan2(x - prev.x, z - prev.z) : 0;
        const tw = { x, y, z, yaw };
        if (prev) {
          prev.yaw = prev.yawSet ? prev.yaw : yaw;
          for (const [lat, h] of [[-7.2, 38], [7.2, 38], [-5.5, 30], [5.5, 30], [-6.2, 45.5], [6.2, 45.5]]) {
            const ax = prev.x + Math.cos(prev.yaw) * lat, az = prev.z - Math.sin(prev.yaw) * lat;
            const bx = x + Math.cos(yaw) * lat, bz = z - Math.sin(yaw) * lat;
            this._catenary(cables, ax, prev.y + h, az, bx, y + h, bz, 7, 8);
          }
        }
        tw.yawSet = true;
        towers.push(tw);
        this.clearSpots.push({ x, z, r: 9 });
        prev = tw;
      }
    }
    // lattice tower: four tapered legs, bracing, three cross-arms
    const parts = [];
    const H = 48;
    const legW = (y) => 4.2 * (1 - y / H) + 0.9;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (let k = 0; k < 6; k++) {
        const y0 = (k / 6) * H, y1 = ((k + 1) / 6) * H;
        const a = new THREE.Vector3(sx * legW(y0), y0, sz * legW(y0)), b = new THREE.Vector3(sx * legW(y1), y1, sz * legW(y1));
        const g = new THREE.BoxGeometry(0.35, a.distanceTo(b), 0.35);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize()));
        g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        parts.push(g);
      }
    }
    for (let k = 1; k < 6; k++) {
      const y = (k / 6) * H, w = legW(y);
      parts.push(new THREE.BoxGeometry(w * 2, 0.2, 0.2).translate(0, y, w), new THREE.BoxGeometry(w * 2, 0.2, 0.2).translate(0, y, -w));
      parts.push(new THREE.BoxGeometry(0.2, 0.2, w * 2).translate(w, y, 0), new THREE.BoxGeometry(0.2, 0.2, w * 2).translate(-w, y, 0));
    }
    for (const [y, span] of [[30, 11], [38, 14.4], [45.5, 12.4]]) parts.push(new THREE.BoxGeometry(span + 1, 0.6, 0.9).translate(0, y, 0));
    parts.push(new THREE.ConeGeometry(1.2, 3, 4).translate(0, H + 1.5, 0));
    const towerGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    const steel = new THREE.MeshStandardMaterial({ color: 0xa9adb1, roughness: 0.5, metalness: 0.7 });
    this.chunked.push(new ChunkedInstances(this.scene, towerGeo, steel, towers, {
      chunk: 800, maxDistance: 5200,
      write: (tw, mm) => { _q.setFromAxisAngle(UP, tw.yaw); mm.compose(_p.set(tw.x, tw.y - 0.5, tw.z), _q, _s.set(1, 1, 1)); },
    }));
    for (const tw of towers) this.physics.addStaticBox(_p.set(tw.x, tw.y + 3, tw.z), new THREE.Vector3(4.5, 3, 4.5), tw.yaw);
    this._wires(cables, 0.06, 0x2a2c30, 3500);
    this.instanceCount += towers.length + cables.length;
  }

  // -------------------------------------------------------------- Shinkansen
  _buildShinkansen() {
    const t = this.terrain;
    // dense centre-line
    const curve = new THREE.CatmullRomCurve3(SHINKANSEN.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    const L = curve.getLength();
    const n = Math.round(L / 6);
    const pts = curve.getSpacedPoints(n);
    // deck: 12 m over the ground, smoothed and grade-limited (≤ 2.5 %); where the hills
    // rise above it the line dives into a tunnel
    const ys = pts.map((p) => t.heightAt(p.x, p.z) + 12);
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    for (let i = 1; i < ys.length; i++) ys[i] = Math.min(ys[i], ys[i - 1] + 0.15);
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] + 0.15);
    // where the hills rise to meet the deck, the line enters a tunnel
    let portal = pts.length - 1;
    for (let i = 10; i < pts.length; i++) if (t.heightAt(pts[i].x, pts[i].z) > ys[i] - 4) { portal = i; break; }
    for (let i = 0; i < portal; i++) ys[i] = Math.max(ys[i], t.heightAt(pts[i].x, pts[i].z) + 7);
    this.train = { pts, ys, portal };
    // deck slab with parapets (sound walls)
    const pos = [], idx = [];
    const hw = 5.2;
    const cross = [[-hw, 0], [hw, 0], [hw, -1.4], [-hw, -1.4], [-hw, 1.9], [-hw + 0.3, 1.9], [hw - 0.3, 1.9], [hw, 1.9]];
    const tan = new THREE.Vector3();
    for (let i = 0; i <= portal; i++) {
      const p = pts[i];
      tan.copy(pts[Math.min(portal, i + 1)]).sub(pts[Math.max(0, i - 1)]).setY(0).normalize();
      const lx = tan.z, lz = -tan.x;
      for (const [o, dy] of cross) pos.push(p.x + lx * o, ys[i] + dy, p.z + lz * o);
      if (i < portal) {
        const a = i * 8, b = a + 8;
        const quad = (p0, p1) => idx.push(a + p0, b + p0, a + p1, a + p1, b + p0, b + p1);
        quad(0, 1); quad(1, 2); quad(2, 3); quad(3, 0); // slab
        quad(0, 4); quad(4, 5); quad(5, 0); // left wall (outer, top, inner)
        quad(7, 1); quad(6, 7); quad(1, 6); // right wall
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb4b1aa, roughness: 0.85, side: THREE.DoubleSide });
    const deck = new THREE.Mesh(g, concrete);
    deck.castShadow = true; deck.receiveShadow = true;
    this.scene.add(deck);
    // piers (single column + hammerhead) and catenary masts
    const piers = [], masts = [];
    for (let i = 5; i < portal - 2; i += 5) {
      const p = pts[i];
      const ground = t.heightAt(p.x, p.z);
      tan.copy(pts[i + 1]).sub(pts[i - 1]).setY(0).normalize();
      const yaw = Math.atan2(tan.x, tan.z);
      if (ys[i] - ground > 3 && this.roadEdgeDist(p.x, p.z) > 3 && !t.isWater(p.x, p.z, 0)) {
        piers.push({ x: p.x, z: p.z, y0: ground - 1, y1: ys[i] - 1.4, yaw });
        this.physics.addStaticCylinder(_p.set(p.x, ground, p.z), 1.3, (ys[i] - ground) / 2);
      }
      if (i % 10 === 0) masts.push({ x: p.x, y: ys[i], z: p.z, yaw });
    }
    const pierGeo = mergeGeometries([
      new THREE.CylinderGeometry(1.2, 1.4, 1, 10).translate(0, 0.5, 0).toNonIndexed(),
    ]);
    const pm = new THREE.InstancedMesh(pierGeo, concrete, piers.length);
    const hm = new THREE.InstancedMesh(new THREE.BoxGeometry(9, 1.6, 2.4), concrete, piers.length);
    piers.forEach((pp, i) => {
      _q.setFromAxisAngle(UP, pp.yaw);
      pm.setMatrixAt(i, _m.compose(_p.set(pp.x, pp.y0, pp.z), _q, _s.set(1, pp.y1 - pp.y0, 1)));
      hm.setMatrixAt(i, _m.compose(_p.set(pp.x, pp.y1 - 0.8, pp.z), _q, _s.set(1, 1, 1)));
    });
    for (const im of [pm, hm]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); this.scene.add(im); }
    const mastGeo = mergeGeometries([
      new THREE.BoxGeometry(0.25, 7, 0.25).translate(-hw + 0.5, 3.5, 0),
      new THREE.BoxGeometry(0.25, 7, 0.25).translate(hw - 0.5, 3.5, 0),
      new THREE.BoxGeometry(hw * 2 - 0.8, 0.25, 0.25).translate(0, 6.8, 0),
    ]);
    const steel = new THREE.MeshStandardMaterial({ color: 0x8e9398, roughness: 0.5, metalness: 0.6 });
    const mm = new THREE.InstancedMesh(mastGeo, steel, masts.length);
    masts.forEach((ms, i) => { _q.setFromAxisAngle(UP, ms.yaw); mm.setMatrixAt(i, _m.compose(_p.set(ms.x, ms.y, ms.z), _q, _s.set(1, 1, 1))); });
    mm.castShadow = true;
    mm.computeBoundingSphere();
    this.scene.add(mm);
    // tunnel portal into the hills
    if (portal < pts.length - 1) {
      const p = pts[portal];
      tan.copy(pts[portal]).sub(pts[portal - 2]).setY(0).normalize();
      const portalGeo = mergeGeometries([
        new THREE.BoxGeometry(14, 12, 3).translate(0, 6, 0),
      ]);
      const pmesh = new THREE.Mesh(portalGeo, concrete);
      pmesh.position.set(p.x, ys[portal] - 1.5, p.z);
      pmesh.rotation.y = Math.atan2(tan.x, tan.z);
      this.scene.add(pmesh);
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), new THREE.MeshBasicMaterial({ color: 0x050505 }));
      hole.position.set(p.x - tan.x * 1.6, ys[portal] + 2, p.z - tan.z * 1.6);
      hole.rotation.y = Math.atan2(tan.x, tan.z) + Math.PI;
      this.scene.add(hole);
    }
    // Tokyo terminal: a long station roof at the start
    {
      const p = pts[0];
      tan.copy(pts[8]).sub(pts[0]).setY(0).normalize();
      const yaw = Math.atan2(tan.x, tan.z);
      const st = new THREE.Group();
      const roof = new THREE.Mesh(new THREE.BoxGeometry(24, 1.2, 150), new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.4, metalness: 0.4 }));
      roof.position.set(0, ys[0] + 8, 70);
      const hall = new THREE.Mesh(new THREE.BoxGeometry(40, ys[0] - 1, 60), new THREE.MeshStandardMaterial({ color: 0xc9c2b3, roughness: 0.8 }));
      hall.position.set(0, (ys[0] - 1) / 2, -10);
      st.add(roof, hall);
      st.position.set(p.x, 0, p.z);
      st.rotation.y = yaw;
      st.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(st);
      this.physics.addStaticBox(_p.set(p.x - tan.x * 10, (ys[0] - 1) / 2, p.z - tan.z * 10), new THREE.Vector3(20, (ys[0] - 1) / 2, 30), yaw);
      this.clearSpots.push({ x: p.x, z: p.z, r: 60 });
    }
    // the train: 12 cars, white with a blue band, long nose at both ends
    const carLen = 25;
    const bodyGeo = new THREE.CapsuleGeometry(1.7, carLen - 3.4, 6, 12).rotateX(Math.PI / 2).scale(1, 1.08, 1).translate(0, 2.2, 0);
    const c = document.createElement('canvas');
    c.width = 16; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f4f5f6'; ctx.fillRect(0, 0, 16, 64);
    ctx.fillStyle = '#1d4fa3'; ctx.fillRect(0, 38, 16, 5);
    ctx.fillStyle = '#20252b'; ctx.fillRect(0, 24, 16, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const trainMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.3 });
    this.trainMesh = new THREE.InstancedMesh(bodyGeo, trainMat, 12);
    this.trainMesh.castShadow = true;
    this.trainMesh.frustumCulled = false;
    this.trainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.trainMesh);
    this.trainState = { s: 0, dir: 1, carLen, wait: 0 };
    this.labels.push({ text: 'SHINKANSEN', x: pts[Math.round(pts.length * 0.45)].x, z: pts[Math.round(pts.length * 0.45)].z + 80 });
    this.instanceCount += piers.length * 2 + masts.length;
  }

  /** Position along the line at arc length s (6 m samples). */
  _trainAt(s, out) {
    const { pts, ys } = this.train;
    const f = Math.max(0, Math.min(pts.length - 1.001, s / 6));
    const i = Math.floor(f), u = f - i;
    out.set(pts[i].x + (pts[i + 1].x - pts[i].x) * u, ys[i] + (ys[i + 1] - ys[i]) * u, pts[i].z + (pts[i + 1].z - pts[i].z) * u);
    return out;
  }

  update(dt, camPos) {
    if (this.trainMesh) {
      const T = this.trainState;
      const len = this.train.portal * 6;
      const cars = 12, span = cars * T.carLen;
      if (T.wait > 0) T.wait -= dt;
      else {
        T.s += T.dir * 62 * dt; // ~220 km/h
        // run from the terminal into the tunnel and back
        if (T.s > len + span) { T.s = len + span; T.dir = -1; T.wait = 6; }
        if (T.s < span) { T.s = span; T.dir = 1; T.wait = 8; }
      }
      for (let k = 0; k < cars; k++) {
        const sc = T.s - k * T.carLen - T.carLen / 2;
        this._trainAt(sc + 2, _a);
        this._trainAt(sc - 2, _b);
        const hidden = sc > len - 4;
        _p.copy(_a).add(_b).multiplyScalar(0.5);
        _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _a.sub(_b).normalize());
        this.trainMesh.setMatrixAt(k, _m.compose(_p, _q, _s.setScalar(hidden ? 0.0001 : 1)));
      }
      this.trainMesh.instanceMatrix.needsUpdate = true;
    }
    if (camPos && (this._cullT = (this._cullT || 0) + dt) > 0.5) {
      this._cullT = 0;
      for (const c of this.chunked) c.update(camPos);
    }
  }

  setNight(n) {
    if (this.vendPanel) this.vendPanel.emissiveIntensity = 0.6 + n * 2.5;
  }
}
