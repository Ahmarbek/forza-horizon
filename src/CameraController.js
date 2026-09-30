import * as THREE from 'three';

/**
 * CameraController.js
 * -------------------
 * Modes:
 *  - 'chase'    Close chase (default) — locked tight behind the car
 *  - 'far'      Far chase
 *  - 'bumper'   Bumper / hood view
 *  - 'showroom' Slow orbit around the car (menus, title)
 *
 * The chase rig is rigidly attached to the car at a fixed distance; only yaw,
 * height and a small acceleration offset are smoothed, so the camera never
 * falls behind under acceleration. It follows the road grade, pulls in when a
 * wall/building is behind the car, and never dips under the terrain.
 */

const MODES = {
  chase: { distance: 5.4, height: 1.65, lookHeight: 1.0, lookAhead: 3.2, fovBase: 62, fovMax: 80 },
  far: { distance: 8.2, height: 2.5, lookHeight: 1.15, lookAhead: 4.5, fovBase: 60, fovMax: 76 },
  bumper: { distance: -1.35, height: 0.62, lookHeight: 0.6, lookAhead: 20, fovBase: 72, fovMax: 90 },
};
export const CHASE_MODE_NAMES = { chase: 'Close Chase', far: 'Far Chase', bumper: 'Bumper' };
const ORDER = ['chase', 'far', 'bumper'];
const FOV_SPEED = 80; // m/s at which FOV reaches max

// Scratch (reused every frame)
const _carPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _up = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _shake = new THREE.Vector3();
const _hit = { hit: false, distance: 0, normal: new THREE.Vector3(), point: new THREE.Vector3() };
const _Y = new THREE.Vector3(0, 1, 0);

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
const damp = (dt, rate) => 1 - Math.exp(-dt * rate);

export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} opts { physics, heightAt(x,z) }
   */
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.physics = opts.physics || null;
    this.heightAt = opts.heightAt || (() => 0);
    this.mode = 'chase';
    this.chaseMode = 'chase';
    this.position = new THREE.Vector3(0, 4, -10);
    this.lookTarget = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 62;
    this.roll = 0;
    this.accelOffset = 0;
    this.orbitAngle = 0;
    this.shakeAmount = 0;
    this.time = 0;
    this.lookBias = 0;
    this.collide = 1;
    this.initialized = false;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'showroom') this.chaseMode = mode;
  }

  cycleChaseMode() {
    this.chaseMode = ORDER[(ORDER.indexOf(this.chaseMode) + 1) % ORDER.length];
    if (this.mode !== 'showroom') this.mode = this.chaseMode;
    return CHASE_MODE_NAMES[this.chaseMode];
  }

  impact(strength) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + strength);
  }

  snap(vehicle) {
    const root = vehicle.root;
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
    this.yaw = Math.atan2(_fwd.x, _fwd.z);
    this.pitch = 0;
    this.accelOffset = 0;
    this.initialized = true;
    this._first = true;
  }

  update(dt, vehicle) {
    if (!this.initialized) this.snap(vehicle);
    this.time += dt;
    const cam = this.camera;
    const root = vehicle.root;
    _carPos.copy(root.position);
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
    _left.set(1, 0, 0).applyQuaternion(root.quaternion);
    _up.set(0, 1, 0).applyQuaternion(root.quaternion);
    const speed = vehicle.speedAbs;
    const speed01 = THREE.MathUtils.clamp(speed / FOV_SPEED, 0, 1);

    let targetFov;
    if (this.mode === 'showroom') {
      this.orbitAngle += dt * 0.22;
      const headYaw = Math.atan2(_fwd.x, _fwd.z);
      const a = headYaw + Math.PI * 0.8 + this.orbitAngle;
      _desired.set(Math.sin(a) * 7.2, 1.4 + Math.sin(this.orbitAngle * 0.7) * 0.4, Math.cos(a) * 7.2).add(_carPos);
      _desired.y = Math.max(_desired.y, this.heightAt(_desired.x, _desired.z) + 0.6);
      _look.copy(_carPos).addScaledVector(_Y, 0.1);
      targetFov = 40;
      const k = this._first ? 1 : damp(dt, 3);
      this.position.lerp(_desired, k);
      this.lookTarget.lerp(_look, k);
      this.roll = THREE.MathUtils.lerp(this.roll, 0, damp(dt, 4));
      this.yaw = Math.atan2(_carPos.x - this.position.x, _carPos.z - this.position.z);
    } else if (this.mode === 'bumper') {
      const m = MODES.bumper;
      // rigid: attached to the chassis
      this.position.copy(_carPos).addScaledVector(_fwd, -m.distance).addScaledVector(_up, m.height);
      this.lookTarget.copy(this.position).addScaledVector(_fwd, m.lookAhead).addScaledVector(_up, -0.4);
      targetFov = m.fovBase + (m.fovMax - m.fovBase) * speed01;
      this.roll = 0;
    } else {
      const m = MODES[this.chaseMode];
      // --- yaw: fast follow of heading, a little velocity blend in slides
      const headYaw = Math.atan2(_fwd.x, _fwd.z);
      let targetYaw = headYaw;
      const vel = vehicle.velocity;
      const planar = Math.hypot(vel.x, vel.z);
      if (planar > 6 && vehicle.speed > 0) {
        const w = THREE.MathUtils.clamp((planar - 6) / 20, 0, 0.35);
        targetYaw = headYaw + wrapAngle(Math.atan2(vel.x, vel.z) - headYaw) * w;
      }
      this.yaw += wrapAngle(targetYaw - this.yaw) * (this._first ? 1 : damp(dt, 9));
      // --- pitch follows the road grade (smoothed)
      const grade = THREE.MathUtils.clamp(_fwd.y, -0.5, 0.5);
      this.pitch = THREE.MathUtils.lerp(this.pitch, grade, this._first ? 1 : damp(dt, 5));
      // --- small acceleration offset (never more than ~0.35 m)
      const targetOff = THREE.MathUtils.clamp(vehicle.longAccel * 0.03, -0.25, 0.35);
      this.accelOffset = THREE.MathUtils.lerp(this.accelOffset, targetOff, damp(dt, 6));

      _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const dist = m.distance + this.accelOffset;
      _desired.copy(_carPos)
        .addScaledVector(_dir, -dist)
        .addScaledVector(_Y, Math.max(0.9, m.height - this.pitch * dist));

      this.lookBias = THREE.MathUtils.lerp(this.lookBias, vehicle.steerAngle * 2.2 * (0.35 + speed01), damp(dt, 4));
      _look.copy(_carPos)
        .addScaledVector(_Y, m.lookHeight)
        .addScaledVector(_dir, m.lookAhead * (0.5 + speed01 * 0.6))
        .addScaledVector(_left, this.lookBias);
      _look.y += this.pitch * m.lookAhead;

      // --- occlusion: pull in when a wall is between car and camera
      let pull = 1;
      if (this.physics) {
        const origin = _ray.copy(_carPos).addScaledVector(_Y, 1.0);
        _dir.subVectors(_desired, origin);
        const len = _dir.length();
        _dir.divideScalar(len);
        this.physics.castRay(origin, _dir, len + 0.3, undefined, _hit);
        if (_hit.hit && _hit.distance < len + 0.3) pull = Math.max(0.25, (_hit.distance - 0.4) / len);
      }
      this.collide = Math.min(pull, THREE.MathUtils.lerp(this.collide, pull, damp(dt, 4)));
      if (this.collide < 1) _desired.lerpVectors(_ray.copy(_carPos).addScaledVector(_Y, 1.0), _desired, this.collide);

      // --- height smoothing only; horizontal position is locked
      if (this._first) this.position.copy(_desired);
      else {
        this.position.x = _desired.x;
        this.position.z = _desired.z;
        this.position.y = THREE.MathUtils.lerp(this.position.y, _desired.y, damp(dt, 14));
      }
      const ground = this.heightAt(this.position.x, this.position.z) + 0.45;
      if (this.position.y < ground) this.position.y = ground;
      this.lookTarget.copy(_look);

      targetFov = m.fovBase + (m.fovMax - m.fovBase) * speed01 * speed01 * (3 - 2 * speed01);
      const targetRoll = THREE.MathUtils.clamp(vehicle.latAccel * 0.0018, -0.04, 0.04);
      this.roll = THREE.MathUtils.lerp(this.roll, targetRoll, damp(dt, 4));
    }
    this._first = false;

    // --- shake: high-speed rumble + impacts
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.5);
    const rumble = this.mode === 'showroom' ? 0 : Math.max(0, speed01 - 0.5) * 0.035;
    const s = rumble + this.shakeAmount * 0.22;
    const t = this.time;
    _shake.set((Math.sin(t * 37.1) + Math.sin(t * 23.7)) * 0.5 * s, (Math.sin(t * 41.3) + Math.sin(t * 29.9)) * 0.5 * s, 0);

    cam.position.copy(this.position).add(_shake);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.lookTarget);
    if (this.roll !== 0) cam.rotateZ(this.roll);

    this.fov = THREE.MathUtils.lerp(this.fov, targetFov, damp(dt, 3));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
