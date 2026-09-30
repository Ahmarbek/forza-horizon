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
    engineForce: 10500, // ≈ powerKW × 35 (kept for the performance index)
    powerKW: 300,
    redline: 8200,
    topSpeed: 76, // m/s (~170 mph)
    brakeForce: 16000,
    maxSteer: 0.58,
    gripFront: 1.25,
    gripRear: 1.2,
    springK: 31000,
    weightFront: 0.52,
    downforce: 1.1, // lift coefficient × area (m²)
    offroad: 0.15,
    lsd: 45,
    balance: 1.08, // rear/front lateral grip capacity (>1 = stable understeer)
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
    powerKW: 414,
    redline: 8500,
    topSpeed: 88,
    brakeForce: 19000,
    maxSteer: 0.52,
    gripFront: 1.35,
    gripRear: 1.35,
    springK: 36000,
    weightFront: 0.42,
    downforce: 1.9,
    frontShare: 0.38,
    offroad: 0.2,
    lsd: 55,
    balance: 1.08, // rear/front lateral grip capacity (>1 = stable understeer)
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
    powerKW: 257,
    redline: 8000,
    topSpeed: 66,
    brakeForce: 14000,
    maxSteer: 0.7,
    gripFront: 1.3,
    gripRear: 0.95,
    springK: 27000,
    weightFront: 0.51,
    downforce: 0.7,
    offroad: 0.2,
    lsd: 110,
    balance: 1.0, // rear/front lateral grip capacity (>1 = stable understeer)
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
    powerKW: 320,
    redline: 7600,
    topSpeed: 70,
    brakeForce: 16500,
    maxSteer: 0.64,
    gripFront: 1.3,
    gripRear: 1.25,
    springK: 26000,
    weightFront: 0.55,
    downforce: 0.6,
    frontShare: 0.45,
    offroad: 0.9,
    lsd: 70,
    tyrePeak: 0.17, // progressive gravel tyres
    balance: 1.0, // rear/front lateral grip capacity (>1 = stable understeer)
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
    powerKW: 500,
    redline: 9000,
    topSpeed: 98,
    brakeForce: 21000,
    maxSteer: 0.5,
    gripFront: 1.45,
    gripRear: 1.42,
    springK: 40000,
    weightFront: 0.43,
    downforce: 2.6,
    frontShare: 0.35,
    offroad: 0.05,
    lsd: 60,
    balance: 1.1, // rear/front lateral grip capacity (>1 = stable understeer)
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
    stockTopSpeed: base.stockTopSpeed ?? base.topSpeed,
    stockPowerKW: base.stockPowerKW ?? base.powerKW,
    powerKW: base.powerKW * (1 + 0.09 * e),
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
const FRONT_Z = 1.36, REAR_Z = -1.32, WHEELBASE = FRONT_Z - REAR_Z;
const MOUNT_Y = 0.0;
const GRAVITY = 9.81;

// Drivetrain / tyre model
const GEAR_TOPS = [0.27, 0.41, 0.55, 0.69, 0.84, 1.03]; // redline speed per gear ÷ top speed
const IDLE_RPM = 900;
const RAD2RPM = 30 / Math.PI;
const WHEEL_INERTIA = 1.3; // kg·m² (wheel + tyre + brake disc)
const ENGINE_INERTIA = 0.16; // kg·m² reflected through the gearbox
const DRIVE_EFF = 0.9;
const AIR = 0.6125; // ½ρ
const ROLL_RES = 0.012;
const SUBSTEPS = 4; // tyre / wheel-spin integration per physics step
const V_LONG_MIN = 3; // slip-ratio denominator floor (m/s)
const V_LAT_MIN = 3.5; // slip-angle denominator floor (m/s)
const SLIP_RATIO_PEAK = 0.1;
// Normalised "magic formula" y = sin(C·atan(B·s)): peak 1.0 at s = 1, ~0.85 when fully sliding
const CURVE_B = 2.3, CURVE_C = 1.35, CURVE_SLOPE0 = CURVE_B * CURVE_C;
const tyreCurve = (s) => Math.sin(CURVE_C * Math.atan(CURVE_B * s));
// Normalised torque curve: 0.69 at 12 % rpm, peak 1.0 at 62 %, 0.82 at the redline
const torqueShape = (r) => Math.max(0.3, 0.5208 + 1.5457 * r - 1.2465 * r * r);

/**
 * Driving surfaces. `mu` scales tyre grip, `rr` is the rolling-resistance
 * coefficient, `loose` how much a rally tyre helps and how progressive the
 * slide is, `rough` feeds camera/body vibration, `dust` tints kicked-up dust.
 */
export const SURFACES = [
  null,
  { id: 1, name: 'asphalt', mu: 1.0, rr: 1, loose: 0, rough: 0, dust: null },
  { id: 2, name: 'concrete', mu: 0.97, rr: 1, loose: 0, rough: 0.05, dust: null },
  { id: 3, name: 'gravel', mu: 0.72, rr: 2.6, loose: 0.85, rough: 0.35, dust: [0.62, 0.57, 0.49] },
  { id: 4, name: 'dirt', mu: 0.76, rr: 2.3, loose: 0.75, rough: 0.3, dust: [0.55, 0.45, 0.34] },
  { id: 5, name: 'grass', mu: 0.64, rr: 4.5, loose: 0.55, rough: 0.45, dust: [0.42, 0.45, 0.3] },
  { id: 6, name: 'sand', mu: 0.56, rr: 7, loose: 1, rough: 0.2, dust: [0.85, 0.78, 0.62] },
  { id: 7, name: 'snow', mu: 0.46, rr: 2.4, loose: 0.9, rough: 0.2, dust: [0.95, 0.96, 0.98] },
  { id: 8, name: 'rock', mu: 0.8, rr: 1.6, loose: 0.3, rough: 0.6, dust: [0.5, 0.5, 0.5] },
];
export const SURFACE = Object.fromEntries(SURFACES.filter(Boolean).map((s) => [s.name, s]));

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
      navUp: false, navDown: false, navLeft: false, navRight: false, confirm: false, back: false,
      shiftUp: false, shiftDown: false, interact: false, map: false };
    this._prevButtons = [];

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyC') this.actions.camera = true;
      if (e.code === 'KeyR') this.actions.reset = true;
      if (e.code === 'KeyM') this.actions.radio = true;
      if (e.code === 'KeyE') this.actions.shiftUp = true;
      if (e.code === 'KeyQ') this.actions.shiftDown = true;
      if (e.code === 'Enter' || e.code === 'KeyF') this.actions.interact = true;
      if (e.code === 'Tab') { this.actions.map = true; e.preventDefault(); }
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

      const edge = (i, ...actions) => {
        const now = pressed(i);
        if (now && !this._prevButtons[i]) for (const a of actions) this.actions[a] = true;
        this._prevButtons[i] = now;
      };
      edge(9, 'menu');
      edge(8, 'camera');
      edge(3, 'reset');
      edge(4, 'tabLeft');
      edge(5, 'tabRight');
      edge(12, 'navUp', 'interact');
      edge(13, 'navDown');
      edge(14, 'navLeft');
      edge(15, 'navRight');
      edge(0, 'confirm');
      edge(1, 'back', 'shiftUp');
      edge(2, 'shiftDown');
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
    this.manual = false; // manual gearbox (E / Q, gamepad B / X)
    this.assists = { abs: true, tcs: true, stm: true, steer: true };
    this.tcsCut = 1;
    this.tcsActive = false;
    this.absActive = false;
    this.surface = SURFACE.asphalt;
    this.rough = 0; // 0..1 surface roughness under the car (camera/audio)
    this._driveTorque = 0;
    this._maxDriveSlip = 0;
    this._shiftCooldown = 0;
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
      omega: 0, // wheel angular velocity (rad/s, + = rolling forward)
      slip: 0,
      slipRatio: 0,
      slide: 0, // sliding speed at the contact patch (m/s) → smoke / skid marks
      surface: SURFACE.asphalt,
      fwd: new THREE.Vector3(),
      lat: new THREE.Vector3(),
      vL: 0, vLat: 0, mu: 1, Fx: 0, Fy: 0,
      hit: { hit: false, distance: 0, normal: new THREE.Vector3(), point: new THREE.Vector3(), terrain: true },
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

    this._setupDrivetrain();
    this._buildProceduralModel();
    this._createBody();
    this._buildContactShadow();
    this._loadModel(this.preset.id);
  }

  /**
   * Derive engine, gearbox and aero constants from the preset:
   *  - peak torque from peak power (torque curve peaks in power near the redline)
   *  - 6 gear ratios so each gear tops out at GEAR_TOPS × top speed
   *  - drag area so the stock car's power-limited top speed is its rated top speed
   */
  _setupDrivetrain() {
    const P = this.preset;
    const powerW = (P.powerKW ?? P.engineForce / 35) * 1000;
    const redline = P.redline ?? 8000;
    const wRed = redline / RAD2RPM;
    let best = 0;
    for (let r = 0.3; r <= 1.0001; r += 0.01) best = Math.max(best, torqueShape(r) * r);
    const peakTorque = powerW / (best * wRed);
    const ratios = GEAR_TOPS.map((f) => wRed / ((f * P.topSpeed) / WHEEL_RADIUS));
    const stockTop = P.stockTopSpeed ?? P.topSpeed;
    const stockPower = (P.stockPowerKW ?? P.powerKW ?? P.engineForce / 35) * 1000;
    const rrPower = ROLL_RES * P.mass * GRAVITY * stockTop;
    const dragArea = Math.max(0.3, (stockPower * DRIVE_EFF - rrPower) / (AIR * stockTop ** 3));
    const driven = P.drive === 'AWD' ? [0, 1, 2, 3] : P.drive === 'FWD' ? [0, 1] : [2, 3];
    // rear tyre scale so the axle grip capacities match the requested balance
    const wf = P.weightFront ?? 0.52;
    const rearScale = clamp(((P.balance ?? 1.1) * P.gripFront * wf) / (P.gripRear * (1 - wf)), 1, 1.45);
    this.drive = {
      redline, peakTorque, ratios, reverse: ratios[0] * 1.1, dragArea, driven, rearScale,
      frontShare: P.drive === 'AWD' ? P.frontShare ?? 0.4 : P.drive === 'FWD' ? 1 : 0,
      lsd: P.lsd ?? 50,
      peakAngle: P.tyrePeak ?? 0.14,
      clutchRPM: redline * 0.45,
      brakeTorque: P.brakeForce * WHEEL_RADIUS * 1.3,
    };
  }

  torqueAt(rpm) {
    return this.drive.peakTorque * torqueShape(Math.min(rpm, this.drive.redline) / this.drive.redline);
  }

  /** Useful steering lock at a given speed (keeps the front tyres near peak slip). */
  steerLimit(speed) {
    const P = this.preset;
    const v = Math.max(Math.abs(speed), 1);
    if (!this.assists.steer) return P.maxSteer / (1 + v * 0.03);
    return Math.min(P.maxSteer, (WHEELBASE * P.gripFront * GRAVITY) / (v * v) + this.drive.peakAngle * (0.85 + 6 / (v + 20)));
  }

  /** Manual gear change (+1 / -1). */
  shift(dir) {
    if (this.direction === -1 || this._shiftTimer > 0) return;
    const g = this.gear + dir;
    if (g < 1 || g > this.drive.ratios.length) return;
    this.gear = g;
    this._shiftTimer = 0.12;
    this._shiftCooldown = 0.35;
    this.shiftEvent = true;
    // hard upshift near the redline → exhaust pop (audio/flames in main)
    if (dir > 0 && this.rpm > this.drive.redline * 0.82 && this.throttleInput > 0.7) this.backfireEvent = true;
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
    // Weight distribution sets the centre of mass along the wheelbase
    const wf = this.preset.weightFront ?? 0.52;
    const comLocal = { x: 0, y: -0.28, z: REAR_Z + wf * WHEELBASE };
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
    this._setupDrivetrain();
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
    for (const w of this.wheels) { w.compression = w.prevCompression = 0; w.spinVel = 0; w.omega = 0; w.slide = 0; }
    this.direction = 1;
    this.gear = 1;
    this.tcsCut = 1;
    this._shiftTimer = 0;
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
   *
   * Model: raycast suspension per corner → tyre load. Every wheel has its own
   * angular velocity, driven by engine torque through the gearbox and a
   * limited-slip differential and slowed by brakes, rolling resistance and the
   * tyre's own longitudinal force (integrated implicitly, 4 sub-steps).
   * Tyre forces come from a combined-slip "magic formula" curve: slip ratio and
   * slip angle are normalised by their peak values, the combined slip picks a
   * point on the curve (grip peaks, then falls away when sliding), and the
   * force is shared between longitudinal and lateral directions — so wheelspin
   * and locked wheels steal cornering grip exactly like real tyres. Surface
   * grip, load sensitivity, aerodynamic drag/downforce and optional driver
   * aids (ABS, traction control, stability control, drift assist) sit on top.
   *
   * @param {number} dt fixed timestep
   * @param {InputController} input
   */
  fixedUpdate(dt, input) {
    const body = this.body;
    const P = this.preset;
    const D = this.drive;
    const A = this.assists;
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

    // Accelerations for camera / HUD
    this.longAccel = THREE.MathUtils.lerp(this.longAccel, (vFwd - this._prevSpeed) / dt, 0.15);
    this.latAccel = THREE.MathUtils.lerp(this.latAccel, _av.dot(_up) * vFwd, 0.15);
    this._prevSpeed = vFwd;

    // ---- Inputs, direction (brake at a standstill engages reverse)
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
      driveInput = input.brake;
      brakeInput = input.throttle;
      if (input.throttle > 0.5 && input.brake < 0.1 && vFwd > -0.8) {
        this._reverseTimer += dt;
        if (this._reverseTimer > 0.1) { this.direction = 1; this._reverseTimer = 0; this.gear = 1; }
      } else this._reverseTimer = 0;
    }

    // ---- Steering: speed-sensitive lock + counter-steer help in slides
    const drifting = this.isDrifting;
    let lock = this.steerLimit(vFwd);
    if (drifting) lock = P.maxSteer;
    let target = input.steer * lock;
    if (drifting && A.steer && Math.abs(vFwd) > 5) target += clamp(this.driftAngle * 0.5, -0.35, 0.35) * (1 - Math.abs(input.steer) * 0.5);
    target = clamp(target, -P.maxSteer, P.maxSteer);
    const steerRate = 3.6 / (1 + Math.abs(vFwd) / 30); // slower hands at speed
    this.steerAngle += clamp(target - this.steerAngle, -steerRate * dt, steerRate * dt);
    this.steerInput = input.steer;
    const cosS = Math.cos(this.steerAngle), sinS = Math.sin(this.steerAngle);

    // ---- Suspension rays + surfaces
    _rayDir.copy(_up).negate();
    const maxLen = REST_LENGTH + WHEEL_RADIUS;
    let grounded = 0;
    let rough = 0;
    const surfCount = this._surfCount || (this._surfCount = new Uint8Array(SURFACES.length));
    surfCount.fill(0);
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
        w.surface = w.hit.terrain !== false && this.physics.surfaceAt
          ? this.physics.surfaceAt(w.contact.x, w.contact.z) : SURFACE.asphalt;
        surfCount[w.surface.id]++;
        rough += w.surface.rough;
        grounded++;
      } else {
        w.grounded = false;
        w.compression = 0;
        w.suspensionLength = REST_LENGTH;
      }
    }
    this.grounded = grounded;
    this.airTime = grounded === 0 ? this.airTime + dt : 0;
    this.rough = grounded ? rough / grounded : 0;
    if (grounded) {
      let best = 1;
      for (let i = 1; i < surfCount.length; i++) if (surfCount[i] > surfCount[best]) best = i;
      this.surface = SURFACES[best];
    }

    // Spring + damper + anti-roll → tyre loads
    const k = P.springK;
    const cBump = 2600, cRebound = 3600;
    const antiRoll = k * 0.4;
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

    // ---- Gearbox + engine → torque at the driven wheels
    this._shiftTimer = Math.max(0, this._shiftTimer - dt);
    const driven = D.driven;
    const dir = this.direction;
    const thr = clamp(driveInput, 0, 1);
    if (dir === 1 && !this.manual) this._autoShift(dt, thr);
    const ratio = dir === -1 ? D.reverse : D.ratios[this.gear - 1];
    let wAvg = 0;
    for (const i of driven) wAvg += this.wheels[i].omega;
    wAvg /= driven.length;
    const wheelRPM = Math.max(0, wAvg * dir) * ratio * RAD2RPM;
    let engaged = this._shiftTimer <= 0;
    let engineRPM = Math.max(wheelRPM, IDLE_RPM);
    if (wheelRPM < D.clutchRPM && (this.gear === 1 || dir === -1)) {
      // pulling away: the clutch slips, holding the engine near launch revs
      engineRPM = Math.max(wheelRPM, IDLE_RPM + thr * (D.clutchRPM - IDLE_RPM));
      if (thr < 0.02) engaged = false;
    }
    let engineTorque = 0;
    if (engaged) {
      if (engineRPM >= D.redline + 60) engineTorque = -this._engineBrake(engineRPM); // rev limiter
      else if (thr > 0.02) engineTorque = this.torqueAt(engineRPM) * thr;
      else if (wheelRPM > IDLE_RPM * 1.3) engineTorque = -this._engineBrake(engineRPM);
    }
    let wheelTorque = engaged ? engineTorque * ratio * DRIVE_EFF : 0;
    // Traction control: limit drive torque to what the driven tyres can put down
    // (grip left over after cornering force); relaxed while drifting so slides
    // can be held on the throttle.
    this.tcsActive = false;
    if (A.tcs && wheelTorque > 0 && grounded >= 2) {
      let cap = 0;
      for (const i of driven) {
        const w = this.wheels[i];
        if (!w.grounded) continue;
        const fMax = w.mu * w.load;
        cap += Math.sqrt(Math.max(0, fMax * fMax - w.Fy * w.Fy)) * WHEEL_RADIUS;
      }
      cap *= drifting || this.handbrake ? 1.9 : 1.04;
      if (wheelTorque > cap) { wheelTorque = cap; this.tcsActive = thr > 0.2; }
    }
    this.tcsCut = engineTorque > 0 && engaged ? wheelTorque / (engineTorque * ratio * DRIVE_EFF) : 1;
    this._driveTorque = wheelTorque * dir;
    this._engineRPM = engaged ? engineRPM : IDLE_RPM + thr * (D.redline - IDLE_RPM) * 0.85;
    const driveInertia = engaged ? (ENGINE_INERTIA * ratio * ratio) / driven.length : 0;

    // ---- Tyre frames, contact velocities and grip
    const nominalLoad = (mass * GRAVITY) / 4;
    const massShare = mass * 0.25;
    const peakTan = Math.tan(D.peakAngle);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const isDriven = driven.includes(i);
      w.isDriven = isDriven;
      w.Fx = 0; w.Fy = 0;
      w.inertia = WHEEL_INERTIA + (isDriven ? driveInertia : 0);
      if (w.front) {
        w.fwd.copy(_fwd).multiplyScalar(cosS).addScaledVector(_left, sinS);
        w.lat.copy(_left).multiplyScalar(cosS).addScaledVector(_fwd, -sinS);
      } else {
        w.fwd.copy(_fwd);
        w.lat.copy(_left);
      }
      if (!w.grounded) { w.vL = w.omega * WHEEL_RADIUS; w.vLat = 0; continue; }
      w.fwd.addScaledVector(w.normal, -w.fwd.dot(w.normal)).normalize();
      w.lat.addScaledVector(w.normal, -w.lat.dot(w.normal)).normalize();
      _r.subVectors(w.contact, _com);
      _vc.crossVectors(_av, _r).add(_lv);
      w.vL = _vc.dot(w.fwd);
      w.vLat = _vc.dot(w.lat);
      const S = w.surface;
      // loose surfaces: rally tyres dig in, everyone else floats
      const surfMu = S.mu + (1 - S.mu) * (P.offroad ?? 0) * 0.5 * S.loose;
      const loadSens = clamp(1 - 0.1 * (w.load / nominalLoad - 1), 0.8, 1.08);
      w.mu = (w.front ? P.gripFront : P.gripRear * D.rearScale) * surfMu * loadSens;
      w.peakTan = peakTan * (1 + 0.5 * S.loose);
    }

    // ---- Brakes (front-biased), handbrake, ABS
    const brakeFront = brakeInput * D.brakeTorque * 0.32; // per wheel
    const brakeRear = brakeInput * D.brakeTorque * 0.18;
    const hbTorque = this.handbrake ? 3200 : 0;

    // ---- Wheel spin + tyre forces, implicit sub-steps
    const h = dt / SUBSTEPS;
    const T = this._driveTorque;
    const Tfront = T * D.frontShare, Trear = T - Tfront;
    let absActive = false;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        // drive torque through the axle's limited-slip differential
        let Td = 0;
        if (w.isDriven) {
          const axleT = w.front ? Tfront : Trear;
          const partner = this.wheels[i ^ 1];
          Td = axleT * 0.5 + clamp(D.lsd * (partner.omega - w.omega), -Math.abs(axleT) * 0.5 - 150, Math.abs(axleT) * 0.5 + 150);
        }
        let Tb = w.front ? brakeFront : brakeRear + hbTorque;
        let Fx = 0, Fy = 0, dFdw = 0;
        if (w.grounded) {
          const Fz = w.load;
          const vL = w.vL;
          const denL = Math.max(Math.abs(vL), V_LONG_MIN);
          const sigma = (w.omega * WHEEL_RADIUS - vL) / denL;
          const sx = sigma / SLIP_RATIO_PEAK;
          const sy = w.vLat / Math.max(Math.abs(vL), V_LAT_MIN) / w.peakTan;
          const sAbs = Math.hypot(sx, sy);
          if (sAbs > 1e-6) {
            const loose = w.surface.loose;
            // loose surfaces slide more progressively (flatter curve past the peak)
            let f = tyreCurve(sAbs);
            if (loose > 0 && sAbs > 1) f = f + (1 - f) * loose * 0.5;
            const F = w.mu * Fz * f;
            Fx = (F * sx) / sAbs;
            Fy = (-F * sy) / sAbs;
          }
          // local slope of Fx w.r.t. wheel speed for the implicit update
          const lin = (w.mu * Fz * CURVE_SLOPE0) / SLIP_RATIO_PEAK;
          dFdw = (lin * (sAbs < 1 ? 1 : 0.12) * WHEEL_RADIUS) / denL;
          // rolling resistance acts like a light brake
          // (soft ground gets draggier with speed)
          Tb += ROLL_RES * w.surface.rr * (1 + (w.surface.loose * Math.abs(vL)) / 15) * Fz * WHEEL_RADIUS;
          // ABS: release brake pressure on a wheel that starts to lock
          if (A.abs && brakeInput > 0 && !this.handbrake && sigma < -SLIP_RATIO_PEAK * 1.3 && Math.abs(vL) > 2) {
            Tb *= 0.3;
            absActive = true;
          }
          w.slipRatio = sigma;
        }
        const Ieff = w.inertia + h * dFdw * WHEEL_RADIUS;
        let omega = w.omega + (h * (Td - Fx * WHEEL_RADIUS)) / Ieff;
        // brakes: Coulomb friction that can lock the wheel
        if (Tb > 0) {
          const dw = (h * Tb) / Ieff;
          omega = Math.abs(omega) <= dw ? 0 : omega - Math.sign(omega) * dw;
        }
        w.omega = omega;
        w.Fx += Fx / SUBSTEPS;
        w.Fy += Fy / SUBSTEPS;
      }
    }
    this.absActive = absActive;

    // ---- Apply tyre impulses
    let rearSlip = 0, maxSlide = 0, maxDriveSlip = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) { w.slide = 0; w.slip = 0; continue; }
      let jx = w.Fx * dt, jy = w.Fy * dt;
      // friction can't overshoot within one step: longitudinally it pulls the
      // contact patch towards the wheel's rim speed, laterally towards zero
      const slipV = w.omega * WHEEL_RADIUS - w.vL;
      if (jx * slipV > 0) jx = Math.sign(jx) * Math.min(Math.abs(jx), Math.abs(slipV) * massShare);
      if (jy * w.vLat < 0) jy = Math.sign(jy) * Math.min(Math.abs(jy), Math.abs(w.vLat) * massShare);
      _imp.copy(w.fwd).multiplyScalar(jx).addScaledVector(w.lat, jy);
      // apply part-way up towards the axle: keeps body roll/pitch lively but sane
      _pt.copy(w.contact).addScaledVector(_up, w.hit.distance * 0.18);
      body.applyImpulseAtPoint(toObj(_imp, _impObj), toObj(_pt, _ptObj), true);

      const slipAngle = Math.atan2(Math.abs(w.vLat), Math.abs(w.vL) + 0.5);
      w.slip = slipAngle;
      w.slide = Math.hypot(w.omega * WHEEL_RADIUS - w.vL, w.vLat);
      maxSlide = Math.max(maxSlide, w.slide);
      if (!w.front) rearSlip = Math.max(rearSlip, slipAngle);
      if (w.isDriven) maxDriveSlip = Math.max(maxDriveSlip, w.slipRatio * Math.sign(this._driveTorque || 1));
    }
    this._maxDriveSlip = maxDriveSlip;

    // ---- Aerodynamics: drag + downforce (split over the axles)
    const v2 = _lv.lengthSq();
    const vMag = Math.sqrt(v2);
    _imp.copy(_lv).multiplyScalar(-AIR * D.dragArea * vMag * dt);
    body.applyImpulse(toObj(_imp, _impObj), true);
    if (grounded > 0) {
      const down = AIR * (P.downforce ?? 1) * vFwd * vFwd * dt;
      const wf = P.weightFront ?? 0.5;
      for (const [z, share] of [[FRONT_Z, wf], [REAR_Z, 1 - wf]]) {
        _imp.copy(_up).multiplyScalar(-down * share);
        _pt.set(0, 0, z).applyQuaternion(_quat).add(_pos);
        body.applyImpulseAtPoint(toObj(_imp, _impObj), toObj(_pt, _ptObj), true);
      }
    }

    // ---- Driver aids
    const yawRate = _av.dot(_up);
    this._hbTimer = this.handbrake ? 1.5 : Math.max(0, (this._hbTimer ?? 0) - dt);
    if (grounded >= 3 && A.stm && this._hbTimer <= 0 && Math.abs(vFwd) > 4) {
      // stability control: trim yaw rate beyond what the steering asks for
      // (off for a moment after a handbrake pull so drifts can be started)
      const wanted = (vFwd * Math.tan(this.steerAngle)) / WHEELBASE;
      const excess = yawRate - wanted;
      if (Math.abs(excess) > 0.08 && Math.sign(excess) === Math.sign(yawRate)) {
        _imp.copy(_up).multiplyScalar(-(excess - Math.sign(excess) * 0.08) * mass * 3.5 * dt);
        body.applyTorqueImpulse(toObj(_imp, _impObj), true);
      }
    }
    if (grounded >= 3 && drifting) {
      // Drift assist: hold the slide inside a controllable angle window
      // (steering into the drift widens it) and keep momentum on throttle.
      const a = this.driftAngle;
      const window = 0.55 + Math.max(0, -Math.sign(a) * input.steer) * 0.25;
      const excess = Math.abs(a) > window ? a - Math.sign(a) * window : 0;
      _imp.copy(_up).multiplyScalar(excess * mass * 18 * dt);
      body.applyTorqueImpulse(toObj(_imp, _impObj), true);
      // gentle yaw damping so the slide doesn't snap back or spin
      _imp.copy(_up).multiplyScalar(-yawRate * mass * 0.25 * dt);
      body.applyTorqueImpulse(toObj(_imp, _impObj), true);
      if (!this.handbrake && driveInput > 0) {
        _tmp.copy(_lv).setY(0).normalize().multiplyScalar(mass * 3.5 * driveInput * dt);
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
        const gy = this.physics.groundHeight ? this.physics.groundHeight(_pos.x, _pos.z) : _pos.y;
        this.reset(_tmp.set(_pos.x, Math.max(gy, _pos.y) + 1.5, _pos.z), yaw);
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
    this.maxSlide = maxSlide;
    // Tyre scrub for audio: how hard the tyres are sliding on a grippy surface
    const hard = this.surface.loose < 0.5;
    this.skid = grounded && hard ? clamp((maxSlide - 1.5) / 6, 0, 1) : 0;
    this.gravel = grounded && !hard ? clamp(this.speedAbs / 25 + maxSlide / 8, 0, 1) : 0;

    // Engine speed for the tacho/audio (small lag)
    this.rpm += (clamp(this._engineRPM, IDLE_RPM * 0.9, D.redline + 150) - this.rpm) * 0.35;
    this._updateGearLabel(driveInput);

    // Expected velocity after this step (for collision detection next step)
    const nlv = body.linvel();
    this._expectedVel.set(nlv.x, nlv.y - GRAVITY * dt, nlv.z);
    this._hasExpected = true;
  }

  _engineBrake(rpm) {
    return this.drive.peakTorque * (0.08 + 0.16 * (rpm / this.drive.redline));
  }

  /** Automatic gearbox: shift points follow throttle; no shifting mid-air. */
  _autoShift(dt, thr) {
    this._shiftCooldown = Math.max(0, this._shiftCooldown - dt);
    if (this._shiftCooldown > 0 || this._shiftTimer > 0 || this.grounded === 0) return;
    const D = this.drive;
    const n = D.ratios.length;
    const g = this.gear;
    const wheelRPM = this._drivenWheelRPM(D.ratios[g - 1]);
    const roadRPM = (Math.max(0, this.speed) / WHEEL_RADIUS) * D.ratios[g - 1] * RAD2RPM;
    const up = D.redline * (0.6 + 0.37 * thr);
    if (g < n && wheelRPM > up && roadRPM > D.redline * 0.5) {
      this.shift(1);
      return;
    }
    if (g > 1) {
      const lowerRPM = roadRPM * (D.ratios[g - 2] / D.ratios[g - 1]);
      const down = D.redline * (0.34 + 0.3 * thr);
      if (roadRPM < down && lowerRPM < D.redline * 0.88) this.shift(-1);
    }
  }

  _drivenWheelRPM(ratio) {
    let w = 0;
    for (const i of this.drive.driven) w += this.wheels[i].omega;
    return Math.max(0, w / this.drive.driven.length) * ratio * RAD2RPM;
  }

  _updateGearLabel(driveInput) {
    const prev = this.gearLabel;
    if (this.direction === -1) this.gearLabel = 'R';
    else if (this.speedAbs < 0.5 && driveInput === 0 && this.brakeInput === 0) this.gearLabel = 'N';
    else this.gearLabel = String(this.gear);
    if (this.gearLabel !== prev) this.shiftEvent = true;
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
      w.spin += w.omega * dt;
      w.spinner.rotation.x = w.spin;
    }

    // Chassis lean: spring-damped roll & pitch from lateral/longitudinal g,
    // plus a light shimmy on rough ground
    const L = this._lean;
    const tr = clamp(this.latAccel * 0.0042, -0.075, 0.075);
    const tp = clamp(-this.longAccel * 0.0032, -0.045, 0.05);
    const ks = 90, kd = 13;
    L.vr += ((tr - L.r) * ks - L.vr * kd) * dt;
    L.vp += ((tp - L.p) * ks - L.vp * kd) * dt;
    L.r += L.vr * dt;
    L.p += L.vp * dt;
    const shimmy = this.grounded ? this.rough * Math.min(1, this.speedAbs / 20) * 0.006 : 0;
    this._shimT = (this._shimT || 0) + dt;
    this.bodyPivot.rotation.set(
      L.p + shimmy * Math.sin(this._shimT * 53), 0,
      L.r + shimmy * Math.sin(this._shimT * 47 + 1.3));

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
    // visual-only chassis lean (roll/pitch from g-forces), pivoting near the COM
    this.bodyPivot = new THREE.Group();
    this.bodyPivot.position.y = -0.3;
    body.position.y = 0.3;
    this.bodyPivot.add(body);
    this.root.add(this.bodyPivot);
    this._lean = { r: 0, p: 0, vr: 0, vp: 0 };

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
      model.position.set(0, -0.62 + 0.3, 0);
      this.bodyPivot.rotation.set(0, 0, 0);
      this.bodyPivot.add(model);
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
          g.position.y += 0.3;
          this.bodyPivot.add(g);
        });
      }
    } catch (err) {
      console.warn('[Vehicle] Failed to adopt car model, keeping procedural body.', err);
      this.bodyGroup.visible = true;
    }
  }
}
