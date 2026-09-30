/**
 * Audio.js
 * --------
 * Fully procedural Web Audio: no sound files are downloaded.
 *  - Engine: detuned saw/square stack → soft clipper → throttle-driven low-pass
 *  - Tyre screech (band-passed noise), wind rush, impact thumps
 *  - UI / skill / countdown / checkpoint cues
 *  - "Horizon Pulse" radio: a generative synthwave loop (drums, bass, pads, arp)
 *
 * Browsers only allow audio after a user gesture, so `unlock()` is called on
 * the first key/click/touch.
 */

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz

// Am – F – C – G (MIDI roots) with triad offsets
const PROGRESSION = [
  { root: 57, triad: [0, 3, 7] },
  { root: 53, triad: [0, 4, 7] },
  { root: 60, triad: [0, 4, 7] },
  { root: 55, triad: [0, 4, 7] },
];
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15]; // A natural minor (relative)

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volumes = { master: 0.8, music: 0.35, sfx: 0.8 };
    this.musicOn = true;
    this._musicTimer = null;
    this._step = 0;
    this._nextNoteTime = 0;
    this._rng = 1;
  }

  /** Must be called from a user gesture handler. Safe to call repeatedly. */
  unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (err) {
      console.warn('[Audio] Web Audio unavailable', err);
      return;
    }
    const c = this.ctx;

    this.master = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(c.destination);
    this.sfxBus = c.createGain();
    this.musicBus = c.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);

    this.noise = this._makeNoise(2);
    this._buildEngine();
    this._buildTyres();
    this._buildWind();
    this.setVolumes(this.volumes);

    this.ready = true;
    if (this.musicOn) this.startMusic();
  }

  setVolumes(v) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.musicOn ? this.volumes.music : 0, t, 0.1);
  }

  setMusic(on) {
    this.musicOn = on;
    if (!this.ready) return;
    if (on) this.startMusic();
    else this.stopMusic();
    this.setVolumes({});
  }

  // ------------------------------------------------------------ Building
  _makeNoise(seconds) {
    const c = this.ctx;
    const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  _buildEngine() {
    const c = this.ctx;
    this.engineOut = c.createGain();
    this.engineOut.gain.value = 0;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2.5;
    filter.frequency.value = 800;
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.4);
    }
    shaper.curve = curve;
    const pre = c.createGain();
    pre.gain.value = 0.5;

    const mk = (type, detune, gain) => {
      const o = c.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = c.createGain();
      g.gain.value = gain;
      o.connect(g).connect(pre);
      o.start();
      return o;
    };
    this.engOsc = [mk('sawtooth', 0, 0.5), mk('sawtooth', 9, 0.35), mk('square', -1200, 0.35), mk('triangle', -2400, 0.6)];
    // growl: amplitude modulation at firing frequency / 2
    this.engLfo = c.createOscillator();
    this.engLfoGain = c.createGain();
    this.engLfoGain.gain.value = 0.25;
    this.engLfo.connect(this.engLfoGain).connect(pre.gain);
    this.engLfo.start();

    pre.connect(shaper).connect(filter).connect(this.engineOut).connect(this.sfxBus);
    this.engFilter = filter;
  }

  _buildTyres() {
    const c = this.ctx;
    const src = this._noiseSource();
    const bp1 = c.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.frequency.value = 2100;
    bp1.Q.value = 7;
    const bp2 = c.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 3300;
    bp2.Q.value = 9;
    this.tyreGain = c.createGain();
    this.tyreGain.gain.value = 0;
    src.connect(bp1).connect(this.tyreGain);
    src.connect(bp2).connect(this.tyreGain);
    this.tyreGain.connect(this.sfxBus);
    this.tyreBp = bp1;
    src.start();
  }

  _buildWind() {
    const c = this.ctx;
    const src = this._noiseSource();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    src.connect(lp).connect(this.windGain).connect(this.sfxBus);
    this.windLp = lp;
    src.start();
    // gravel / grass rumble: low band-passed noise with a slow tremolo
    const g2 = this._noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.9;
    this.gravelGain = c.createGain();
    this.gravelGain.gain.value = 0;
    g2.connect(bp).connect(this.gravelGain).connect(this.sfxBus);
    this.gravelBp = bp;
    g2.start();
  }

  // -------------------------------------------------------------- Update
  /**
   * @param {Vehicle} v player vehicle
   * @param {boolean} active false in menus (engine idles, no screech)
   */
  update(v, active) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const rpm = v.rpm;
    const throttle = active ? Math.max(v.throttleInput, v.brakeInput * (v.direction === -1 ? 1 : 0)) : 0;
    const base = (rpm / 60) * 3; // V6 firing frequency
    for (let i = 0; i < this.engOsc.length; i++) this.engOsc[i].frequency.setTargetAtTime(base, t, 0.03);
    this.engLfo.frequency.setTargetAtTime(base / 2, t, 0.03);
    this.engFilter.frequency.setTargetAtTime(350 + throttle * 2600 + rpm * 0.25, t, 0.05);
    const rpmN = Math.min(1, rpm / (v.drive?.redline ?? 8200));
    this.engineOut.gain.setTargetAtTime((active ? 0.09 : 0.05) + throttle * 0.1 + rpmN * 0.07, t, 0.06);

    const speed = v.speedAbs;
    const skid = active ? v.skid * Math.min(1, speed / 6) : 0;
    this.tyreGain.gain.setTargetAtTime(skid * 0.28, t, 0.05);
    this.tyreBp.frequency.setTargetAtTime(1700 + skid * 900, t, 0.1);

    if (this.gravelGain) {
      const gr = active ? (v.gravel || 0) : 0;
      this.gravelGain.gain.setTargetAtTime(gr * 0.3, t, 0.08);
      this.gravelBp.frequency.setTargetAtTime(260 + gr * 500 + (v.rough || 0) * 200, t, 0.1);
    }

    const w = active ? Math.min(1, speed / 80) : 0;
    this.windGain.gain.setTargetAtTime(w * w * 0.35, t, 0.2);
    this.windLp.frequency.setTargetAtTime(300 + w * 1400, t, 0.2);
  }

  // ------------------------------------------------------------ One-shots
  _env(gainNode, t, attack, peak, decay) {
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _tone(freq, dur, type = 'sine', vol = 0.2, delay = 0, bus = this.sfxBus) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = c.createGain();
    this._env(g, t, 0.008, vol, dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  impact(strength) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime;
    const s = Math.min(1, strength / 15);
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + s * 1500;
    const g = c.createGain();
    this._env(g, t, 0.004, 0.5 * s + 0.1, 0.35);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.5);
    // body thump
    const o = c.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const og = c.createGain();
    this._env(og, t, 0.004, 0.6 * s + 0.1, 0.3);
    o.connect(og).connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.4);
  }

  skill() { this._tone(988, 0.12, 'triangle', 0.12); this._tone(1318, 0.18, 'triangle', 0.1, 0.07); }
  bank() { [784, 988, 1175, 1568].forEach((f, i) => this._tone(f, 0.22, 'triangle', 0.12, i * 0.07)); }
  fail() { this._tone(220, 0.3, 'sawtooth', 0.08); this._tone(165, 0.4, 'sawtooth', 0.08, 0.12); }
  /** Exhaust pop on a hard upshift: short filtered noise crack + low thump. */
  backfire() {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 500;
    bp.Q.value = 1.2;
    const g = c.createGain();
    this._env(g, t, 0.002, 0.35, 0.09);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.15);
    this._tone(70, 0.08, 'sine', 0.25);
  }

  checkpoint() { this._tone(1046, 0.12, 'sine', 0.2); this._tone(1568, 0.25, 'sine', 0.16, 0.06); }
  countdown(go) { this._tone(go ? 880 : 440, go ? 0.6 : 0.25, 'square', 0.12); }
  click() { this._tone(1400, 0.04, 'square', 0.04); }
  purchase() { [1318, 1760, 2093].forEach((f, i) => this._tone(f, 0.15, 'triangle', 0.12, i * 0.05)); }
  levelUp() { [523, 659, 784, 1046, 1318].forEach((f, i) => this._tone(f, 0.3, 'triangle', 0.13, i * 0.09)); }
  stunt(stars) { for (let i = 0; i < Math.max(1, stars); i++) this._tone(1175 + i * 220, 0.22, 'triangle', 0.14, i * 0.12); }

  // ---------------------------------------------------------------- Music
  startMusic() {
    if (!this.ready || this._musicTimer) return;
    this._nextNoteTime = this.ctx.currentTime + 0.1;
    this._step = 0;
    this._musicTimer = setInterval(() => this._schedule(), 25);
  }

  stopMusic() {
    clearInterval(this._musicTimer);
    this._musicTimer = null;
  }

  _rand() {
    // deterministic LCG so the melody has structure but evolves
    this._rng = (this._rng * 1664525 + 1013904223) >>> 0;
    return this._rng / 4294967296;
  }

  _schedule() {
    const c = this.ctx;
    if (c.state !== 'running') return;
    const spb = 60 / 108 / 4; // 16th notes at 108 BPM
    while (this._nextNoteTime < c.currentTime + 0.12) {
      this._playStep(this._step, this._nextNoteTime, spb);
      this._nextNoteTime += spb;
      this._step++;
    }
  }

  _playStep(step, t, spb) {
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const chord = PROGRESSION[bar % 4];
    const section = Math.floor(bar / 8) % 3; // 0 intro-ish, 1 full, 2 breakdown
    const bus = this.musicBus;
    const c = this.ctx;

    // Drums
    if (s16 % 4 === 0 && section !== 2) this._kick(t);
    if (s16 === 4 || s16 === 12) this._snare(t, section === 2 ? 0.05 : 0.12);
    if (s16 % 2 === 0) this._hat(t, s16 % 4 === 2 ? 0.05 : 0.025);

    // Bass: 8th notes on the root, octave jumps
    if (s16 % 2 === 0) {
      const n = chord.root - 12 + (s16 % 8 === 6 ? 12 : 0);
      this._synth(NOTE(n), spb * 1.8, 'sawtooth', 0.09, t, 500, bus);
    }
    // Pad at the start of each bar
    if (s16 === 0) {
      for (const off of chord.triad) this._pad(NOTE(chord.root + 12 + off), spb * 16, t);
    }
    // Arpeggio / lead
    if (section >= 1 || bar % 8 >= 4) {
      if (s16 % 2 === 0 || this._rand() < 0.3) {
        const tri = chord.triad;
        const idx = section === 1 ? Math.floor(this._rand() * SCALE.length) : Math.floor(s16 / 2) % 3;
        const n = section === 1 ? chord.root + 24 + SCALE[idx] - (SCALE[idx] > 7 ? 12 : 0) : chord.root + 24 + tri[idx];
        this._synth(NOTE(n), spb * 0.9, 'square', 0.035, t, 2600, bus);
      }
    }
    void c;
  }

  _synth(freq, dur, type, vol, t, cutoff, bus) {
    if (!isFinite(freq)) return;
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff * 1.6, t);
    f.frequency.exponentialRampToValueAtTime(cutoff * 0.5, t + dur);
    const g = c.createGain();
    this._env(g, t, 0.005, vol, dur);
    o.connect(f).connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _pad(freq, dur, t) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    for (const d of [-8, 8]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = d;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    f.connect(g).connect(this.musicBus);
  }

  _kick(t) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = c.createGain();
    this._env(g, t, 0.002, 0.35, 0.22);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.3);
  }

  _snare(t, vol) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const g = c.createGain();
    this._env(g, t, 0.002, vol, 0.16);
    src.connect(hp).connect(g).connect(this.musicBus);
    src.start(t, Math.random());
    src.stop(t + 0.2);
  }

  _hat(t, vol) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = c.createGain();
    this._env(g, t, 0.001, vol, 0.04);
    src.connect(hp).connect(g).connect(this.musicBus);
    src.start(t, Math.random());
    src.stop(t + 0.06);
  }
}
