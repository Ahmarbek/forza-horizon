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

export function createRoutes() {
  const routes = {
    festival: new Route({ id: 'festival', name: 'Festival Loop', points: FESTIVAL_POINTS, width: 14, type: 'circuit' }),
    highway: new Route({
      id: 'highway', name: 'Horizon Highway', width: 20, type: 'highway',
      points: [
        [800, -700], [880, 0], [820, 700], [560, 1250], [100, 1650], [-500, 1730], [-1100, 1710],
        [-1590, 1470], [-1720, 900], [-1700, 300], [-1600, -300], [-1350, -900], [-900, -1350],
        [-300, -1560], [300, -1500], [650, -1150],
      ],
    }),
    mountain: new Route({
      id: 'mountain', name: 'Fuji Pass', width: 11, type: 'country',
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
  };
  const connectors = [
    new Route({ id: 'c-fest-east', closed: false, width: 11, type: 'country', points: [[440, -120], [620, -160], [880, -250]] }),
    new Route({ id: 'c-city-fest', closed: false, width: 11, type: 'country', points: [[-1000, 500], [-900, 400], [-620, 330], [-360, 300], [-120, 230], [30, 170]] }),
    new Route({ id: 'c-mtn-fest', closed: false, width: 11, type: 'country', points: [[-460, -260], [-320, -340], [-150, -378], [0, -348], [60, -300]] }),
    new Route({ id: 'c-city-north', closed: false, width: 11, type: 'country', points: [[-750, 1500], [-720, 1610], [-640, 1725]] }),
    new Route({ id: 'c-city-east', closed: false, width: 11, type: 'country', points: [[-500, 1000], [-200, 1050], [150, 1160], [470, 1330]] }),
    new Route({ id: 'c-mtn-south', closed: false, width: 11, type: 'country', points: [[-700, -1020], [-760, -1180], [-860, -1390]] }),
    new Route({ id: 'c-fest-south', closed: false, width: 11, type: 'country', points: [[370, -340], [420, -620], [560, -900], [690, -1100]] }),
  ];
  return { routes, connectors };
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
  }

  /** Junction points where connectors meet other roads (level + no rails). */
  junctions() {
    const pts = [];
    for (const c of this.connectors) {
      pts.push([c.xs[0], c.zs[0]], [c.xs[c.count - 1], c.zs[c.count - 1]]);
    }
    return pts;
  }

  build() {
    const tex = createRoadTextures(this.renderer);
    this.textures = tex;
    const offsets = { highway: 0.06, circuit: 0.055, country: 0.05 };
    for (const r of this.all) {
      if (!r.render) continue;
      const mat = new THREE.MeshStandardMaterial({
        map: tex[r.type] || tex.country,
        roughnessMap: tex.roughness,
        normalMap: tex.normal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 1,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: r.type === 'highway' ? -4 : -2,
        polygonOffsetUnits: r.type === 'highway' ? -4 : -2,
      });
      const mesh = new THREE.Mesh(ribbon(r, -r.width / 2, r.width / 2, offsets[r.type] ?? 0.05, r.width), mat);
      mesh.receiveShadow = true;
      mesh.name = `Road:${r.id}`;
      this.scene.add(mesh);
    }
    // Rumble curbs on the festival circuit and the mountain pass
    const curbMat = new THREE.MeshStandardMaterial({
      map: createCurbTexture(), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    });
    const curbGeos = [];
    for (const r of [this.routes.festival, this.routes.mountain]) {
      const hw = r.width / 2;
      curbGeos.push(ribbon(r, -hw - 1.0, -hw + 0.15, 0.07, 2.2), ribbon(r, hw - 0.15, hw + 1.0, 0.07, 2.2));
    }
    const curbs = new THREE.Mesh(mergeGeometries(curbGeos), curbMat);
    curbs.receiveShadow = true;
    this.scene.add(curbs);

    this._buildGuardRails();
    this._buildLights();
  }

  _nearJunction(x, z, r = 45) {
    for (const [jx, jz] of this._junctions) if (Math.hypot(x - jx, z - jz) < r) return true;
    return false;
  }

  _buildGuardRails() {
    this._junctions = this.junctions();
    const railGeo = mergeGeometries([
      new THREE.BoxGeometry(0.08, 0.32, 4.1).translate(0, 0.62, 0),
      new THREE.BoxGeometry(0.12, 0.72, 0.12).translate(-0.08, 0.36, 0),
    ]);
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.35 });
    const list = [];
    const addRails = (r, offsetExtra, onlyCurves) => {
      const step = Math.max(1, Math.round(4 / r.spacing));
      for (let i = 0; i < r.count; i += step) {
        let curve = 1;
        if (onlyCurves) {
          const a = r._wrap(i - 6), b = r._wrap(i + 6);
          curve = Math.abs(r.tx[a] * r.tz[b] - r.tz[a] * r.tx[b]);
          if (curve < 0.08) continue;
        }
        for (const side of [-1, 1]) {
          if (onlyCurves) {
            const a = r._wrap(i - 6), b = r._wrap(i + 6);
            const cross = r.tx[a] * r.tz[b] - r.tz[a] * r.tx[b];
            const outer = cross > 0 ? -1 : 1;
            if (side !== outer) continue;
          }
          const off = side * (r.width / 2 + offsetExtra);
          const x = r.xs[i] + r.tz[i] * off, z = r.zs[i] - r.tx[i] * off;
          if (this._nearJunction(x, z)) continue;
          if (r.id !== 'festival' && this._nearOtherRoad(x, z, r)) continue;
          const y = this.terrain.heightAt(x, z);
          list.push({ x, y, z, yaw: Math.atan2(r.tx[i], r.tz[i]), side });
        }
      }
    };
    addRails(this.routes.highway, 1.6, false);
    addRails(this.routes.mountain, 1.4, true);
    addRails(this.routes.festival, 2.4, true);

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
      const i = r.nearestIndex(x, z);
      if (r.lastDistanceSq < (r.width / 2 + 3) ** 2) return true;
    }
    return false;
  }

  _buildLights() {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.17, 9, 8).translate(0, 4.5, 0),
      new THREE.BoxGeometry(0.12, 0.12, 3.4).translate(0, 8.9, 1.6),
    ]);
    const headGeo = new THREE.BoxGeometry(0.55, 0.16, 1.1).translate(0, 8.8, 3.2);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x6b7078, roughness: 0.45, metalness: 0.7 });
    this.lampMaterial = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd49a, emissiveIntensity: 0.3, roughness: 0.3 });
    const list = [];
    const place = (r, spacing, off) => {
      const step = Math.max(1, Math.round(spacing / r.spacing));
      for (let i = 0; i < r.count; i += step) {
        const side = (i / step) % 2 === 0 ? 1 : -1;
        const o = side * (r.width / 2 + off);
        const x = r.xs[i] + r.tz[i] * o, z = r.zs[i] - r.tx[i] * o;
        if (this._nearJunction(x, z, 30)) continue;
        if (r.id !== 'festival' && this._nearOtherRoad(x, z, r)) continue;
        if (r.id === 'festival' && x > -45 && x < 45 && z > -110 && z < -10) continue;
        const y = this.terrain.heightAt(x, z);
        list.push({ x, y, z, yaw: Math.atan2(r.xs[i] - x, r.zs[i] - z) });
      }
    };
    place(this.routes.festival, 42, 2.8);
    place(this.routes.highway, 70, 3.2);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, list.length);
    const heads = new THREE.InstancedMesh(headGeo, this.lampMaterial, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((l, i) => {
      q.setFromAxisAngle(up, l.yaw);
      m.compose(p.set(l.x, l.y, l.z), q, s);
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      this.physics.addStaticCylinder(p, 0.2, 4.5);
    });
    poles.castShadow = true;
    poles.computeBoundingSphere();
    heads.computeBoundingSphere();
    this.scene.add(poles, heads);
    this.lampPositions = list;
    this.instanceCount += list.length;
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
  return {
    circuit: wrap(circuit, true), highway: wrap(highway, true), country: wrap(country, true),
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
