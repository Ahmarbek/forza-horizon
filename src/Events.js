import * as THREE from 'three';
import { Vehicle, CAR_PRESETS, tunePreset } from './Vehicle.js';
import { AIDriver } from './AIDriver.js';

/**
 * Events.js
 * ---------
 *  - EventManager: circuit races vs AI and solo time trials (countdown,
 *    checkpoints, laps, positions, wrong-way, results + rewards).
 *  - StuntManager: free-roam PR stunts — speed traps, speed zones, drift
 *    zones and danger-sign jumps — with 1-3 star ratings and saved records.
 */

export const EVENTS = [
  {
    id: 'sakura-circuit', type: 'race', name: 'Sakura Circuit', laps: 3, ai: 5,
    desc: '3 laps · 5 rivals', payout: [30000, 18000, 12000, 7000, 4500, 3000], xp: [3000, 2200, 1700, 1300, 1000, 800],
  },
  {
    id: 'festival-sprint', type: 'race', name: 'Festival Sprint', laps: 1, ai: 5,
    desc: '1 lap dash · 5 rivals', payout: [12000, 8000, 6000, 4000, 2500, 1500], xp: [1500, 1100, 900, 700, 500, 400],
  },
  {
    id: 'time-trial', type: 'trial', name: 'Hanami Time Trial', laps: 2, ai: 0,
    desc: 'Beat the clock · best lap counts', stars: [62, 52, 46], payout: [4000, 9000, 16000], xp: [800, 1500, 2500],
  },
];

const DIFFICULTY = { easy: 0.86, normal: 0.95, hard: 1.03, unbeatable: 1.1 };
const RIVAL_NAMES = ['Kenji', 'Aiko', 'Marco', 'Lena', 'Diego', 'Yuki', 'Sven', 'Priya'];
const RIVAL_COLORS = ['#e0162b', '#27c485', '#ffd23f', '#8b5cff', '#1b1d22', '#ff7a1a', '#1f6feb'];
const CP_COUNT = 8;

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

export function formatTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

// ============================================================================
// Race / Time trial
// ============================================================================
export class EventManager {
  /**
   * @param {object} ctx { scene, physics, env, player, ui, audio, progression }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.state = 'idle'; // idle | countdown | running | finished
    this.def = null;
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
    const n = env.trackSamples.length;
    this.def = def;
    this.cpIndices = Array.from({ length: CP_COUNT }, (_, k) => (env.startIndex + Math.round((k * n) / CP_COUNT)) % n);
    env.showCheckpoints(this.cpIndices);

    const skill = DIFFICULTY[this.progression.settings.difficulty] ?? 0.95;
    const playerPI = this.player.preset;
    const racers = [];
    // AI rivals take the front slots, player starts at the back (Horizon style)
    const pool = CAR_PRESETS.filter((c) => c.topSpeed <= playerPI.topSpeed * 1.12 && c.topSpeed >= playerPI.topSpeed * 0.8);
    const cars = pool.length ? pool : CAR_PRESETS;
    for (let i = 0; i < def.ai; i++) {
      const base = cars[i % cars.length];
      const preset = tunePreset(base, { engine: 1, grip: 1, brakes: 1 });
      const v = new Vehicle(this.scene, this.physics, preset, { loadModel: false, name: base.name });
      v.setPaint(RIVAL_COLORS[i % RIVAL_COLORS.length]);
      const yaw = env.gridSlot(i, _v);
      v.reset(_v, yaw);
      const driver = new AIDriver(env, {
        skill: skill * (0.94 + (i / Math.max(1, def.ai - 1)) * 0.08) * (1 - i * 0.004),
        lane: i % 2 === 0 ? 2.2 : -2.2,
        name: RIVAL_NAMES[i],
      });
      racers.push(this._racer(v, driver, RIVAL_NAMES[i]));
    }
    const pyaw = env.gridSlot(def.ai, _v);
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
    env.setActiveCheckpoint(0, def.laps === 1);
  }

  _racer(vehicle, driver, name) {
    return {
      vehicle, driver, name,
      idx: -1, rel: 0, prevRel: 0, lap: 0, nextCp: 0,
      progress: 0, finished: false, finishTime: null, lapStart: 0, bestLap: null, lastLap: null,
    };
  }

  /** Remove AI cars and event furniture. */
  cleanup() {
    for (const r of this.racers) if (r.driver) r.vehicle.dispose();
    this.racers = [];
    this.env.hideCheckpoints();
    this.state = 'idle';
    this.def = null;
    this.ui.showRaceHUD(false);
    this.ui.wrongWay(false);
  }

  quit() {
    if (!this.active) return;
    this.cleanup();
    this.ui.toast('Event abandoned');
  }

  /** Fixed-rate: compute AI inputs and step AI vehicles. */
  fixedUpdate(dt) {
    if (!this.active) return;
    const vehicles = this.racers.map((r) => r.vehicle);
    for (const r of this.racers) {
      if (!r.driver) continue;
      r.driver.enabled = this.state === 'running' || this.state === 'finished';
      const others = vehicles.filter((v) => v !== r.vehicle);
      const inp = r.driver.update(dt, r.vehicle, others);
      r.vehicle.fixedUpdate(dt, inp);
    }
  }

  /** Per-frame visual sync for AI cars. */
  updateVisuals(dt, alpha) {
    for (const r of this.racers) if (r.driver) r.vehicle.update(dt, alpha);
  }

  update(dt) {
    if (!this.active) return;
    const env = this.env;
    const n = env.trackSamples.length;

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
    for (const r of this.racers) {
      const p = r.vehicle.root.position;
      r.idx = env.nearestIndex(p.x, p.z, r.idx);
      r.prevRel = r.rel;
      r.rel = (r.idx - env.startIndex + n) % n;
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

    // --- Positions
    const order = [...this.racers].sort((a, b) => b.progress - a.progress);
    order.forEach((r, i) => (r.position = i + 1));

    // --- Rubber banding (distance to player in samples)
    const pp = this.playerRacer.progress;
    for (const r of this.racers) {
      if (!r.driver) continue;
      const gap = ((r.progress - pp) * env.sampleSpacing);
      r.driver.rubber = THREE.MathUtils.clamp(1 - gap / 1500, 0.9, 1.06);
    }

    // --- Wrong way
    const pr = this.playerRacer;
    if (this.state === 'running' && !pr.finished) {
      const tan = env.trackTangents[pr.idx];
      const wrong = this.player.forward.dot(tan) < -0.35 && this.player.speedAbs > 4;
      this.wrongWayTime = wrong ? this.wrongWayTime + dt : 0;
      this.ui.wrongWay(this.wrongWayTime > 0.8);
    } else this.ui.wrongWay(false);

    // --- HUD
    const lapTime = this.state === 'running' ? this.time - pr.lapStart : 0;
    this.ui.updateRaceHUD({
      type: this.def.type,
      position: pr.position,
      total: this.racers.length,
      lap: Math.max(1, Math.min(pr.lap, this.def.laps)),
      laps: this.def.laps,
      time: this.time,
      lapTime,
      bestLap: pr.bestLap,
      record: this.progression.record(this.def.id).bestLap ?? null,
    });
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

    // Estimate finishing times for AI still running
    const n = this.env.trackSamples.length;
    const total = def.laps * n;
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
      const lap = pr.bestLap;
      stars = def.stars.filter((s) => lap <= s).length;
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
      title,
      event: def,
      position,
      stars,
      credits,
      xp,
      bestLap: pr.bestLap,
      totalTime: pr.finishTime,
      newLapRecord: prevBestLap == null || pr.bestLap < prevBestLap,
      newTimeRecord: prevBestTime == null || pr.finishTime < prevBestTime,
      table: def.type === 'race'
        ? order.map((r, i) => ({ pos: i + 1, name: r.name, car: r.vehicle.name, time: r.finishTime, player: !r.driver }))
        : null,
    });
  }

  /** Markers for the minimap / world map. */
  markers() {
    if (!this.active) return null;
    const cars = [];
    for (const r of this.racers) if (r.driver) cars.push(r.vehicle.root.position);
    let checkpoint = null;
    if (this.state !== 'finished') {
      const i = this.cpIndices[this.playerRacer.nextCp];
      checkpoint = this.env.trackSamples[i];
    }
    return { cars, checkpoint };
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
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
    this.idx = -1;
    this.prevIdx = -1;
    this.activeZone = null;
    this.jump = null;
    this.enabled = true;
  }

  reset() {
    this.idx = -1;
    this.prevIdx = -1;
    this._cancelZone();
    this.jump = null;
  }

  _cancelZone() {
    if (this.activeZone) this.ui.zoneMeter(null);
    this.activeZone = null;
  }

  /** true if moving forward from sample a to b crosses sample `i` */
  _crossed(a, b, i) {
    const n = this.env.trackSamples.length;
    if (a < 0) return false;
    const fwd = (b - a + n) % n;
    if (fwd === 0 || fwd > 30) return false; // not a forward move / teleport
    const off = (i - a + n) % n;
    return off > 0 && off <= fwd;
  }

  update(dt) {
    if (!this.enabled) return;
    const env = this.env;
    const v = this.player;
    const p = v.root.position;
    this.prevIdx = this.idx;
    this.idx = env.nearestIndex(p.x, p.z, this.idx);
    env.trackPoint(this.idx, 0, _t);
    const onRoad = _t.distanceTo(p) < 16;
    const mph = this.progression.settings.units === 'mph';
    const speedConv = mph ? 2.23694 : 3.6;
    const unit = mph ? 'MPH' : 'KM/H';

    for (const st of env.stunts) {
      if (st.type === 'jump') continue;
      if (!onRoad || !this._crossed(this.prevIdx, this.idx, st.index)) continue;
      if (st.type === 'trap') {
        const val = v.speedAbs * 2.23694; // thresholds stored in mph
        this._result(st, val, `${Math.round(val * (speedConv / 2.23694))} ${unit}`);
      } else if (!this.activeZone) {
        this.activeZone = { st, time: 0, dist: 0, drift: 0 };
      }
    }

    // --- Active zone
    const z = this.activeZone;
    if (z) {
      z.time += dt;
      z.dist += v.speedAbs * dt;
      if (z.st.type === 'drift' && v.isDrifting) z.drift += Math.abs(v.driftAngle) * 57.3 * v.speedAbs * dt * 0.9;
      if (!onRoad || z.time > 90) {
        this.ui.showSkill(`${z.st.name.toUpperCase()} FAILED`, null, 'fail');
        this._cancelZone();
      } else if (this._crossed(this.prevIdx, this.idx, z.st.end)) {
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

    // --- Jumps
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
        const label = mph ? `${Math.round(dist * 3.281)} FT` : `${Math.round(dist)} M`;
        this._result(j.st, dist, label);
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
// Free-roam traffic ("Drivatars" cruising the loop)
// ============================================================================
export class AmbientTraffic {
  constructor({ scene, physics, env }) {
    this.scene = scene;
    this.physics = physics;
    this.env = env;
    this.cars = [];
  }

  get active() { return this.cars.length > 0; }

  spawn(count = 4, avoid = null) {
    this.despawn();
    const env = this.env;
    const n = env.trackSamples.length;
    for (let i = 0; i < count; i++) {
      const base = CAR_PRESETS[(i * 2 + 1) % CAR_PRESETS.length];
      const v = new Vehicle(this.scene, this.physics, base, { loadModel: false, name: base.name });
      v.setPaint(RIVAL_COLORS[(i + 3) % RIVAL_COLORS.length]);
      // spread around the lap, away from the player
      let idx = Math.round(((i + 0.5) / count) * n);
      if (avoid) {
        const pi = env.nearestIndex(avoid.x, avoid.z);
        if (Math.abs(((idx - pi + n + n / 2) % n) - n / 2) < 40) idx = (idx + Math.round(n / (count * 2))) % n;
      }
      const lane = i % 2 === 0 ? 3.2 : -3.2;
      env.trackPoint(idx, lane, _v);
      _v.y = 1.0;
      v.reset(_v, env.trackYaw(idx));
      const driver = new AIDriver(env, { skill: 0.72 + (i % 3) * 0.05, lane, name: base.name });
      driver.enabled = true;
      this.cars.push({ vehicle: v, driver });
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
      // cruise: cap throttle so they drive at a relaxed pace
      if (c.vehicle.speed > 30) inp.throttle = Math.min(inp.throttle, 0.3);
      c.vehicle.fixedUpdate(dt, inp);
    }
  }

  updateVisuals(dt, alpha) {
    for (const c of this.cars) c.vehicle.update(dt, alpha);
  }

  positions() {
    return this.cars.map((c) => c.vehicle.root.position);
  }
}
