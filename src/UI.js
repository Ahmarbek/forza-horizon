import { CAR_PRESETS, PAINT_COLORS, UPGRADE_TYPES, performanceIndex } from './Vehicle.js';
import { xpForLevel } from './Progression.js';
import { formatTime } from './Events.js';

/**
 * UI.js
 * -----
 * DOM layer: title screen, HUD (tachometer, speedo, gear, minimap, skill
 * chain, level/credits, race panel, countdown, stunt banners), results
 * screen, tile-grid menu (events, garage shop + upgrades, world map,
 * settings), gamepad focus navigation and touch controls. Talks to the game
 * only through the callbacks passed in.
 */

const TAB_ORDER = ['festival', 'garage', 'map', 'settings'];
const ARC_FRACTION = 0.75; // 270° sweep
const R = 84;
const CIRC = 2 * Math.PI * R;
const ARC_LEN = CIRC * ARC_FRACTION;
const MAX_RPM = 9000;
const REDLINE = 7500;
const MS_TO_MPH = 2.23694;
const MS_TO_KMH = 3.6;
const MINIMAP_RANGE = 200; // metres from centre to edge
const STUNT_COLORS = { trap: '#2de2ff', zone: '#2de2ff', drift: '#b36bff', jump: '#ffd23f' };
const STUNT_LABELS = { trap: 'SPEED TRAP', zone: 'SPEED ZONE', drift: 'DRIFT ZONE', jump: 'DANGER SIGN' };

const fmt = (n) => Math.round(n).toLocaleString();
const starsHTML = (n, max = 3) => Array.from({ length: max }, (_, i) => `<span class="${i < n ? 'on' : ''}">★</span>`).join('');

export class UI {
  /**
   * @param {object} callbacks { onAction(action, data), onSetting(key, value) }
   */
  constructor(callbacks) {
    this.cb = callbacks;
    this.units = 'mph';
    this.menuOpen = false;
    this.activeTab = 'festival';
    this.focusIndex = -1;
    this.garageCar = null;
    this.touch = { left: false, right: false, throttle: false, brake: false, handbrake: false, active: false };

    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.el = {
      loader: $('loader'), loaderFill: $('loader-fill'), loaderText: $('loader-text'),
      title: $('title'), titleStart: $('title-start'),
      hud: $('hud'), speed: $('speed'), speedUnit: $('speed-unit'), gear: $('gear'),
      rpmArc: $('tacho-arc'), rpmReadout: $('rpm-readout'), handbrake: $('handbrake-light'),
      ticks: $('tacho-ticks'), tacho: document.querySelector('.tacho'),
      minimap: $('minimap-canvas'), worldMap: $('world-map'),
      chain: $('skill-chain'), chainScore: $('skill-chain-score'), chainMult: $('skill-chain-mult'),
      chainTimer: $('skill-chain-timer'), feed: $('skill-feed'), totalScore: $('total-score'),
      toast: $('toast'), menu: $('menu'), carName: $('menu-car-name'), carClass: $('menu-car-class'),
      cameraLabel: $('camera-label'), backend: $('physics-backend'), fatal: $('fatal'),
      raceHud: $('race-hud'), countdown: $('countdown'), wrongWay: $('wrong-way'),
      zone: $('zone-meter'), stunt: $('stunt-banner'), results: $('results'), touchLayer: $('touch'),
    };
    this.mmCtx = this.el.minimap.getContext('2d');
    this.mapCtx = this.el.worldMap.getContext('2d');

    // cached values to avoid redundant DOM writes
    this._last = { speed: -1, gear: '', rpm: -1, hb: null, score: -1, redline: null, race: {} };

    this._buildTacho();
    this._buildSwatches();
    this._bindMenu();
    this._bindSettings();
    this._bindResults();
    this._bindTouch();
  }

  // ================================================================ Loader
  setLoading(frac, text) {
    this.el.loaderFill.style.width = `${Math.round(frac * 100)}%`;
    if (text) this.el.loaderText.textContent = text;
  }

  hideLoader() {
    this.el.loader.classList.add('is-done');
  }

  showFatal(message) {
    this.el.fatal.hidden = false;
    this.el.fatal.innerHTML = `<div><h2>Unable to start</h2><p>${message}</p></div>`;
    this.el.loader.classList.add('is-done');
  }

  setBackend(name) {
    this.el.backend.textContent = `Physics: ${name === 'rapier' ? 'Rapier (WASM)' : 'Lite fallback'}`;
  }

  // ================================================================= Title
  showTitle(progression, onStart) {
    const d = progression.data;
    this.$('title-level').textContent = d.level;
    this.$('title-credits').textContent = fmt(d.credits);
    this.$('title-car').textContent = progression.selectedPreset.name;
    this.el.title.hidden = false;
    this.el.hud.classList.add('is-hidden');
    const isTouch = matchMedia('(pointer: coarse)').matches;
    this.el.titleStart.textContent = isTouch ? 'TAP TO DRIVE' : 'PRESS ANY KEY TO DRIVE';
    const go = (e) => {
      if (e.type === 'keydown' && ['Tab', 'F5', 'F12'].includes(e.key)) return;
      window.removeEventListener('keydown', go, true);
      window.removeEventListener('pointerdown', go, true);
      this.el.title.hidden = true;
      this.el.hud.classList.remove('is-hidden');
      onStart(e.type === 'pointerdown' && e.pointerType === 'touch');
    };
    window.addEventListener('keydown', go, true);
    window.addEventListener('pointerdown', go, true);
  }

  // ================================================================= Tacho
  _buildTacho() {
    const ns = 'http://www.w3.org/2000/svg';
    const track = document.querySelector('.tacho__track');
    track.setAttribute('stroke-dasharray', `${ARC_LEN} ${CIRC}`);
    const red = document.querySelector('.tacho__redline');
    const redStart = ARC_LEN * (REDLINE / MAX_RPM);
    red.setAttribute('stroke-dasharray', `0 ${redStart} ${ARC_LEN - redStart} ${CIRC}`);
    this.el.rpmArc.setAttribute('stroke-dasharray', `0 ${CIRC}`);

    for (let i = 0; i <= 9; i++) {
      const a = ((135 + (i / 9) * 270) * Math.PI) / 180;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 100 + Math.cos(a) * 72); line.setAttribute('y1', 100 + Math.sin(a) * 72);
      line.setAttribute('x2', 100 + Math.cos(a) * 78); line.setAttribute('y2', 100 + Math.sin(a) * 78);
      line.setAttribute('class', 'tacho__tick tacho__tick--major');
      this.el.ticks.appendChild(line);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', 100 + Math.cos(a) * 62);
      label.setAttribute('y', 100 + Math.sin(a) * 62);
      label.setAttribute('class', 'tacho__label');
      if (i * 1000 >= REDLINE) label.setAttribute('fill', '#ff2d8f');
      label.textContent = String(i);
      this.el.ticks.appendChild(label);
      if (i < 9) {
        const am = ((135 + ((i + 0.5) / 9) * 270) * Math.PI) / 180;
        const m = document.createElementNS(ns, 'line');
        m.setAttribute('x1', 100 + Math.cos(am) * 75); m.setAttribute('y1', 100 + Math.sin(am) * 75);
        m.setAttribute('x2', 100 + Math.cos(am) * 78); m.setAttribute('y2', 100 + Math.sin(am) * 78);
        m.setAttribute('class', 'tacho__tick');
        this.el.ticks.appendChild(m);
      }
    }
  }

  updateHUD(vehicle) {
    const L = this._last;
    const conv = this.units === 'mph' ? MS_TO_MPH : MS_TO_KMH;
    const spd = Math.min(999, Math.round(vehicle.speedAbs * conv));
    if (spd !== L.speed) {
      L.speed = spd;
      const s = String(spd).padStart(3, '0');
      const firstSig = s.search(/[1-9]/);
      const leadCount = firstSig === -1 ? 2 : firstSig;
      this.el.speed.innerHTML = `<span class="lead">${s.slice(0, leadCount)}</span>${s.slice(leadCount)}`;
    }
    if (vehicle.gearLabel !== L.gear) {
      L.gear = vehicle.gearLabel;
      this.el.gear.textContent = L.gear;
      this.el.gear.classList.remove('is-shift');
      void this.el.gear.offsetWidth; // restart animation
      this.el.gear.classList.add('is-shift');
    }
    const rpm = Math.round(vehicle.rpm / 50) * 50;
    if (rpm !== L.rpm) {
      L.rpm = rpm;
      const frac = Math.min(1, rpm / MAX_RPM);
      this.el.rpmArc.setAttribute('stroke-dasharray', `${ARC_LEN * frac} ${CIRC}`);
      this.el.tacho.style.setProperty('--rpm', frac.toFixed(3));
      this.el.rpmReadout.textContent = `${rpm} RPM`;
      const red = rpm >= REDLINE;
      if (red !== L.redline) {
        L.redline = red;
        this.el.rpmArc.classList.toggle('is-redline', red);
      }
    }
    if (vehicle.handbrake !== L.hb) {
      L.hb = vehicle.handbrake;
      this.el.handbrake.classList.toggle('is-on', L.hb);
    }
  }

  setUnits(units) {
    this.units = units;
    this.el.speedUnit.textContent = units === 'mph' ? 'MPH' : 'KM/H';
    this._last.speed = -1;
  }

  formatSpeed(ms) {
    const conv = this.units === 'mph' ? MS_TO_MPH : MS_TO_KMH;
    return `${Math.round(ms * conv)} ${this.units === 'mph' ? 'MPH' : 'KM/H'}`;
  }

  // ======================================================= Profile / level
  updateProfile(progression) {
    const d = progression.data;
    const frac = Math.min(1, d.xp / xpForLevel(d.level));
    this.$('hud-level').textContent = d.level;
    this.$('hud-credits').textContent = fmt(d.credits);
    this.$('hud-xp').style.width = `${(frac * 100).toFixed(1)}%`;
    this.$('menu-level').textContent = d.level;
    this.$('menu-level-2').textContent = d.level;
    this.$('menu-credits').textContent = fmt(d.credits);
    this.$('menu-xp').style.width = `${(frac * 100).toFixed(1)}%`;
    const preset = progression.selectedPreset;
    this.el.carName.textContent = preset.name;
    this.el.carClass.textContent = performanceIndex(preset).label;
  }

  // =============================================================== Minimap
  drawMinimap(vehicle, env, markers) {
    const ctx = this.mmCtx;
    const W = this.el.minimap.width;
    const half = W / 2;
    const scale = half / MINIMAP_RANGE;
    const p = vehicle.root.position;
    const yaw = Math.atan2(vehicle.forward.x, vehicle.forward.z);
    const racing = markers && !markers.freeRoam;
    const view = MINIMAP_RANGE * 1.5;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();
    // World → minimap: car at centre, heading up; world +X is "left" → mirror.
    ctx.translate(half, half);
    ctx.rotate(yaw);
    ctx.scale(-scale, -scale);
    ctx.translate(-p.x, -p.z);

    // city blocks
    const city = env.city;
    if (city.contains(p.x, p.z, view)) {
      ctx.fillStyle = 'rgba(60,64,76,0.9)';
      const r = city.rect;
      ctx.fillRect(r.minX - 9, r.minZ - 9, r.maxX - r.minX + 18, r.maxZ - r.minZ + 18);
      ctx.fillStyle = 'rgba(28,30,38,0.95)';
      for (const b of city.blocks) ctx.fillRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    // roads
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const trace = (r, step) => {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < r.count; i += step) {
        const x = r.xs[i], z = r.zs[i];
        const near = Math.abs(x - p.x) < view && Math.abs(z - p.z) < view;
        if (near) { if (pen) ctx.lineTo(x, z); else ctx.moveTo(x, z); pen = true; }
        else pen = false;
      }
      if (r.closed && pen) ctx.lineTo(r.xs[0], r.zs[0]);
    };
    for (const r of env.roads.all) {
      if (!r.render) continue;
      trace(r, 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = r.width + 5;
      ctx.stroke();
      ctx.strokeStyle = '#3d4250';
      ctx.lineWidth = r.width;
      ctx.stroke();
    }
    if (racing && markers.route) {
      trace(markers.route, 2);
      ctx.strokeStyle = 'rgba(255,45,143,0.95)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(80,86,100,0.9)';
    ctx.fillRect(-45, -110, 90, 100);

    if (!racing) {
      for (const st of env.stunts) {
        const pos = st.type === 'jump' ? st.ramp : { x: st.route.xs[st.index], z: st.route.zs[st.index] };
        if (Math.abs(pos.x - p.x) > view || Math.abs(pos.z - p.z) > view) continue;
        ctx.fillStyle = STUNT_COLORS[st.type];
        ctx.beginPath();
        ctx.arc(pos.x, pos.z, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (markers) {
      if (markers.checkpoint) {
        const c = markers.checkpoint;
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(c.x, c.z, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = racing ? '#ff4d5e' : 'rgba(255,255,255,0.85)';
      for (const c of markers.cars) {
        ctx.beginPath();
        ctx.arc(c.x, c.z, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(10, 11);
    ctx.lineTo(0, 5);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawWorldMap(vehicle, env, progression, events) {
    const canvas = this.el.worldMap;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(300, rect.width * dpr);
    canvas.height = Math.max(200, rect.height * dpr);
    const ctx = this.mapCtx;
    const W = canvas.width, H = canvas.height;
    const b = env.mapBounds;
    const pad = 16 * dpr;
    const s = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxZ - b.minZ));
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const X = (x) => W / 2 - (x - cx) * s; // mirrored like the minimap
    const Y = (z) => H / 2 - (z - cz) * s;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c1210';
    ctx.fillRect(0, 0, W, H);
    const img = env.mapCanvas();
    ctx.drawImage(img, X(b.maxX), Y(b.maxZ), (b.maxX - b.minX) * s, (b.maxZ - b.minZ) * s);

    ctx.lineJoin = 'round';
    for (const r of env.roads.all) {
      if (!r.render) continue;
      ctx.beginPath();
      ctx.moveTo(X(r.xs[0]), Y(r.zs[0]));
      for (let i = 3; i < r.count; i += 3) ctx.lineTo(X(r.xs[i]), Y(r.zs[i]));
      if (r.closed) ctx.closePath();
      ctx.strokeStyle = r.type === 'highway' ? '#ffd23f' : '#f2f2f2';
      ctx.lineWidth = Math.max(2 * dpr, r.width * s * 1.4);
      ctx.stroke();
    }
    const city = env.city.rect;
    ctx.strokeStyle = 'rgba(255,45,143,0.8)';
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(X(city.maxX), Y(city.maxZ), (city.maxX - city.minX) * s, (city.maxZ - city.minZ) * s);

    const label = (text, x, z, color = '#fff', size = 15) => {
      ctx.font = `800 ${size * dpr}px "Barlow Condensed", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(text, X(x), Y(z));
      ctx.fillStyle = color;
      ctx.fillText(text, X(x), Y(z));
    };
    label('NEON CITY', (city.minX + city.maxX) / 2, city.maxZ + 40, '#ff7ab8', 18);
    label('FESTIVAL SITE', 200, 330, '#ff7ab8', 16);
    label('FUJI PASS', -780, -640, '#ffffff', 15);
    label('HORIZON HIGHWAY', 1000, 300, '#ffd23f', 14);

    // race starts
    if (events) {
      const seen = new Set();
      for (const ev of events) {
        const r = env.routes[ev.route];
        if (seen.has(r)) continue;
        seen.add(r);
        const x = X(r.xs[r.startIndex]), y = Y(r.zs[r.startIndex]);
        ctx.fillStyle = '#ff2d8f';
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y - 16 * dpr); ctx.lineTo(x + 11 * dpr, y - 11 * dpr); ctx.lineTo(x, y - 7 * dpr);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 16 * dpr); ctx.stroke();
      }
    }
    // PR stunts with star ratings
    ctx.textAlign = 'center';
    for (const st of env.stunts) {
      const pos = st.type === 'jump' ? st.ramp : { x: st.route.xs[st.index], z: st.route.zs[st.index] };
      const x = X(pos.x), y = Y(pos.z);
      ctx.fillStyle = STUNT_COLORS[st.type];
      ctx.beginPath();
      ctx.arc(x, y, 5.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      const rec = progression?.data.stunts[st.id];
      ctx.fillStyle = '#ffd23f';
      ctx.font = `700 ${11 * dpr}px "Barlow Condensed", sans-serif`;
      ctx.fillText('★'.repeat(rec?.stars || 0) + '☆'.repeat(3 - (rec?.stars || 0)), x, y + 16 * dpr);
    }

    const p = vehicle.root.position;
    const yaw = Math.atan2(vehicle.forward.x, vehicle.forward.z);
    ctx.save();
    ctx.translate(X(p.x), Y(p.z));
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -13 * dpr);
    ctx.lineTo(9 * dpr, 10 * dpr);
    ctx.lineTo(0, 5 * dpr);
    ctx.lineTo(-9 * dpr, 10 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.font = `800 ${20 * dpr}px "Barlow Condensed", sans-serif`;
    ctx.fillText('N ↑', W - 60 * dpr, 34 * dpr);
  }

  // ========================================================== Skill chain
  showSkill(label, points, variant = '') {
    const el = document.createElement('div');
    el.className = `skill-pop${variant ? ` skill-pop--${variant}` : ''}`;
    el.innerHTML = points != null ? `${label}<b>+${fmt(points)}</b>` : label;
    this.el.feed.prepend(el);
    while (this.el.feed.children.length > 3) this.el.feed.lastChild.remove();
    setTimeout(() => el.remove(), 2400);
  }

  updateChain(active, score, mult, timerFrac) {
    const c = this.el.chain;
    if (active) {
      c.classList.remove('is-banked');
      c.classList.add('is-active');
      this.el.chainScore.textContent = fmt(score);
      this.el.chainMult.textContent = `x${mult.toFixed(1)}`;
      this.el.chainTimer.style.transform = `scaleX(${Math.max(0, timerFrac).toFixed(3)})`;
    }
  }

  bankChain() {
    const c = this.el.chain;
    c.classList.remove('is-active');
    c.classList.add('is-banked');
    setTimeout(() => c.classList.remove('is-banked'), 700);
  }

  dropChain() {
    this.el.chain.classList.remove('is-active', 'is-banked');
  }

  setTotalScore(total) {
    const v = Math.round(total);
    if (v === this._last.score) return;
    this._last.score = v;
    this.el.totalScore.textContent = fmt(v);
  }

  updateStats(progression, sessionStats) {
    const d = progression.data;
    const st = d.stats;
    this.$('stat-total').textContent = fmt(d.totalSkill);
    this.$('stat-best').textContent = fmt(Math.max(st.bestChain, sessionStats?.bestChain ?? 0));
    this.$('stat-wins').textContent = fmt(st.racesWon || 0);
    this.$('stat-drift').textContent = `${Math.round(Math.max(st.longestDrift, sessionStats?.longestDrift ?? 0))} m`;
    this.$('stat-top').textContent = this.formatSpeed(Math.max(st.topSpeed, sessionStats?.topSpeed ?? 0));
    const stars = Object.values(d.stunts).reduce((a, s) => a + (s.stars || 0), 0);
    this.$('stat-stars').textContent = `${stars} ★`;
  }

  toast(msg, ms = 1800) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  setRegion(text) {
    if (this._last.region === text) return;
    this._last.region = text;
    this.$('banner-sub').textContent = `Free Roam · ${text}`;
  }

  setCameraLabel(label) {
    this.el.cameraLabel.textContent = label;
  }

  // ============================================================ Race HUD
  showRaceHUD(on, def) {
    this.el.hud.classList.toggle('is-racing', on);
    this.$('quit-event').hidden = !on;
    if (on && def) {
      this.$('race-name').textContent = def.name;
      this.el.raceHud.classList.toggle('is-trial', def.type === 'trial');
      this._last.race = {};
    }
  }

  updateRaceHUD(d) {
    const L = this._last.race;
    const set = (key, id, val) => {
      if (L[key] !== val) { L[key] = val; this.$(id).textContent = val; }
    };
    set('pos', 'race-pos', String(d.position));
    set('total', 'race-total', String(d.total));
    set('lap', 'race-lap', `${d.lap}/${d.laps}`);
    set('time', 'race-time', formatTime(d.time));
    set('laptime', 'race-laptime', formatTime(d.lapTime));
    set('best', 'race-best', formatTime(d.bestLap ?? d.record));
  }

  countdown(text) {
    const c = this.el.countdown;
    c.textContent = text;
    c.classList.remove('is-on', 'is-go');
    void c.offsetWidth;
    c.classList.add('is-on');
    if (text === 'GO!') c.classList.add('is-go');
  }

  wrongWay(on) {
    if (this._last.wrong === on) return;
    this._last.wrong = on;
    this.el.wrongWay.classList.toggle('is-on', on);
  }

  // ======================================================= Stunts & level
  zoneMeter(name, value, stars = 0) {
    const z = this.el.zone;
    if (!name) { z.classList.remove('is-on'); this._last.zone = null; return; }
    if (this._last.zone !== name) {
      this._last.zone = name;
      this.$('zone-name').textContent = name;
      z.classList.add('is-on');
    }
    this.$('zone-value').textContent = value;
    this.$('zone-stars').innerHTML = starsHTML(stars);
  }

  _banner(variant, type, name, value, stars, extra) {
    const b = this.el.stunt;
    b.className = `stunt-banner${variant ? ` stunt-banner--${variant}` : ''}`;
    this.$('stunt-type').textContent = type;
    this.$('stunt-name').textContent = name;
    this.$('stunt-value').textContent = value;
    this.$('stunt-stars').innerHTML = stars == null ? '' : starsHTML(stars);
    this.$('stunt-extra').textContent = extra || '';
    void b.offsetWidth;
    b.classList.add('is-on');
  }

  stuntBanner(st, label, stars, newRecord, reward) {
    const extra = [newRecord ? 'NEW RECORD!' : '', reward ? `+${fmt(reward)} CR` : ''].filter(Boolean).join('  ·  ');
    const variant = st.type === 'drift' ? 'drift' : st.type === 'jump' ? 'jump' : '';
    this._banner(variant, STUNT_LABELS[st.type], st.name, label, stars, extra);
  }

  levelBanner(level, reward) {
    this._banner('level', 'LEVEL UP', 'Festival Reward', `LEVEL ${level}`, null, `+${fmt(reward)} CR`);
  }

  // ============================================================== Results
  _bindResults() {
    this.$('results-continue').addEventListener('click', () => this.cb.onAction('results-continue'));
    this.$('results-retry').addEventListener('click', () => this.cb.onAction('results-retry'));
  }

  showResults(r) {
    this.$('results-event').textContent = r.event.name;
    this.$('results-title').textContent = r.title;
    this.$('results-stars').innerHTML = r.event.type === 'trial' ? starsHTML(r.stars) : '';
    const table = this.$('results-table');
    table.innerHTML = r.table
      ? r.table.map((row) => `<tr class="${row.player ? 'is-player' : ''}"><td>${row.pos}</td><td>${row.name}</td><td>${row.car}</td><td>${formatTime(row.time)}</td></tr>`).join('')
      : `<tr><td></td><td>Targets</td><td>★ ${formatTime(r.event.stars[0])} · ★★ ${formatTime(r.event.stars[1])} · ★★★ ${formatTime(r.event.stars[2])}</td><td></td></tr>`;
    this.$('results-time').innerHTML = `${formatTime(r.totalTime)}${r.newTimeRecord ? '<span class="rec">PB</span>' : ''}`;
    this.$('results-lap').innerHTML = `${formatTime(r.bestLap)}${r.newLapRecord ? '<span class="rec">PB</span>' : ''}`;
    this.$('results-credits').textContent = fmt(r.credits);
    this.$('results-xp').textContent = fmt(r.xp);
    this.el.results.hidden = false;
    this.resultsOpen = true;
    this.focusIndex = -1;
  }

  hideResults() {
    this.el.results.hidden = true;
    this.resultsOpen = false;
  }

  // ================================================================= Menu
  _bindMenu() {
    this.el.menu.querySelectorAll('.menu__tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    this.el.menu.addEventListener('click', (e) => {
      const card = e.target.closest('[data-action]');
      if (card && this.el.menu.contains(card)) {
        this.cb.onAction(card.dataset.action, card.dataset.arg);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.menuOpen) return;
      if (e.code === 'KeyQ') this.cycleTab(-1);
      if (e.code === 'KeyE') this.cycleTab(1);
    });
    window.addEventListener('resize', () => {
      if (this.menuOpen && this.activeTab === 'map') this.cb.onAction('redraw-map');
    });
  }

  renderEvents(events, progression, activeId) {
    const wrap = this.$('event-cards');
    wrap.innerHTML = events.map((ev) => {
      const rec = progression.data.records[ev.id] || {};
      let record = '';
      if (ev.type === 'race') record = rec.bestPosition ? `Best: ${ordinal(rec.bestPosition)} · Wins ${rec.wins || 0}` : 'Not raced yet';
      else record = rec.bestLap ? `Best lap ${formatTime(rec.bestLap)} ${'★'.repeat(rec.stars || 0)}` : 'No time set';
      const top = ev.type === 'race' ? `Win ${fmt(ev.payout[0])} CR` : `Up to ${fmt(ev.payout[2])} CR`;
      const kind = ev.type === 'race' ? (ev.route === 'city' ? 'STREET RACE' : ev.route === 'highway' ? 'HIGHWAY RACE' : ev.route === 'mountain' ? 'MOUNTAIN RACE' : 'ROAD RACE') : 'TIME TRIAL';
      return `<button class="card event-card event-card--${ev.type}" data-action="start-event" data-arg="${ev.id}">
        <div class="event-card__type">${kind}${activeId === ev.id ? ' · ACTIVE' : ''}</div>
        <div>
          <div class="card__title">${ev.name}</div>
          <div class="card__sub">${ev.desc} · ${top}</div>
          <div class="event-card__record">${record}</div>
        </div>
      </button>`;
    }).join('');
  }

  _buildSwatches() {
    const sw = this.$('paint-swatches');
    sw.innerHTML = '';
    for (const color of PAINT_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = color;
      b.dataset.color = color;
      b.title = color;
      b.addEventListener('click', () => this.cb.onAction('paint', color));
      sw.appendChild(b);
    }
  }

  renderGarage(progression) {
    const d = progression.data;
    const wrap = this.$('garage-cars');
    wrap.innerHTML = '';
    for (const car of CAR_PRESETS) {
      const owned = !!d.owned[car.id];
      const tuned = progression.presetFor(car.id);
      const pi = performanceIndex(tuned);
      const selected = d.selectedCar === car.id;
      const affordable = d.credits >= car.price;
      const card = document.createElement('button');
      card.className = `card car-card${owned ? ' is-owned' : ' is-locked'}${selected ? ' is-selected' : ''}`;
      card.dataset.car = car.id;
      const bar = (v) => `<div class="car-card__bar"><i style="width:${Math.round(Math.min(1, v) * 100)}%"></i></div>`;
      const color = owned ? d.owned[car.id].paint : car.color;
      card.innerHTML = `
        <div class="car-card__class">${pi.label}</div>
        <div class="car-card__thumb">
          <img src="assets/cars/${car.id}.png" alt="${car.name}" loading="lazy"
               onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'car-card__silhouette',style:'--car-color:${color}'}))" />
        </div>
        <div>
          <div class="card__title">${car.name}</div>
          <div class="card__sub">${car.drive} · ${Math.round(tuned.topSpeed * MS_TO_MPH)} mph</div>
          ${owned ? '' : `<div class="car-card__price${affordable ? '' : ' is-locked'}">${fmt(car.price)} CR</div>`}
        </div>
        <div class="car-card__stats">
          <span>Speed</span>${bar(car.stats.speed)}
          <span>Handling</span>${bar(car.stats.handling)}
          <span>Accel</span>${bar(car.stats.accel)}
        </div>`;
      card.addEventListener('click', () => this.cb.onAction(owned ? 'select-car' : 'buy-car', car.id));
      wrap.appendChild(card);
    }

    // Paint + upgrades for the equipped car
    const cur = d.selectedCar;
    const paint = d.owned[cur]?.paint;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-selected', s.dataset.color === paint));
    const up = d.owned[cur]?.upgrades || {};
    const rows = Object.entries(UPGRADE_TYPES).map(([type, info]) => {
      const tier = up[type] || 0;
      const cost = progression.upgradeCost(cur, type);
      const pips = [0, 1, 2].map((i) => `<i class="${i < tier ? 'on' : ''}"></i>`).join('');
      const btn = cost == null
        ? '<button class="btn btn--ghost" disabled>MAX</button>'
        : `<button class="btn" data-action="upgrade" data-arg="${type}" ${d.credits < cost ? 'disabled' : ''}>${fmt(cost)} CR</button>`;
      return `<div class="upgrade-row"><span>${info.label}</span><div class="pips">${pips}</div>${btn}</div>`;
    }).join('');
    const pi = performanceIndex(progression.selectedPreset);
    this.$('upgrades').innerHTML = `<div class="upgrades__head"><span>UPGRADES · ${progression.selectedPreset.name.toUpperCase()}</span><span>${pi.label}</span></div>${rows}`;
  }

  _bindSettings() {
    const on = (id, key, evt = 'change', map = (el) => el.value) => {
      const el = this.$(id);
      el.addEventListener(evt, () => this.cb.onSetting(key, map(el)));
    };
    on('set-units', 'units');
    on('set-difficulty', 'difficulty');
    on('set-bloom', 'bloom', 'change', (el) => el.checked);
    on('set-blur', 'blur', 'change', (el) => el.checked);
    on('set-radio', 'radio', 'change', (el) => el.checked);
    on('set-shadows', 'shadows', 'change', (el) => Number(el.value));
    on('set-time', 'time', 'input', (el) => Number(el.value));
    on('set-res', 'resolution', 'change', (el) => Number(el.value));
    on('set-grass', 'grass');
    on('set-traffic', 'traffic', 'change', (el) => Number(el.value));
    on('set-master', 'master', 'input', (el) => Number(el.value) / 100);
    on('set-music', 'music', 'input', (el) => Number(el.value) / 100);
    on('set-sfx', 'sfx', 'input', (el) => Number(el.value) / 100);
  }

  /** Reflect saved settings into the form controls. */
  applySettings(s) {
    this.$('set-units').value = s.units;
    this.$('set-difficulty').value = s.difficulty;
    this.$('set-bloom').checked = s.bloom;
    this.$('set-blur').checked = s.blur;
    this.$('set-radio').checked = s.radio;
    this.$('set-shadows').value = String(s.shadows);
    this.$('set-time').value = String(s.time);
    this.$('set-res').value = String(s.resolution);
    this.$('set-grass').value = s.grass;
    this.$('set-traffic').value = String(s.traffic);
    this.$('set-master').value = String(Math.round(s.master * 100));
    this.$('set-music').value = String(Math.round(s.music * 100));
    this.$('set-sfx').value = String(Math.round(s.sfx * 100));
    this.setUnits(s.units);
  }

  setTimeSlider(v) {
    this.$('set-time').value = String(v);
  }

  openMenu() {
    this.menuOpen = true;
    this.el.menu.classList.add('is-open');
    this.el.menu.setAttribute('aria-hidden', 'false');
    this.el.hud.classList.add('is-hidden');
    this.focusIndex = -1;
    this.switchTab(this.activeTab);
  }

  closeMenu() {
    this.menuOpen = false;
    this.el.menu.classList.remove('is-open');
    this.el.menu.setAttribute('aria-hidden', 'true');
    this.el.hud.classList.remove('is-hidden');
    this._clearFocus();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  switchTab(tab) {
    this.activeTab = tab;
    this.el.menu.querySelectorAll('.menu__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    this.el.menu.querySelectorAll('.menu__panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
    this._clearFocus();
    this.focusIndex = -1;
    this.cb.onAction('tab', tab);
    if (tab === 'map') requestAnimationFrame(() => this.cb.onAction('redraw-map'));
  }

  cycleTab(dir) {
    const i = TAB_ORDER.indexOf(this.activeTab);
    this.switchTab(TAB_ORDER[(i + dir + TAB_ORDER.length) % TAB_ORDER.length]);
  }

  // ---- Gamepad focus navigation (spatial)
  _focusables() {
    if (this.resultsOpen) return [...this.el.results.querySelectorAll('button')];
    const panel = this.el.menu.querySelector('.menu__panel.is-active');
    return [...panel.querySelectorAll('button.card:not([hidden]), .swatch, label.card, .upgrade-row .btn:not(:disabled)')];
  }

  _clearFocus() {
    document.querySelectorAll('.is-focused').forEach((e) => e.classList.remove('is-focused'));
  }

  navigate(dx, dy) {
    const items = this._focusables();
    if (!items.length) return;
    if (this.focusIndex < 0 || this.focusIndex >= items.length) {
      this.focusIndex = 0;
    } else {
      const cur = items[this.focusIndex].getBoundingClientRect();
      const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
      let best = -1, bestScore = Infinity;
      items.forEach((el, i) => {
        if (i === this.focusIndex) return;
        const r = el.getBoundingClientRect();
        const ex = r.left + r.width / 2 - cx, ey = r.top + r.height / 2 - cy;
        const along = ex * dx + ey * dy;
        if (along <= 1) return;
        const across = Math.abs(ex * dy) + Math.abs(ey * dx);
        const score = along + across * 2;
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best >= 0) this.focusIndex = best;
    }
    this._clearFocus();
    const el = items[this.focusIndex];
    el.classList.add('is-focused');
    el.scrollIntoView({ block: 'nearest' });
  }

  confirm() {
    const items = this._focusables();
    const el = items[this.focusIndex];
    if (!el) return;
    const input = el.querySelector('input, select');
    if (input) {
      if (input.type === 'checkbox') { input.checked = !input.checked; input.dispatchEvent(new Event('change')); }
      else if (input.tagName === 'SELECT') {
        input.selectedIndex = (input.selectedIndex + 1) % input.options.length;
        input.dispatchEvent(new Event('change'));
      } else if (input.type === 'range') {
        const step = (Number(input.max) - Number(input.min)) / 8;
        const v = Number(input.value) + step;
        input.value = String(v > Number(input.max) ? input.min : v);
        input.dispatchEvent(new Event('input'));
      }
      return;
    }
    el.click();
  }

  // ======================================================= Touch controls
  _bindTouch() {
    const layer = this.el.touchLayer;
    const press = (btn, down) => {
      const k = btn.dataset.touch;
      if (k === 'menu') { if (down) this.cb.onAction('toggle-menu'); return; }
      this.touch[k] = down;
      btn.classList.toggle('is-down', down);
    };
    layer.querySelectorAll('[data-touch]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); press(btn, true); });
      const up = (e) => { e.preventDefault(); press(btn, false); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  enableTouch() {
    this.touch.active = true;
    this.el.touchLayer.hidden = false;
    document.body.classList.add('is-touch');
  }

  setTouchVisible(on) {
    if (this.touch.active) this.el.touchLayer.hidden = !on;
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
