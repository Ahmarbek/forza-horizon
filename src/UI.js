import { CAR_PRESETS, PAINT_COLORS } from './Vehicle.js';

/**
 * UI.js
 * -----
 * DOM layer: HUD (tachometer, speedo, gear, minimap, skill chain popups),
 * tile-grid menu (tabs, cards, garage, world map, settings) and gamepad
 * focus navigation. Communicates with the app through callbacks only.
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
const MINIMAP_RANGE = 170; // metres from centre to edge

export class UI {
  /**
   * @param {object} callbacks { onAction(action, data), onSetting(key, value) }
   */
  constructor(callbacks) {
    this.cb = callbacks;
    this.units = 'mph';
    this.menuOpen = false;
    this.activeTab = 'festival';
    this.selectedCar = CAR_PRESETS[0].id;
    this.selectedPaint = CAR_PRESETS[0].color;
    this.focusIndex = -1;

    const $ = (id) => document.getElementById(id);
    this.el = {
      loader: $('loader'), loaderFill: $('loader-fill'), loaderText: $('loader-text'),
      hud: $('hud'), speed: $('speed'), speedUnit: $('speed-unit'), gear: $('gear'),
      rpmArc: $('tacho-arc'), rpmReadout: $('rpm-readout'), handbrake: $('handbrake-light'),
      ticks: $('tacho-ticks'), tacho: document.querySelector('.tacho'),
      minimap: $('minimap-canvas'), worldMap: $('world-map'),
      chain: $('skill-chain'), chainScore: $('skill-chain-score'), chainMult: $('skill-chain-mult'),
      chainTimer: $('skill-chain-timer'), feed: $('skill-feed'), totalScore: $('total-score'),
      toast: $('toast'), menu: $('menu'), credits: $('menu-credits'), carName: $('menu-car-name'),
      cameraLabel: $('camera-label'), backend: $('physics-backend'), fatal: $('fatal'),
      statTotal: $('stat-total'), statBest: $('stat-best'), statDrift: $('stat-drift'), statTop: $('stat-top'),
    };
    this.mmCtx = this.el.minimap.getContext('2d');
    this.mapCtx = this.el.worldMap.getContext('2d');

    // cached values to avoid redundant DOM writes
    this._last = { speed: -1, gear: '', rpm: -1, hb: null, score: -1, redline: null };

    this._buildTacho();
    this._buildGarage();
    this._bindMenu();
    this._bindSettings();
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
      const x1 = 100 + Math.cos(a) * 72, y1 = 100 + Math.sin(a) * 72;
      const x2 = 100 + Math.cos(a) * 78, y2 = 100 + Math.sin(a) * 78;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
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

  // =============================================================== Minimap
  drawMinimap(vehicle, env) {
    const ctx = this.mmCtx;
    const W = this.el.minimap.width;
    const half = W / 2;
    const scale = half / MINIMAP_RANGE;
    const p = vehicle.root.position;
    const yaw = Math.atan2(vehicle.forward.x, vehicle.forward.z);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();

    // World → minimap: translate car to centre, rotate so heading is up.
    // World +X is "left" when looking along +Z, so mirror X.
    ctx.translate(half, half);
    ctx.rotate(yaw);
    ctx.scale(-scale, -scale);
    ctx.translate(-p.x, -p.z);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1 / scale;
    const g0x = Math.floor((p.x - 250) / 50) * 50, g0z = Math.floor((p.z - 250) / 50) * 50;
    ctx.beginPath();
    for (let x = g0x; x < p.x + 250; x += 50) { ctx.moveTo(x, p.z - 250); ctx.lineTo(x, p.z + 250); }
    for (let z = g0z; z < p.z + 250; z += 50) { ctx.moveTo(p.x - 250, z); ctx.lineTo(p.x + 250, z); }
    ctx.stroke();

    // track
    const pts = env.trackPoints2D;
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    trace();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 20;
    ctx.stroke();
    ctx.strokeStyle = '#3d4250';
    ctx.lineWidth = 14;
    ctx.stroke();
    // route highlight
    ctx.strokeStyle = 'rgba(45,226,255,0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // plaza
    ctx.fillStyle = 'rgba(80,86,100,0.9)';
    ctx.fillRect(-45, -110, 90, 100);

    // cones
    ctx.fillStyle = '#ff7a1a';
    for (const c of env.cones) {
      const t = c.body ? c.body.translation() : c;
      ctx.beginPath();
      ctx.arc(t.x, t.z, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // player arrow (always centre, pointing up)
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

  drawWorldMap(vehicle, env) {
    const canvas = this.el.worldMap;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(300, rect.width * dpr);
    canvas.height = Math.max(200, rect.height * dpr);
    const ctx = this.mapCtx;
    const W = canvas.width, H = canvas.height;
    const b = env.bounds;
    const pad = 40 * dpr;
    const sx = (W - pad * 2) / (b.maxX - b.minX);
    const sz = (H - pad * 2) / (b.maxZ - b.minZ);
    const s = Math.min(sx, sz);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    // North (+Z) up, world +X shown to the left (mirrored like the minimap)
    const X = (x) => W / 2 - (x - cx) * s;
    const Y = (z) => H / 2 - (z - cz) * s;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
    bg.addColorStop(0, '#1d2a22');
    bg.addColorStop(1, '#0c1210');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = Math.ceil(b.minX / 100) * 100; x <= b.maxX; x += 100) {
      ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), H); ctx.stroke();
    }
    for (let z = Math.ceil(b.minZ / 100) * 100; z <= b.maxZ; z += 100) {
      ctx.beginPath(); ctx.moveTo(0, Y(z)); ctx.lineTo(W, Y(z)); ctx.stroke();
    }

    // trees
    const tp = env.treePositions;
    for (let i = 0; i < tp.length; i += 3) {
      ctx.fillStyle = tp[i + 2] === 1 ? 'rgba(255,179,209,0.75)' : 'rgba(80,140,90,0.55)';
      ctx.beginPath();
      ctx.arc(X(tp[i]), Y(tp[i + 1]), (tp[i + 2] === 1 ? 2.4 : 1.8) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // track
    const pts = env.trackPoints2D;
    ctx.beginPath();
    ctx.moveTo(X(pts[0]), Y(pts[1]));
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(X(pts[i]), Y(pts[i + 1]));
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = 14 * s + 4 * dpr;
    ctx.stroke();
    ctx.strokeStyle = '#555b69';
    ctx.lineWidth = 14 * s;
    ctx.stroke();

    // plaza
    ctx.fillStyle = '#555b69';
    ctx.fillRect(X(45), Y(-10), 90 * s, 100 * s);
    ctx.fillStyle = '#ff2d8f';
    ctx.font = `800 ${14 * dpr}px "Barlow Condensed", sans-serif`;
    ctx.fillText('FESTIVAL SITE', X(45), Y(-10) - 6 * dpr);

    // cones
    ctx.fillStyle = '#ff7a1a';
    for (const c of env.cones) {
      const t = c.body ? c.body.translation() : c;
      ctx.beginPath();
      ctx.arc(X(t.x), Y(t.z), 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // player
    const p = vehicle.root.position;
    const yaw = Math.atan2(vehicle.forward.x, vehicle.forward.z);
    ctx.save();
    ctx.translate(X(p.x), Y(p.z));
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12 * dpr);
    ctx.lineTo(8 * dpr, 9 * dpr);
    ctx.lineTo(0, 4 * dpr);
    ctx.lineTo(-8 * dpr, 9 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // compass
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${20 * dpr}px "Barlow Condensed", sans-serif`;
    ctx.fillText('N ↑', W - 60 * dpr, 34 * dpr);
  }

  // ========================================================== Skill chain
  showSkill(label, points, variant = '') {
    const el = document.createElement('div');
    el.className = `skill-pop${variant ? ` skill-pop--${variant}` : ''}`;
    el.innerHTML = points != null ? `${label}<b>+${Math.round(points).toLocaleString()}</b>` : label;
    this.el.feed.prepend(el);
    while (this.el.feed.children.length > 4) this.el.feed.lastChild.remove();
    setTimeout(() => el.remove(), 2400);
  }

  updateChain(active, score, mult, timerFrac) {
    const c = this.el.chain;
    if (active) {
      c.classList.remove('is-banked');
      c.classList.add('is-active');
      this.el.chainScore.textContent = Math.round(score).toLocaleString();
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
    this.el.totalScore.textContent = v.toLocaleString();
    this.el.credits.textContent = Math.round(v * 2.5).toLocaleString();
  }

  updateStats(stats) {
    this.el.statTotal.textContent = Math.round(stats.total).toLocaleString();
    this.el.statBest.textContent = Math.round(stats.bestChain).toLocaleString();
    this.el.statDrift.textContent = `${Math.round(stats.longestDrift)} m`;
    this.el.statTop.textContent = this.formatSpeed(stats.topSpeed);
  }

  toast(msg, ms = 1600) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  setCameraLabel(label) {
    this.el.cameraLabel.textContent = label;
  }

  // ================================================================== Menu
  _bindMenu() {
    this.el.menu.querySelectorAll('.menu__tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    this.el.menu.querySelectorAll('[data-action]').forEach((card) => {
      card.addEventListener('click', () => this.cb.onAction(card.dataset.action));
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

  _buildGarage() {
    const wrap = document.getElementById('garage-cars');
    wrap.innerHTML = '';
    for (const car of CAR_PRESETS) {
      const card = document.createElement('button');
      card.className = 'card car-card';
      card.dataset.car = car.id;
      const bar = (v) => `<div class="car-card__bar"><i style="width:${Math.round(v * 100)}%"></i></div>`;
      card.innerHTML = `
        <div class="car-card__class">${car.klass}</div>
        <div class="car-card__silhouette" style="--car-color:${car.color}"></div>
        <div>
          <div class="card__title">${car.name}</div>
          <div class="card__sub">${car.drive} · ${Math.round(car.topSpeed * MS_TO_MPH)} mph top speed</div>
        </div>
        <div class="car-card__stats">
          <span>Speed</span>${bar(car.stats.speed)}
          <span>Handling</span>${bar(car.stats.handling)}
          <span>Accel</span>${bar(car.stats.accel)}
          <span>Launch</span>${bar(car.stats.launch)}
        </div>`;
      card.addEventListener('click', () => this.selectCar(car.id));
      wrap.appendChild(card);
    }

    const sw = document.getElementById('paint-swatches');
    sw.innerHTML = '';
    for (const color of PAINT_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = color;
      b.dataset.color = color;
      b.title = color;
      b.addEventListener('click', () => this.selectPaint(color));
      sw.appendChild(b);
    }
    this._refreshGarage();
  }

  selectCar(id) {
    const car = CAR_PRESETS.find((c) => c.id === id);
    if (!car) return;
    this.selectedCar = id;
    this.selectedPaint = car.color;
    this.el.carName.textContent = car.name;
    document.querySelector('.menu__car-class').textContent = car.klass;
    this._refreshGarage();
    this.cb.onAction('select-car', car);
  }

  selectPaint(color) {
    this.selectedPaint = color;
    this._refreshGarage();
    this.cb.onAction('paint', color);
  }

  _refreshGarage() {
    document.querySelectorAll('.car-card').forEach((c) => c.classList.toggle('is-selected', c.dataset.car === this.selectedCar));
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-selected', s.dataset.color === this.selectedPaint));
  }

  _bindSettings() {
    const on = (id, key, evt = 'change', map = (el) => el.value) => {
      const el = document.getElementById(id);
      el.addEventListener(evt, () => this.cb.onSetting(key, map(el)));
    };
    on('set-units', 'units');
    on('set-bloom', 'bloom', 'change', (el) => el.checked);
    on('set-blur', 'blur', 'change', (el) => el.checked);
    on('set-shadows', 'shadows', 'change', (el) => Number(el.value));
    on('set-time', 'time', 'input', (el) => Number(el.value));
    on('set-res', 'resolution', 'change', (el) => Number(el.value));
  }

  setTimeSlider(v) {
    document.getElementById('set-time').value = String(v);
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
    if (tab === 'map') requestAnimationFrame(() => this.cb.onAction('redraw-map'));
  }

  cycleTab(dir) {
    const i = TAB_ORDER.indexOf(this.activeTab);
    this.switchTab(TAB_ORDER[(i + dir + TAB_ORDER.length) % TAB_ORDER.length]);
  }

  // ---- Gamepad focus navigation (spatial)
  _focusables() {
    const panel = this.el.menu.querySelector('.menu__panel.is-active');
    return [...panel.querySelectorAll('button.card, .swatch, label.card')];
  }

  _clearFocus() {
    this.el.menu.querySelectorAll('.is-focused').forEach((e) => e.classList.remove('is-focused'));
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
    items[this.focusIndex].classList.add('is-focused');
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
        const v = Number(input.value) + 8;
        input.value = String(v > Number(input.max) ? input.min : v);
        input.dispatchEvent(new Event('input'));
      }
      return;
    }
    el.click();
  }
}
