import * as THREE from 'three';
import { PhysicsWorld } from './PhysicsWorld.js';
import { Environment } from './Environment.js';
import { Vehicle, InputController, CAR_PRESETS, preloadCarModels } from './Vehicle.js';
import { CameraController } from './CameraController.js';
import { UI } from './UI.js';
import { createPostProcessing, installRadianceClamp } from './Shaders.js';
import { AudioSystem } from './Audio.js';
import { Progression } from './Progression.js';
import { EventManager, StuntManager, AmbientTraffic, EventBeacons, EVENTS, EVENT_KIND_LABEL } from './Events.js';
import { RoadGraph } from './Navigation.js';
import { Effects } from './Effects.js';

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

const FROZEN_INPUT = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: true });
const QUALITY = {
  ultra: { shadows: 4096, grass: 'high', resolution: 1, reflections: 'dynamic', bloom: true },
  high: { shadows: 2048, grass: 'high', resolution: 1, reflections: 'dynamic', bloom: true },
  medium: { shadows: 1024, grass: 'low', resolution: 0.85, reflections: 'sky', bloom: true },
  low: { shadows: 0, grass: 'off', resolution: 0.75, reflections: 'sky', bloom: false },
};
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
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 20000);

    // ----------------------------------------------------------- Physics
    this.ui.setLoading(0.15, 'Initialising physics…');
    this.physics = new PhysicsWorld();
    const backend = await this.physics.init();
    this.ui.setBackend(backend);

    // ------------------------------------------------------------- World
    const carModels = preloadCarModels();
    installRadianceClamp();
    this.env = new Environment(this.scene, this.physics, r);
    await this.env.build(async (frac, text) => {
      this.ui.setLoading(frac, text);
      await nextFrame();
    });
    this.ui.setLoading(0.8, 'Loading cars from the garage…');
    await Promise.race([carModels, new Promise((res) => setTimeout(res, 8000))]);

    this.input = new InputController();
    this.input.touch = this.ui.touch;
    this.vehicle = new Vehicle(this.scene, this.physics, this.progression.selectedPreset);
    this.vehicle.setPaint(this.progression.selectedPaint);
    this.applyDrivingAids();
    this.vehicle.reset(this.env.startPosition, this.env.startYaw);

    this.effects = new Effects(this.scene);

    this.cameraCtl = new CameraController(this.camera, {
      physics: this.physics,
      heightAt: (x, z) => this.env.heightAt(x, z),
    });
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
    this.spawnTraffic();
    this.beacons = new EventBeacons(this.scene, this.env);
    this.ui.beacons = this.beacons.list;
    this.nav = new RoadGraph(this.env);
    this.waypoint = null;
    this._gpsTimer = 0;
    this.ui.setRedline(this.vehicle.drive.redline);

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
    this.ui.setLoading(0.88, 'Lighting…');
    this.setTime(settings.time);
    this.env.veg.setGrassDensity(settings.grass);

    this.post = createPostProcessing(r, this.scene, this.camera);
    this.post.bloomPass.enabled = settings.bloom;
    this.post.blurEnabled = settings.blur;
    if (settings.shadows !== 2048) this.env.setShadowQuality(settings.shadows);
    this._setupReflections(settings.reflections ?? 'dynamic');
    if (!new URLSearchParams(location.search).has('nothumbs')) {
      this.ui.setLoading(0.9, 'Photographing the events…');
      await nextFrame();
      this.ui.thumbs = this._eventThumbnails();
    }

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
    this.ui.showPrompt(null);
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

  spawnTraffic() {
    const scale = this.progression.settings.traffic ?? 1;
    if (scale > 0) this.traffic.spawn(scale, this.vehicle.root.position);
    else this.traffic.despawn();
    this.traffic.setHeadlights(this.env.lampLevel ?? 0);
  }

  resetCar() {
    const v = this.vehicle;
    const p = v.root.position;
    const env = this.env;
    if (env.inPlaza(p.x, p.z) && !this.events.active) {
      v.reset(env.startPosition, env.startYaw);
    } else if (this.events.active) {
      const route = this.events.route;
      const i = route.nearestIndex(p.x, p.z);
      const pos = route.point(i, 0, new THREE.Vector3());
      pos.y += 1.2;
      v.reset(pos, route.yaw(i));
    } else {
      const n = env.nearestRoad(p.x, p.z, p.y);
      // route height wins on bridges (the ground may be a lake bed below)
      n.point.y = Math.max(n.route ? n.point.y : -1e9, env.heightAt(n.point.x, n.point.z)) + 1.2;
      v.reset(n.point, n.yaw);
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
    this.spawnTraffic();
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
      case 'time-night':
        this.setTime(-12);
        this.ui.toast('Night');
        break;
      case 'travel': {
        if (this.events.active) { this.ui.toast('Finish or quit the event first'); break; }
        const route = this.env.routes[data] || this.env.roads.all.find((r) => r.id === data);
        if (!route) break;
        // sprint roads drop you near the top end (the ski resort, the lake), loops just before the start line
        const i = route._wrap(data === 'summit' ? route.finishIndex - Math.round(30 / route.spacing)
          : route.closed ? route.startIndex - Math.round(40 / route.spacing) : Math.round(route.count * 0.35));
        const pos = route.point(i, data === 'highway' ? -4.4 : route.elevated ? -3.8 : 0, new THREE.Vector3());
        pos.y = (route.bridge && route.bridge[i] ? route.ys[i] : Math.max(route.ys[i], this.env.heightAt(pos.x, pos.z))) + 1.2;
        this.vehicle.reset(pos, route.yaw(i));
        this.cameraCtl.snap(this.vehicle);
        this.stunts.reset();
        this.skills.reset();
        this.spawnTraffic();
        this.closeMenu();
        this.ui.toast(`Fast travel: ${route.name}`);
        break;
      }
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
        this.spawnTraffic();
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
          this.ui.setRedline(this.vehicle.drive.redline);
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
            this.spawnTraffic();
          }
          prog.resetAll();
          this.vehicle.applyPreset(prog.selectedPreset, prog.selectedPaint);
          this.ui.updateProfile(prog);
          this.ui.toast('Progress reset');
        }
        break;
      case 'redraw-map':
        this.ui.drawWorldMap(this.vehicle, this.env, prog, EVENTS);
        break;
      case 'map-waypoint':
        this.setWaypoint({ x: data.x, z: data.z }, null);
        this.ui.showMapInfo(`<div class="map-info__kind">WAYPOINT SET</div><div class="map-info__name">${this.env.regionAt(data.x, data.z)}</div>
          <div class="map-info__sub">${this.ui.gpsPath ? `${this.ui.formatDistance(this.ui.gpsPath.length)} by road` : 'Off-road destination'}</div>
          <button class="btn btn--small btn--ghost" data-action="clear-waypoint">Clear GPS</button>`);
        this.ui.drawWorldMap(this.vehicle, this.env, prog, EVENTS);
        this.audio.click();
        break;
      case 'map-event': {
        const b = this.beacons.list.find((x) => x.ev.id === data);
        if (!b) break;
        const ev = b.ev;
        const rec = prog.data.records[ev.id] || {};
        const best = ev.type === 'race' ? (rec.bestPosition ? `Best finish: ${rec.bestPosition}${['th', 'st', 'nd', 'rd'][rec.bestPosition] || 'th'}` : 'Not raced yet') : rec.bestLap ? `Best lap ${rec.bestLap.toFixed(2)} s` : 'No time set';
        this.ui.showMapInfo(`<div class="map-info__kind" style="color:${b.color}">${EVENT_KIND_LABEL(ev)}</div><div class="map-info__name">${ev.name}</div>
          <div class="map-info__sub">${ev.desc}<br>${best}</div>
          <button class="btn btn--small" data-action="start-event" data-arg="${ev.id}">Start event</button>
          <button class="btn btn--small btn--ghost" data-action="set-route" data-arg="${ev.id}">Set GPS route</button>`);
        this.audio.click();
        break;
      }
      case 'set-route': {
        const b = this.beacons.list.find((x) => x.ev.id === data);
        if (b) { this.setWaypoint({ x: b.pos.x, z: b.pos.z }, b.ev.name); this.ui.toast(`GPS: ${b.ev.name}`); }
        this.ui.drawWorldMap(this.vehicle, this.env, prog, EVENTS);
        break;
      }
      case 'clear-waypoint':
        this.setWaypoint(null);
        this.ui.drawWorldMap(this.vehicle, this.env, prog, EVENTS);
        break;
    }
  }

  /** Driver aids & gearbox from settings → player car. */
  applyDrivingAids() {
    const s = this.progression.settings;
    const v = this.vehicle;
    Object.assign(v.assists, { abs: s.abs, tcs: s.tcs, stm: s.stm, steer: s.steerAssist });
    v.manual = s.transmission === 'manual';
  }

  onSetting(key, value, fromPreset = false) {
    this.progression.setSetting(key, value);
    if (!fromPreset && ['shadows', 'grass', 'resolution', 'reflections', 'bloom'].includes(key) && this.progression.settings.quality !== 'custom') {
      this.progression.setSetting('quality', 'custom');
      this.ui.applySettings(this.progression.settings);
    }
    switch (key) {
      case 'quality':
        this.applyQuality(value);
        break;
      case 'reflections':
        this._setupReflections(value);
        break;
      case 'abs':
      case 'tcs':
      case 'stm':
      case 'steerAssist':
      case 'transmission':
        this.applyDrivingAids();
        break;
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
      case 'grass':
        this.env.veg.setGrassDensity(value);
        break;
      case 'traffic':
        if (!this.events.active) this.spawnTraffic();
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
    const lamps = this.env.lampLevel ?? 0;
    this.effects?.setLight(new THREE.Color(1, 1, 1).multiplyScalar(1 - (this.env.night ?? 0) * 0.8));
    this.vehicle?.setHeadlights(lamps);
    this.traffic?.setHeadlights(lamps);
  }

  /** Small photos of every event's start line for the event cards. */
  _eventThumbnails() {
    const out = {};
    const r = this.renderer;
    const W = 400, H = 225;
    const cam = new THREE.PerspectiveCamera(55, W / H, 0.5, 20000);
    const pr = r.getPixelRatio();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const size = r.getSize(new THREE.Vector2());
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    try {
      for (const ev of EVENTS) {
        const route = this.env.routes[ev.route];
        if (out[ev.route]) continue;
        route.point(route.startIndex - 30 / route.spacing, route.width * 0.25, p);
        route.point(route.startIndex + 60 / route.spacing, 0, q);
        cam.position.set(p.x, p.y + 6.5, p.z);
        cam.lookAt(q.x, q.y + 2, q.z);
        this.env.terrain.update(cam.position);
        this.env.veg.update(0, cam);
        r.setViewport(0, 0, W / pr, H / pr);
        r.render(this.scene, cam);
        ctx.drawImage(r.domElement, 0, r.domElement.height - H, W, H, 0, 0, W, H);
        out[ev.route] = canvas.toDataURL('image/jpeg', 0.82);
      }
    } catch (err) {
      console.warn('[Horizon] Event thumbnails unavailable', err);
    }
    r.setViewport(0, 0, size.x, size.y);
    return out;
  }

  /** Dynamic car reflections: a small cube map around the player's car. */
  _setupReflections(mode) {
    this.reflections = mode;
    const v = this.vehicle;
    if (mode === 'dynamic' && !this.cubeRT) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
      this.cubeCam = new THREE.CubeCamera(1, 1200, this.cubeRT);
      this.scene.add(this.cubeCam);
    }
    const env = mode === 'dynamic' ? this.cubeRT.texture : null;
    v.paintMaterial.envMap = env;
    v.paintMaterial.needsUpdate = true;
    this._cubeFrame = 0;
  }

  _updateReflections() {
    if (this.reflections !== 'dynamic' || !this.cubeCam) return;
    if ((this._cubeFrame++ % 4) !== 0) return;
    const v = this.vehicle;
    const r = this.renderer;
    this.cubeCam.position.copy(v.root.position).y += 1.1;
    const vis = v.root.visible;
    v.root.visible = false;
    v.contactShadow.visible = false;
    const grass = this.env.veg.grass;
    const gv = grass?.visible;
    if (grass) grass.visible = false;
    const auto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    this.cubeCam.update(r, this.scene);
    r.shadowMap.autoUpdate = auto;
    if (grass) grass.visible = gv;
    v.root.visible = vis;
    v.contactShadow.visible = true;
  }

  applyQuality(level) {
    const q = QUALITY[level];
    if (!q) return;
    for (const [k, v] of Object.entries(q)) this.onSetting(k, v, true);
    this.ui.applySettings(this.progression.settings);
  }

  /** GPS: waypoint + road route, recomputed as the player drives. */
  setWaypoint(wp, label) {
    this.waypoint = wp;
    this.waypointLabel = label;
    this._gpsTimer = 0;
    if (!wp) { this.ui.setGps(null, null); return; }
    this._updateGps(true);
  }

  _updateGps(force = false) {
    if (!this.waypoint) return;
    const p = this.vehicle.root.position;
    const d = Math.hypot(p.x - this.waypoint.x, p.z - this.waypoint.z);
    if (d < 30 && !force) {
      this.ui.toast(`Arrived${this.waypointLabel ? `: ${this.waypointLabel}` : ''}`);
      this.setWaypoint(null);
      return;
    }
    const path = this.nav.path(p.x, p.z, this.waypoint.x, this.waypoint.z);
    this.ui.setGps(path, this.waypoint);
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
      for (const a of ['camera', 'reset', 'shiftUp', 'shiftDown', 'interact', 'map']) input.consume(a);
    } else {
      for (const a of ['tabLeft', 'tabRight', 'navUp', 'navDown', 'navLeft', 'navRight', 'confirm', 'back']) input.consume(a);
      if (state !== STATE.GAMEPLAY) for (const a of ['shiftUp', 'shiftDown', 'interact', 'map']) input.consume(a);
      if (state === STATE.GAMEPLAY) {
        if (input.consume('camera')) {
          const name = this.cameraCtl.cycleChaseMode();
          this.ui.setCameraLabel(name);
          this.ui.toast(`Camera: ${name}`);
        }
        if (input.consume('reset') && !this.events.freezePlayer) this.resetCar();
        if (input.consume('shiftUp') && this.vehicle.manual) this.vehicle.shift(1);
        if (input.consume('shiftDown') && this.vehicle.manual) this.vehicle.shift(-1);
        const near = this._nearBeacon;
        if (input.consume('interact') && near) this.startEvent(near.ev.id);
        if (input.consume('map')) { this.openMenu(); this.ui.switchTab('map'); }
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

    // tyre smoke, dust and skid marks for the player and nearby cars
    const fxCars = this._fxCars || (this._fxCars = []);
    fxCars.length = 0;
    fxCars.push(v);
    const addNear = (c) => { if (c !== v && c.root.position.distanceToSquared(v.root.position) < 140 * 140) fxCars.push(c); };
    for (const r of this.events.racers) addNear(r.vehicle);
    for (const c of this.traffic.cars) addNear(c.vehicle);
    this.effects.setPixelScale(this.renderer.domElement.height, this.camera.fov);
    this.effects.update(simulate ? dt : 0, simulate ? fxCars : []);

    if (v.backfireEvent) {
      v.backfireEvent = false;
      if (this.state === STATE.GAMEPLAY) { this.effects.backfire(v); this.audio.backfire(); }
    }

    if (v.impactEvent > 0) {
      if (v.impactEvent > 6) this.effects.sparks(v.root.position, v.forward, v.impactEvent);
      this.cameraCtl.impact(Math.min(1, v.impactEvent / 12));
      this.audio.impact(v.impactEvent);
      if (this.state === STATE.GAMEPLAY) this.skills.crash(v.impactEvent);
      v.impactEvent = 0;
    }

    // Drove into deep water → splash, then back onto the nearest road
    if (this.state === STATE.GAMEPLAY) {
      const p = v.root.position;
      const depth = this.env.waterDepthAt(p.x, p.y + 0.3, p.z);
      this._wetTime = depth > 0.8 ? (this._wetTime || 0) + dt : 0;
      if (this._wetTime > 0.7) {
        this._wetTime = 0;
        this.resetCar();
        this.ui.toast('Splash! Back to the road');
        this.skills.crash(10);
      }
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
      if (this.frame % 30 === 0) {
        const p = v.root.position;
        this.ui.setRegion(this.env.regionAt(p.x, p.z));
      }
      if (this.frame % 2 === 0) {
        this.ui.drawMinimap(v, this.env, this.events.markers() ?? { cars: this.traffic.positions(), checkpoint: null, freeRoam: true });
      }
      // event beacons: prompt when parked inside one
      this._nearBeacon = !this.events.active && v.speedAbs < 12 ? this.beacons.near(v.root.position) : null;
      this.ui.showPrompt(this._nearBeacon, this.input.usingGamepad);
      this._gpsTimer -= dt;
      if (this.waypoint && this._gpsTimer <= 0) { this._gpsTimer = 0.6; this._updateGps(); }
    }
    this.audio.update(v, this.state === STATE.GAMEPLAY);

    // ---- Periodic save (distance / stats)
    this._saveTimer += dt;
    if (this._saveTimer > 20) {
      this._saveTimer = 0;
      this.progression.save();
    }


    // ---- Render
    this.beacons.setVisible(!this.events.active);
    this.beacons.update(dt);
    this._updateReflections();
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
