import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';

/**
 * Roads.js
 * --------
 * Route: a resampled centre-line (closed circuit or open connector) with an
 * elevation profile, used for rendering, AI, racing and minimaps.
 * RoadNetwork: the world's road layout plus meshes (asphalt ribbons with
 * type-specific markings, rumble curbs, guard rails, street lights).
 */

const SPACING = 3; // metres between samples

export class Route {
  /**
   * @param {object} o { id, name, points: [[x,z]...], closed, width, type,
   *                     rounded (corner radius for grid streets), render, carves, flat }
   */
  constructor(o) {
    Object.assign(this, {
      closed: true, width: 14, type: 'country', render: true, carves: true, flat: false, rounded: 0,
    }, o);
    if (this.maxGrade == null && !this.closed && this.id.startsWith('c-')) this.maxGrade = 0.13;
    const dense = this.rounded > 0 ? roundedPolyline(o.points, this.rounded, this.closed) : splinePolyline(o.points, this.closed);
    this._resample(dense);
    this.startIndex = 0;
  }

  _resample(pts) {
    // cumulative length
    const segs = this.closed ? pts.length : pts.length - 1;
    const cum = [0];
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[segs];
    const n = Math.max(8, Math.round(total / SPACING));
    this.length = total;
    this.count = this.closed ? n : n + 1;
    this.spacing = total / n;
    this.xs = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    this.ys = new Float32Array(this.count);
    let seg = 0;
    for (let i = 0; i < this.count; i++) {
      const d = Math.min(total, i * this.spacing);
      while (seg < segs - 1 && cum[seg + 1] < d) seg++;
      const a = pts[seg], b = pts[(seg + 1) % pts.length];
      const t = (d - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
      this.xs[i] = a[0] + (b[0] - a[0]) * t;
      this.zs[i] = a[1] + (b[1] - a[1]) * t;
    }
    // tangents (xz)
    this.tx = new Float32Array(this.count);
    this.tz = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const p = this._wrap(i - 1), q = this._wrap(i + 1);
      const dx = this.xs[q] - this.xs[p], dz = this.zs[q] - this.zs[p];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l;
      this.tz[i] = dz / l;
    }
    // interleaved 2D points for canvases
    this.points2D = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      this.points2D[i * 2] = this.xs[i];
      this.points2D[i * 2 + 1] = this.zs[i];
    }
  }

  _wrap(i) {
    if (this.closed) return ((i % this.count) + this.count) % this.count;
    return Math.min(this.count - 1, Math.max(0, i));
  }

  setHeights(h) {
    this.ys.set(h);
  }

  /** Nearest sample index; local search around `hint` when given. */
  nearestIndex(x, z, hint = -1, window = 45) {
    let best = 0, bestD = Infinity;
    const xs = this.xs, zs = this.zs;
    if (hint < 0) {
      for (let i = 0; i < this.count; i++) {
        const dx = xs[i] - x, dz = zs[i] - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      this._lastD2 = bestD;
      return best;
    }
    for (let k = -window; k <= window; k++) {
      const i = this._wrap(hint + k);
      const dx = xs[i] - x, dz = zs[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 1600) return this.nearestIndex(x, z, -1);
    this._lastD2 = bestD;
    return best;
  }

  /** Distance² of the last nearestIndex query. */
  get lastDistanceSq() { return this._lastD2 ?? Infinity; }

  /** Point `lateral` metres left of the centre-line at (fractional) index. */
  point(index, lateral, out) {
    const i = this._wrap(Math.round(index));
    return out.set(this.xs[i] + this.tz[i] * lateral, this.ys[i], this.zs[i] - this.tx[i] * lateral);
  }

  yaw(index) {
    const i = this._wrap(Math.round(index));
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  tangent(index, out) {
    const i = this._wrap(Math.round(index));
    return out.set(this.tx[i], 0, this.tz[i]);
  }

  /** Grid slot k behind the start line → writes position, returns yaw. */
  gridSlot(k, out) {
    const back = 12 + Math.floor(k / 2) * 9;
    const idx = this.startIndex - back / this.spacing;
    const lateral = (k % 2 === 0 ? 1 : -1) * Math.min(3.2, this.width / 2 - 2.2);
    this.point(idx, lateral, out);
    out.y += 1.0;
    return this.yaw(idx);
  }
}

// ---------------------------------------------------------------------------
// Polyline builders
// ---------------------------------------------------------------------------
function splinePolyline(points, closed) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'centripetal', 0.5);
  const n = Math.round(curve.getLength() / 1.5);
  return curve.getSpacedPoints(n).map((v) => [v.x, v.z]).slice(0, closed ? n : n + 1);
}

/** Straight segments joined by circular arcs of radius r (city streets). */
function roundedPolyline(points, r, closed) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out.push(points[i]); continue; }
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n];
    const d0x = p1[0] - p0[0], d0z = p1[1] - p0[1];
    const d1x = p2[0] - p1[0], d1z = p2[1] - p1[1];
    const l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    const a0 = [p1[0] - (d0x / l0) * r, p1[1] - (d0z / l0) * r];
    const a1 = [p1[0] + (d1x / l1) * r, p1[1] + (d1z / l1) * r];
    // quadratic Bézier approximates the arc well enough at street scale
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const x = (1 - t) * (1 - t) * a0[0] + 2 * (1 - t) * t * p1[0] + t * t * a1[0];
      const z = (1 - t) * (1 - t) * a0[1] + 2 * (1 - t) * t * p1[1] + t * t * a1[1];
      out.push([x, z]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// World road layout
// ---------------------------------------------------------------------------
export const FESTIVAL_POINTS = [
  [0, -170], [0, 40], [30, 170], [120, 250], [250, 240], [330, 150], [300, 40],
  [340, -60], [440, -120], [460, -250], [370, -340], [230, -330], [150, -250],
  [60, -300], [-10, -260],
];

export const CITY_RECT = { minX: -1500, maxX: -500, minZ: 500, maxZ: 1500 };
export const CITY_STREET_STEP = 125;
export const CITY_STREET_WIDTH = 18;
export const MINATO_RECT = { minX: 1950, maxX: 2450, minZ: -700, maxZ: -100 };
export const MINATO_STEP = 100;
export const MINATO_STREET_WIDTH = 14;
export const MINATO_Y = 2;
export const AIRFIELD = { minX: -3060, maxX: -1640, minZ: 2640, maxZ: 2760 };

export function createRoutes() {
  const routes = {
    festival: new Route({ id: 'festival', name: 'Festival Loop', points: FESTIVAL_POINTS, width: 14, type: 'circuit', rails: 'curves', lamps: 'pole' }),
    highway: new Route({
      id: 'highway', name: 'Horizon Highway', width: 20, type: 'highway', rails: 'both', lamps: 'pole',
      points: [
        [800, -700], [880, 0], [820, 700], [560, 1250], [100, 1650], [-500, 1730], [-1100, 1710],
        [-1590, 1470], [-1720, 900], [-1700, 300], [-1600, -300], [-1350, -900], [-900, -1350],
        [-300, -1560], [300, -1500], [650, -1150],
      ],
    }),
    mountain: new Route({
      id: 'mountain', name: 'Fuji Pass', width: 11, type: 'country', rails: 'curves',
      points: [
        [-460, -260], [-400, -480], [-520, -700], [-480, -900], [-700, -1020], [-930, -960],
        [-1100, -800], [-1020, -600], [-1150, -420], [-980, -260], [-760, -330], [-640, -200],
      ],
    }),
    city: new Route({
      id: 'city', name: 'Neon City Circuit', width: CITY_STREET_WIDTH, type: 'street', render: false, carves: false, flat: true,
      rounded: 13,
      points: [[-1375, 625], [-625, 625], [-625, 1000], [-875, 1000], [-875, 1375], [-1375, 1375]],
    }),
    coast: new Route({
      id: 'coast', name: 'Coastal Road', width: 13, type: 'country', rails: 'seaward', lamps: 'pole', lampSpacing: 90,
      points: [
        [2400, 2300], [2520, 1800], [2560, 1300], [2580, 800], [2560, 300], [2545, -150], [2560, -800],
        [2500, -1400], [2420, -2000], [2300, -2500], [2100, -2900], [1800, -3100], [1400, -3000],
        [1250, -2600], [1200, -2000], [1260, -1450], [1480, -900], [1600, -350], [1500, 300], [1450, 900],
        [1500, 1500], [1700, 2000], [2000, 2350],
      ],
    }),
    lake: new Route({
      id: 'lake', name: 'Lakeside Loop', width: 12, type: 'country', rails: 'curves', lamps: 'lantern',
      points: [
        [200, 2100], [205, 2350], [212, 2750], [222, 3200], [270, 3370], [0, 3400], [-330, 3230],
        [-480, 2820], [-400, 2370], [-160, 2110],
      ],
    }),
    summit: new Route({
      id: 'summit', name: 'Summit Road', width: 10, type: 'country', closed: false, rails: 'curves', maxGrade: 0.12,
      points: [
        [-650, -1600], [-800, -1850], [-1000, -2000], [-1250, -1950], [-1450, -2100], [-1300, -2300],
        [-1050, -2400], [-1170, -2560], [-1450, -2540], [-1750, -2450], [-1990, -2660], [-2090, -2950],
        [-1950, -3200], [-1800, -3330], [-1640, -3390],
      ],
    }),
    rally: new Route({
      id: 'rally', name: 'Kiso Forest Trail', width: 8.5, type: 'dirt', rails: 'none', smooth: 45, maxGrade: 0.13,
      points: [
        [-2250, 500], [-2400, 900], [-2650, 1150], [-2950, 1250], [-3200, 1050], [-3300, 700], [-3150, 350],
        [-3250, 0], [-3100, -400], [-2800, -600], [-2550, -450], [-2600, -150], [-2400, 50], [-2300, 250],
      ],
    }),
    minato: new Route({
      id: 'minato', name: 'Minato Harbour Circuit', width: MINATO_STREET_WIDTH, type: 'street', render: false, carves: false,
      flat: true, flatY: MINATO_Y, rounded: 10,
      points: [[1950, -700], [2450, -700], [2450, -100], [2250, -100], [2250, -400], [2050, -400], [2050, -100], [1950, -100]],
    }),
    airfield: new Route({
      id: 'airfield', name: 'Airfield Strip', width: 40, type: 'runway', closed: false, rails: 'none', lamps: 'none',
      points: [[-1680, 2700], [-2300, 2700], [-3020, 2700]],
    }),
  };
  const connectors = [
    new Route({ id: 'c-fest-east', closed: false, width: 11, type: 'country', points: [[440, -120], [620, -160], [880, -250]] }),
    new Route({ id: 'c-city-fest', closed: false, width: 11, type: 'country', points: [[-1000, 500], [-900, 400], [-620, 330], [-360, 300], [-120, 230], [30, 170]] }),
    new Route({ id: 'c-mtn-fest', closed: false, width: 11, type: 'country', points: [[-460, -260], [-320, -340], [-150, -378], [0, -348], [60, -300]] }),
    new Route({ id: 'c-city-north', closed: false, width: 11, type: 'country', points: [[-750, 1500], [-720, 1610], [-640, 1725]] }),
    new Route({ id: 'c-city-east', closed: false, width: 11, type: 'country', points: [[-500, 1000], [-200, 1050], [150, 1160], [470, 1330]] }),
    new Route({ id: 'c-mtn-south', closed: false, width: 11, type: 'country', points: [[-700, -1020], [-760, -1180], [-860, -1390]] }),
    new Route({ id: 'c-fest-south', closed: false, width: 11, type: 'country', points: [[370, -340], [420, -620], [560, -900], [690, -1100]] }),
    new Route({ id: 'c-hwy-minato', name: 'Harbour Road', closed: false, width: 11, type: 'country', points: [[880, 0], [1150, -60], [1450, -150], [1750, -300], [1950, -300]] }),
    new Route({ id: 'c-minato-coast', closed: false, width: 11, type: 'country', points: [[2450, -400], [2500, -405], [2556, -410]] }),
    new Route({ id: 'c-hwy-farm', name: 'Farm Road', closed: false, width: 10, type: 'country', points: [[650, -1150], [850, -1500], [1050, -1900], [1203, -2200]] }),
    new Route({ id: 'c-village-ew', name: 'Village Lane', closed: false, width: 7, type: 'dirt', smooth: 40, points: [[1218, -2420], [1500, -2460], [1800, -2400], [2100, -2450], [2345, -2400]] }),
    new Route({ id: 'c-village-ns', name: 'Paddy Lane', closed: false, width: 7, type: 'dirt', smooth: 40, points: [[1650, -1980], [1660, -2400], [1640, -2900], [1600, -3060]] }),
    new Route({ id: 'c-hwy-lake', closed: false, width: 11, type: 'country', points: [[100, 1650], [130, 1880], [200, 2100]] }),
    new Route({ id: 'c-lake-coast', name: 'Wind Farm Road', closed: false, width: 11, type: 'country', points: [[270, 3370], [700, 3280], [1200, 3000], [1700, 2600], [2000, 2350]] }),
    new Route({ id: 'c-hwy-summit', closed: false, width: 10, type: 'country', points: [[-900, -1350], [-780, -1480], [-650, -1600]] }),
    new Route({ id: 'c-hwy-rally', name: 'Kiso Road', closed: false, width: 9, type: 'country', points: [[-1715, 600], [-1950, 580], [-2250, 500]] }),
    new Route({ id: 'c-hwy-airfield', name: 'Airfield Road', closed: false, width: 11, type: 'country', points: [[-1100, 1710], [-1300, 2000], [-1500, 2350], [-1640, 2620], [-1680, 2700]] }),
  ];
  return { routes, connectors };
}

/** Where two drawn routes cross (segment intersections), for levelled junctions. */
export function findCrossings(routes, minGap = 60) {
  const CELL = 60;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  routes.forEach((r, ri) => {
    const n = r.closed ? r.count : r.count - 1;
    for (let i = 0; i < n; i += 2) {
      const j = r._wrap(i + 2);
      const k = key((r.xs[i] + r.xs[j]) / 2, (r.zs[i] + r.zs[j]) / 2);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([ri, i, j]);
    }
  });
  const out = [];
  const seg = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d;
    const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [ax + (bx - ax) * t, az + (bz - az) * t] : null;
  };
  for (const [k, list] of grid) {
    const [gx, gz] = k.split(',').map(Number);
    const near = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = grid.get(`${gx + a},${gz + b}`);
      if (l) near.push(...l);
    }
    for (const [ri, i, j] of list) {
      const A = routes[ri];
      for (const [rj, p, q] of near) {
        if (rj <= ri) continue;
        const B = routes[rj];
        const hit = seg(A.xs[i], A.zs[i], A.xs[j], A.zs[j], B.xs[p], B.zs[p], B.xs[q], B.zs[q]);
        if (hit && !out.some(([x, z]) => Math.hypot(x - hit[0], z - hit[1]) < minGap)) out.push(hit);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Road meshes
// ---------------------------------------------------------------------------
export class RoadNetwork {
  constructor(scene, physics, renderer, terrain) {
    this.scene = scene;
    this.physics = physics;
    this.renderer = renderer;
    this.terrain = terrain;
    const { routes, connectors } = createRoutes();
    this.routes = routes;
    this.connectors = connectors;
    this.all = [...Object.values(routes), ...connectors];
    this.instanceCount = 0;
    this.crossings = findCrossings(this.all.filter((r) => r.render));
  }

  /** Junction points: connector ends, open-route ends and at-grade crossings (levelled, no rails). */
  junctions() {
    const pts = [];
    for (const r of this.all) {
      if (r.closed || !r.render) continue;
      pts.push([r.xs[0], r.zs[0]], [r.xs[r.count - 1], r.zs[r.count - 1]]);
    }
    for (const c of this.crossings) pts.push(c);
    return pts;
  }

  build() {
    const tex = createRoadTextures(this.renderer);
    this.textures = tex;
    const lifts = { highway: 0.06, circuit: 0.055, country: 0.05, dirt: 0.04, runway: 0.05 };
    let order = 0;
    for (const r of this.all) {
      if (!r.render) continue;
      order++;
      const mat = new THREE.MeshStandardMaterial({
        map: tex[r.type] || tex.country,
        roughnessMap: tex.roughness,
        normalMap: r.type === 'dirt' ? tex.dirtNormal : tex.normal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 1,
        metalness: 0,
        polygonOffset: true,
        // every road gets its own depth bias so crossings never z-fight
        polygonOffsetFactor: -2 - (r.type === 'highway' ? 3 : 0) - order * 0.15,
        polygonOffsetUnits: -2 - (r.type === 'highway' ? 3 : 0) - order * 0.15,
      });
      const repeat = r.type === 'runway' ? 40 : r.width;
      const mesh = new THREE.Mesh(ribbon(r, -r.width / 2, r.width / 2, lifts[r.type] ?? 0.05, repeat), mat);
      mesh.receiveShadow = true;
      mesh.name = `Road:${r.id}`;
      this.scene.add(mesh);
    }
    // Rumble curbs on the festival circuit, the mountain pass and the summit hairpins
    const curbMat = new THREE.MeshStandardMaterial({
      map: createCurbTexture(), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    });
    const curbGeos = [];
    for (const r of [this.routes.festival, this.routes.mountain, this.routes.summit]) {
      const hw = r.width / 2;
      curbGeos.push(ribbon(r, -hw - 1.0, -hw + 0.15, 0.07, 2.2), ribbon(r, hw - 0.15, hw + 1.0, 0.07, 2.2));
    }
    const curbs = new THREE.Mesh(mergeGeometries(curbGeos), curbMat);
    curbs.receiveShadow = true;
    this.scene.add(curbs);

    this._junctions = this.junctions();
    this._buildGuardRails();
    this._buildLights();
    this._buildBridges();
  }

  _nearJunction(x, z, r = 45) {
    for (const [jx, jz] of this._junctions) if (Math.abs(x - jx) < r && Math.abs(z - jz) < r && Math.hypot(x - jx, z - jz) < r) return true;
    return false;
  }

  _buildGuardRails() {
    const railGeo = mergeGeometries([
      new THREE.BoxGeometry(0.08, 0.32, 4.1).translate(0, 0.62, 0),
      new THREE.BoxGeometry(0.12, 0.72, 0.12).translate(-0.08, 0.36, 0),
    ]);
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.35 });
    const list = [];
    const addRails = (r, offsetExtra, mode) => {
      const step = Math.max(1, Math.round(4 / r.spacing));
      for (let i = 0; i < r.count; i += step) {
        if (r.bridge && r.bridge[i]) continue;
        let outer = 0;
        if (mode === 'curves') {
          const a = r._wrap(i - 6), b = r._wrap(i + 6);
          const cross = r.tx[a] * r.tz[b] - r.tz[a] * r.tx[b];
          if (Math.abs(cross) < 0.08) continue;
          outer = cross > 0 ? -1 : 1;
        }
        for (const side of [-1, 1]) {
          if (mode === 'curves' && side !== outer) continue;
          const off = side * (r.width / 2 + offsetExtra);
          const x = r.xs[i] + r.tz[i] * off, z = r.zs[i] - r.tx[i] * off;
          // seaward: only on the side facing the ocean (+x), and only above a drop
          if (mode === 'seaward') {
            if (r.tz[i] * side <= 0) continue;
            if (this.terrain.heightAt(x + 12 * Math.sign(r.tz[i] * side), z) > r.ys[i] - 3) continue;
          }
          if (this._nearJunction(x, z)) continue;
          if (r.id !== 'festival' && this._nearOtherRoad(x, z, r)) continue;
          const y = this.terrain.heightAt(x, z);
          if (Math.abs(y - r.ys[i]) > 2.5) continue; // off the edge of a cutting/embankment
          list.push({ x, y, z, yaw: Math.atan2(r.tx[i], r.tz[i]), side });
        }
      }
    };
    for (const r of this.all) {
      if (!r.render || !r.rails || r.rails === 'none') continue;
      const extra = r.type === 'highway' ? 1.6 : r.id === 'festival' ? 2.4 : 1.4;
      addRails(r, extra, r.rails);
    }

    const mesh = new THREE.InstancedMesh(railGeo, railMat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const half = new THREE.Vector3(0.1, 0.45, 2.05);
    list.forEach((r, i) => {
      q.setFromAxisAngle(up, r.yaw + (r.side < 0 ? Math.PI : 0));
      mesh.setMatrixAt(i, m.compose(p.set(r.x, r.y, r.z), q, s));
      this.physics.addStaticBox(p.set(r.x, r.y + 0.45, r.z), half, r.yaw);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
    this.railCount = list.length;
    this.instanceCount += list.length;
  }

  _nearOtherRoad(x, z, self) {
    for (const r of this.all) {
      if (r === self) continue;
      const bx = r._bbox || (r._bbox = routeBBox(r));
      const pad = r.width / 2 + 3;
      if (x < bx.minX - pad || x > bx.maxX + pad || z < bx.minZ - pad || z > bx.maxZ + pad) continue;
      r.nearestIndex(x, z);
      if (r.lastDistanceSq < pad * pad) return true;
    }
    return false;
  }

  _buildLights() {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.17, 9, 8).translate(0, 4.5, 0),
      new THREE.BoxGeometry(0.12, 0.12, 3.4).translate(0, 8.9, 1.6),
    ]);
    const headGeo = new THREE.BoxGeometry(0.55, 0.16, 1.1).translate(0, 8.8, 3.2);
    // stone lantern (tōrō): base, post, light box, roof
    const lanternGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.45, 0.55, 0.3, 6).translate(0, 0.15, 0),
      new THREE.CylinderGeometry(0.16, 0.2, 1.1, 6).translate(0, 0.85, 0),
      new THREE.CylinderGeometry(0.42, 0.36, 0.18, 6).translate(0, 1.49, 0),
      new THREE.ConeGeometry(0.62, 0.42, 6).translate(0, 2.05, 0),
      new THREE.SphereGeometry(0.11, 6, 4).translate(0, 2.3, 0),
    ]);
    const lanternLightGeo = new THREE.BoxGeometry(0.5, 0.36, 0.5).translate(0, 1.76, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x6b7078, roughness: 0.45, metalness: 0.7 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a8781, roughness: 0.92 });
    this.lampMaterial = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd49a, emissiveIntensity: 0.3, roughness: 0.3 });
    const poles = [], lanterns = [];
    const place = (r, spacing, off, out) => {
      const step = Math.max(1, Math.round(spacing / r.spacing));
      for (let i = 0; i < r.count; i += step) {
        const side = (i / step) % 2 === 0 ? 1 : -1;
        const o = side * (r.width / 2 + off);
        const x = r.xs[i] + r.tz[i] * o, z = r.zs[i] - r.tx[i] * o;
        if (this._nearJunction(x, z, 30)) continue;
        if (r.bridge && r.bridge[i]) continue;
        if (r.id !== 'festival' && this._nearOtherRoad(x, z, r)) continue;
        if (r.id === 'festival' && x > -45 && x < 45 && z > -110 && z < -10) continue;
        if (this.terrain.isWater(x, z, -0.5)) continue;
        const y = this.terrain.heightAt(x, z);
        if (Math.abs(y - r.ys[i]) > 2.5) continue;
        out.push({ x, y, z, yaw: Math.atan2(r.xs[i] - x, r.zs[i] - z) });
      }
    };
    for (const r of this.all) {
      if (!r.render || !r.lamps || r.lamps === 'none') continue;
      if (r.lamps === 'pole') place(r, r.lampSpacing ?? (r.type === 'highway' ? 70 : 42), r.type === 'highway' ? 3.2 : 2.8, poles);
      else if (r.lamps === 'lantern') place(r, 36, 2.2, lanterns);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const instanced = (list, geos, radius, halfH) => {
      const meshes = geos.map(([g, mat, shadow]) => {
        const im = new THREE.InstancedMesh(g, mat, list.length);
        im.castShadow = shadow;
        return im;
      });
      list.forEach((l, i) => {
        q.setFromAxisAngle(up, l.yaw);
        m.compose(p.set(l.x, l.y, l.z), q, s);
        for (const im of meshes) im.setMatrixAt(i, m);
        this.physics.addStaticCylinder(p, radius, halfH);
      });
      for (const im of meshes) { im.computeBoundingSphere(); this.scene.add(im); }
    };
    instanced(poles, [[poleGeo, poleMat, true], [headGeo, this.lampMaterial, false]], 0.2, 4.5);
    instanced(lanterns, [[lanternGeo, stoneMat, true], [lanternLightGeo, this.lampMaterial, false]], 0.45, 1.1);
    this.lampPositions = [...poles, ...lanterns];
    this.instanceCount += poles.length + lanterns.length;
  }

  // --------------------------------------------------------------- Bridges
  /**
   * Every run of `route.bridge` samples becomes a bridge: concrete deck slab,
   * vermilion railings (the road ribbon itself is the running surface), piers
   * down to the ground/lake bed, and a static collider for the deck.
   */
  _buildBridges() {
    const slabGeos = [], pierList = [], railList = [];
    const spans = [];
    for (const r of this.all) {
      if (!r.bridge) continue;
      let i = 0;
      while (i < r.count) {
        if (!r.bridge[i]) { i++; continue; }
        let j = i;
        while (j < r.count && r.bridge[j]) j++;
        spans.push({ r, a: Math.max(0, i - 1), b: Math.min(r.count - 1, j) });
        i = j;
      }
    }
    this.bridgeSpans = spans;
    for (const { r, a, b } of spans) {
      const hw = r.width / 2 + 0.9;
      // deck slab: top at road level, 1.1 m thick, closed sides
      const rows = b - a + 1;
      const pos = [], idx = [];
      for (let k = 0; k < rows; k++) {
        const i = a + k;
        const lx = r.tz[i], lz = -r.tx[i];
        const y = r.ys[i] + 0.02;
        for (const [off, dy] of [[-hw, 0], [hw, 0], [hw, -1.1], [-hw, -1.1]]) {
          pos.push(r.xs[i] + lx * off, y + dy, r.zs[i] + lz * off);
        }
        if (k < rows - 1) {
          const o = k * 4, n = o + 4;
          // top, right side, bottom, left side
          for (const [p0, p1] of [[0, 1], [1, 2], [2, 3], [3, 0]]) idx.push(o + p0, n + p0, o + p1, o + p1, n + p0, n + p1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      slabGeos.push(g);

      // deck collider: two triangles per sample pair across the running surface
      const verts = [], tris = [];
      for (let k = 0; k < rows; k++) {
        const i = a + k;
        const lx = r.tz[i], lz = -r.tx[i];
        verts.push(r.xs[i] - lx * hw, r.ys[i], r.zs[i] - lz * hw, r.xs[i] + lx * hw, r.ys[i], r.zs[i] + lz * hw);
        if (k < rows - 1) { const o = k * 2; tris.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
      }
      const boxes = [];
      for (let i = a; i < b; i += 2) {
        const j = Math.min(b, i + 2);
        const cx = (r.xs[i] + r.xs[j]) / 2, cz = (r.zs[i] + r.zs[j]) / 2, cy = (r.ys[i] + r.ys[j]) / 2 - 0.25;
        boxes.push({ x: cx, y: cy, z: cz, hx: hw, hy: 0.25, hz: Math.hypot(r.xs[j] - r.xs[i], r.zs[j] - r.zs[i]) / 2 + 0.3, yaw: Math.atan2(r.tx[i], r.tz[i]) });
      }
      this.physics.addTrimesh(new Float32Array(verts), new Uint32Array(tris), boxes);

      // piers every ~36 m, railings every ~2.4 m on both sides
      const pierStep = Math.max(1, Math.round(36 / r.spacing));
      for (let i = a + pierStep; i < b - 2; i += pierStep) {
        const ground = this.terrain.heightAt(r.xs[i], r.zs[i]);
        const top = r.ys[i] - 1.1;
        if (top - ground < 1.5) continue;
        pierList.push({ x: r.xs[i], z: r.zs[i], y0: ground - 2, y1: top, yaw: Math.atan2(r.tx[i], r.tz[i]), w: r.width });
      }
      const railStep = Math.max(1, Math.round(2.4 / r.spacing));
      for (let i = a; i <= b; i += railStep) {
        for (const side of [-1, 1]) {
          const off = side * (hw - 0.25);
          railList.push({ x: r.xs[i] + r.tz[i] * off, y: r.ys[i], z: r.zs[i] - r.tx[i] * off, yaw: Math.atan2(r.tx[i], r.tz[i]) });
        }
      }
      // railings are solid for cars
      for (let i = a; i < b; i += 2) {
        const j = Math.min(b, i + 2);
        for (const side of [-1, 1]) {
          const off = side * (hw - 0.2);
          const x = (r.xs[i] + r.xs[j]) / 2 + r.tz[i] * off, z = (r.zs[i] + r.zs[j]) / 2 - r.tx[i] * off;
          this.physics.addStaticBox(new THREE.Vector3(x, (r.ys[i] + r.ys[j]) / 2 + 0.6, z),
            new THREE.Vector3(0.15, 0.6, Math.hypot(r.xs[j] - r.xs[i], r.zs[j] - r.zs[i]) / 2 + 0.4), Math.atan2(r.tx[i], r.tz[i]));
        }
      }
    }
    if (!spans.length) return;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9a968f, roughness: 0.85 });
    const slab = new THREE.Mesh(mergeGeometries(slabGeos), concrete);
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.scene.add(slab);

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    // piers: two columns + cap beam (unit height, scaled)
    const pierGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.9, 1.1, 1, 12).translate(-3.2, 0.5, 0),
      new THREE.CylinderGeometry(0.9, 1.1, 1, 12).translate(3.2, 0.5, 0),
    ]);
    const capGeo = new THREE.BoxGeometry(1, 1, 1);
    const piers = new THREE.InstancedMesh(pierGeo, concrete, pierList.length);
    const caps = new THREE.InstancedMesh(capGeo, concrete, pierList.length);
    pierList.forEach((pl, i) => {
      q.setFromAxisAngle(up, pl.yaw);
      piers.setMatrixAt(i, m.compose(p.set(pl.x, pl.y0, pl.z), q, s.set(pl.w / 12, pl.y1 - pl.y0, 1)));
      caps.setMatrixAt(i, m.compose(p.set(pl.x, pl.y1 - 0.5, pl.z), q, s.set(pl.w + 1.5, 1, 1.8)));
    });
    for (const im of [piers, caps]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); this.scene.add(im); }
    // vermilion railing posts with a continuous top rail segment
    const vermilion = new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.55 });
    const railGeo = mergeGeometries([
      new THREE.BoxGeometry(0.14, 1.1, 0.14).translate(0, 0.55, 0),
      new THREE.BoxGeometry(0.1, 0.12, 2.5).translate(0, 1.08, 0),
      new THREE.BoxGeometry(0.06, 0.08, 2.5).translate(0, 0.6, 0),
    ]);
    const rails = new THREE.InstancedMesh(railGeo, vermilion, railList.length);
    s.set(1, 1, 1);
    railList.forEach((rl, i) => {
      q.setFromAxisAngle(up, rl.yaw);
      rails.setMatrixAt(i, m.compose(p.set(rl.x, rl.y, rl.z), q, s));
    });
    rails.castShadow = true;
    rails.computeBoundingSphere();
    this.scene.add(rails);
    this.instanceCount += pierList.length * 2 + railList.length;
  }

  /** Closest road (route or connector) to a point: { route, index, d2 }. */
  nearest(x, z, filter = null) {
    let best = null;
    for (const r of this.all) {
      if (filter && !filter(r)) continue;
      const i = r.nearestIndex(x, z);
      const d2 = r.lastDistanceSq;
      if (!best || d2 < best.d2) best = { route: r, index: i, d2 };
    }
    return best;
  }

  /** Deck height if x,z is on a bridge (within its width), else null. */
  bridgeHeightAt(x, z) {
    if (!this.bridgeSpans) return null;
    for (const { r, a, b } of this.bridgeSpans) {
      const bb = r._bbox || (r._bbox = routeBBox(r));
      if (x < bb.minX - 20 || x > bb.maxX + 20 || z < bb.minZ - 20 || z > bb.maxZ + 20) continue;
      const i = r.nearestIndex(x, z);
      if (i < a || i > b) continue;
      if (r.lastDistanceSq < (r.width / 2 + 1) ** 2) return r.ys[i];
    }
    return null;
  }
}

function routeBBox(r) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < r.count; i++) {
    minX = Math.min(minX, r.xs[i]); maxX = Math.max(maxX, r.xs[i]);
    minZ = Math.min(minZ, r.zs[i]); maxZ = Math.max(maxZ, r.zs[i]);
  }
  return { minX, maxX, minZ, maxZ };
}

/** Ribbon along a route between lateral offsets a..b, following its heights. */
export function ribbon(r, a, b, lift, vRepeat) {
  const n = r.count;
  const rows = r.closed ? n + 1 : n;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const idx = [];
  let dist = 0;
  for (let k = 0; k < rows; k++) {
    const i = k % n;
    if (k > 0) {
      const j = (k - 1) % n;
      dist += Math.hypot(r.xs[i] - r.xs[j], r.zs[i] - r.zs[j]);
    }
    const lx = r.tz[i], lz = -r.tx[i]; // left vector
    const y = r.ys[i] + lift;
    const o = k * 6;
    pos[o] = r.xs[i] + lx * a; pos[o + 1] = y; pos[o + 2] = r.zs[i] + lz * a;
    pos[o + 3] = r.xs[i] + lx * b; pos[o + 4] = y; pos[o + 5] = r.zs[i] + lz * b;
    const v = dist / vRepeat;
    uv[k * 4] = 0; uv[k * 4 + 1] = v; uv[k * 4 + 2] = 1; uv[k * 4 + 3] = v;
    if (k < rows - 1) {
      const q = k * 2;
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure normals face up
  if (g.attributes.normal.getY(0) < 0) {
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Procedural road textures
// ---------------------------------------------------------------------------
export function createRoadTextures(renderer) {
  const S = 1024;
  const rng = mulberry32(99);
  const height = new Float32Array(S * S);
  const octaves = [[16, 0.35], [64, 0.25], [256, 0.2]];
  for (const [n, amp] of octaves) {
    const g = new Float32Array((n + 1) * (n + 1));
    for (let i = 0; i < g.length; i++) g[i] = rng();
    for (let i = 0; i <= n; i++) { g[i * (n + 1) + n] = g[i * (n + 1)]; g[n * (n + 1) + i] = g[i]; }
    for (let y = 0; y < S; y++) {
      const fy = (y / S) * n, iy = Math.floor(fy), ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * n, ix = Math.floor(fx), tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const a = g[iy * (n + 1) + ix], b = g[iy * (n + 1) + ix + 1];
        const c = g[(iy + 1) * (n + 1) + ix], d = g[(iy + 1) * (n + 1) + ix + 1];
        height[y * S + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
  }
  for (let i = 0; i < S * S; i++) height[i] += (rng() - 0.5) * 0.3; // aggregate grit

  const canvas = () => { const c = document.createElement('canvas'); c.width = S; c.height = S; return c; };

  const base = canvas();
  const bctx = base.getContext('2d');
  const img = bctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const h = height[i];
    const stone = rng() < 0.012 ? 30 : 0;
    const v = 46 + h * 34 + stone;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v + 1; img.data[i * 4 + 2] = v + 3; img.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);
  for (let k = 0; k < 18; k++) {
    const x = rng() * S, y = rng() * S, r = 30 + rng() * 110;
    const g = bctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(8,8,10,0.22)'); g.addColorStop(1, 'rgba(8,8,10,0)');
    bctx.fillStyle = g; bctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // cracks & tar seams
  bctx.strokeStyle = 'rgba(14,14,16,0.55)';
  bctx.lineWidth = 1.4;
  for (let k = 0; k < 16; k++) {
    let x = rng() * S, y = rng() * S;
    bctx.beginPath(); bctx.moveTo(x, y);
    for (let s = 0; s < 7; s++) { x += (rng() - 0.5) * 50; y += (rng() - 0.5) * 50; bctx.lineTo(x, y); }
    bctx.stroke();
  }

  const withMarkings = (draw) => {
    const c = canvas();
    const ctx = c.getContext('2d');
    ctx.drawImage(base, 0, 0);
    // tyre wear in the lanes
    const wear = ctx.createLinearGradient(0, 0, S, 0);
    wear.addColorStop(0.15, 'rgba(0,0,0,0)'); wear.addColorStop(0.3, 'rgba(0,0,0,0.16)');
    wear.addColorStop(0.42, 'rgba(0,0,0,0)'); wear.addColorStop(0.58, 'rgba(0,0,0,0)');
    wear.addColorStop(0.7, 'rgba(0,0,0,0.16)'); wear.addColorStop(0.85, 'rgba(0,0,0,0)');
    ctx.fillStyle = wear; ctx.fillRect(0, 0, S, S);
    draw(ctx);
    // paint wear speckle
    const id = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < S * S; i++) {
      if (id.data[i * 4] > 150 && rng() < 0.18) {
        id.data[i * 4] *= 0.75; id.data[i * 4 + 1] *= 0.75; id.data[i * 4 + 2] *= 0.75;
      }
    }
    ctx.putImageData(id, 0, 0);
    return c;
  };
  const white = 'rgba(236,236,230,0.95)';
  const yellow = 'rgba(230,184,40,0.95)';
  const line = (ctx, u, w, color, dash = null) => {
    ctx.fillStyle = color;
    if (!dash) ctx.fillRect(S * u - (S * w) / 2, 0, S * w, S);
    else ctx.fillRect(S * u - (S * w) / 2, 0, S * w, S * dash);
  };
  const circuit = withMarkings((ctx) => {
    line(ctx, 0.04, 0.018, white); line(ctx, 0.96, 0.018, white); line(ctx, 0.5, 0.016, white, 0.45);
  });
  const highway = withMarkings((ctx) => {
    line(ctx, 0.035, 0.012, white); line(ctx, 0.965, 0.012, white);
    line(ctx, 0.49, 0.009, yellow); line(ctx, 0.51, 0.009, yellow);
    line(ctx, 0.27, 0.009, white, 0.35); line(ctx, 0.73, 0.009, white, 0.35);
  });
  const country = withMarkings((ctx) => {
    line(ctx, 0.05, 0.02, white); line(ctx, 0.95, 0.02, white); line(ctx, 0.5, 0.02, yellow, 0.5);
  });

  // gravel/dirt track: packed earth, two worn wheel ruts, grassy crown and verges
  const dirt = canvas();
  {
    const ctx = dirt.getContext('2d');
    const id = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S;
        const h = height[i];
        const rut = Math.exp(-(((u - 0.3) / 0.07) ** 2)) + Math.exp(-(((u - 0.7) / 0.07) ** 2));
        const verge = Math.max(0, Math.abs(u - 0.5) - 0.38) / 0.12;
        const crown = Math.exp(-(((u - 0.5) / 0.05) ** 2)) * (0.5 + h * 0.6);
        const stone = rng() < 0.02 ? 25 : 0;
        let r = 118 + h * 50 - rut * 22 + stone, g = 96 + h * 40 - rut * 18 + stone, b = 70 + h * 30 - rut * 12 + stone;
        const grass = Math.min(1, verge * (0.6 + h) + crown * 0.55);
        r = r * (1 - grass) + (58 + h * 30) * grass; g = g * (1 - grass) + (76 + h * 40) * grass; b = b * (1 - grass) + (38 + h * 20) * grass;
        id.data[i * 4] = r; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  }
  // runway: pale concrete slabs, centre-line dashes, edge lines, touchdown bars
  const runway = canvas();
  {
    const ctx = runway.getContext('2d');
    ctx.drawImage(base, 0, 0);
    ctx.fillStyle = 'rgba(190,188,182,0.55)';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(60,60,60,0.35)';
    ctx.lineWidth = 2;
    for (let k = 0; k <= S; k += S / 8) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k, S); ctx.stroke(); }
    for (let k = 0; k <= S; k += S / 4) { ctx.beginPath(); ctx.moveTo(0, k); ctx.lineTo(S, k); ctx.stroke(); }
    ctx.fillStyle = 'rgba(245,245,240,0.95)';
    ctx.fillRect(S * 0.495, 0, S * 0.01, S * 0.5);
    ctx.fillRect(S * 0.03, 0, S * 0.008, S);
    ctx.fillRect(S * 0.962, 0, S * 0.008, S);
    ctx.fillStyle = 'rgba(30,30,30,0.18)';
    ctx.fillRect(S * 0.35, 0, S * 0.1, S);
    ctx.fillRect(S * 0.55, 0, S * 0.1, S);
  }

  const rough = canvas();
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(255, 175 + height[i] * 70));
    rimg.data[i * 4] = v; rimg.data[i * 4 + 1] = v; rimg.data[i * 4 + 2] = v; rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  const norm = canvas();
  const nctx = norm.getContext('2d');
  const nimg = nctx.createImageData(S, S);
  const H = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * 2.4, ny = -dy * 2.4, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (y * S + x) * 4;
      nimg.data[o] = (nx / l * 0.5 + 0.5) * 255;
      nimg.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      nimg.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
      nimg.data[o + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const wrap = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // dirt normal: stronger grit so loose tracks look bumpy
  const dn = canvas();
  {
    const ctx = dn.getContext('2d');
    const img2 = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (H(x + 1, y) - H(x - 1, y)) * 5, dy = (H(x, y + 1) - H(x, y - 1)) * 5;
        const l = Math.hypot(dx, dy, 1);
        const o = (y * S + x) * 4;
        img2.data[o] = (-dx / l * 0.5 + 0.5) * 255; img2.data[o + 1] = (-dy / l * 0.5 + 0.5) * 255;
        img2.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; img2.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img2, 0, 0);
  }
  return {
    circuit: wrap(circuit, true), highway: wrap(highway, true), country: wrap(country, true),
    dirt: wrap(dirt, true), runway: wrap(runway, true), dirtNormal: wrap(dn, false),
    plain: wrap(base, true), roughness: wrap(rough, false), normal: wrap(norm, false),
  };
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
