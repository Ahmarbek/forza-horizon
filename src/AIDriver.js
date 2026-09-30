import * as THREE from 'three';

/**
 * AIDriver.js
 * -----------
 * Produces {throttle, brake, steer, handbrake} for an AI Vehicle so it can use
 * exactly the same physics as the player.
 *  - Pure-pursuit steering toward a speed-scaled look-ahead point on the spline
 *  - Corner speed planning from upcoming curvature (v = sqrt(mu*g/k)) with a
 *    braking envelope, scaled by the driver's skill
 *  - Simple traffic avoidance (lane shift when a car is ahead)
 *  - Stuck detection → reverse → respawn on the racing line
 *  - Mild rubber-banding relative to the player
 */

const _tgt = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _p = new THREE.Vector3();

export class AIDriver {
  constructor(route, { skill = 1, lane = 0, name = 'AI' } = {}) {
    this.route = route;
    this.skill = skill; // ~0.85 (easy) … 1.05 (hard)
    this.baseLane = lane;
    this.lane = lane;
    this.name = name;
    this.idx = -1;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.enabled = false;
    this.rubber = 1;
  }

  reset() {
    this.idx = -1;
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.lane = this.baseLane;
  }

  /**
   * @param {number} dt
   * @param {Vehicle} v the AI's own vehicle
   * @param {Vehicle[]} others every other car (for avoidance)
   */
  update(dt, v, others) {
    const inp = this.input;
    if (!this.enabled) {
      inp.throttle = 0; inp.brake = 1; inp.steer = 0; inp.handbrake = true;
      return inp;
    }
    const route = this.route;
    const n = route.count;
    const spacing = route.spacing;
    const pos = v.root.position;
    this.idx = route.nearestIndex(pos.x, pos.z, this.idx);
    const speed = Math.max(0, v.speed);

    // --- Traffic avoidance: shift lane if someone is close ahead
    _fwd.copy(v.forward).setY(0).normalize();
    _left.set(_fwd.z, 0, -_fwd.x); // +X-left convention
    let targetLane = this.baseLane;
    for (const o of others) {
      _d.subVectors(o.root.position, pos);
      const ahead = _d.dot(_fwd);
      const lat = _d.dot(_left);
      if (ahead > 0 && ahead < 16 && Math.abs(lat) < 2.6) {
        targetLane = lat > 0 ? -3.6 : 3.6; // pass on the other side
        break;
      }
    }
    this.lane += THREE.MathUtils.clamp(targetLane - this.lane, -3 * dt, 3 * dt);

    // --- Steering (pure pursuit)
    const look = 7 + speed * 0.55;
    route.point(this.idx + look / spacing, this.lane, _tgt);
    _d.subVectors(_tgt, pos).setY(0);
    const ang = Math.atan2(_d.dot(_left), _d.dot(_fwd));
    inp.steer = THREE.MathUtils.clamp((ang * 1.25) / v.steerLimit(speed), -1, 1);

    // --- Speed planning from curvature ahead
    // loose surfaces: plan for less grip (rally tyres claw some back)
    const loose = route.type === 'dirt' ? 0.76 + 0.2 * (v.preset.offroad ?? 0) : 1;
    const decel = 8.5 * this.skill * loose;
    const mu = 1.05 * this.skill * loose * ((v.preset.gripFront + v.preset.gripRear) / 2 / 1.25);
    const horizon = Math.min(260, 30 + (speed * speed) / (2 * decel));
    let target = v.preset.topSpeed;
    const win = Math.max(2, Math.round(12 / spacing));
    for (let d = 6; d < horizon; d += 8) {
      const i0 = this.idx + Math.round(d / spacing);
      const a = route._wrap(i0 - win), b = route._wrap(i0 + win);
      const dot = route.tx[a] * route.tx[b] + route.tz[a] * route.tz[b];
      const dTheta = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      const k = dTheta / (2 * win * spacing);
      if (k < 1e-4) continue;
      const vCorner = Math.sqrt((mu * 9.81) / k);
      const vAllowed = Math.sqrt(vCorner * vCorner + 2 * decel * Math.max(0, d - 6));
      if (vAllowed < target) target = vAllowed;
    }
    target *= this.rubber;
    // open routes: pull over and stop at the end of the road
    if (!route.closed && this.idx >= route.count - Math.round(40 / spacing)) target = 0;

    if (speed < target - 1.5) { inp.throttle = 1; inp.brake = 0; }
    else if (speed < target + 1) { inp.throttle = 0.35; inp.brake = 0; }
    else { inp.throttle = 0; inp.brake = THREE.MathUtils.clamp((speed - target) / 5, 0.2, 1); }
    inp.handbrake = false;

    // --- Stuck recovery
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      inp.throttle = 0;
      inp.brake = 1; // brake held while stopped → Vehicle engages reverse
      inp.steer = -inp.steer;
      return inp;
    }
    if (speed < 1.5 && inp.throttle > 0.5) {
      this.stuckTime += dt;
      if (this.stuckTime > 5) {
        this.respawn(v);
      } else if (this.stuckTime > 2 && this.stuckTime - dt <= 2) {
        this.reverseTime = 1.1;
      }
    } else if (speed > 4) {
      this.stuckTime = 0;
    }
    // Also respawn if we wandered far from the road
    route.point(this.idx, 0, _p);
    if (Math.hypot(_p.x - pos.x, _p.z - pos.z) > 45 || pos.y < _p.y - 15) this.respawn(v);
    return inp;
  }

  respawn(v) {
    const route = this.route;
    const i = this.idx + Math.round(-6 / route.spacing);
    route.point(i, this.baseLane, _p);
    _p.y += 1.2;
    v.reset(_p, route.yaw(i));
    this.stuckTime = 0;
    this.reverseTime = 0;
  }
}
