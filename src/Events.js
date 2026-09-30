import * as THREE from 'three';
import { Vehicle, CAR_PRESETS, tunePreset } from './Vehicle.js';
import { AIDriver } from './AIDriver.js';

/**
 * Events.js
 * ---------
 *  - EventManager: circuit races vs AI and solo time trials on any route
 *    (countdown, checkpoints, laps, positions, wrong-way, results + rewards).
 *  - StuntManager: free-roam PR stunts — speed traps, speed zones, drift
 *    zones and danger-sign jumps — with 1-3 star ratings and saved records.
 *  - AmbientTraffic: "Drivatars" cruising the world's roads in free roam.
 */

export const EVENTS = [
  {
    id: 'sakura-circuit', type: 'race', route: 'festival', name: 'Sakura Circuit', laps: 3, ai: 5,
    desc: 'Festival Loop · 3 laps', payout: [30000, 18000, 12000, 7000, 4500, 3000], xp: [3000, 2200, 1700, 1300, 1000, 800],
  },
  {
    id: 'c1-loop', type: 'race', route: 'c1', name: 'C1 Loop', laps: 3, ai: 5, kind: 'EXPRESSWAY RACE',
    desc: 'Elevated loop over Tokyo · 3 laps', payout: [55000, 33000, 20000, 12000, 7500, 5000], xp: [4800, 3500, 2600, 1900, 1400, 1000],
  },
  {
    id: 'neon-city', type: 'race', route: 'city', name: 'Tokyo Downtown Race', laps: 2, ai: 5, kind: 'STREET RACE',
    desc: 'Shibuya, Ginkgo Avenue, the docks · 2 laps', payout: [40000, 24000, 15000, 9000, 6000, 4000], xp: [3600, 2600, 2000, 1500, 1100, 900],
  },
  {
    id: 'fuji-pass', type: 'race', route: 'mountain', name: 'Ohtani Pass', laps: 2, ai: 5, kind: 'MOUNTAIN RACE',
    desc: 'Hill road above the festival · 2 laps', payout: [45000, 27000, 17000, 10000, 6500, 4500], xp: [4000, 2900, 2200, 1600, 1200, 900],
  },
  {
    id: 'horizon-highway', type: 'race', route: 'highway', name: 'Horizon Expressway', laps: 1, ai: 5, kind: 'HIGHWAY RACE',
    desc: '13 km loop through every region', payout: [60000, 36000, 22000, 13000, 8000, 5000], xp: [5000, 3600, 2700, 2000, 1500, 1100],
  },
  {
    id: 'festival-sprint', type: 'race', route: 'festival', name: 'Festival Sprint', laps: 1, ai: 5,
    desc: 'Festival Loop · 1 lap', payout: [12000, 8000, 6000, 4000, 2500, 1500], xp: [1500, 1100, 900, 700, 500, 400],
  },
  {
    id: 'legend-island', type: 'race', route: 'island', name: 'Legend Island Circuit', laps: 3, ai: 5, kind: 'ROAD RACE',
    desc: 'Around the island · 3 laps', payout: [50000, 30000, 19000, 11000, 7000, 4800], xp: [4500, 3300, 2500, 1800, 1300, 1000],
  },
  {
    id: 'coastal-circuit', type: 'race', route: 'coast', name: 'Ito Coast Sprint', laps: 1, ai: 5, kind: 'SPRINT',
    desc: 'Tokyo to Nangan along the cliffs · 6 km', payout: [70000, 42000, 26000, 15000, 9000, 6000], xp: [6000, 4300, 3200, 2400, 1800, 1300],
  },
  {
    id: 'lakeside-loop', type: 'race', route: 'lake', name: 'Lake Haruna Loop', laps: 2, ai: 5, kind: 'ROAD RACE',
    desc: 'Crater lake in Shimanoyama · 2 laps', payout: [38000, 23000, 14000, 8500, 5500, 3800], xp: [3400, 2500, 1900, 1400, 1100, 800],
  },
  {
    id: 'haruna-touge', type: 'race', route: 'touge', name: 'Haruna Touge', laps: 1, ai: 5, kind: 'SPRINT',
    desc: 'Uphill hairpins to the lake', payout: [42000, 25000, 16000, 9500, 6000, 4200], xp: [3900, 2800, 2100, 1600, 1200, 900],
  },
  {
    id: 'summit-sprint', type: 'race', route: 'summit', name: 'Sotoyama Skyline', laps: 1, ai: 5, kind: 'SPRINT',
    desc: 'Hill climb to the ski resort', payout: [50000, 30000, 19000, 11000, 7000, 4800], xp: [4500, 3300, 2500, 1800, 1300, 1000],
  },
  {
    id: 'kiso-rally', type: 'race', route: 'rally', name: 'Nangan Forest Rally', laps: 2, ai: 5, kind: 'DIRT RACE',
    desc: 'Gravel trail through the pines · 2 laps', payout: [48000, 29000, 18000, 10500, 6800, 4600], xp: [4300, 3100, 2400, 1700, 1300, 950],
  },
  {
    id: 'minato-streets', type: 'race', route: 'ito', name: 'Ito Harbour GP', laps: 3, ai: 5, kind: 'STREET RACE',
    desc: 'Tight harbour streets · 3 laps', payout: [36000, 22000, 13500, 8000, 5200, 3600], xp: [3300, 2400, 1800, 1300, 1000, 750],
  },
  {
    id: 'airfield-drag', type: 'race', route: 'docks', name: 'Dockyard Drag', laps: 1, ai: 3, kind: 'DRAG RACE',
    desc: 'Flat out along the Tokyo quay · 1.3 km', payout: [15000, 9000, 6000, 3500], xp: [1500, 1100, 800, 600],
  },
  {
    id: 'time-trial', type: 'trial', route: 'festival', name: 'Hanami Time Trial', laps: 2, ai: 0,
    desc: 'Best lap counts', stars: [62, 52, 46], payout: [4000, 9000, 16000], xp: [800, 1500, 2500],
  },
  {
    id: 'city-attack', type: 'trial', route: 'city', name: 'Tokyo Time Attack', laps: 2, ai: 0,
    desc: 'Best lap counts', stars: [150, 130, 118], payout: [5000, 11000, 20000], xp: [900, 1700, 2800],
  },
  {
    id: 'c1-trial', type: 'trial', route: 'c1', name: 'C1 Time Attack', laps: 2, ai: 0,
    desc: 'Best lap counts', stars: [120, 104, 96], payout: [5000, 11000, 20000], xp: [900, 1700, 2800],
  },
  {
    id: 'lake-trial', type: 'trial', route: 'lake', name: 'Haruna Lake Time Trial', laps: 2, ai: 0,
    desc: 'Best lap counts', stars: [150, 128, 116], payout: [5000, 11000, 20000], xp: [900, 1700, 2800],
  },
];

const DIFFICULTY = { easy: 0.86, normal: 0.95, hard: 1.03, unbeatable: 1.1 };
const AI_UPGRADES = {
  easy: { engine: 0, grip: 0, brakes: 0 },
  normal: { engine: 1, grip: 0, brakes: 1 },
  hard: { engine: 1, grip: 1, brakes: 1 },
  unbeatable: { engine: 2, grip: 2, brakes: 2 },
};
const RIVAL_NAMES = ['Kenji', 'Aiko', 'Marco', 'Lena', 'Diego', 'Yuki', 'Sven', 'Priya'];
const RIVAL_COLORS = ['#e0162b', '#27c485', '#ffd23f', '#8b5cff', '#1b1d22', '#ff7a1a', '#1f6feb', '#f4f4f4'];
const CP_COUNT = 10;

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

export const EVENT_KIND_LABEL = (ev) => ev.kind ?? (ev.type === 'trial' ? 'TIME TRIAL'
  : ev.route === 'city' ? 'STREET RACE' : ev.route === 'highway' ? 'HIGHWAY RACE' : ev.route === 'mountain' ? 'MOUNTAIN RACE' : 'ROAD RACE');
export const EVENT_COLOR = (ev) => (ev.type === 'trial' ? '#2de2ff' : ev.kind === 'SPRINT' ? '#ffd23f' : ev.kind === 'DRAG RACE' ? '#ff8a2d' : ev.kind === 'DIRT RACE' ? '#b6ff3b' : ev.kind === 'EXPRESSWAY RACE' ? '#8b5cff' : '#ff2d8f');

// ============================================================================
// Event beacons: light columns at every event start you can drive into
// ============================================================================
export class EventBeacons {
  constructor(scene, env) {
    this.scene = scene;
    this.env = env;
    this.time = 0;
    this.list = [];
    const byRoute = new Map();
    for (const ev of EVENTS) {
      const r = env.routes[ev.route];
      const k = byRoute.get(r) || 0;
      byRoute.set(r, k + 1);
      // alongside the road just before the start line, spaced out if several share a route
      let p;
      if (r.elevated) {
        // expressway events start from beside the deck, up on the viaduct
        const i = r._wrap(Math.round(r.startIndex - (18 + k * 16) / r.spacing));
        p = r.point(i, 0, new THREE.Vector3());
        p.y = r.ys[i];
      } else {
        const i = r._wrap(Math.round(r.startIndex - (18 + k * 16) / r.spacing));
        const side = r.flat && r.render === false ? 0.5 : 1;
        p = r.point(i, -(r.width / 2 + 5) * side, new THREE.Vector3());
        p.y = r.flat ? (r.flatY ?? 0) : env.heightAt(p.x, p.z);
        if (r.bridge && r.bridge[i]) p.y = r.ys[i];
      }
      this.list.push({ ev, pos: p, color: EVENT_COLOR(ev) });
    }
    this._build();
  }

  _build() {
    const beamGeo = new THREE.CylinderGeometry(2.4, 2.4, 70, 24, 1, true).translate(0, 35, 0);
    const ringGeo = new THREE.RingGeometry(3.2, 4.4, 40).rotateX(-Math.PI / 2);
    this.uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } };
    for (const b of this.list) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { ...this.uniforms, uColor: { value: new THREE.Color(b.color) } },
        vertexShader: /* glsl */ `
          varying float vH; varying vec3 vN; varying vec3 vView;
          void main() {
            vH = position.y / 70.0;
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime;
          varying float vH; varying vec3 vN; varying vec3 vView;
          void main() {
            float rim = 1.0 - abs(dot(vN, vView));
            float a = pow(rim, 1.5) * (1.0 - vH) * (0.55 + 0.45 * sin(vH * 30.0 - uTime * 3.0));
            gl_FragColor = vec4(uColor * a * 1.6, a);
          }`,
      });
      const beam = new THREE.Mesh(beamGeo, mat);
      beam.position.copy(b.pos);
      beam.frustumCulled = false;
      beam.renderOrder = 7;
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.position.copy(b.pos).y += 0.12;
      this.scene.add(beam, ring);
      b.beam = beam;
      b.ring = ring;
    }
  }

  setVisible(on) {
    for (const b of this.list) { b.beam.visible = on; b.ring.visible = on; }
  }

  /** Nearest beacon within `range` metres of p, or null. */
  near(p, range = 16) {
    let best = null, bd = range * range;
    for (const b of this.list) {
      const d = (b.pos.x - p.x) ** 2 + (b.pos.z - p.z) ** 2;
      if (d < bd && Math.abs(b.pos.y - p.y) < 8) { bd = d; best = b; }
    }
    return best;
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const s = 1 + Math.sin(this.time * 3) * 0.08;
    for (const b of this.list) b.ring.scale.setScalar(s);
  }
}

export function formatTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ============================================================================
// Race / Time trial
// ============================================================================
export class EventManager {
  /** @param {object} ctx { scene, physics, env, player, ui, audio, progression } */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.state = 'idle'; // idle | countdown | running | finished
    this.def = null;
    this.route = null;
    this.racers = [];
    this.time = 0;
    this.countdown = 0;
    this.wrongWayTime = 0;
  }

  get active() { return this.state !== 'idle'; }
  get freezePlayer() { return this.state === 'countdown'; }

  start(def) {
    this.cleanup();
    const env = this.env;
    const route = env.routes[def.route];
    this.route = route;
    const n = route.count;
    this.def = def;
    this.sprint = !route.closed;
    if (this.sprint) {
      // point-to-point: gates spread from the start line to the finish line
      const a = route.startIndex, b = route.finishIndex ?? route.count - 1;
      this.cpIndices = Array.from({ length: CP_COUNT }, (_, k) => Math.round(a + ((k + 1) * (b - a)) / CP_COUNT));
    } else {
      this.cpIndices = Array.from({ length: CP_COUNT }, (_, k) => (route.startIndex + Math.round((k * n) / CP_COUNT)) % n);
    }
    env.showCheckpoints(route, this.cpIndices);

    const skill = DIFFICULTY[this.progression.settings.difficulty] ?? 0.95;
    const pp = this.player.preset;
    const racers = [];
    const pool = CAR_PRESETS.filter((c) => c.topSpeed <= pp.topSpeed * 1.12 && c.topSpeed >= pp.topSpeed * 0.8);
    const cars = pool.length ? pool : CAR_PRESETS;
    const laneW = Math.min(4, route.width / 2 - 2.2);
    for (let i = 0; i < def.ai; i++) {
      const base = cars[i % cars.length];
      const ups = AI_UPGRADES[this.progression.settings.difficulty] ?? AI_UPGRADES.normal;
      const v = new Vehicle(this.scene, this.physics, tunePreset(base, ups), { loadModel: false, name: base.name });
      v.setPaint(RIVAL_COLORS[i % RIVAL_COLORS.length]);
      v.setHeadlights(env.lampLevel ?? 0);
      const yaw = route.gridSlot(i, _v);
      v.reset(_v, yaw);
      const driver = new AIDriver(route, {
        skill: skill * (0.94 + (i / Math.max(1, def.ai - 1)) * 0.08) * (1 - i * 0.004),
        lane: (i % 2 === 0 ? 1 : -1) * laneW * 0.6,
        name: RIVAL_NAMES[i],
      });
      racers.push(this._racer(v, driver, RIVAL_NAMES[i]));
    }
    const pyaw = route.gridSlot(def.ai, _v);
    this.player.reset(_v, pyaw);
    racers.push(this._racer(this.player, null, 'You'));
    this.racers = racers;
    this.playerRacer = racers[racers.length - 1];

    this.time = 0;
    this.countdown = 3.999;
    this._lastCount = 4;
    this.state = 'countdown';
    this.wrongWayTime = 0;
    this.ui.showRaceHUD(true, def);
    env.setActiveCheckpoint(0, !this.sprint && def.laps === 1);
  }

  _racer(vehicle, driver, name) {
    return {
      vehicle, driver, name,
      idx: -1, rel: 0, prevRel: 0, lap: 0, nextCp: 0,
      progress: 0, finished: false, finishTime: null, lapStart: 0, bestLap: null, lastLap: null,
    };
  }

  cleanup() {
    for (const r of this.racers) if (r.driver) r.vehicle.dispose();
    this.racers = [];
    this.env.hideCheckpoints();
    this.state = 'idle';
    this.def = null;
    this.route = null;
    this.ui.showRaceHUD(false);
    this.ui.wrongWay(false);
  }

  quit() {
    if (!this.active) return;
    this.cleanup();
    this.ui.toast('Event abandoned');
  }

  fixedUpdate(dt) {
    if (!this.active) return;
    const vehicles = this.racers.map((r) => r.vehicle);
    for (const r of this.racers) {
      if (!r.driver) continue;
      r.driver.enabled = this.state === 'running' || this.state === 'finished';
      const others = vehicles.filter((v) => v !== r.vehicle);
      r.vehicle.fixedUpdate(dt, r.driver.update(dt, r.vehicle, others));
    }
  }

  updateVisuals(dt, alpha) {
    for (const r of this.racers) if (r.driver) r.vehicle.update(dt, alpha);
  }

  update(dt) {
    if (!this.active) return;
    const env = this.env;
    const route = this.route;
    const n = route.count;

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const c = Math.ceil(this.countdown);
      if (c !== this._lastCount) {
        this._lastCount = c;
        if (c > 0) { this.ui.countdown(String(c)); this.audio.countdown(false); }
        else { this.ui.countdown('GO!'); this.audio.countdown(true); }
      }
      if (this.countdown <= 0) {
        this.state = 'running';
        for (const r of this.racers) r.lapStart = 0;
      }
    }
    if (this.state === 'running' || this.state === 'finished') this.time += dt;

    // --- Progress tracking
    if (this.sprint) this._updateSprint(dt);
    else for (const r of this.racers) {
      const p = r.vehicle.root.position;
      r.idx = route.nearestIndex(p.x, p.z, r.idx);
      r.prevRel = r.rel;
      r.rel = (r.idx - route.startIndex + n) % n;
      if (r.finished || this.state === 'countdown') {
        r.progress = r.finished ? 1e9 - r.finishTime : r.rel - n;
        continue;
      }
      const crossedLine = r.prevRel > n * 0.75 && r.rel < n * 0.25;
      if (r.nextCp === 0) {
        if (crossedLine) this._crossLine(r);
      } else {
        const cpRel = Math.round((r.nextCp * n) / CP_COUNT);
        if (r.rel >= cpRel && r.rel < cpRel + n / CP_COUNT / 2) {
          r.nextCp = (r.nextCp + 1) % CP_COUNT;
          if (!r.driver) {
            this.audio.checkpoint();
            env.setActiveCheckpoint(r.nextCp, r.nextCp === 0 && r.lap === this.def.laps);
          }
        }
      }
      r.progress = r.lap === 0 ? r.rel - n : (r.lap - 1) * n + r.rel;
    }

    const order = [...this.racers].sort((a, b) => b.progress - a.progress);
    order.forEach((r, i) => (r.position = i + 1));

    // --- Rubber banding
    const pp = this.playerRacer.progress;
    for (const r of this.racers) {
      if (!r.driver) continue;
      const gap = (r.progress - pp) * route.spacing;
      r.driver.rubber = THREE.MathUtils.clamp(1 - gap / 1500, 0.9, 1.06);
    }

    // --- Wrong way
    const pr = this.playerRacer;
    if (this.state === 'running' && !pr.finished) {
      route.tangent(pr.idx, _t);
      const wrong = this.player.forward.x * _t.x + this.player.forward.z * _t.z < -0.35 && this.player.speedAbs > 4;
      this.wrongWayTime = wrong ? this.wrongWayTime + dt : 0;
      this.ui.wrongWay(this.wrongWayTime > 0.8);
    } else this.ui.wrongWay(false);

    // live leaderboard (gap to the leader in seconds at the leader's pace)
    let board = null;
    if (this.def.type === 'race' && (this._boardT = (this._boardT || 0) - dt) <= 0) {
      this._boardT = 0.25;
      const leader = order[0];
      const pace = Math.max(12, leader.vehicle.speedAbs);
      board = order.map((r, i) => ({
        pos: i + 1, name: r.driver ? r.name : 'YOU', player: !r.driver,
        gap: r.finished ? 'FIN' : i === 0 ? (leader.finished ? 'FIN' : 'LEAD') : leader.finished ? '' : `+${(((leader.progress - r.progress) * route.spacing) / pace).toFixed(1)}s`,
      }));
    }
    const fin = route.finishIndex ?? route.count - 1;
    this.ui.updateRaceHUD({
      board,
      sprint: this.sprint,
      progress: this.sprint ? Math.max(0, Math.min(1, pr.rel / Math.max(1, fin - route.startIndex))) : 0,
      type: this.def.type,
      position: pr.position,
      total: this.racers.length,
      lap: Math.max(1, Math.min(pr.lap, this.def.laps)),
      laps: this.def.laps,
      time: this.time,
      lapTime: this.state === 'running' ? this.time - pr.lapStart : 0,
      bestLap: pr.bestLap,
      record: this.progression.record(this.def.id).bestLap ?? null,
    });
  }

  /** Point-to-point progress: gates in order, finish at route.finishIndex. */
  _updateSprint() {
    const route = this.route;
    const fin = route.finishIndex ?? route.count - 1;
    for (const r of this.racers) {
      const p = r.vehicle.root.position;
      r.idx = route.nearestIndex(p.x, p.z, r.idx);
      r.rel = r.idx - route.startIndex;
      if (r.finished) { r.progress = 1e9 - r.finishTime; continue; }
      if (this.state === 'countdown') { r.progress = r.rel; continue; }
      if (r.lap === 0) { r.lap = 1; r.lapStart = 0; r.nextCp = 0; }
      const cp = this.cpIndices[r.nextCp];
      if (cp != null && r.idx >= cp && r.idx < cp + 40) {
        if (r.nextCp === CP_COUNT - 1 || r.idx >= fin) {
          r.finished = true;
          r.finishTime = this.time;
          r.bestLap = this.time;
          if (!r.driver) this._playerFinished();
        } else {
          r.nextCp++;
          if (!r.driver) {
            this.audio.checkpoint();
            this.env.setActiveCheckpoint(r.nextCp, r.nextCp === CP_COUNT - 1);
          }
        }
      }
      r.progress = r.rel;
    }
  }

  _crossLine(r) {
    const def = this.def;
    const isPlayer = !r.driver;
    if (r.lap === 0) {
      r.lap = 1;
      r.lapStart = this.time;
    } else {
      const lapTime = this.time - r.lapStart;
      r.lastLap = lapTime;
      r.bestLap = r.bestLap == null ? lapTime : Math.min(r.bestLap, lapTime);
      r.lapStart = this.time;
      if (isPlayer) this.ui.showSkill(`LAP ${r.lap}  ${formatTime(lapTime)}`, null, 'cyan');
      if (r.lap >= def.laps) {
        r.finished = true;
        r.finishTime = this.time;
        if (isPlayer) this._playerFinished();
        return;
      }
      r.lap++;
    }
    r.nextCp = 1;
    if (isPlayer) {
      this.audio.checkpoint();
      this.env.setActiveCheckpoint(1, false);
    }
  }

  _playerFinished() {
    const def = this.def;
    const pr = this.playerRacer;
    this.state = 'finished';
    this.env.hideCheckpoints();

    const n = this.route.count;
    const total = this.sprint ? (this.route.finishIndex ?? n - 1) - this.route.startIndex : def.laps * n;
    for (const r of this.racers) {
      if (r.finished) continue;
      const done = Math.max(1, r.progress);
      const avg = done / Math.max(1, this.time);
      r.finishTime = this.time + (total - done) / Math.max(avg, 1);
    }
    const order = [...this.racers].sort((a, b) => a.finishTime - b.finishTime);
    const position = order.indexOf(pr) + 1;

    const rec = this.progression.record(def.id);
    const prevBestLap = rec.bestLap;
    const prevBestTime = rec.bestTime;
    rec.bestLap = rec.bestLap == null ? pr.bestLap : Math.min(rec.bestLap, pr.bestLap);
    rec.bestTime = rec.bestTime == null ? pr.finishTime : Math.min(rec.bestTime, pr.finishTime);

    let credits, xp, stars = 0, title;
    if (def.type === 'race') {
      credits = def.payout[position - 1] ?? 1000;
      xp = def.xp[position - 1] ?? 300;
      rec.bestPosition = Math.min(rec.bestPosition ?? 99, position);
      if (position === 1) { rec.wins = (rec.wins || 0) + 1; this.progression.stat('racesWon', 1, 'add'); }
      title = position === 1 ? 'VICTORY!' : `${ordinal(position)} PLACE`;
    } else {
      stars = def.stars.filter((s) => pr.bestLap <= s).length;
      credits = stars ? def.payout[stars - 1] : 1000;
      xp = stars ? def.xp[stars - 1] : 300;
      rec.stars = Math.max(rec.stars || 0, stars);
      title = stars === 3 ? 'GOLD TIME!' : stars === 2 ? 'SILVER TIME' : stars === 1 ? 'BRONZE TIME' : 'TRIAL COMPLETE';
    }
    const diffMult = { easy: 0.7, normal: 1, hard: 1.3, unbeatable: 1.7 }[this.progression.settings.difficulty] ?? 1;
    if (def.type === 'race') credits = Math.round(credits * diffMult);
    this.progression.addCredits(credits, def.name);
    this.progression.addXP(xp);
    this.progression.save();
    this.audio.bank();

    this.ui.showResults({
      title, event: def, position, stars, credits, xp,
      bestLap: pr.bestLap,
      totalTime: pr.finishTime,
      newLapRecord: prevBestLap == null || pr.bestLap < prevBestLap,
      newTimeRecord: prevBestTime == null || pr.finishTime < prevBestTime,
      table: def.type === 'race'
        ? order.map((r, i) => ({ pos: i + 1, name: r.name, car: r.vehicle.name, time: r.finishTime, player: !r.driver }))
        : null,
    });
  }

  markers() {
    if (!this.active) return null;
    const cars = [];
    for (const r of this.racers) if (r.driver) cars.push(r.vehicle.root.position);
    let checkpoint = null;
    if (this.state !== 'finished') {
      const i = this.cpIndices[this.playerRacer.nextCp];
      checkpoint = { x: this.route.xs[i], z: this.route.zs[i] };
    }
    return { cars, checkpoint, route: this.route };
  }
}

// ============================================================================
// PR stunts (free roam)
// ============================================================================
export class StuntManager {
  constructor({ env, player, ui, audio, progression }) {
    this.env = env;
    this.player = player;
    this.ui = ui;
    this.audio = audio;
    this.progression = progression;
    this.track = new Map(); // route → { idx, prevIdx }
    this.activeZone = null;
    this.jump = null;
    this.enabled = true;
  }

  reset() {
    this.track.clear();
    this._cancelZone();
    this.jump = null;
  }

  _cancelZone() {
    if (this.activeZone) this.ui.zoneMeter(null);
    this.activeZone = null;
  }

  /** true if moving forward along `route` from sample a to b crosses sample i */
  _crossed(route, a, b, i) {
    const n = route.count;
    if (a < 0) return false;
    const fwd = (b - a + n) % n;
    if (fwd === 0 || fwd > 30) return false;
    const off = (i - a + n) % n;
    return off > 0 && off <= fwd;
  }

  update(dt) {
    if (!this.enabled) return;
    const env = this.env;
    const v = this.player;
    const p = v.root.position;
    const mph = this.progression.settings.units === 'mph';
    const speedConv = mph ? 2.23694 : 3.6;
    const unit = mph ? 'MPH' : 'KM/H';

    // track the player's position along every route that has stunts (cheap windowed search)
    for (const st of env.stunts) {
      if (!st.route || this.track.has(st.route)) continue;
      this.track.set(st.route, { idx: -1, prevIdx: -1, onRoad: false });
    }
    for (const [route, t] of this.track) {
      t.prevIdx = t.idx;
      t.idx = route.nearestIndex(p.x, p.z, t.idx);
      route.point(t.idx, 0, _t);
      t.onRoad = Math.hypot(_t.x - p.x, _t.z - p.z) < route.width / 2 + 9;
    }

    for (const st of env.stunts) {
      if (st.type === 'jump') continue;
      const t = this.track.get(st.route);
      if (!t.onRoad || !this._crossed(st.route, t.prevIdx, t.idx, st.index)) continue;
      if (st.type === 'trap') {
        const val = v.speedAbs * 2.23694;
        this._result(st, val, `${Math.round(val * (speedConv / 2.23694))} ${unit}`);
      } else if (!this.activeZone) {
        this.activeZone = { st, time: 0, dist: 0, drift: 0 };
      }
    }

    const z = this.activeZone;
    if (z) {
      const t = this.track.get(z.st.route);
      z.time += dt;
      z.dist += v.speedAbs * dt;
      if (z.st.type === 'drift' && v.isDrifting) z.drift += Math.abs(v.driftAngle) * 57.3 * v.speedAbs * dt * 0.9;
      if (!t.onRoad || z.time > 120) {
        this.ui.showSkill(`${z.st.name.toUpperCase()} FAILED`, null, 'fail');
        this._cancelZone();
      } else if (this._crossed(z.st.route, t.prevIdx, t.idx, z.st.end)) {
        if (z.st.type === 'zone') {
          const avg = (z.dist / z.time) * 2.23694;
          this._result(z.st, avg, `${Math.round(avg * (speedConv / 2.23694))} ${unit} avg`);
        } else {
          this._result(z.st, z.drift, `${Math.round(z.drift).toLocaleString()} pts`);
        }
        this._cancelZone();
      } else {
        const live = z.st.type === 'zone'
          ? `${Math.round((z.dist / Math.max(z.time, 0.1)) * speedConv)} ${unit}`
          : `${Math.round(z.drift).toLocaleString()} pts`;
        this.ui.zoneMeter(z.st.name, live, this._stars(z.st, z.st.type === 'zone' ? (z.dist / Math.max(z.time, 0.1)) * 2.23694 : z.drift));
      }
    }

    for (const st of env.stunts) {
      if (st.type !== 'jump') continue;
      const r = st.ramp;
      const dx = p.x - r.x, dz = p.z - r.z;
      const lx = Math.cos(r.yaw) * dx - Math.sin(r.yaw) * dz;
      const lz = Math.sin(r.yaw) * dx + Math.cos(r.yaw) * dz;
      if (!this.jump && Math.abs(lx) < r.width / 2 + 1 && lz > r.length - 3 && lz < r.length + 6 && v.grounded < 4 && v.speedAbs > 8) {
        this.jump = { st, x: p.x, z: p.z, air: false, t: 0 };
      }
    }
    if (this.jump) {
      const j = this.jump;
      j.t += dt;
      if (v.grounded === 0) j.air = true;
      if (j.air && v.grounded >= 2) {
        const dist = Math.hypot(p.x - j.x, p.z - j.z);
        this._result(j.st, dist, mph ? `${Math.round(dist * 3.281)} FT` : `${Math.round(dist)} M`);
        this.jump = null;
      } else if (j.t > 6 || (!j.air && j.t > 1)) {
        this.jump = null;
      }
    }
  }

  _stars(st, value) {
    return st.stars.filter((s) => value >= s).length;
  }

  _result(st, value, label) {
    const stars = this._stars(st, value);
    const res = this.progression.submitStunt(st.id, value, stars, true);
    const reward = res.newStars * 2500;
    if (reward) {
      this.progression.addCredits(reward, st.name);
      this.progression.addXP(res.newStars * 400);
    }
    this.ui.stuntBanner(st, label, stars, res.improved && res.previous != null, reward);
    this.audio.stunt(stars);
  }
}

// ============================================================================
// Free-roam traffic
// ============================================================================
const TRAFFIC_PLAN = [
  { route: 'highway', count: 4, skill: 0.8, lane: 4.4, cap: 36 },
  { route: 'c1', count: 3, skill: 0.78, lane: 3.8, cap: 30 },
  { route: 'city', count: 3, skill: 0.62, lane: 3.2, cap: 17 },
  { route: 'festival', count: 1, skill: 0.72, lane: 3, cap: 26 },
  { route: 'mountain', count: 1, skill: 0.7, lane: 2.3, cap: 24 },
  { route: 'lake', count: 1, skill: 0.7, lane: 2.7, cap: 24 },
  { route: 'ito', count: 2, skill: 0.6, lane: 3, cap: 14 },
  { route: 'island', count: 1, skill: 0.7, lane: 3, cap: 24 },
];

export class AmbientTraffic {
  constructor({ scene, physics, env }) {
    this.scene = scene;
    this.physics = physics;
    this.env = env;
    this.cars = [];
  }

  get active() { return this.cars.length > 0; }

  spawn(scale = 1, avoid = null) {
    this.despawn();
    const env = this.env;
    let k = 0;
    for (const plan of TRAFFIC_PLAN) {
      const route = env.routes[plan.route];
      const count = Math.max(0, Math.round(plan.count * scale));
      for (let i = 0; i < count; i++, k++) {
        const base = CAR_PRESETS[(k * 2 + 1) % CAR_PRESETS.length];
        const v = new Vehicle(this.scene, this.physics, base, { loadModel: false, name: base.name });
        v.setPaint(RIVAL_COLORS[(k + 3) % RIVAL_COLORS.length]);
        let idx = Math.round(((i + 0.37) / count) * route.count);
        if (avoid) {
          const pi = route.nearestIndex(avoid.x, avoid.z);
          const n = route.count;
          const d = Math.abs(((idx - pi + n + n / 2) % n) - n / 2) * route.spacing;
          if (d < 120 && route.lastDistanceSq < 200 * 200) idx = (idx + Math.round(200 / route.spacing)) % n;
        }
        const lane = (i % 2 === 0 ? 1 : -1) * plan.lane;
        route.point(idx, lane, _v);
        _v.y += 1.0;
        v.reset(_v, route.yaw(idx));
        const driver = new AIDriver(route, { skill: plan.skill + (k % 3) * 0.03, lane, name: base.name });
        driver.enabled = true;
        this.cars.push({ vehicle: v, driver, cap: plan.cap });
      }
    }
  }

  despawn() {
    for (const c of this.cars) c.vehicle.dispose();
    this.cars = [];
  }

  fixedUpdate(dt, player) {
    if (!this.cars.length) return;
    const all = this.cars.map((c) => c.vehicle).concat(player);
    for (const c of this.cars) {
      const others = all.filter((v) => v !== c.vehicle);
      const inp = c.driver.update(dt, c.vehicle, others);
      if (c.vehicle.speed > c.cap) inp.throttle = Math.min(inp.throttle, 0.2);
      c.vehicle.fixedUpdate(dt, inp);
    }
  }

  updateVisuals(dt, alpha) {
    for (const c of this.cars) c.vehicle.update(dt, alpha);
  }

  setHeadlights(level) {
    for (const c of this.cars) c.vehicle.setHeadlights(level);
  }

  positions() {
    return this.cars.map((c) => c.vehicle.root.position);
  }
}
