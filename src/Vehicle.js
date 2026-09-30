import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTaillightGlowMaterial, createLightLensMaterial } from './Shaders.js';

/**
 * Vehicle.js
 * ----------
 * Arcade raycast vehicle:
 *  - 4 independent suspension rays (spring stiffness, bump/rebound damping,
 *    rest length, bump stop, anti-roll bars)
 *  - Engine torque curve with top-speed falloff, 6-speed auto box + reverse
 *  - Speed-sensitive steering, friction-circle tyre model
 *  - Handbrake drift mode (rear lateral grip collapse)
 *  - Keyboard + Gamepad input
 *  - Procedural low-poly car (always built instantly); optional GLTF swap-in
 */

// ============================================================================
// Car presets (also drive the Garage menu)
// ============================================================================
export const CAR_PRESETS = [
  {
    id: 'sakura-gt',
    name: 'Sakura GT',
    price: 0,
    drive: 'RWD',
    color: '#c9ccd4',
    mass: 1400,
    engineForce: 10500,
    topSpeed: 76, // m/s (~170 mph)
    brakeForce: 16000,
    maxSteer: 0.58,
    gripFront: 1.25,
    gripRear: 1.2,
    springK: 31000,
    stats: { speed: 0.82, handling: 0.78, accel: 0.74, launch: 0.6 },
  },
  {
    id: 'volta-r',
    name: 'Volta R',
    price: 120000,
    drive: 'AWD',
    color: '#c25a1d',
    mass: 1550,
    engineForce: 14500,
    topSpeed: 88,
    brakeForce: 19000,
    maxSteer: 0.52,
    gripFront: 1.35,
    gripRear: 1.35,
    springK: 36000,
    stats: { speed: 0.95, handling: 0.84, accel: 0.9, launch: 0.92 },
  },
  {
    id: 'kaze-drift',
    name: 'Kaze Drift',
    price: 45000,
    drive: 'RWD',
    color: '#ff2d8f',
    mass: 1250,
    engineForce: 9000,
    topSpeed: 66,
    brakeForce: 14000,
    maxSteer: 0.7,
    gripFront: 1.3,
    gripRear: 0.95,
    springK: 27000,
    stats: { speed: 0.66, handling: 0.9, accel: 0.7, launch: 0.55 },
  },
  {
    id: 'yama-rally',
    name: 'Yama Rally',
    price: 70000,
    drive: 'AWD',
    color: '#1f6feb',
    mass: 1330,
    engineForce: 11200,
    topSpeed: 70,
    brakeForce: 16500,
    maxSteer: 0.64,
    gripFront: 1.3,
    gripRear: 1.25,
    springK: 26000,
    stats: { speed: 0.72, handling: 0.86, accel: 0.84, launch: 0.9 },
  },
  {
    id: 'tenshi-x',
    name: 'Tenshi X',
    price: 250000,
    drive: 'AWD',
    color: '#f4f4f4',
    mass: 1420,
    engineForce: 17500,
    topSpeed: 98,
    brakeForce: 21000,
    maxSteer: 0.5,
    gripFront: 1.45,
    gripRear: 1.42,
    springK: 40000,
    stats: { speed: 1.0, handling: 0.9, accel: 1.0, launch: 0.95 },
  },
];

// ============================================================================
// Upgrades & performance index
// ============================================================================
export const UPGRADE_TYPES = {
  engine: { label: 'Engine', costs: [8000, 18000, 35000] },
  grip: { label: 'Tyres', costs: [6000, 14000, 28000] },
  brakes: { label: 'Brakes', costs: [4000, 9000, 18000] },
};

/** Returns a copy of `base` with upgrade tiers (0-3) applied. */
export function tunePreset(base, up = {}) {
  const e = up.engine || 0, g = up.grip || 0, b = up.brakes || 0;
  return {
    ...base,
    engineForce: base.engineForce * (1 + 0.09 * e),
    topSpeed: base.topSpeed * (1 + 0.035 * e),
    gripFront: base.gripFront * (1 + 0.06 * g),
    gripRear: base.gripRear * (1 + 0.06 * g),
    brakeForce: base.brakeForce * (1 + 0.12 * b),
    upgrades: { engine: e, grip: g, brakes: b },
  };
}

/** Forza-style performance index + class letter. */
export function performanceIndex(p) {
  const raw = p.topSpeed * 4 + (p.engineForce / p.mass) * 30
    + ((p.gripFront + p.gripRear) / 2) * 120 + (p.brakeForce / p.mass) * 4;
  const pi = Math.round(THREE.MathUtils.clamp(800 + (raw - 721.6) * 0.82, 100, 999));
  const klass = pi <= 500 ? 'D' : pi <= 600 ? 'C' : pi <= 700 ? 'B' : pi <= 800 ? 'A' : pi <= 900 ? 'S1' : pi <= 998 ? 'S2' : 'X';
  return { pi, klass, label: `${klass} ${pi}` };
}

export const PAINT_COLORS = ['#c9ccd4', '#c25a1d', '#ff2d8f', '#1f6feb', '#ffd23f', '#1b1d22', '#f4f4f4', '#27c485'];

const MODEL_DIR = './assets/cars/';
const MODEL_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Car model cache (Blender-built glTF per car id) + shared materials
// ---------------------------------------------------------------------------
const modelCache = new Map();
function loadCarModel(id) {
  if (!modelCache.has(id)) {
    const loader = new GLTFLoader();
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), MODEL_TIMEOUT_MS);
      loader.load(`${MODEL_DIR}${id}.glb`, (g) => { clearTimeout(timer); resolve(g.scene); },
        undefined, (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e?.message || e))); });
    });
    modelCache.set(id, p);
  }
  return modelCache.get(id);
}

/** Start downloading every car model up front (garage + AI use them all). */
export function preloadCarModels() {
  return Promise.allSettled(CAR_PRESETS.map((c) => loadCarModel(c.id)));
}

let SHARED = null;
function sharedMaterials() {
  if (SHARED) return SHARED;
  SHARED = {
    Glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.66, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.8 }),
    Trim: new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.55, metalness: 0.2 }),
    Grille: new THREE.MeshStandardMaterial({ color: 0x060607, roughness: 0.4, metalness: 0.35 }),
    Carbon: new THREE.MeshPhysicalMaterial({ color: 0x131417, roughness: 0.32, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.05 }),
    Chrome: new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 1, roughness: 0.06 }),
    Interior: new THREE.MeshStandardMaterial({ color: 0x19191b, roughness: 0.82 }),
    Tire: new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.9 }),
    Rim: new THREE.MeshStandardMaterial({ color: 0xb9bdc5, metalness: 1, roughness: 0.2 }),
    Brake: new THREE.MeshStandardMaterial({ color: 0x5d5d62, metalness: 1, roughness: 0.42 }),
    Caliper: new THREE.MeshStandardMaterial({ color: 0xd61c1c, roughness: 0.35, metalness: 0.2 }),
    Plate: new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.45 }),
  };
  return SHARED;
}

let SHADOW_TEX = null;
function contactShadowTexture() {
  if (SHADOW_TEX) return SHADOW_TEX;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 64, 4, 32, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.save();
  ctx.scale(1, 1);
  ctx.fillRect(0, 0, 64, 128);
  ctx.restore();
  SHADOW_TEX = new THREE.CanvasTexture(c);
  return SHADOW_TEX;
}

// Geometry constants (body-local, +Z forward, +X left, +Y up)
const HALF_EXTENTS = { x: 0.92, y: 0.32, z: 2.15 };
const WHEEL_RADIUS = 0.36;
const WHEEL_WIDTH = 0.3;
const REST_LENGTH = 0.38;
const WHEEL_LAYOUT = [
  // x (left+), z (fwd+), front?
  { x: 0.83, z: 1.36, front: true },   // FL
  { x: -0.83, z: 1.36, front: true },  // FR
  { x: 0.84, z: -1.32, front: false }, // RL
  { x: -0.84, z: -1.32, front: false },// RR
];
const MOUNT_Y = 0.0;
const GEAR_SPLITS = [0.19, 0.33, 0.48, 0.63, 0.8, 1.0];
const IDLE_RPM = 900;
const REDLINE_RPM = 8200;
const GRAVITY = 9.81;

// ============================================================================
// Scratch objects — allocated once, reused every step (no GC in the loop)
// ============================================================================
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _lv = new THREE.Vector3();
const _av = new THREE.Vector3();
const _com = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _impObj = { x: 0, y: 0, z: 0 };
const _ptObj = { x: 0, y: 0, z: 0 };
const _Y = new THREE.Vector3(0, 1, 0);

function toObj(v, o) { o.x = v.x; o.y = v.y; o.z = v.z; return o; }
const clamp = THREE.MathUtils.clamp;

// ============================================================================
// Input
// ============================================================================
export class InputController {
  constructor() {
    this.keys = new Set();
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0; // +1 = left
    this.handbrake = false;
    this.usingGamepad = false;
    this.enabled = true;

    // edge-triggered actions (consumed by main loop)
    this.touch = null; // optional on-screen controls state (see UI)
    this.actions = { menu: false, camera: false, reset: false, radio: false, tabLeft: false, tabRight: false,
      navUp: false, navDown: false, navLeft: false, navRight: false, confirm: false, back: false };
    this._prevButtons = [];

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyC') this.actions.camera = true;
      if (e.code === 'KeyR') this.actions.reset = true;
      if (e.code === 'KeyM') this.actions.radio = true;
      this.usingGamepad = false;
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  consume(name) {
    const v = this.actions[name];
    this.actions[name] = false;
    return v;
  }

  update(dt) {
    const k = this.keys;
    let kThrottle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let kBrake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let kSteer = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    let kHand = k.has('Space');
    const t = this.touch;
    if (t && t.active) {
      if (t.throttle) kThrottle = 1;
      if (t.brake) kBrake = 1;
      if (t.handbrake) kHand = true;
      kSteer += (t.left ? 1 : 0) - (t.right ? 1 : 0);
      kSteer = Math.max(-1, Math.min(1, kSteer));
    }

    // --- Gamepad
    let gp = null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    let gThrottle = 0, gBrake = 0, gSteer = 0, gHand = false;
    if (gp) {
      const b = gp.buttons;
      const val = (i) => (b[i] ? (typeof b[i] === 'object' ? b[i].value : b[i]) : 0);
      const pressed = (i) => (b[i] ? (typeof b[i] === 'object' ? b[i].pressed : b[i] > 0.5) : false);
      gThrottle = val(7);
      gBrake = val(6);
      const ax = gp.axes[0] || 0;
      const dz = 0.12;
      const mag = Math.abs(ax) < dz ? 0 : (Math.abs(ax) - dz) / (1 - dz);
      gSteer = -Math.sign(ax) * mag * (0.35 + 0.65 * mag); // progressive response
      gHand = pressed(0);
      if (gThrottle > 0.05 || gBrake > 0.05 || Math.abs(gSteer) > 0.05 || gHand) this.usingGamepad = true;

      const edge = (i, action) => {
        const now = pressed(i);
        if (now && !this._prevButtons[i]) this.actions[action] = true;
        this._prevButtons[i] = now;
      };
      edge(9, 'menu');
      edge(8, 'camera');
      edge(3, 'reset');
      edge(4, 'tabLeft');
      edge(5, 'tabRight');
      edge(12, 'navUp');
      edge(13, 'navDown');
      edge(14, 'navLeft');
      edge(15, 'navRight');
      edge(0, 'confirm');
      edge(1, 'back');
    }

    if (!this.enabled) {
      kThrottle = kBrake = kSteer = 0; kHand = false;
      gThrottle = gBrake = gSteer = 0; gHand = false;
    }

    this.throttle = Math.max(kThrottle, gThrottle);
    this.brake = Math.max(kBrake, gBrake);
    this.handbrake = kHand || gHand;

    if (this.usingGamepad && gp) {
      this.steer = gSteer;
    } else {
      // Keyboard steering ramps in/out for smoothness
      const rate = kSteer === 0 || Math.sign(kSteer) !== Math.sign(this.steer) ? 7 : 3.2;
      const target = kSteer;
      const d = target - this.steer;
      this.steer += clamp(d, -rate * dt, rate * dt);
    }
  }
}

// ============================================================================
// Vehicle
// ============================================================================
export class Vehicle {
  /**
   * @param {object} options { loadModel: bool, name: string }
   */
  constructor(scene, physics, preset = CAR_PRESETS[0], options = {}) {
    this.scene = scene;
    this.physics = physics;
    this.preset = { ...preset };
    this.name = options.name ?? preset.name;
    this.isPlayer = options.loadModel !== false;
    this.skid = 0; // 0..1 tyre scrub amount (audio / smoke)

    this.root = new THREE.Group();
    this.root.name = 'Vehicle';
    scene.add(this.root);

    // Telemetry (read by UI/camera/skills)
    this.speed = 0; // signed forward m/s
    this.speedAbs = 0;
    this.rpm = IDLE_RPM;
    this.gear = 1;
    this.gearLabel = 'N';
    this.direction = 1; // 1 drive, -1 reverse
    this.throttleInput = 0;
    this.brakeInput = 0;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.handbrake = false;
    this.driftAngle = 0; // radians between heading and velocity
    this.isDrifting = false;
    this.grounded = 0; // wheels on ground
    this.airTime = 0;
    this.lastImpact = 0; // m/s delta-v of last collision
    this.impactEvent = 0;
    this.landEvent = 0;
    this.longAccel = 0;
    this.latAccel = 0;
    this.shiftEvent = false;
    this._shiftTimer = 0;
    this._reverseTimer = 0;
    this._upsideTimer = 0;
    this._prevSpeed = 0;
    this._expectedVel = new THREE.Vector3();
    this._hasExpected = false;

    this.wheels = WHEEL_LAYOUT.map((w, i) => ({
      index: i,
      front: w.front,
      left: w.x > 0,
      mount: new THREE.Vector3(w.x, MOUNT_Y, w.z),
      compression: 0,
      prevCompression: 0,
      suspensionLength: REST_LENGTH,
      visualLength: REST_LENGTH,
      grounded: false,
      load: 0,
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      spin: 0,
      spinVel: 0,
      slip: 0,
      hit: { hit: false, distance: 0, normal: new THREE.Vector3(), point: new THREE.Vector3() },
      pivot: null,
      spinner: null,
    }));

    // Interpolation state
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.currPos = new THREE.Vector3();
    this.currQuat = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);

    this._buildProceduralModel();
    this._createBody();
    this._buildContactShadow();
    this._loadModel(this.preset.id);
  }

  _buildContactShadow() {
    const mat = new THREE.MeshBasicMaterial({
      map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.85,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    });
    this.contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 5.2).rotateX(-Math.PI / 2), mat);
    this.contactShadow.renderOrder = 2;
    this.scene.add(this.contactShadow);
  }

  /** Remove from scene and physics world (AI cars between events). */
  dispose() {
    this._disposed = true;
    this.physics.removeBody(this.body);
    this.scene.remove(this.root);
    this.scene.remove(this.contactShadow);
    if (this.headSpot) this.scene.remove(this.headSpot, this.headSpot.target);
    // geometries of glTF models are shared through the cache — only free procedural ones
    this.bodyGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }

  // -------------------------------------------------------------- Physics body
  _createBody() {
    const comLocal = { x: 0, y: -0.28, z: 0.05 };
    this.comLocal = new THREE.Vector3(comLocal.x, comLocal.y, comLocal.z);
    this.body = this.physics.createVehicleBody({
      position: new THREE.Vector3(0, 1.2, 0),
      quaternion: new THREE.Quaternion(),
      halfExtents: HALF_EXTENTS,
      mass: this.preset.mass,
      centerOfMass: comLocal,
    });
  }

  applyPreset(preset, paint) {
    const color = this.paintMaterial.color.getHexString();
    this.preset = { ...preset };
    this.name = preset.name;
    // Mass changes need a new body; keep the current transform.
    const t = this.body.translation();
    const r = this.body.rotation();
    const pos = new THREE.Vector3(t.x, t.y + 0.3, t.z);
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this.physics.removeBody(this.body);
    this._createBody();
    this.body.setTranslation(pos, true);
    this.body.setRotation(quat, true);
    this._syncPoseImmediate();
    this.setPaint(paint ?? preset.color ?? '#' + color);
    if (preset.id !== this._modelId) this._loadModel(preset.id);
  }

  setPaint(hex) {
    this.paintMaterial.color.set(hex);
  }

  reset(position, yaw) {
    _quat.setFromAxisAngle(_Y, yaw);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) { w.compression = w.prevCompression = 0; w.spinVel = 0; }
    this.direction = 1;
    this.gear = 1;
    this._hasExpected = false;
    this._syncPoseImmediate();
  }

  _syncPoseImmediate() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.root.position.copy(this.currPos);
    this.root.quaternion.copy(this.currQuat);
  }

  // ------------------------------------------------------------- Fixed update
  /**
   * Runs at the fixed physics rate BEFORE the physics step.
   * @param {number} dt fixed timestep
   * @param {InputController} input
   */
  fixedUpdate(dt, input) {
    const body = this.body;
    const P = this.preset;
    const mass = P.mass;

    // ---- Read state
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    _lv.set(lv.x, lv.y, lv.z);
    _av.set(av.x, av.y, av.z);
    _com.copy(this.physics.backend === 'rapier' ? this.comLocal : _tmp.set(0, 0, 0)).applyQuaternion(_quat).add(_pos);

    // Interpolation bookkeeping (state after the previous step)
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.currPos.copy(_pos);
    this.currQuat.copy(_quat);

    // ---- Collision detection via unexpected velocity change (backend agnostic)
    if (this._hasExpected) {
      // Horizontal-only: landing a jump is not a crash (reported separately)
      _tmp.subVectors(_lv, this._expectedVel);
      const dv = Math.hypot(_tmp.x, _tmp.z);
      if (dv > 3.2) {
        this.lastImpact = dv;
        this.impactEvent = dv;
      } else if (_tmp.y > 5) {
        this.landEvent = _tmp.y;
      }
    }

    _up.set(0, 1, 0).applyQuaternion(_quat);
    _fwd.set(0, 0, 1).applyQuaternion(_quat);
    _left.set(1, 0, 0).applyQuaternion(_quat);

    const vFwd = _lv.dot(_fwd);
    this.speed = vFwd;
    this.speedAbs = Math.hypot(_lv.x, _lv.z); // planar speed (ignores bounce)
    this.velocity.copy(_lv);
    this.forward.copy(_fwd);
    const speedRatio = Math.abs(vFwd) / P.topSpeed;

    // Accelerations for camera / HUD
    this.longAccel = THREE.MathUtils.lerp(this.longAccel, (vFwd - this._prevSpeed) / dt, 0.15);
    this.latAccel = THREE.MathUtils.lerp(this.latAccel, _av.dot(_up) * vFwd, 0.15);
    this._prevSpeed = vFwd;

    // ---- Inputs, direction & gearbox
    this.throttleInput = input.throttle;
    this.brakeInput = input.brake;
    this.handbrake = input.handbrake;
    let driveInput = 0;
    let brakeInput = 0;
    if (this.direction === 1) {
      driveInput = input.throttle;
      brakeInput = input.brake;
      if (input.brake > 0.5 && input.throttle < 0.1 && vFwd < 0.8) {
        this._reverseTimer += dt;
        if (this._reverseTimer > 0.2) { this.direction = -1; this._reverseTimer = 0; }
      } else this._reverseTimer = 0;
    } else {
      driveInput = -input.brake;
      brakeInput = input.throttle;
      if (input.throttle > 0.5 && input.brake < 0.1 && vFwd > -0.8) {
        this._reverseTimer += dt;
        if (this._reverseTimer > 0.1) { this.direction = 1; this._reverseTimer = 0; }
      } else this._reverseTimer = 0;
    }
    this._updateGearbox(dt, vFwd, driveInput);

    // ---- Steering (inverse speed scaling)
    const speedFactor = 1 / (1 + Math.abs(vFwd) * 0.05);
    // Counter-steer assist: let the fronts point along velocity while drifting
    let target = input.steer * P.maxSteer * speedFactor;
    if (this.isDrifting && Math.abs(vFwd) > 5) target += clamp(this.driftAngle * 0.35, -0.25, 0.25) * (1 - Math.abs(input.steer) * 0.5);
    const steerRate = 3.2;
    this.steerAngle += clamp(target - this.steerAngle, -steerRate * dt, steerRate * dt);
    this.steerInput = input.steer;
    const cosS = Math.cos(this.steerAngle), sinS = Math.sin(this.steerAngle);

    // ---- Suspension rays
    _rayDir.copy(_up).negate();
    const maxLen = REST_LENGTH + WHEEL_RADIUS;
    let grounded = 0;
    for (const w of this.wheels) {
      _mount.copy(w.mount).applyQuaternion(_quat).add(_pos);
      this.physics.castRay(_mount, _rayDir, maxLen + 0.3, body, w.hit);
      w.prevCompression = w.compression;
      if (w.hit.hit && w.hit.distance <= maxLen) {
        w.grounded = true;
        w.compression = maxLen - w.hit.distance;
        w.suspensionLength = w.hit.distance - WHEEL_RADIUS;
        w.contact.copy(w.hit.point);
        w.normal.copy(w.hit.normal);
        grounded++;
      } else {
        w.grounded = false;
        w.compression = 0;
        w.suspensionLength = REST_LENGTH;
      }
    }
    this.grounded = grounded;
    this.airTime = grounded === 0 ? this.airTime + dt : 0;

    // Spring + damper + anti-roll
    const k = P.springK;
    const cBump = 2600, cRebound = 3600;
    const antiRoll = k * 0.55;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) { w.load = 0; continue; }
      const compVel = (w.compression - w.prevCompression) / dt;
      let force = k * w.compression + (compVel > 0 ? cBump : cRebound) * compVel;
      // bump stop
      if (w.compression > REST_LENGTH * 0.92) force += (w.compression - REST_LENGTH * 0.92) * k * 8;
      const other = this.wheels[i ^ 1]; // axle partner (0<->1, 2<->3)
      force += (w.compression - other.compression) * antiRoll;
      force = Math.max(0, force);
      w.load = force;
      _mount.copy(w.mount).applyQuaternion(_quat).add(_pos);
      _imp.copy(_up).multiplyScalar(force * dt);
      body.applyImpulseAtPoint(toObj(_imp, _impObj), toObj(_mount, _ptObj), true);
    }

    // ---- Engine force with torque curve & top-speed falloff
    const driven = P.drive === 'AWD' ? [0, 1, 2, 3] : [2, 3];
    const topFall = Math.max(0, 1 - Math.pow(clamp(speedRatio, 0, 1.2), 2.6));
    const rpmNorm = (this.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
    const band = 0.78 + 0.32 * Math.sin(Math.PI * clamp(rpmNorm * 0.9 + 0.1, 0, 1));
    const launch = 1 + 0.35 * Math.max(0, 1 - Math.abs(vFwd) / 12);
    const shiftCut = this._shiftTimer > 0 ? 0.25 : 1;
    let engine = P.engineForce * topFall * band * launch * shiftCut * driveInput;
    if (this.direction === -1) engine = Math.max(engine, -P.engineForce * 0.5 * (vFwd < -16 ? 0 : 1));

    // ---- Tyres
    let rearSlip = 0;
    let scrub = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // wheel frame
      if (w.front) {
        _wf.copy(_fwd).multiplyScalar(cosS).addScaledVector(_left, sinS);
        _wl.copy(_left).multiplyScalar(cosS).addScaledVector(_fwd, -sinS);
      } else {
        _wf.copy(_fwd);
        _wl.copy(_left);
      }
      if (!w.grounded) {
        // free-spinning wheel visual
        const isDriven = driven.includes(i);
        w.spinVel = THREE.MathUtils.lerp(w.spinVel, isDriven ? driveInput * 60 : w.spinVel * 0.98, 0.05);
        continue;
      }
      // project wheel frame onto contact plane
      _wf.addScaledVector(w.normal, -_wf.dot(w.normal)).normalize();
      _wl.addScaledVector(w.normal, -_wl.dot(w.normal)).normalize();

      _r.subVectors(w.contact, _com);
      _vc.crossVectors(_av, _r).add(_lv);
      const vLong = _vc.dot(_wf);
      const vLat = _vc.dot(_wl);
      const load = Math.max(w.load, 0);
      const massShare = mass * 0.25;

      // Grip coefficients
      let mu = w.front ? P.gripFront : P.gripRear;
      let latStiff = w.front ? 0.9 : 0.85;
      const slipAngle = Math.atan2(Math.abs(vLat), Math.abs(vLong) + 0.5);
      w.slip = slipAngle;
      scrub = Math.max(scrub, Math.abs(vLat) - 1.2);
      if (!w.front) {
        rearSlip = Math.max(rearSlip, slipAngle);
        if (this.handbrake) { mu *= 0.42; latStiff = 0.12; }
        // sliding friction lower than static → sustainable drifts
        else if (slipAngle > 0.2 && Math.abs(vFwd) > 6) { mu *= 0.86; latStiff *= 0.7; }
      }
      const maxImpulse = mu * load * dt;

      // Lateral: cancel a fraction of lateral velocity for this wheel's mass share
      let jLat = -vLat * massShare * latStiff;

      // Longitudinal
      let jLong = 0;
      if (driven.includes(i)) jLong += (engine / driven.length) * dt;
      // Service brakes (front bias) + handbrake (rear)
      let brakeF = brakeInput * P.brakeForce * (w.front ? 0.3 : 0.2);
      if (this.handbrake && !w.front) brakeF += P.brakeForce * 0.35;
      if (brakeF > 0) {
        const jb = Math.min(brakeF * dt, Math.abs(vLong) * massShare);
        jLong -= Math.sign(vLong) * jb;
      }
      // Rolling resistance + engine braking when coasting
      const coast = driveInput === 0 && brakeInput === 0 ? 0.045 : 0.012;
      jLong -= Math.sign(vLong) * Math.min(Math.abs(vLong) * massShare, load * coast * dt);

      // Friction circle (longitudinal gets priority under braking)
      const total = Math.hypot(jLong, jLat);
      if (total > maxImpulse && total > 1e-6) {
        const s = maxImpulse / total;
        jLong *= s;
        jLat *= s;
      }

      _imp.copy(_wf).multiplyScalar(jLong).addScaledVector(_wl, jLat);
      // Apply between contact and COM height to tame roll/pitch
      _pt.copy(w.contact).addScaledVector(_up, (w.hit.distance) * 0.62);
      body.applyImpulseAtPoint(toObj(_imp, _impObj), toObj(_pt, _ptObj), true);

      // Wheel spin for visuals (with wheelspin/lock)
      let targetSpin = vLong / WHEEL_RADIUS;
      if (this.handbrake && !w.front) targetSpin = 0;
      else if (driven.includes(i) && Math.abs(engine) > P.engineForce * 0.6 && Math.abs(vFwd) < 8)
        targetSpin += Math.sign(engine) * 12;
      w.spinVel = THREE.MathUtils.lerp(w.spinVel, targetSpin, 0.35);
    }

    // ---- Aerodynamics: drag + downforce
    const v2 = _lv.lengthSq();
    const dragCoef = 0.36;
    _imp.copy(_lv).multiplyScalar(-dragCoef * Math.sqrt(v2) * dt);
    body.applyImpulse(toObj(_imp, _impObj), true);
    if (grounded > 0) {
      _imp.copy(_up).multiplyScalar(-1.4 * v2 * dt);
      body.applyImpulse(toObj(_imp, _impObj), true);
    }

    // ---- Stability helpers (arcade)
    const yawRate = _av.dot(_up);
    if (grounded >= 3 && !this.handbrake) {
      // mild yaw damping so the car doesn't spin out from small slides
      const yawDamp = this.isDrifting ? 0.35 : 0.9;
      _imp.copy(_up).multiplyScalar(-yawRate * yawDamp * mass * 0.6 * dt);
      body.applyTorqueImpulse(toObj(_imp, _impObj), true);
    }
    if (grounded >= 3 && this.isDrifting) {
      // Drift assist: hold the slide inside a controllable angle window
      // (steering into the drift widens it) and keep momentum on throttle.
      const a = this.driftAngle;
      const window = 0.5 + Math.max(0, -Math.sign(a) * input.steer) * 0.25;
      const excess = Math.abs(a) > window ? a - Math.sign(a) * window : 0;
      const yawCorrect = excess * mass * 18;
      _imp.copy(_up).multiplyScalar(yawCorrect * dt);
      body.applyTorqueImpulse(toObj(_imp, _impObj), true);
      if (!this.handbrake && driveInput > 0) {
        _tmp.copy(_lv).setY(0).normalize().multiplyScalar(mass * 4.5 * driveInput * dt);
        body.applyImpulse(toObj(_tmp, _impObj), true);
      }
    }
    if (grounded === 0) {
      // air control: gently level the car
      _tmp.crossVectors(_up, _Y).multiplyScalar(mass * 1.8 * dt);
      _tmp2.copy(_av).multiplyScalar(-mass * 0.4 * dt);
      _tmp2.y = 0;
      _tmp.add(_tmp2);
      body.applyTorqueImpulse(toObj(_tmp, _impObj), true);
    }

    // Auto-recover when stuck upside down
    if (_up.y < 0.2 && this.speedAbs < 3) {
      this._upsideTimer += dt;
      if (this._upsideTimer > 2) {
        const yaw = Math.atan2(_fwd.x, _fwd.z);
        this.reset(_tmp.set(_pos.x, 1.5, _pos.z), yaw);
        this._upsideTimer = 0;
        return;
      }
    } else this._upsideTimer = 0;

    // ---- Drift telemetry
    const planarSpeed = Math.hypot(_lv.x, _lv.z);
    if (planarSpeed > 3) {
      const velYaw = Math.atan2(_lv.x, _lv.z);
      const headYaw = Math.atan2(_fwd.x, _fwd.z);
      let a = velYaw - headYaw;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (vFwd < 0) a = 0;
      this.driftAngle = a;
    } else this.driftAngle = 0;
    this.isDrifting = grounded >= 2 && planarSpeed > 8 && Math.abs(this.driftAngle) > 0.26 && vFwd > 0;
    this.rearSlip = rearSlip;
    // Tyre scrub for audio: lateral sliding, handbrake lock or launch wheelspin
    let skid = clamp(scrub / 6, 0, 1);
    if (this.handbrake && Math.abs(vFwd) > 3) skid = Math.max(skid, 0.7);
    if (driveInput > 0.8 && Math.abs(vFwd) < 7 && grounded >= 3 && P.drive !== 'AWD') skid = Math.max(skid, 0.5 * driveInput);
    if (brakeInput > 0.8 && Math.abs(vFwd) > 12) skid = Math.max(skid, 0.35);
    this.skid = grounded ? skid : 0;

    // Expected velocity after this step (for collision detection next step)
    const nlv = body.linvel();
    this._expectedVel.set(nlv.x, nlv.y - GRAVITY * dt, nlv.z);
    this._hasExpected = true;
  }

  _updateGearbox(dt, vFwd, driveInput) {
    const P = this.preset;
    const prevGear = this.gear;
    const prevLabel = this.gearLabel;
    this._shiftTimer = Math.max(0, this._shiftTimer - dt);
    const spd = Math.abs(vFwd);

    if (this.direction === -1) {
      this.gear = 0;
      this.gearLabel = 'R';
    } else {
      if (this.gear < 1) this.gear = 1;
      const top = GEAR_SPLITS[this.gear - 1] * P.topSpeed;
      const lower = this.gear > 1 ? GEAR_SPLITS[this.gear - 2] * P.topSpeed : 0;
      if (spd > top * 0.97 && this.gear < GEAR_SPLITS.length) this.gear++;
      else if (spd < lower * 0.82 && this.gear > 1) this.gear--;
      this.gearLabel = spd < 0.5 && driveInput === 0 && this.brakeInput === 0 ? 'N' : String(this.gear);
    }

    if (this.gear > prevGear && prevGear >= 1) this._shiftTimer = 0.14;
    if (this.gearLabel !== prevLabel) this.shiftEvent = true;

    // RPM
    let target;
    if (this.gearLabel === 'N') {
      target = IDLE_RPM + Math.abs(driveInput || this.throttleInput) * (REDLINE_RPM - IDLE_RPM) * 0.85;
    } else if (this.direction === -1) {
      target = IDLE_RPM + (spd / 16) * (REDLINE_RPM - IDLE_RPM) * 0.8;
    } else {
      const top = GEAR_SPLITS[this.gear - 1] * P.topSpeed;
      target = IDLE_RPM + clamp(spd / top, 0, 1.02) * (REDLINE_RPM - IDLE_RPM);
      // wheelspin / airborne / drifting flare
      if ((this.grounded === 0 || this.isDrifting || this.handbrake) && driveInput > 0.1)
        target = Math.max(target, IDLE_RPM + driveInput * (REDLINE_RPM - IDLE_RPM) * 0.92);
    }
    if (this._shiftTimer > 0) target *= 0.92;
    this.rpm = THREE.MathUtils.lerp(this.rpm, clamp(target, IDLE_RPM * 0.9, REDLINE_RPM + 150), 0.22);
  }

  // ------------------------------------------------------------ Visual update
  /** Called once per rendered frame with the accumulator alpha. */
  update(dt, alpha) {
    // Latest body pose (after the last physics step)
    const t = this.body.translation();
    const r = this.body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    // prev = before last step; interpolate toward latest
    this.root.position.lerpVectors(this.currPos, _pos, alpha);
    this.root.quaternion.slerpQuaternions(this.currQuat, _quat, alpha);

    // Wheels
    for (const w of this.wheels) {
      const target = w.grounded ? clamp(w.suspensionLength, 0, REST_LENGTH) : REST_LENGTH;
      w.visualLength = THREE.MathUtils.lerp(w.visualLength, target, 1 - Math.exp(-dt * 30));
      w.pivot.position.set(w.mount.x, w.mount.y - w.visualLength, w.mount.z);
      w.pivot.rotation.y = w.front ? this.steerAngle : 0;
      w.spin += w.spinVel * dt;
      w.spinner.rotation.x = w.spin;
    }

    // Lights react to inputs
    const braking = (this.direction === 1 ? this.brakeInput : this.throttleInput) > 0.05 || this.handbrake;
    const k = 1 - Math.exp(-dt * 18);
    this._brakeLevel = THREE.MathUtils.lerp(this._brakeLevel ?? 0, braking ? 1 : 0, k);
    const b = this._brakeLevel;
    this.tailLensMaterial.emissiveIntensity = 1.6 + b * 9;
    this.tailGlowMaterial.uniforms.uIntensity.value = 0.25 + b * 1.25;
    const rev = this.direction === -1 ? 1 : 0;
    this.reverseMaterial.emissiveIntensity = THREE.MathUtils.lerp(this.reverseMaterial.emissiveIntensity, rev * 6, k);

    // Contact shadow follows the ground under the car
    let gy = 0, gn = 0;
    for (const w of this.wheels) if (w.grounded) { gy += w.contact.y; gn++; }
    const cs = this.contactShadow;
    if (gn > 0) {
      cs.visible = true;
      cs.position.set(this.root.position.x, gy / gn + 0.03, this.root.position.z);
      cs.rotation.y = Math.atan2(this.forward.x, this.forward.z);
      cs.material.opacity = 0.85;
    } else {
      cs.material.opacity *= 0.9;
    }

    if (this.headSpot) {
      this.headSpot.position.copy(this.root.position).addScaledVector(this.forward, 2.2).y += 0.1;
      this.headSpot.target.position.copy(this.root.position).addScaledVector(this.forward, 30);
      this.headSpot.target.position.y -= 3;
      this.headSpot.target.updateMatrixWorld();
    }
  }

  /** 0..1 night factor: headlight glow + (player) spotlight. */
  setHeadlights(level) {
    this.headMaterial.emissiveIntensity = 2 + level * 10;
    if (this.isPlayer) {
      if (!this.headSpot && level > 0.05) {
        const s = new THREE.SpotLight(0xfff1dc, 0, 110, 0.55, 0.55, 1.2);
        this.scene.add(s, s.target);
        this.headSpot = s;
      }
      if (this.headSpot) {
        this.headSpot.intensity = level * 320;
        this.headSpot.visible = level > 0.05;
      }
    }
  }

  // ------------------------------------------------------ Procedural model
  _buildProceduralModel() {
    const body = new THREE.Group();
    body.name = 'ProceduralBody';
    this.bodyGroup = body;
    this.root.add(body);

    this.paintMaterial = new THREE.MeshPhysicalMaterial({
      color: this.preset.color,
      metalness: 0.45,
      roughness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.025,
      envMapIntensity: 1.25,
    });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0d12, metalness: 0.2, roughness: 0.05, clearcoat: 1 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.6, metalness: 0.2 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.15, metalness: 1 });

    // Side profile (z = forward, y = up); extruded across width.
    const W = 1.84;
    const y0 = -0.42; // sill line (car ground clearance ~0.2 m)
    const prof = new THREE.Shape();
    prof.moveTo(-2.22, y0 + 0.12);
    prof.lineTo(-2.26, y0 + 0.42);
    prof.lineTo(-2.2, y0 + 0.62); // rear deck
    prof.quadraticCurveTo(-1.6, y0 + 0.72, -1.1, y0 + 0.74);
    prof.lineTo(1.2, y0 + 0.66);
    prof.quadraticCurveTo(1.95, y0 + 0.58, 2.2, y0 + 0.42); // hood → nose
    prof.lineTo(2.3, y0 + 0.18);
    prof.lineTo(2.22, y0 + 0.02);
    prof.lineTo(-2.1, y0 + 0.0);
    prof.closePath();
    const lower = new THREE.ExtrudeGeometry(prof, {
      depth: W, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 12,
    });
    // extrude runs along +Z of the shape space: map shape (x→z_car, y→y) & depth → x
    // Map shape x → car +Z and extrusion depth → car X (rotation keeps winding).
    lower.translate(0, 0, -W / 2);
    lower.rotateY(-Math.PI / 2);
    lower.computeVertexNormals();
    const lowerMesh = new THREE.Mesh(lower, this.paintMaterial);
    lowerMesh.castShadow = true;
    lowerMesh.receiveShadow = true;
    body.add(lowerMesh);

    // Greenhouse (cabin)
    const cab = new THREE.Shape();
    cab.moveTo(-1.35, 0);
    cab.quadraticCurveTo(-0.9, 0.42, -0.35, 0.5);
    cab.lineTo(0.25, 0.5);
    cab.quadraticCurveTo(0.7, 0.44, 1.05, 0);
    cab.closePath();
    const CW = 1.46;
    const cabinGeo = new THREE.ExtrudeGeometry(cab, {
      depth: CW, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 10,
    });
    cabinGeo.translate(0, 0, -CW / 2);
    cabinGeo.rotateY(-Math.PI / 2);
    cabinGeo.computeVertexNormals();
    const cabin = new THREE.Mesh(cabinGeo, glass);
    cabin.position.y = y0 + 0.7;
    cabin.castShadow = true;
    body.add(cabin);
    // Roof panel (paint) over the glass
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 1.05), this.paintMaterial);
    roof.position.set(0, y0 + 0.7 + 0.56, -0.08);
    roof.castShadow = true;
    body.add(roof);

    // Rear wing
    const wing = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.36), trim);
    blade.position.y = 0.3;
    blade.rotation.x = -0.08;
    const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.18), trim);
    s1.position.set(0.55, 0.15, 0);
    const s2 = s1.clone();
    s2.position.x = -0.55;
    wing.add(blade, s1, s2);
    wing.position.set(0, y0 + 0.66, -1.95);
    wing.traverse((o) => (o.castShadow = true));
    body.add(wing);

    // Front splitter, side skirts, diffuser
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.3), trim);
    splitter.position.set(0, y0 + 0.02, 2.2);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.2), trim);
    diffuser.position.set(0, y0 + 0.1, -2.25);
    for (const sx of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 2.2), trim);
      skirt.position.set(sx * 0.96, y0 + 0.08, 0);
      body.add(skirt);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.14), this.paintMaterial);
      mirror.position.set(sx * 1.0, y0 + 0.86, 0.72);
      body.add(mirror);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 12), chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(sx * 0.32, y0 + 0.14, -2.33);
      body.add(pipe);
      const pipe2 = pipe.clone();
      pipe2.position.x = sx * 0.2;
      body.add(pipe2);
    }
    body.add(splitter, diffuser);

    // License plate
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 })
    );
    plate.position.set(0, y0 + 0.3, -2.3);
    plate.rotation.y = Math.PI;
    body.add(plate);

    // --- Lights
    // Headlights (emissive white)
    this.headMaterial = createLightLensMaterial('#fff6e8', 3.2);
    this.headMaterial.color.set(0xffffff);
    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.05), this.headMaterial);
      hl.position.set(sx * 0.62, y0 + 0.44, 2.21);
      hl.rotation.x = -0.35;
      body.add(hl);
    }
    // Taillights: full-width light bar + lens + additive glow billboard
    this.tailLensMaterial = createLightLensMaterial('#ff1030', 1.6);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.04), this.tailLensMaterial);
    bar.position.set(0, y0 + 0.56, -2.27);
    body.add(bar);
    for (const sx of [-1, 1]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.05), this.tailLensMaterial);
      tl.position.set(sx * 0.68, y0 + 0.5, -2.27);
      body.add(tl);
    }
    this.tailGlowMaterial = createTaillightGlowMaterial('#ff1030');
    this.tailGlows = [];
    for (const sx of [-1, 1]) {
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.5), this.tailGlowMaterial);
      glow.position.set(sx * 0.68, y0 + 0.5, -2.33);
      glow.rotation.y = Math.PI;
      glow.renderOrder = 5;
      body.add(glow);
      this.tailGlows.push(glow);
    }
    // Reverse lights
    this.reverseMaterial = createLightLensMaterial('#ffffff', 0);
    for (const sx of [-1, 1]) {
      const rl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.04), this.reverseMaterial);
      rl.position.set(sx * 0.4, y0 + 0.3, -2.3);
      body.add(rl);
    }

    // --- Wheels (always procedural so suspension/steer/spin animate)
    const tireGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 24, 1);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(WHEEL_RADIUS * 0.68, WHEEL_RADIUS * 0.68, WHEEL_WIDTH + 0.01, 20, 1);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.04, WHEEL_RADIUS * 1.3, 0.07);
    const hubGeo = new THREE.CylinderGeometry(0.06, 0.06, WHEEL_WIDTH + 0.03, 10);
    hubGeo.rotateZ(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(0.08, 0.18, 0.22);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.92 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.3, metalness: 0.9 });
    const caliperMat = new THREE.MeshStandardMaterial({ color: 0xffc400, roughness: 0.4 });

    for (const w of this.wheels) {
      const pivot = new THREE.Group();
      const spinner = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      spinner.add(tire, rim);
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(spokeGeo, chrome);
        spoke.position.x = (w.left ? 1 : -1) * (WHEEL_WIDTH / 2 + 0.005);
        spoke.rotation.x = (s / 5) * Math.PI;
        spinner.add(spoke);
      }
      spinner.add(new THREE.Mesh(hubGeo, chrome));
      const caliper = new THREE.Mesh(caliperGeo, caliperMat);
      caliper.position.set((w.left ? 1 : -1) * (WHEEL_WIDTH / 2 - 0.06), 0.1, -0.12);
      pivot.add(spinner, caliper);
      w.procParts = [...spinner.children];
      w.procCaliper = caliper;
      pivot.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      pivot.position.set(w.mount.x, w.mount.y - REST_LENGTH, w.mount.z);
      w.pivot = pivot;
      w.spinner = spinner;
      this.root.add(pivot);
    }
  }

  // ------------------------------------------------------------ glTF models
  _loadModel(id) {
    this._modelId = id;
    loadCarModel(id)
      .then((scene) => {
        if (this._disposed || this._modelId !== id) return;
        this._adoptModel(scene.clone(true));
      })
      .catch((err) => {
        if (!this._warned) console.info(`[Vehicle] Car model "${id}" unavailable (${err.message}) — using procedural body.`);
        this._warned = true;
      });
  }

  _adoptModel(model) {
    try {
      const shared = sharedMaterials();
      const own = { Paint: this.paintMaterial, Headlight: this.headMaterial, Taillight: this.tailLensMaterial, Reverse: this.reverseMaterial };
      const wheelSrc = model.getObjectByName('Wheel');
      const caliperSrc = model.getObjectByName('Caliper');
      if (wheelSrc) wheelSrc.removeFromParent();
      if (caliperSrc) caliperSrc.removeFromParent();
      const bind = (root) => root.traverse((o) => {
        if (!o.isMesh) return;
        const name = (o.material?.name || '').split('.')[0];
        o.material = own[name] || shared[name] || o.material;
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData.shared = true;
      });
      bind(model);
      if (this.gltfModel) this.root.remove(this.gltfModel);
      model.position.set(0, -0.62, 0);
      this.root.add(model);
      this.gltfModel = model;
      this.bodyGroup.visible = false;

      // Replace wheel visuals (keep pivots/spinners so suspension + spin still animate)
      if (wheelSrc) {
        bind(wheelSrc);
        if (caliperSrc) bind(caliperSrc);
        for (const w of this.wheels) {
          for (const p of w.procParts) p.removeFromParent();
          if (w.procCaliper) w.procCaliper.removeFromParent();
          if (w.modelWheel) w.modelWheel.removeFromParent();
          if (w.modelCaliper) w.modelCaliper.removeFromParent();
          const wh = wheelSrc.clone(true);
          wh.position.set(0, 0, 0);
          wh.rotation.set(0, w.left ? 0 : Math.PI, 0);
          w.spinner.add(wh);
          w.modelWheel = wh;
          if (caliperSrc) {
            const c = caliperSrc.clone(true);
            const holder = new THREE.Group();
            holder.rotation.y = w.left ? 0 : Math.PI;
            holder.add(c);
            w.pivot.add(holder);
            w.modelCaliper = holder;
          }
        }
      }

      // Move the taillight glow billboards onto the model's lamp clusters
      this.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      model.traverse((o) => {
        if (o.isMesh && o.material === this.tailLensMaterial) {
          tmp.setFromObject(o).applyMatrix4(inv);
          box.union(tmp);
        }
      });
      if (!box.isEmpty() && this.tailGlows) {
        const cy = (box.min.y + box.max.y) / 2;
        this.tailGlows.forEach((g, i) => {
          g.removeFromParent();
          const sx = i === 0 ? -1 : 1;
          g.position.set(sx * Math.max(0.35, box.max.x - 0.18), cy, box.min.z - 0.05);
          this.root.add(g);
        });
      }
    } catch (err) {
      console.warn('[Vehicle] Failed to adopt car model, keeping procedural body.', err);
      this.bodyGroup.visible = true;
    }
  }
}
