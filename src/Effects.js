import * as THREE from 'three';
import { SURFACE } from './Vehicle.js';

/**
 * Effects.js
 * ----------
 *  - Skid marks: a ring buffer of ground-hugging quads laid down behind each
 *    sliding tyre (dark rubber on tarmac, lighter ruts on dirt/grass/sand/snow),
 *    fading out as they age
 *  - Tyre smoke & dust: pooled soft particles; white smoke when tyres slide on
 *    tarmac, surface-coloured dust/spray kicked up on loose ground
 *  - Sparks on hard impacts
 * One draw call each, no allocation in the frame loop.
 */

const MAX_SEGMENTS = 4000;
const MAX_PARTICLES = 900;
const MARK_LIFE = 45; // seconds

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _side = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _c = new THREE.Color();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.light = new THREE.Color(1, 1, 1);
    this._buildMarks();
    this._buildParticles();
    this.tracks = new WeakMap(); // vehicle → per-wheel track state
  }

  // ----------------------------------------------------------- Skid marks
  _buildMarks() {
    const n = MAX_SEGMENTS;
    const pos = new Float32Array(n * 4 * 3);
    const col = new Float32Array(n * 4 * 4);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      idx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
    });
    this.marks = new THREE.Mesh(g, m);
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 3;
    this.scene.add(this.marks);
    this.markBorn = new Float32Array(n).fill(-1e9);
    this.markAlpha = new Float32Array(n);
    this.markHead = 0;
  }

  _addSegment(a, b, normal, width, color, alpha) {
    const i = this.markHead;
    this.markHead = (this.markHead + 1) % MAX_SEGMENTS;
    _dir.subVectors(b, a);
    _side.crossVectors(normal, _dir).normalize().multiplyScalar(width / 2);
    const pos = this.marks.geometry.attributes.position.array;
    const o = i * 12;
    const lift = 0.025;
    pos[o] = a.x - _side.x; pos[o + 1] = a.y + lift; pos[o + 2] = a.z - _side.z;
    pos[o + 3] = a.x + _side.x; pos[o + 4] = a.y + lift; pos[o + 5] = a.z + _side.z;
    pos[o + 6] = b.x - _side.x; pos[o + 7] = b.y + lift; pos[o + 8] = b.z - _side.z;
    pos[o + 9] = b.x + _side.x; pos[o + 10] = b.y + lift; pos[o + 11] = b.z + _side.z;
    const col = this.marks.geometry.attributes.color.array;
    for (let k = 0; k < 4; k++) {
      col[i * 16 + k * 4] = color.r; col[i * 16 + k * 4 + 1] = color.g; col[i * 16 + k * 4 + 2] = color.b;
      col[i * 16 + k * 4 + 3] = alpha;
    }
    this.markBorn[i] = this.time;
    this.markAlpha[i] = alpha;
    this._marksDirty = true;
  }

  // ------------------------------------------------------------ Particles
  _buildParticles() {
    const n = MAX_PARTICLES;
    this.p = {
      pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), age: new Float32Array(n).fill(1e9),
      life: new Float32Array(n), size: new Float32Array(n), grow: new Float32Array(n),
      col: new Float32Array(n * 3), alpha: new Float32Array(n), drag: new Float32Array(n), lift: new Float32Array(n),
      head: 0,
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      name: 'SmokeParticles',
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 600 }, uLight: { value: this.light } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        varying float vSpark;
        void main() {
          vColor = aColor;
          vSpark = step(aSize, 0.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = abs(aSize) * uScale / max(-mv.z, 0.5);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        varying vec4 vColor;
        varying float vSpark;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = vSpark > 0.5 ? (1.0 - smoothstep(0.15, 0.5, d)) : (1.0 - smoothstep(0.1, 0.5, d)) * (0.75 + 0.25 * sin(c.x * 13.0 + c.y * 7.0));
          vec3 col = vSpark > 0.5 ? vColor.rgb * 4.0 : vColor.rgb * uLight;
          gl_FragColor = vec4(col, vColor.a * a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.particles = new THREE.Points(g, m);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 6;
    this.scene.add(this.particles);
  }

  _emit(x, y, z, vx, vy, vz, life, size, grow, color, alpha, drag = 1.6, lift = 0.6) {
    const P = this.p;
    const i = P.head;
    P.head = (P.head + 1) % MAX_PARTICLES;
    P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z;
    P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
    P.age[i] = 0; P.life[i] = life; P.size[i] = size; P.grow[i] = grow;
    P.col[i * 3] = color.r; P.col[i * 3 + 1] = color.g; P.col[i * 3 + 2] = color.b;
    P.alpha[i] = alpha; P.drag[i] = drag; P.lift[i] = lift;
  }

  /** Sparks at a point (hard impacts). */
  sparks(pos, dir, strength) {
    const n = Math.min(40, Math.round(8 + strength * 3));
    _c.setRGB(1, 0.55, 0.15);
    for (let k = 0; k < n; k++) {
      const s = 4 + Math.random() * 8;
      this._emit(pos.x, pos.y + 0.3, pos.z,
        dir.x * s + (Math.random() - 0.5) * 6, 2 + Math.random() * 4, dir.z * s + (Math.random() - 0.5) * 6,
        0.35 + Math.random() * 0.3, -0.12, 0, _c, 1, 0.5, -9);
    }
  }

  /**
   * @param {number} dt
   * @param {Vehicle[]} vehicles cars to emit for (player first)
   */
  update(dt, vehicles) {
    this.time += dt;
    for (const v of vehicles) this._vehicle(v, dt);
    this._stepParticles(dt);
    this._fadeMarks();
  }

  _vehicle(v, dt) {
    let st = this.tracks.get(v);
    if (!st) { st = v.wheels.map(() => ({ last: new THREE.Vector3(), on: false, acc: 0 })); this.tracks.set(v, st); }
    const speed = v.speedAbs;
    v.wheels.forEach((w, i) => {
      const t = st[i];
      if (!w.grounded || v.grounded < 2) { t.on = false; return; }
      const S = w.surface || SURFACE.asphalt;
      const loose = S.loose > 0.4;
      const sliding = w.slide > (loose ? 1.2 : 2.2);
      // loose ground always leaves a (faint) track; tarmac only when sliding
      const marking = (sliding && speed > 1.5) || (loose && speed > 3);
      // contact point, a tyre radius under the hub, following the car's roll
      _a.copy(w.contact);
      if (marking) {
        if (t.on && _a.distanceToSquared(t.last) > 0.35 * 0.35) {
          let alpha, color;
          if (!loose) { color = _c.setRGB(0.02, 0.02, 0.02); alpha = Math.min(0.75, 0.25 + (w.slide - 2) * 0.06); }
          else if (S === SURFACE.snow) { color = _c.setRGB(0.55, 0.6, 0.68); alpha = 0.55; }
          else { color = _c.setRGB(S.dust[0] * 0.45, S.dust[1] * 0.42, S.dust[2] * 0.4); alpha = sliding ? 0.5 : 0.28; }
          if (_a.distanceToSquared(t.last) < 16) this._addSegment(t.last, _a, w.normal, 0.28, color, alpha);
          t.last.copy(_a);
        } else if (!t.on) {
          t.last.copy(_a);
          t.on = true;
        }
      } else t.on = false;

      // smoke / dust
      t.acc += dt;
      const rate = loose ? Math.min(40, speed * 1.4 + w.slide * 6) : sliding ? Math.min(55, 10 + w.slide * 5) : 0;
      if (rate <= 0) return;
      const interval = 1 / rate;
      while (t.acc > interval) {
        t.acc -= interval;
        const back = 0.3 + Math.random() * 0.4;
        if (!loose) {
          _c.setRGB(0.82, 0.82, 0.84);
          this._emit(_a.x - v.forward.x * back, _a.y + 0.25, _a.z - v.forward.z * back,
            v.velocity.x * 0.25 + (Math.random() - 0.5) * 1.5, 0.6 + Math.random() * 0.8, v.velocity.z * 0.25 + (Math.random() - 0.5) * 1.5,
            1.6 + Math.random() * 1.4, 0.9, 2.4, _c, Math.min(0.55, 0.12 + w.slide * 0.04), 1.4, 0.5);
        } else {
          const d = S.dust || [0.6, 0.55, 0.45];
          _c.setRGB(d[0], d[1], d[2]);
          const amount = Math.min(0.5, 0.08 + speed * 0.006 + w.slide * 0.04);
          this._emit(_a.x - v.forward.x * back, _a.y + 0.2, _a.z - v.forward.z * back,
            v.velocity.x * 0.3 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.4, v.velocity.z * 0.3 + (Math.random() - 0.5) * 2,
            1.1 + Math.random() * 1.2, 0.7, 2.8, _c, amount, 1.9, S === SURFACE.snow ? 0.2 : 0.35);
        }
      }
      t.acc = Math.min(t.acc, 0.2);
    });
  }

  _stepParticles(dt) {
    const P = this.p;
    const g = this.particles.geometry;
    const pos = g.attributes.position.array, col = g.attributes.aColor.array, size = g.attributes.aSize.array;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (P.age[i] > P.life[i]) { col[i * 4 + 3] = 0; size[i] = 0.0001; continue; }
      P.age[i] += dt;
      const k = Math.exp(-P.drag[i] * dt);
      P.vel[i * 3] *= k; P.vel[i * 3 + 2] *= k;
      P.vel[i * 3 + 1] = P.vel[i * 3 + 1] * k + P.lift[i] * dt;
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      const f = P.age[i] / P.life[i];
      pos[i * 3] = P.pos[i * 3]; pos[i * 3 + 1] = P.pos[i * 3 + 1]; pos[i * 3 + 2] = P.pos[i * 3 + 2];
      col[i * 4] = P.col[i * 3]; col[i * 4 + 1] = P.col[i * 3 + 1]; col[i * 4 + 2] = P.col[i * 3 + 2];
      col[i * 4 + 3] = P.alpha[i] * (1 - f) * Math.min(1, f * 8);
      // negative size marks a spark (additive-looking, no growth)
      size[i] = P.size[i] < 0 ? P.size[i] : P.size[i] + P.grow[i] * P.age[i];
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  _fadeMarks() {
    // fade the oldest marks out over their last seconds (checked in slices)
    const col = this.marks.geometry.attributes.color.array;
    const n = MAX_SEGMENTS;
    const slice = 400;
    this._fadeCursor = ((this._fadeCursor || 0) + slice) % n;
    for (let j = 0; j < slice; j++) {
      const i = (this._fadeCursor + j) % n;
      const age = this.time - this.markBorn[i];
      if (age < MARK_LIFE - 10 || this.markAlpha[i] <= 0) continue;
      const a = this.markAlpha[i] * Math.max(0, (MARK_LIFE - age) / 10);
      for (let k = 0; k < 4; k++) col[i * 16 + k * 4 + 3] = a;
      if (a <= 0) this.markAlpha[i] = 0;
      this._marksDirty = true;
    }
    if (this._marksDirty) {
      this.marks.geometry.attributes.position.needsUpdate = true;
      this.marks.geometry.attributes.color.needsUpdate = true;
      this._marksDirty = false;
    }
  }

  setLight(color) {
    this.light.copy(color);
  }

  setPixelScale(heightPx, fov) {
    this.particles.material.uniforms.uScale.value = heightPx / (2 * Math.tan((fov * Math.PI) / 360));
  }

  clear() {
    this.p.age.fill(1e9);
    this.marks.geometry.attributes.color.array.fill(0);
    this.marks.geometry.attributes.color.needsUpdate = true;
  }
}
