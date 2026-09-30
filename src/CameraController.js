import * as THREE from 'three';

/**
 * CameraController.js
 * -------------------
 * Modes:
 *  - 'chase'    Close chase (default)
 *  - 'far'      Far chase
 *  - 'showroom' Slow orbit around the car (menu state)
 *
 * Position follows a critically-damped spring toward the ideal rig position;
 * yaw follows a blend of chassis heading and velocity heading (so drifts are
 * framed from the outside). Speed drives FOV (60° → 85°) and a subtle
 * high-speed shake; longitudinal / lateral acceleration drive pitch & roll.
 */

const MODES = {
  chase: { distance: 6.2, height: 1.9, lookHeight: 1.0, lookAhead: 4.0, stiffness: 55 },
  far: { distance: 9.5, height: 3.1, lookHeight: 1.1, lookAhead: 5.0, stiffness: 40 },
};
export const CHASE_MODE_NAMES = { chase: 'Close Chase', far: 'Far Chase' };

const BASE_FOV = 60;
const MAX_FOV = 85;
const FOV_SPEED = 75; // m/s at which FOV reaches max

// Scratch (reused every frame)
const _carPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _shake = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.chaseMode = 'chase';
    this.position = new THREE.Vector3(0, 4, -10);
    this.velocity = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.lookVelocity = new THREE.Vector3();
    this.yaw = 0;
    this.fov = BASE_FOV;
    this.roll = 0;
    this.pitchOffset = 0;
    this.orbitAngle = 0;
    this.shakeAmount = 0;
    this.time = 0;
    this.lookBias = 0;
    this.initialized = false;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'showroom') this.chaseMode = mode;
  }

  cycleChaseMode() {
    this.chaseMode = this.chaseMode === 'chase' ? 'far' : 'chase';
    if (this.mode !== 'showroom') this.mode = this.chaseMode;
    return CHASE_MODE_NAMES[this.chaseMode];
  }

  /** Add an impulse to the camera shake (e.g. on collisions). */
  impact(strength) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + strength);
  }

  /** Snap behind the car (after reset / first frame). */
  snap(vehicle) {
    const root = vehicle.root;
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
    this.yaw = Math.atan2(_fwd.x, _fwd.z);
    const m = MODES[this.chaseMode];
    _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.position.copy(root.position).addScaledVector(_dir, -m.distance).addScaledVector(_Y, m.height);
    this.lookTarget.copy(root.position).addScaledVector(_Y, m.lookHeight);
    this.velocity.set(0, 0, 0);
    this.lookVelocity.set(0, 0, 0);
    this.initialized = true;
  }

  update(dt, vehicle) {
    if (!this.initialized) this.snap(vehicle);
    this.time += dt;
    const cam = this.camera;
    const root = vehicle.root;
    _carPos.copy(root.position);
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
    _left.set(1, 0, 0).applyQuaternion(root.quaternion);

    const speed = vehicle.speedAbs;
    const speed01 = THREE.MathUtils.clamp(speed / FOV_SPEED, 0, 1);

    let targetFov;
    let stiffness;
    if (this.mode === 'showroom') {
      this.orbitAngle += dt * 0.22;
      const headYaw = Math.atan2(_fwd.x, _fwd.z);
      const a = headYaw + Math.PI * 0.8 + this.orbitAngle;
      _desired.set(Math.sin(a) * 7.2, 1.5 + Math.sin(this.orbitAngle * 0.7) * 0.4, Math.cos(a) * 7.2).add(_carPos);
      _look.copy(_carPos).addScaledVector(_Y, 0.2);
      targetFov = 42;
      stiffness = 12;
      this.roll = THREE.MathUtils.lerp(this.roll, 0, 1 - Math.exp(-dt * 4));
      this.yaw = Math.atan2(_carPos.x - _desired.x, _carPos.z - _desired.z);
    } else {
      const m = MODES[this.chaseMode];
      // --- Yaw: heading blended with velocity direction
      const headYaw = Math.atan2(_fwd.x, _fwd.z);
      let targetYaw = headYaw;
      const vel = vehicle.velocity;
      const planar = Math.hypot(vel.x, vel.z);
      if (planar > 4 && vehicle.speed > 0) {
        const velYaw = Math.atan2(vel.x, vel.z);
        const w = THREE.MathUtils.clamp((planar - 4) / 12, 0, 0.55);
        targetYaw = headYaw + wrapAngle(velYaw - headYaw) * w;
      }
      if (vehicle.speed < -2) targetYaw = headYaw; // reversing: stay behind
      const yawRate = 5.5;
      this.yaw += wrapAngle(targetYaw - this.yaw) * (1 - Math.exp(-dt * yawRate));

      // --- Rig position
      const dist = m.distance + speed01 * 1.2;
      _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      // Acceleration pitch: camera dips when braking, lifts on launch
      this.pitchOffset = THREE.MathUtils.lerp(
        this.pitchOffset,
        THREE.MathUtils.clamp(-vehicle.longAccel * 0.018, -0.35, 0.35),
        1 - Math.exp(-dt * 5)
      );
      _desired.copy(_carPos).addScaledVector(_dir, -dist).addScaledVector(_Y, m.height + this.pitchOffset);
      // keep above ground
      _desired.y = Math.max(_desired.y, 0.6);

      // --- Look target with steering look-ahead bias
      this.lookBias = THREE.MathUtils.lerp(
        this.lookBias,
        vehicle.steerAngle * 3.2 * (0.4 + speed01),
        1 - Math.exp(-dt * 3)
      );
      _look.copy(_carPos)
        .addScaledVector(_Y, m.lookHeight)
        .addScaledVector(_dir, m.lookAhead * (0.4 + speed01 * 0.8))
        .addScaledVector(_left, this.lookBias);

      targetFov = BASE_FOV + (MAX_FOV - BASE_FOV) * speed01 * speed01 * (3 - 2 * speed01);
      stiffness = m.stiffness;

      // --- Roll from lateral acceleration
      const targetRoll = THREE.MathUtils.clamp(vehicle.latAccel * 0.0025, -0.06, 0.06);
      this.roll = THREE.MathUtils.lerp(this.roll, targetRoll, 1 - Math.exp(-dt * 4));
    }

    // --- Critically-damped spring (sub-stepped for stability)
    const damping = 2 * Math.sqrt(stiffness);
    let remaining = dt;
    while (remaining > 1e-5) {
      const h = Math.min(remaining, 1 / 120);
      _acc.subVectors(_desired, this.position).multiplyScalar(stiffness).addScaledVector(this.velocity, -damping);
      // vertical axis stiffer to avoid bobbing through terrain
      _acc.y += (_desired.y - this.position.y) * stiffness * 0.6;
      this.velocity.addScaledVector(_acc, h);
      this.position.addScaledVector(this.velocity, h);

      _acc.subVectors(_look, this.lookTarget).multiplyScalar(stiffness * 2.2)
        .addScaledVector(this.lookVelocity, -2 * Math.sqrt(stiffness * 2.2));
      this.lookVelocity.addScaledVector(_acc, h);
      this.lookTarget.addScaledVector(this.lookVelocity, h);
      remaining -= h;
    }

    // --- Shake: speed rumble + impact impulses
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.5);
    const rumble = this.mode === 'showroom' ? 0 : Math.max(0, speed01 - 0.45) * 0.05;
    const s = rumble + this.shakeAmount * 0.25;
    const t = this.time;
    _shake.set(
      (Math.sin(t * 37.1) + Math.sin(t * 23.7)) * 0.5 * s,
      (Math.sin(t * 41.3) + Math.sin(t * 29.9)) * 0.5 * s,
      0
    );

    cam.position.copy(this.position).add(_shake);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.lookTarget);
    if (this.roll !== 0) cam.rotateZ(this.roll);

    this.fov = THREE.MathUtils.lerp(this.fov, targetFov, 1 - Math.exp(-dt * 3));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
