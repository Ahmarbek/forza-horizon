import * as THREE from 'three';
import { PhysicsWorld } from './PhysicsWorld.js';
import { Environment } from './Environment.js';
import { Vehicle, InputController } from './Vehicle.js';
import { CameraController } from './CameraController.js';
import { UI } from './UI.js';
import { createPostProcessing, createSkyMaterial } from './Shaders.js';

/**
 * main.js
 * -------
 * Application lifecycle: bootstrap renderer/physics/world, run the frame loop,
 * and manage the GAMEPLAY ⇄ MENU state machine. Also hosts the Horizon-style
 * skill chain scoring system.
 */

export const STATE = Object.freeze({ LOADING: 'LOADING', GAMEPLAY: 'GAMEPLAY', MENU: 'MENU' });

// ============================================================================
// Skill chain system
// ============================================================================
class SkillSystem {
  constructor(ui) {
    this.ui = ui;
    this.chainScore = 0;
    this.chainMult = 1;
    this.chainTimer = 0;
    this.chainActive = false;
    this.total = 0;
    this.stats = { total: 0, bestChain: 0, longestDrift: 0, topSpeed: 0 };

    this.driftPoints = 0;
    this.driftDistance = 0;
    this.driftGrace = 0;
    this.cleanTimer = 0;
    this.speedTimer = 0;
    this.airborne = 0;
  }

  static CHAIN_TIME = 4.5;

  _award(label, points, variant) {
    this.ui.showSkill(label, points, variant);
    this.chainScore += points;
    this.chainMult = Math.min(9.9, this.chainMult + 0.2);
    this.chainTimer = SkillSystem.CHAIN_TIME;
    this.chainActive = true;
  }

  crash(strength) {
    // Only meaningful impacts break the chain
    if (strength < 5) return;
    this.cleanTimer = 0;
    if (this.chainActive) {
      this.ui.showSkill('CHAIN BROKEN', null, 'fail');
      this.chainActive = false;
      this.chainScore = 0;
      this.chainMult = 1;
      this.ui.dropChain();
    }
    this.driftPoints = 0;
    this.driftDistance = 0;
  }

  conesKnocked(n) {
    for (let i = 0; i < n; i++) this._award('CONE SMASH', 50, 'lime');
  }

  reset() {
    this.driftPoints = 0;
    this.driftDistance = 0;
    this.cleanTimer = 0;
  }

  update(dt, v) {
    const speed = v.speedAbs;
    this.stats.topSpeed = Math.max(this.stats.topSpeed, speed);

    // --- Drift
    if (v.isDrifting) {
      const angleDeg = Math.abs(v.driftAngle) * 57.3;
      this.driftPoints += angleDeg * speed * dt * 0.9;
      this.driftDistance += speed * dt;
      this.driftGrace = 0.4;
    } else if (this.driftPoints > 0) {
      this.driftGrace -= dt;
      if (this.driftGrace <= 0) {
        if (this.driftPoints >= 60) {
          const pts = Math.round(this.driftPoints / 10) * 10;
          const label = pts > 2500 ? 'AWESOME DRIFT' : pts > 1000 ? 'GREAT DRIFT' : 'DRIFT';
          this._award(label, pts);
          this.stats.longestDrift = Math.max(this.stats.longestDrift, this.driftDistance);
        }
        this.driftPoints = 0;
        this.driftDistance = 0;
      }
    }

    // --- Speed skill (> ~100 mph sustained)
    if (speed > 44.7) {
      this.speedTimer += dt;
      if (this.speedTimer > 2) {
        this.speedTimer = 0;
        this._award('SPEED SKILL', 150 + Math.round((speed - 44.7) * 10), 'cyan');
      }
    } else this.speedTimer = 0;

    // --- Air
    if (v.grounded === 0) this.airborne += dt;
    else {
      if (this.airborne > 0.6) this._award('AIR', Math.round(this.airborne * 250), 'cyan');
      this.airborne = 0;
    }

    // --- Clean driving: 10 s above ~35 mph without a hard impact
    if (speed > 15) {
      this.cleanTimer += dt;
      if (this.cleanTimer > 10) {
        this.cleanTimer = 0;
        this._award('CLEAN DRIVING', 100, 'cyan');
      }
    }

    // --- Chain timer / banking (timer pauses while mid-drift)
    if (this.chainActive) {
      if (!v.isDrifting) this.chainTimer -= dt;
      const live = this.chainScore + this.driftPoints;
      this.ui.updateChain(true, live, this.chainMult, this.chainTimer / SkillSystem.CHAIN_TIME);
      if (this.chainTimer <= 0) {
        const banked = Math.round(this.chainScore * this.chainMult);
        this.total += banked;
        this.stats.bestChain = Math.max(this.stats.bestChain, banked);
        this.ui.showSkill('SKILL CHAIN', banked, 'lime');
        this.ui.bankChain();
        this.chainActive = false;
        this.chainScore = 0;
        this.chainMult = 1;
      }
    } else if (this.driftPoints > 60) {
      // show the live drift building before the first award
      this.ui.updateChain(true, this.driftPoints, this.chainMult, 1);
    }
    this.stats.total = this.total;
    this.ui.setTotalScore(this.total);
  }
}

// ============================================================================
// Application
// ============================================================================
class App {
  constructor() {
    this.state = STATE.LOADING;
    this.clock = new THREE.Clock();
    this.resolutionScale = 1;
    this.frame = 0;
    this._envDirty = false;
    this._envTimer = 0;
  }

  async init() {
    this.ui = new UI({
      onAction: (a, d) => this.onMenuAction(a, d),
      onSetting: (k, v) => this.onSetting(k, v),
    });
    this.ui.setLoading(0.05, 'Starting renderer…');

    // ---------------------------------------------------------- Renderer
    const canvas = document.getElementById('scene');
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    } catch (err) {
      this.ui.showFatal('WebGL is not available in this browser. Please enable hardware acceleration.');
      throw err;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 6000);

    // ----------------------------------------------------------- Physics
    this.ui.setLoading(0.15, 'Initialising physics…');
    this.physics = new PhysicsWorld();
    const backend = await this.physics.init();
    this.ui.setBackend(backend);

    // ------------------------------------------------------------- World
    this.ui.setLoading(0.35, 'Building the Festival Loop…');
    await nextFrame();
    this.env = new Environment(this.scene, this.physics, r).build();
    this.ui.setLoading(0.7, 'Preparing the garage…');
    await nextFrame();

    this.input = new InputController();
    this.vehicle = new Vehicle(this.scene, this.physics);
    this.vehicle.reset(this.env.startPosition, this.env.startYaw);

    this.cameraCtl = new CameraController(this.camera);
    this.cameraCtl.snap(this.vehicle);

    this.skills = new SkillSystem(this.ui);

    // ----------------------------------------------- Env map + post FX
    this.ui.setLoading(0.85, 'Lighting…');
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), createSkyMaterial());
    this.envScene.add(this.envSky);
    this._updateEnvMap();
    this.scene.environmentIntensity = 0.7;

    this.post = createPostProcessing(r, this.scene, this.camera);

    // ---------------------------------------------------------- Events
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        this.toggleMenu();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.clock.getDelta(); // drop the hidden gap
    });

    // Warm-up render so shader compilation happens behind the loader
    this.ui.setLoading(0.95, 'Compiling shaders…');
    await nextFrame();
    this.vehicle.update(0, 1);
    this.cameraCtl.update(1 / 60, this.vehicle);
    r.compile(this.scene, this.camera);
    this.post.render(1 / 60);

    this.ui.setLoading(1, 'Ready');
    this.ui.hideLoader();
    this.state = STATE.GAMEPLAY;
    this.ui.toast('W A S D / Arrows to drive · Space handbrake · Esc menu', 3500);
    canvas.focus();

    console.info(
      `[Horizon] physics=${backend} · instanced roadside objects=${this.env.instanceCount} · barriers=${this.env.barrierCount}`
    );

    this.clock.getDelta();
    r.setAnimationLoop(() => this.tick());
  }

  // ---------------------------------------------------------------- State
  toggleMenu() {
    if (this.state === STATE.GAMEPLAY) this.openMenu();
    else if (this.state === STATE.MENU) this.closeMenu();
  }

  openMenu() {
    this.state = STATE.MENU;
    this.input.enabled = false;
    this.cameraCtl.setMode('showroom');
    this.ui.updateStats(this.skills.stats);
    this.ui.openMenu();
  }

  closeMenu() {
    this.state = STATE.GAMEPLAY;
    this.input.enabled = true;
    this.cameraCtl.setMode(this.cameraCtl.chaseMode);
    this.ui.closeMenu();
    this.clock.getDelta();
  }

  resetCar() {
    const v = this.vehicle;
    const p = v.root.position;
    const env = this.env;
    // nearest track sample
    let best = 0, bestD = Infinity;
    for (let i = 0; i < env.trackSamples.length; i++) {
      const s = env.trackSamples[i];
      const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const s = env.trackSamples[best];
    const t = env.trackTangents[best];
    const pos = new THREE.Vector3(s.x, 1.2, s.z);
    // If we are near the start plaza, use the grid instead
    if (env.inPlaza(p.x, p.z)) v.reset(env.startPosition, env.startYaw);
    else v.reset(pos, Math.atan2(t.x, t.z));
    this.cameraCtl.snap(v);
    this.skills.reset();
  }

  onMenuAction(action, data) {
    switch (action) {
      case 'resume':
        this.closeMenu();
        break;
      case 'reset':
        this.vehicle.reset(this.env.startPosition, this.env.startYaw);
        this.env.resetCones();
        this.skills.reset();
        this.closeMenu();
        this.cameraCtl.snap(this.vehicle);
        this.ui.toast('Back at the Festival site');
        break;
      case 'time-golden':
        this.setTime(9);
        this.ui.toast('Golden hour');
        break;
      case 'time-noon':
        this.setTime(52);
        this.ui.toast('Midday');
        break;
      case 'camera': {
        const name = this.cameraCtl.cycleChaseMode();
        this.cameraCtl.setMode('showroom');
        this.ui.setCameraLabel(name);
        this.ui.toast(`Camera: ${name}`);
        break;
      }
      case 'select-car':
        this.vehicle.applyPreset(data);
        this.ui.toast(`${data.name} equipped`);
        break;
      case 'paint':
        this.vehicle.setPaint(data);
        break;
      case 'redraw-map':
        this.ui.drawWorldMap(this.vehicle, this.env);
        break;
    }
  }

  onSetting(key, value) {
    switch (key) {
      case 'units':
        this.ui.setUnits(value);
        this.ui.updateStats(this.skills.stats);
        break;
      case 'bloom':
        this.post.bloomPass.enabled = value;
        break;
      case 'blur':
        this.post.blurEnabled = value;
        break;
      case 'shadows':
        this.env.setShadowQuality(value);
        break;
      case 'time':
        this.setTime(value, false);
        break;
      case 'resolution':
        this.resolutionScale = value;
        this.onResize();
        break;
    }
  }

  setTime(elevation, syncSlider = true) {
    this.env.setTimeOfDay(elevation);
    if (syncSlider) this.ui.setTimeSlider(elevation);
    // Env-map regeneration is debounced (slider drags fire rapidly)
    this._envDirty = true;
    this._envTimer = 0.15;
  }

  _updateEnvMap() {
    // Share sky uniforms so the reflection matches the visible sky
    const src = this.env.sky.material.uniforms;
    const dst = this.envSky.material.uniforms;
    for (const k of ['uSunDir', 'uZenith', 'uHorizon', 'uGround', 'uSunColor']) dst[k].value.copy(src[k].value);
    dst.uSunset.value = src.uSunset.value;
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 1000);
    this.scene.environment = this.envRT.texture;
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, 2) * this.resolutionScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, pr);
    this.env.petals.material.uniforms.uPixelRatio.value = pr;
  }

  // ----------------------------------------------------------------- Loop
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.frame++;
    const input = this.input;
    input.update(dt);

    // ---- Global actions
    if (input.consume('menu')) this.toggleMenu();

    if (this.state === STATE.MENU) {
      if (input.consume('tabLeft')) this.ui.cycleTab(-1);
      if (input.consume('tabRight')) this.ui.cycleTab(1);
      if (input.consume('navUp')) this.ui.navigate(0, -1);
      if (input.consume('navDown')) this.ui.navigate(0, 1);
      if (input.consume('navLeft')) this.ui.navigate(-1, 0);
      if (input.consume('navRight')) this.ui.navigate(1, 0);
      if (input.consume('confirm')) this.ui.confirm();
      if (input.consume('back')) this.closeMenu();
      input.consume('camera');
      input.consume('reset');
    } else {
      for (const a of ['tabLeft', 'tabRight', 'navUp', 'navDown', 'navLeft', 'navRight', 'confirm', 'back']) input.consume(a);
      if (input.consume('camera')) {
        const name = this.cameraCtl.cycleChaseMode();
        this.ui.setCameraLabel(name);
        this.ui.toast(`Camera: ${name}`);
      }
      if (input.consume('reset')) this.resetCar();
    }

    // ---- Simulation (paused while in the menu)
    let alpha = 1;
    if (this.state === STATE.GAMEPLAY) {
      alpha = this.physics.step(dt, (fixedDt) => this.vehicle.fixedUpdate(fixedDt, input));
    }
    const v = this.vehicle;
    v.update(dt, alpha);

    if (v.impactEvent > 0) {
      this.cameraCtl.impact(Math.min(1, v.impactEvent / 12));
      this.skills.crash(v.impactEvent);
      v.impactEvent = 0;
    }

    const knocked = this.env.update(dt, v.root.position, this.camera);
    if (this.state === STATE.GAMEPLAY) {
      if (knocked) this.skills.conesKnocked(knocked);
      this.skills.update(dt, v);
    }

    this.cameraCtl.update(dt, v);

    // ---- HUD
    if (this.state === STATE.GAMEPLAY) {
      this.ui.updateHUD(v);
      if (this.frame % 2 === 0) this.ui.drawMinimap(v, this.env);
    }

    // ---- Deferred env-map refresh
    if (this._envDirty) {
      this._envTimer -= dt;
      if (this._envTimer <= 0) {
        this._envDirty = false;
        this._updateEnvMap();
      }
    }

    // ---- Render
    this.post.setSpeed(this.state === STATE.GAMEPLAY ? v.speedAbs / 80 : 0);
    this.post.render(dt);
  }
}

function nextFrame() {
  return new Promise((res) => requestAnimationFrame(() => res()));
}

// ============================================================================
// Boot
// ============================================================================
const app = new App();
window.__horizon = app; // handy for debugging in the console

app.init().catch((err) => {
  console.error('[Horizon] Fatal init error', err);
  if (app.ui) app.ui.showFatal(`${err?.message ?? err}`);
  else {
    const f = document.getElementById('fatal');
    f.hidden = false;
    f.textContent = `Unable to start: ${err?.message ?? err}`;
  }
});
