import { CAR_PRESETS, tunePreset, UPGRADE_TYPES } from './Vehicle.js';

/**
 * Progression.js
 * --------------
 * Player profile persisted to localStorage: credits, XP/level, garage
 * (owned cars, paint, upgrade tiers), event records, stunt stars and settings.
 * Every storage access is wrapped so private mode / blocked storage still
 * lets the game run (progress just isn't kept).
 */

const KEY = 'horizon-drive-save-v1';

const DEFAULT = () => ({
  version: 1,
  credits: 20000,
  xp: 0,
  level: 1,
  totalSkill: 0,
  selectedCar: 'sakura-gt',
  owned: { 'sakura-gt': { paint: '#c9ccd4', upgrades: { engine: 0, grip: 0, brakes: 0 } } },
  records: {}, // eventId → { bestTime, bestLap, wins, bestPosition }
  stunts: {}, // stuntId → { best, stars }
  stats: { bestChain: 0, longestDrift: 0, topSpeed: 0, racesWon: 0, distance: 0 },
  settings: {
    units: 'mph', bloom: true, blur: true, shadows: 2048, time: 38, resolution: 1,
    master: 0.8, music: 0.35, sfx: 0.8, radio: true, difficulty: 'normal', grass: 'high', traffic: 1,
    abs: true, tcs: true, stm: true, steerAssist: true, transmission: 'auto', quality: 'high', reflections: 'dynamic',
  },
});

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level) {
  return 2500 + (level - 1) * 1500;
}

export class Progression {
  constructor() {
    this.data = DEFAULT();
    this.listeners = [];
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const def = DEFAULT();
      this.data = {
        ...def,
        ...saved,
        stats: { ...def.stats, ...saved.stats },
        settings: { ...def.settings, ...saved.settings },
        owned: { ...def.owned, ...saved.owned },
      };
      if (!CAR_PRESETS.some((c) => c.id === this.data.selectedCar)) this.data.selectedCar = 'sakura-gt';
    } catch (err) {
      console.warn('[Progression] Could not load save, starting fresh.', err);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable: progress lives for this session only */
    }
  }

  resetAll() {
    const settings = this.data.settings;
    this.data = DEFAULT();
    this.data.settings = settings;
    this.save();
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _emit(type, payload) {
    for (const fn of this.listeners) fn(type, payload);
  }

  // ---------------------------------------------------------------- Money
  get credits() { return this.data.credits; }

  addCredits(n, reason) {
    this.data.credits = Math.max(0, Math.round(this.data.credits + n));
    this._emit('credits', { amount: n, reason });
    this.save();
  }

  // ------------------------------------------------------------ XP/levels
  addXP(n) {
    const d = this.data;
    d.xp += Math.round(n);
    const ups = [];
    while (d.xp >= xpForLevel(d.level)) {
      d.xp -= xpForLevel(d.level);
      d.level++;
      const reward = 5000 + d.level * 1000;
      d.credits += reward;
      ups.push({ level: d.level, reward });
    }
    this.save();
    for (const u of ups) this._emit('levelup', u);
    this._emit('xp', { amount: n });
  }

  addSkillScore(points) {
    this.data.totalSkill += points;
    // Banked skill chains pay out credits and XP (Horizon style)
    this.addXP(points * 0.5);
    this.addCredits(points * 0.2, 'Skill chain');
  }

  // --------------------------------------------------------------- Garage
  owns(carId) { return !!this.data.owned[carId]; }

  buyCar(carId) {
    const car = CAR_PRESETS.find((c) => c.id === carId);
    if (!car || this.owns(carId)) return { ok: false, reason: 'Already owned' };
    if (this.data.credits < car.price) return { ok: false, reason: 'Not enough credits' };
    this.data.credits -= car.price;
    this.data.owned[carId] = { paint: car.color, upgrades: { engine: 0, grip: 0, brakes: 0 } };
    this.save();
    this._emit('credits', { amount: -car.price, reason: `Bought ${car.name}` });
    return { ok: true };
  }

  selectCar(carId) {
    if (!this.owns(carId)) return false;
    this.data.selectedCar = carId;
    this.save();
    return true;
  }

  setPaint(carId, color) {
    if (!this.owns(carId)) return;
    this.data.owned[carId].paint = color;
    this.save();
  }

  upgradeCost(carId, type) {
    const tier = this.data.owned[carId]?.upgrades[type] ?? 0;
    return tier >= 3 ? null : UPGRADE_TYPES[type].costs[tier];
  }

  buyUpgrade(carId, type) {
    const own = this.data.owned[carId];
    if (!own) return { ok: false, reason: 'Car not owned' };
    const cost = this.upgradeCost(carId, type);
    if (cost == null) return { ok: false, reason: 'Fully upgraded' };
    if (this.data.credits < cost) return { ok: false, reason: 'Not enough credits' };
    this.data.credits -= cost;
    own.upgrades[type]++;
    this.save();
    this._emit('credits', { amount: -cost, reason: 'Upgrade' });
    return { ok: true };
  }

  /** Tuned preset for a car (with its upgrades). */
  presetFor(carId) {
    const base = CAR_PRESETS.find((c) => c.id === carId) ?? CAR_PRESETS[0];
    return tunePreset(base, this.data.owned[carId]?.upgrades);
  }

  get selectedPreset() { return this.presetFor(this.data.selectedCar); }
  get selectedPaint() { return this.data.owned[this.data.selectedCar]?.paint; }

  // --------------------------------------------------------------- Records
  record(eventId) {
    return this.data.records[eventId] || (this.data.records[eventId] = {});
  }

  /** Returns { improved, previous } */
  submitStunt(stuntId, value, stars, higherIsBetter = true) {
    const s = this.data.stunts[stuntId] || (this.data.stunts[stuntId] = { best: null, stars: 0 });
    const prev = s.best;
    const improved = prev == null || (higherIsBetter ? value > prev : value < prev);
    if (improved) s.best = value;
    const newStars = Math.max(0, stars - s.stars);
    s.stars = Math.max(s.stars, stars);
    this.save();
    return { improved, previous: prev, newStars };
  }

  stat(key, value, mode = 'max') {
    const st = this.data.stats;
    st[key] = mode === 'max' ? Math.max(st[key] || 0, value) : (st[key] || 0) + value;
  }

  get settings() { return this.data.settings; }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }
}
