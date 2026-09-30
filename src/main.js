import * as THREE from 'three';
import { PhysicsWorld } from './PhysicsWorld.js';
import { Environment } from './Environment.js';
import { Vehicle, InputController, CAR_PRESETS } from './Vehicle.js';
import { CameraController } from './CameraController.js';
import { UI } from './UI.js';
import { createPostProcessing, createSkyMaterial } from './Shaders.js';
import { AudioSystem } from './Audio.js';
import { Progression } from './Progression.js';
import { EventManager, StuntManager, AmbientTraffic, EVENTS } from './Events.js';

/**
 * main.js
 * -------
 * Application lifecycle: bootstrap renderer/physics/world, run the frame loop
 * and manage the LOADING → TITLE → GAMEPLAY ⇄ MENU / RESULTS state machine.
 * Also hosts the Horizon-style skill chain scoring.
 */

export const STATE = Object.freeze({
  LOADING: 'LOADING', TITLE: 'TITLE', GAMEPLAY: 'GAMEPLAY', MENU: 'MENU', RESULTS: 'RESULTS',
});

const FROZEN_INPUT = Object.freeze({ throttle: 0, brake: 1, steer: 0, handbrake: true });
const IDLE_INPUT = Object.freeze({ throttle: 0, brake: 0.4, steer: 0, handbrake: false });

// ============================================================================
// Skill chain system
// ============================================================================
class SkillSystem {
  constructor(ui, audio, progression) {
    this.ui = ui;
    this.audio = audio;
    this.progression = progression;
    this.chainScore = 0;
    this.chainMult = 1;
    this.chainTimer = 0;
    this.chainActive = false;
    this.total = 0; // this session
    this.stats = { bestChain: 0, longestDrift: 0, topSpeed: 0 };

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
    this.audio.skill();
    this.chainScore += points;
    this.chainMult = Math.min(9.9, this.chainMult + 0.2);
    this.chainTimer = SkillSystem.CHAIN_TIME;
    this.chainActive = true;
  }

  crash(strength) {
    if (strength < 5) return; // only meaningful impacts break the chain
    this.cleanTimer = 0;
    if (this.chainActive) {
      this.ui.showSkill('CHAIN BROKEN', null, 'fail');
      this.audio.fail();
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
      if (this.airborne > 0.6) this._award(this.airborne > 1.5 ? 'GREAT AIR' : 'AIR', Math.round(this.airborne * 250), 'cyan');
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

    // --- Chain timer / banking (timer pauses mid-drift)
    if (this.chainActive) {
      if (!v.isDrifting) this.chainTimer -= dt;
      this.ui.updateChain(true, this.chainScore + this.driftPoints, this.chainMult, this.chainTimer / SkillSystem.CHAIN_TIME);
      if (this.chainTimer <= 0) {
        const banked = Math.round(this.chainScore * this.chainMult);
        this.total += banked;
        this.stats.bestChain = Math.max(this.stats.bestChain, banked);
        this.ui.showSkill('SKILL CHAIN', banked, 'lime');
        this.ui.bankChain();
        this.audio.bank();
        this.progression.stat('bestChain', banked);
        this.progression.stat('longestDrift', this.stats.longestDrift);
        this.progression.stat('topSpeed', this.stats.topSpeed);
        this.progression.addSkillScore(banked);
        this.chainActive = false;
        this.chainScore = 0;
        this.chainMult = 1;
      }
    } else if (this.driftPoints > 60) {
      this.ui.updateChain(true, this.driftPoints, this.chainMult, 1);
    }
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
    this._saveTimer = 0;
  }

  async init() {
    this.progression = new Progression();
    const settings = this.progression.settings;
    this.ui = new UI({
      onAction: (a, d) => this.onMenuAction(a, d),
      onSetting: (k, v) => this.onSetting(k, v),
    });
    this.ui.applySettings(settings);
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
    this.resolutionScale = settings.resolution;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.resolutionScale);
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
    this.input.touch = this.ui.touch;
    this.vehicle = new Vehicle(this.scene, this.physics, this.progression.selectedPreset);
    this.vehicle.setPaint(this.progression.selectedPaint);
    this.vehicle.reset(this.env.startPosition, this.env.startYaw);

    this.cameraCtl = new CameraController(this.camera);
    this.cameraCtl.snap(this.vehicle);

    // ------------------------------------------------ Game systems
    this.audio = new AudioSystem();
    this.audio.musicOn = settings.radio;
    this.audio.setVolumes({ master: settings.master, music: settings.music, sfx: settings.sfx });
    this.skills = new SkillSystem(this.ui, this.audio, this.progression);
    const ctx = {
      scene: this.scene, physics: this.physics, env: this.env, player: this.vehicle,
      ui: this.ui, audio: this.audio, progression: this.progression,
    };
    this.events = new EventManager(ctx);
    this.stunts = new StuntManager(ctx);
    this.traffic = new AmbientTraffic(ctx);
    this.traffic.spawn(4, this.vehicle.root.position);

    this.progression.onChange((type, payload) => {
      if (type === 'levelup') {
        this.ui.levelBanner(payload.level, payload.reward);
        this.audio.levelUp();
      }
      this.ui.updateProfile(this.progression);
      if (this.state === STATE.MENU && this.ui.activeTab === 'garage') this.ui.renderGarage(this.progression);
    });
    this.ui.updateProfile(this.progression);

    // ----------------------------------------------- Env map + post FX
    this.ui.setLoading(0.85, 'Lighting…');
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), createSkyMaterial());
    this.envScene.add(this.envSky);
    this.env.setTimeOfDay(settings.time);
    this._updateEnvMap();
    this.scene.environmentIntensity = 0.7;

    this.post = createPostProcessing(r, this.scene, this.camera);
    this.post.bloomPass.enabled = settings.bloom;
    this.post.blurEnabled = settings.blur;
    if (settings.shadows !== 2048) this.env.setShadowQuality(settings.shadows);

    // ---------------------------------------------------------- Events
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.clock.getDelta(); // drop the hidden gap
      else if (this.state === STATE.GAMEPLAY) this.openMenu(); // auto-pause
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

    console.info(
      `[Horizon] physics=${backend} · instanced roadside objects=${this.env.instanceCount} · barriers=${this.env.barrierCount}`
    );

    // Title screen with the showroom camera orbiting the player's car
    this.state = STATE.TITLE;
    this.cameraCtl.setMode('showroom');
    this.ui.showTitle(this.progression, (touch) => this.startGame(touch));

    this.clock.getDelta();
    r.setAnimationLoop(() => this.tick());
  }

  startGame(touch) {
    this.audio.unlock();
    if (touch || matchMedia('(pointer: coarse)').matches) this.ui.enableTouch();
    this.state = STATE.GAMEPLAY;
    this.input.enabled = true;
    this.cameraCtl.setMode(this.cameraCtl.chaseMode);
    this.cameraCtl.snap(this.vehicle);
    this.ui.toast(touch ? 'Hold GAS to drive · ☰ for menu' : 'W A S D / Arrows to drive · Space handbrake · Esc menu', 3500);
    document.getElementById('scene').focus();
  }

  onKey(e) {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.state === STATE.RESULTS) this.onMenuAction('results-continue');
      else this.toggleMenu();
    }
    if (this.state === STATE.RESULTS && (e.code === 'Enter' || e.code === 'Space')) {
      e.preventDefault();
      this.onMenuAction('results-continue');
    }
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
    this.ui.setTouchVisible(false);
    this.progression.save();
    this.ui.openMenu();
  }

  closeMenu() {
    this.state = STATE.GAMEPLAY;
    this.input.enabled = true;
    this.cameraCtl.setMode(this.cameraCtl.chaseMode);
    this.ui.setTouchVisible(true);
    this.ui.closeMenu();
    this.clock.getDelta();
  }

  resetCar() {
    const v = this.vehicle;
    const p = v.root.position;
    const env = this.env;
    if (env.inPlaza(p.x, p.z) && !this.events.active) {
      v.reset(env.startPosition, env.startYaw);
    } else {
      const i = env.nearestIndex(p.x, p.z);
      const pos = env.trackPoint(i, 0, new THREE.Vector3());
      pos.y = 1.2;
      v.reset(pos, env.trackYaw(i));
    }
    this.cameraCtl.snap(v);
    this.skills.reset();
    this.stunts.reset();
  }

  startEvent(id) {
    const def = EVENTS.find((e) => e.id === id);
    if (!def) return;
    if (this.state === STATE.MENU) this.closeMenu();
    this.ui.hideResults();
    this.state = STATE.GAMEPLAY;
    this.input.enabled = true;
    this.stunts.reset();
    this.stunts.enabled = false;
    this.skills.reset();
    this.traffic.despawn();
    this.events.start(def);
    this.cameraCtl.snap(this.vehicle);
    this.ui.toast(def.type === 'race' ? `${def.name} · ${def.laps} lap${def.laps > 1 ? 's' : ''}` : `${def.name} · best lap counts`);
  }

  endEvent() {
    this.events.cleanup();
    this.traffic.spawn(4, this.vehicle.root.position);
    this.stunts.enabled = true;
    this.stunts.reset();
    this.ui.hideResults();
    this.state = STATE.GAMEPLAY;
    this.input.enabled = true;
    this.ui.setTouchVisible(true);
    this.ui.updateProfile(this.progression);
  }

  onMenuAction(action, data) {
    const prog = this.progression;
    switch (action) {
      case 'toggle-menu':
        this.toggleMenu();
        break;
      case 'tab':
        if (data === 'festival') {
          this.ui.renderEvents(EVENTS, prog, this.events.def?.id);
          this.ui.updateStats(prog, this.skills.stats);
        } else if (data === 'garage') this.ui.renderGarage(prog);
        this.audio.click();
        break;
      case 'resume':
        this.closeMenu();
        break;
      case 'reset':
        if (this.events.active) { this.resetCar(); this.closeMenu(); break; }
        this.vehicle.reset(this.env.startPosition, this.env.startYaw);
        this.env.resetCones();
        this.skills.reset();
        this.stunts.reset();
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
      case 'start-event':
        this.startEvent(data);
        break;
      case 'quit-event':
        this.events.quit();
        this.traffic.spawn(4, this.vehicle.root.position);
        this.stunts.enabled = true;
        this.ui.renderEvents(EVENTS, prog, null);
        this.closeMenu();
        break;
      case 'results-continue':
        this.audio.click();
        this.endEvent();
        break;
      case 'results-retry':
        this.audio.click();
        this.startEvent(this.events.def?.id);
        break;
      case 'select-car':
        if (this.events.active) { this.ui.toast("Can't swap cars during an event"); break; }
        if (prog.selectCar(data)) {
          this.vehicle.applyPreset(prog.selectedPreset, prog.selectedPaint);
          this.ui.renderGarage(prog);
          this.ui.updateProfile(prog);
          this.ui.toast(`${prog.selectedPreset.name} equipped`);
          this.audio.click();
        }
        break;
      case 'buy-car': {
        const car = CAR_PRESETS.find((c) => c.id === data);
        const res = prog.buyCar(data);
        if (res.ok) {
          this.audio.purchase();
          this.ui.toast(`${car.name} added to your garage!`);
          if (!this.events.active) this.onMenuAction('select-car', data);
        } else {
          this.audio.fail();
          this.ui.toast(`${car.name}: ${res.reason} (${car.price.toLocaleString()} CR)`);
        }
        this.ui.renderGarage(prog);
        break;
      }
      case 'upgrade': {
        if (this.events.active) { this.ui.toast("Can't upgrade during an event"); break; }
        const res = prog.buyUpgrade(prog.data.selectedCar, data);
        if (res.ok) {
          this.audio.purchase();
          this.vehicle.applyPreset(prog.selectedPreset, prog.selectedPaint);
          this.ui.toast('Upgrade installed');
        } else {
          this.audio.fail();
          this.ui.toast(res.reason);
        }
        this.ui.renderGarage(prog);
        this.ui.updateProfile(prog);
        break;
      }
      case 'paint':
        prog.setPaint(prog.data.selectedCar, data);
        this.vehicle.setPaint(data);
        this.ui.renderGarage(prog);
        break;
      case 'reset-progress':
        if (window.confirm('Reset all progress? Credits, cars, upgrades and records will be lost.')) {
          if (this.events.active) {
            this.events.quit();
            this.stunts.enabled = true;
            this.traffic.spawn(4, this.vehicle.root.position);
          }
          prog.resetAll();
          this.vehicle.applyPreset(prog.selectedPreset, prog.selectedPaint);
          this.ui.updateProfile(prog);
          this.ui.toast('Progress reset');
        }
        break;
      case 'redraw-map':
        this.ui.drawWorldMap(this.vehicle, this.env, prog);
        break;
    }
  }

  onSetting(key, value) {
    this.progression.setSetting(key, value);
    switch (key) {
      case 'units':
        this.ui.setUnits(value);
        this.ui.updateStats(this.progression, this.skills.stats);
        break;
      case 'bloom':
        this.post.bloomPass.enabled = value;
        break;
      case 'blur':
        this.post.blurEnabled = value;
        break;
      case 'radio':
        this.audio.setMusic(value);
        break;
      case 'master':
      case 'music':
      case 'sfx':
        this.audio.setVolumes({ [key]: value });
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
    this.progression.setSetting('time', elevation);
    if (syncSlider) this.ui.setTimeSlider(elevation);
    // Env-map regeneration is debounced (slider drags fire rapidly)
    this._envDirty = true;
    this._envTimer = 0.15;
  }

  _updateEnvMap() {
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
    const state = this.state;

    // ---- Global actions
    if (input.consume('menu')) {
      if (state === STATE.RESULTS) this.onMenuAction('results-continue');
      else this.toggleMenu();
    }
    if (input.consume('radio')) {
      const on = !this.progression.settings.radio;
      this.onSetting('radio', on);
      document.getElementById('set-radio').checked = on;
      this.ui.toast(on ? 'Horizon Pulse radio ON' : 'Radio OFF');
    }

    if (state === STATE.MENU || state === STATE.RESULTS) {
      if (state === STATE.MENU) {
        if (input.consume('tabLeft')) this.ui.cycleTab(-1);
        if (input.consume('tabRight')) this.ui.cycleTab(1);
      }
      if (input.consume('navUp')) this.ui.navigate(0, -1);
      if (input.consume('navDown')) this.ui.navigate(0, 1);
      if (input.consume('navLeft')) this.ui.navigate(-1, 0);
      if (input.consume('navRight')) this.ui.navigate(1, 0);
      if (input.consume('confirm')) this.ui.confirm();
      if (input.consume('back')) {
        if (state === STATE.MENU) this.closeMenu();
        else this.onMenuAction('results-continue');
      }
      input.consume('camera');
      input.consume('reset');
    } else {
      for (const a of ['tabLeft', 'tabRight', 'navUp', 'navDown', 'navLeft', 'navRight', 'confirm', 'back']) input.consume(a);
      if (state === STATE.GAMEPLAY) {
        if (input.consume('camera')) {
          const name = this.cameraCtl.cycleChaseMode();
          this.ui.setCameraLabel(name);
          this.ui.toast(`Camera: ${name}`);
        }
        if (input.consume('reset') && !this.events.freezePlayer) this.resetCar();
      }
    }

    // ---- Simulation (paused in the menu / title)
    let alpha = 1;
    const simulate = this.state === STATE.GAMEPLAY || this.state === STATE.RESULTS;
    if (simulate) {
      const playerInput = this.state === STATE.RESULTS ? IDLE_INPUT : this.events.freezePlayer ? FROZEN_INPUT : input;
      alpha = this.physics.step(dt, (fixedDt) => {
        this.vehicle.fixedUpdate(fixedDt, playerInput);
        this.events.fixedUpdate(fixedDt);
        this.traffic.fixedUpdate(fixedDt, this.vehicle);
      });
    }
    const v = this.vehicle;
    v.update(dt, alpha);
    this.events.updateVisuals(dt, alpha);
    this.traffic.updateVisuals(dt, alpha);

    if (v.impactEvent > 0) {
      this.cameraCtl.impact(Math.min(1, v.impactEvent / 12));
      this.audio.impact(v.impactEvent);
      if (this.state === STATE.GAMEPLAY) this.skills.crash(v.impactEvent);
      v.impactEvent = 0;
    }

    if (v.landEvent > 0) {
      this.cameraCtl.impact(Math.min(0.6, v.landEvent / 20));
      this.audio.impact(v.landEvent * 0.5);
      v.landEvent = 0;
    }

    const knocked = this.env.update(dt, v.root.position, this.camera);
    if (this.state === STATE.GAMEPLAY) {
      if (knocked) this.skills.conesKnocked(knocked);
      this.skills.update(dt, v);
      this.stunts.update(dt);
      this.progression.stat('distance', v.speedAbs * dt, 'add');
    }
    if (simulate) {
      this.events.update(dt);
      if (this.events.state === 'finished' && this.state === STATE.GAMEPLAY) {
        this.state = STATE.RESULTS;
        this.ui.setTouchVisible(false);
      }
    }

    this.cameraCtl.update(dt, v);

    // ---- HUD
    if (this.state === STATE.GAMEPLAY) {
      this.ui.updateHUD(v);
      if (this.frame % 2 === 0) {
        this.ui.drawMinimap(v, this.env, this.events.markers() ?? { cars: this.traffic.positions(), checkpoint: null, freeRoam: true });
      }
    }
    this.audio.update(v, this.state === STATE.GAMEPLAY);

    // ---- Periodic save (distance / stats)
    this._saveTimer += dt;
    if (this._saveTimer > 20) {
      this._saveTimer = 0;
      this.progression.save();
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
