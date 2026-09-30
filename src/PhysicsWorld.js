import * as THREE from 'three';

/**
 * PhysicsWorld
 * ------------
 * Thin façade over @dimforge/rapier3d-compat with:
 *  - fixed time-step accumulator (60 Hz)
 *  - collision-group helpers (STATIC_GEOMETRY, VEHICLE_BODY, WHEELS, PROPS)
 *  - a uniform ray-cast API used by the raycast vehicle
 *
 * If Rapier cannot be loaded (offline, CDN blocked, WASM disabled) a small
 * built-in rigid-body solver ("lite" backend) takes over so the prototype is
 * always drivable. Both backends expose the same body API subset
 * (translation/rotation/linvel/angvel/applyImpulse/applyImpulseAtPoint/...),
 * so gameplay code never needs to know which one is running.
 */

export const GROUPS = Object.freeze({
  STATIC_GEOMETRY: 0x0001,
  VEHICLE_BODY: 0x0002,
  WHEELS: 0x0004,
  PROPS: 0x0008,
  ALL: 0xffff,
});

/** Rapier packs interaction groups as (memberships << 16) | filter. */
export function interactionGroups(memberships, filter) {
  return ((memberships & 0xffff) << 16) | (filter & 0xffff);
}

export const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
const GRAVITY = -9.81;

// ---------------------------------------------------------------------------
// Scratch objects (never allocate inside the step loop)
// ---------------------------------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();
const _m3b = new THREE.Matrix3();

export class PhysicsWorld {
  constructor() {
    this.backend = 'none';
    this.RAPIER = null;
    this.world = null;
    this.lite = null;
    this.accumulator = 0;
    this.fixedDt = FIXED_DT;
    this.stepCount = 0;

    this._ray = null; // Rapier Ray (reused)
    this._rayGroups = interactionGroups(GROUPS.WHEELS, GROUPS.STATIC_GEOMETRY);
    this.props = []; // dynamic props { body, index }
  }

  get supportsDynamicProps() {
    return this.backend === 'rapier';
  }

  async init() {
    try {
      const mod = await import('@dimforge/rapier3d-compat');
      const RAPIER = mod.default ?? mod;
      await RAPIER.init();
      this.RAPIER = RAPIER;
      this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
      this.world.timestep = this.fixedDt;
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
      this.backend = 'rapier';
    } catch (err) {
      console.warn('[PhysicsWorld] Rapier unavailable, using built-in lite solver.', err);
      this.lite = new LiteSolver(GRAVITY);
      this.backend = 'lite';
    }
    return this.backend;
  }

  // -------------------------------------------------------------- Colliders

  /** Infinite-ish flat ground at y = 0. */
  createGround(halfSize = 1500) {
    if (this.backend === 'rapier') {
      const R = this.RAPIER;
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
      const desc = R.ColliderDesc.cuboid(halfSize, 0.5, halfSize)
        .setFriction(1.0)
        .setCollisionGroups(interactionGroups(GROUPS.STATIC_GEOMETRY, GROUPS.ALL));
      this.world.createCollider(desc, body);
    } else {
      this.lite.groundY = 0;
    }
  }

  /** Static oriented box (rotation about Y only). */
  addStaticBox(position, halfExtents, rotationY = 0) {
    if (this.backend === 'rapier') {
      const R = this.RAPIER;
      _q1.setFromAxisAngle(_v1.set(0, 1, 0), rotationY);
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.fixed()
          .setTranslation(position.x, position.y, position.z)
          .setRotation({ x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w })
      );
      const desc = R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(0.4)
        .setRestitution(0.2)
        .setCollisionGroups(interactionGroups(GROUPS.STATIC_GEOMETRY, GROUPS.ALL));
      this.world.createCollider(desc, body);
    } else {
      this.lite.addStaticBox(position, halfExtents, rotationY);
    }
  }

  /** Static vertical cylinder (tree trunks, lamp posts). */
  addStaticCylinder(position, radius, halfHeight) {
    if (this.backend === 'rapier') {
      const R = this.RAPIER;
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(position.x, position.y + halfHeight, position.z)
      );
      const desc = R.ColliderDesc.cylinder(halfHeight, radius)
        .setFriction(0.4)
        .setRestitution(0.1)
        .setCollisionGroups(interactionGroups(GROUPS.STATIC_GEOMETRY, GROUPS.ALL));
      this.world.createCollider(desc, body);
    } else {
      _v4.set(radius, halfHeight, radius);
      _v3.set(position.x, position.y + halfHeight, position.z);
      this.lite.addStaticBox(_v3, _v4, 0);
    }
  }

  /**
   * Dynamic chassis body. `centerOfMass` is in body-local space; lowering it
   * gives the car its planted feel.
   */
  createVehicleBody({ position, quaternion, halfExtents, mass, centerOfMass }) {
    const inertia = {
      x: (mass / 12) * (4 * halfExtents.y * halfExtents.y + 4 * halfExtents.z * halfExtents.z),
      y: (mass / 12) * (4 * halfExtents.x * halfExtents.x + 4 * halfExtents.z * halfExtents.z),
      z: (mass / 12) * (4 * halfExtents.x * halfExtents.x + 4 * halfExtents.y * halfExtents.y),
    };

    if (this.backend === 'rapier') {
      const R = this.RAPIER;
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(position.x, position.y, position.z)
          .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
          .setLinearDamping(0.02)
          .setAngularDamping(0.6)
          .setCcdEnabled(true)
          .setCanSleep(false)
      );
      const desc = R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setMassProperties(mass, centerOfMass, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.3)
        .setRestitution(0.05)
        .setCollisionGroups(
          interactionGroups(GROUPS.VEHICLE_BODY, GROUPS.STATIC_GEOMETRY | GROUPS.PROPS)
        );
      this.world.createCollider(desc, body);
      return body;
    }
    return this.lite.createBody({ position, quaternion, halfExtents, mass, inertia });
  }

  /** Dynamic knock-over prop (Rapier backend only). Returns body or null. */
  addDynamicCone(position, radius = 0.28, halfHeight = 0.38) {
    if (this.backend !== 'rapier') return null;
    const R = this.RAPIER;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y + halfHeight, position.z)
        .setLinearDamping(0.3)
        .setAngularDamping(0.4)
    );
    const desc = R.ColliderDesc.cone(halfHeight, radius)
      .setMass(4)
      .setFriction(0.7)
      .setRestitution(0.3)
      .setCollisionGroups(
        interactionGroups(GROUPS.PROPS, GROUPS.STATIC_GEOMETRY | GROUPS.VEHICLE_BODY | GROUPS.PROPS)
      );
    this.world.createCollider(desc, body);
    return body;
  }

  // ------------------------------------------------------------- Ray casts

  /**
   * Cast a ray against static geometry. Writes into `out`:
   *   out.hit (bool), out.distance, out.normal (Vector3), out.point (Vector3)
   */
  castRay(origin, dir, maxDist, excludeBody, out) {
    out.hit = false;
    if (this.backend === 'rapier') {
      const ray = this._ray;
      ray.origin.x = origin.x; ray.origin.y = origin.y; ray.origin.z = origin.z;
      ray.dir.x = dir.x; ray.dir.y = dir.y; ray.dir.z = dir.z;
      const hit = this.world.castRayAndGetNormal(
        ray, maxDist, true, undefined, this._rayGroups, undefined, excludeBody
      );
      if (hit) {
        const toi = hit.timeOfImpact ?? hit.toi;
        out.hit = true;
        out.distance = toi;
        out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        out.point.copy(dir).multiplyScalar(toi).add(origin);
      }
      return out;
    }
    return this.lite.castRay(origin, dir, maxDist, out);
  }

  // ------------------------------------------------------------------ Step

  /**
   * Advance the simulation by a variable frame delta using a fixed-step
   * accumulator. `fixedUpdate(dt)` runs before every physics sub-step so
   * controllers can apply forces. Returns the interpolation alpha [0..1].
   */
  step(frameDt, fixedUpdate) {
    this.accumulator += Math.min(frameDt, 0.25);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < MAX_SUBSTEPS) {
      if (fixedUpdate) fixedUpdate(this.fixedDt);
      if (this.backend === 'rapier') this.world.step();
      else this.lite.step(this.fixedDt);
      this.accumulator -= this.fixedDt;
      this.stepCount++;
      steps++;
    }
    // Drop backlog if we are too slow rather than spiralling.
    if (steps === MAX_SUBSTEPS && this.accumulator > this.fixedDt) this.accumulator = 0;
    return this.accumulator / this.fixedDt;
  }
}

// ===========================================================================
// Lite fallback solver — one family of dynamic OBBs vs ground plane + static
// OBBs. Deliberately small; only used when Rapier cannot initialise.
// ===========================================================================

class LiteBody {
  constructor({ position, quaternion, halfExtents, mass, inertia }) {
    this.p = new THREE.Vector3().copy(position);
    this.q = new THREE.Quaternion().copy(quaternion);
    this.v = new THREE.Vector3();
    this.w = new THREE.Vector3();
    this.half = new THREE.Vector3().copy(halfExtents);
    this.m = mass;
    this.invMass = 1 / mass;
    this.invInertiaLocal = new THREE.Vector3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z);
    this.invInertiaWorld = new THREE.Matrix3();
    this.linDamp = 0.02;
    this.angDamp = 0.6;
    this._t = { x: 0, y: 0, z: 0 };
    this._r = { x: 0, y: 0, z: 0, w: 1 };
    this._lv = { x: 0, y: 0, z: 0 };
    this._av = { x: 0, y: 0, z: 0 };
    this.updateInertia();
  }

  updateInertia() {
    // I_world^-1 = R * diag(I_local^-1) * R^T
    const m4 = _tmpM4.makeRotationFromQuaternion(this.q);
    _m3.setFromMatrix4(m4);
    _m3b.copy(_m3).transpose();
    const d = this.invInertiaLocal;
    const e = _m3.elements;
    // scale columns of R by diag
    e[0] *= d.x; e[1] *= d.x; e[2] *= d.x;
    e[3] *= d.y; e[4] *= d.y; e[5] *= d.y;
    e[6] *= d.z; e[7] *= d.z; e[8] *= d.z;
    this.invInertiaWorld.multiplyMatrices(_m3, _m3b);
  }

  // --- Rapier-compatible API subset -------------------------------------
  translation() { const t = this._t; t.x = this.p.x; t.y = this.p.y; t.z = this.p.z; return t; }
  rotation() { const r = this._r; r.x = this.q.x; r.y = this.q.y; r.z = this.q.z; r.w = this.q.w; return r; }
  linvel() { const l = this._lv; l.x = this.v.x; l.y = this.v.y; l.z = this.v.z; return l; }
  angvel() { const a = this._av; a.x = this.w.x; a.y = this.w.y; a.z = this.w.z; return a; }
  mass() { return this.m; }
  worldCom() { return this.translation(); }
  setTranslation(t) { this.p.set(t.x, t.y, t.z); }
  setRotation(r) { this.q.set(r.x, r.y, r.z, r.w); this.updateInertia(); }
  setLinvel(v) { this.v.set(v.x, v.y, v.z); }
  setAngvel(w) { this.w.set(w.x, w.y, w.z); }
  applyImpulse(j) {
    this.v.x += j.x * this.invMass; this.v.y += j.y * this.invMass; this.v.z += j.z * this.invMass;
  }
  applyImpulseAtPoint(j, pt) {
    this.applyImpulse(j);
    _la.set(pt.x - this.p.x, pt.y - this.p.y, pt.z - this.p.z);
    _lb.set(j.x, j.y, j.z);
    _la.cross(_lb).applyMatrix3(this.invInertiaWorld);
    this.w.add(_la);
  }
  applyTorqueImpulse(t) {
    _la.set(t.x, t.y, t.z).applyMatrix3(this.invInertiaWorld);
    this.w.add(_la);
  }
}

const _tmpM4 = new THREE.Matrix4();
const _la = new THREE.Vector3();
const _lb = new THREE.Vector3();

class LiteSolver {
  constructor(gravity) {
    this.gravity = gravity;
    this.groundY = 0;
    this.bodies = [];
    this.statics = []; // { center, half, cos, sin }
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  }

  createBody(opts) {
    const b = new LiteBody(opts);
    this.bodies.push(b);
    return b;
  }

  addStaticBox(position, halfExtents, rotationY) {
    this.statics.push({
      center: new THREE.Vector3().copy(position),
      half: new THREE.Vector3().copy(halfExtents),
      cos: Math.cos(rotationY),
      sin: Math.sin(rotationY),
    });
  }

  castRay(origin, dir, maxDist, out) {
    out.hit = false;
    let best = maxDist;
    // Ground plane
    if (dir.y < -1e-6) {
      const t = (this.groundY - origin.y) / dir.y;
      if (t >= 0 && t < best) {
        best = t;
        out.hit = true;
        out.normal.set(0, 1, 0);
      }
    }
    // Static OBBs (slab test in box-local frame)
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i];
      const ox = origin.x - s.center.x, oy = origin.y - s.center.y, oz = origin.z - s.center.z;
      // world->local: rotate by -theta about Y
      const lox = s.cos * ox - s.sin * oz, loz = s.sin * ox + s.cos * oz;
      const ldx = s.cos * dir.x - s.sin * dir.z, ldz = s.sin * dir.x + s.cos * dir.z;
      const o = [lox, oy, loz], d = [ldx, dir.y, ldz], h = [s.half.x, s.half.y, s.half.z];
      let tmin = 0, tmax = best, axis = -1, sign = 1;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-8) {
          if (o[a] < -h[a] || o[a] > h[a]) { miss = true; break; }
        } else {
          let t1 = (-h[a] - o[a]) / d[a], t2 = (h[a] - o[a]) / d[a];
          let sgn = -1;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sgn = 1; }
          if (t1 > tmin) { tmin = t1; axis = a; sign = sgn; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { miss = true; break; }
        }
      }
      if (!miss && axis >= 0 && tmin < best) {
        best = tmin;
        out.hit = true;
        // local normal -> world
        const n = [0, 0, 0];
        n[axis] = sign;
        out.normal.set(s.cos * n[0] + s.sin * n[2], n[1], -s.sin * n[0] + s.cos * n[2]);
      }
    }
    if (out.hit) {
      out.distance = best;
      out.point.copy(dir).multiplyScalar(best).add(origin);
    }
    return out;
  }

  step(dt) {
    for (const b of this.bodies) {
      b.v.y += this.gravity * dt;
      b.v.multiplyScalar(Math.max(0, 1 - b.linDamp * dt));
      b.w.multiplyScalar(Math.max(0, 1 - b.angDamp * dt));

      b.p.addScaledVector(b.v, dt);
      // q += 0.5 * w * q * dt
      _q2.set(b.w.x * dt * 0.5, b.w.y * dt * 0.5, b.w.z * dt * 0.5, 0).multiply(b.q);
      b.q.set(b.q.x + _q2.x, b.q.y + _q2.y, b.q.z + _q2.z, b.q.w + _q2.w).normalize();
      b.updateInertia();

      this._resolveGround(b);
      this._resolveStatics(b);
    }
  }

  _contact(b, point, normal, depth, friction, restitution) {
    // positional correction
    b.p.addScaledVector(normal, depth * 0.8);
    // relative velocity at point
    _v1.subVectors(point, b.p);
    _v2.copy(b.w).cross(_v1).add(b.v);
    const vn = _v2.dot(normal);
    if (vn >= 0) return;
    // effective mass along normal
    _v3.copy(_v1).cross(normal).applyMatrix3(b.invInertiaWorld).cross(_v1);
    const k = b.invMass + normal.dot(_v3);
    const jn = (-(1 + restitution) * vn) / k;
    _v4.copy(normal).multiplyScalar(jn);
    b.applyImpulseAtPoint(_v4, point);
    // friction
    _v2.copy(b.w).cross(_v1).add(b.v);
    _v3.copy(normal).multiplyScalar(_v2.dot(normal));
    _v2.sub(_v3); // tangential velocity
    const vt = _v2.length();
    if (vt > 1e-4) {
      const jt = Math.min(vt / k, friction * jn);
      _v4.copy(_v2).multiplyScalar(-jt / vt);
      b.applyImpulseAtPoint(_v4, point);
    }
  }

  _resolveGround(b) {
    const c = this._corners;
    let i = 0;
    for (let sx = -1; sx <= 1; sx += 2)
      for (let sy = -1; sy <= 1; sy += 2)
        for (let sz = -1; sz <= 1; sz += 2)
          c[i++].set(sx * b.half.x, sy * b.half.y, sz * b.half.z).applyQuaternion(b.q).add(b.p);
    for (let k = 0; k < 8; k++) {
      const depth = this.groundY - c[k].y;
      if (depth > 0) this._contact(b, c[k], _upN, depth, 0.6, 0.0);
    }
  }

  _resolveStatics(b) {
    // Approximate chassis with 3 spheres along its length.
    const r = Math.min(b.half.x, b.half.y * 1.6);
    for (let sIdx = -1; sIdx <= 1; sIdx++) {
      _sphere.set(0, 0, sIdx * (b.half.z - r)).applyQuaternion(b.q).add(b.p);
      for (const s of this.statics) {
        const dx = _sphere.x - s.center.x, dy = _sphere.y - s.center.y, dz = _sphere.z - s.center.z;
        const lx = s.cos * dx - s.sin * dz, lz = s.sin * dx + s.cos * dz;
        const cx = Math.max(-s.half.x, Math.min(s.half.x, lx));
        const cy = Math.max(-s.half.y, Math.min(s.half.y, dy));
        const cz = Math.max(-s.half.z, Math.min(s.half.z, lz));
        const ex = lx - cx, ey = dy - cy, ez = lz - cz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= r * r || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        // local normal -> world
        const nlx = ex / d, nly = ey / d, nlz = ez / d;
        _n.set(s.cos * nlx + s.sin * nlz, nly, -s.sin * nlx + s.cos * nlz);
        _cp.copy(_sphere).addScaledVector(_n, -r);
        this._contact(b, _cp, _n, r - d, 0.3, 0.2);
      }
    }
  }
}

const _upN = new THREE.Vector3(0, 1, 0);
const _sphere = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cp = new THREE.Vector3();
