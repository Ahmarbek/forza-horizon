import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { FOG } from './Fog.js';

/**
 * Atmosphere.js
 * -------------
 * Physically based sky (Preetham scattering), procedural cloud layer with
 * sun-lit edges, stars at night, sun/moon directional light with a
 * camera-following shadow frustum, sky-matched fog, and a PMREM environment
 * map regenerated from the sky whenever the time of day changes.
 *
 * Time of day is expressed as sun elevation in degrees (-14 … 65);
 * negative values are night (moonlight, lit windows, street lamps).
 */

const CLOUD_ALT = 1400;

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.night = 0;
    this.elevation = 38;
    this.time = 0;

    // --- Sky
    this.sky = new Sky();
    this.sky.scale.setScalar(5000);
    this.sky.frustumCulled = false;
    const su = this.sky.material.uniforms;
    su.turbidity.value = 4.5;
    su.rayleigh.value = 1.6;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.78;
    scene.add(this.sky);

    // --- Clouds + stars dome
    this.cloudUniforms = {
      uSunDir: { value: this.sunDir },
      uSunCol: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyCol: { value: new THREE.Color(0.55, 0.65, 0.8) },
      uTime: { value: 0 },
      uCover: { value: 0.66 },
      uNight: { value: 0 },
      uCam: { value: new THREE.Vector3() },
    };
    const cloudMat = new THREE.ShaderMaterial({
      name: 'Clouds',
      uniforms: this.cloudUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyCol;
        uniform float uTime; uniform float uCover; uniform float uNight; uniform vec3 uCam;
        varying vec3 vDir;
        float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
        float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*n(p); p=p*2.02+vec2(13.1,7.7); a*=0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          if (d.y <= 0.0) discard;
          float t = ${CLOUD_ALT.toFixed(1)} / max(d.y, 0.02);
          vec2 p = (uCam.xz + d.xz * t) * 0.00045 + vec2(uTime * 0.004, uTime * 0.0015);
          float base = fbm(p);
          float detail = fbm(p * 3.7 + 11.0);
          float dens = smoothstep(uCover, uCover + 0.28, base * 0.8 + detail * 0.3);
          // light: darker bellies, bright sun-facing edges
          float light = fbm(p + uSunDir.xz * 0.02);
          float shade = clamp(0.55 + (base - light) * 2.2, 0.25, 1.0);
          float fwd = pow(max(dot(d, uSunDir), 0.0), 6.0);
          vec3 col = mix(uSkyCol * 0.9, uSunCol * 1.25, shade) + uSunCol * fwd * 0.8 * (1.0 - dens * 0.6);
          col = mix(col, vec3(0.06, 0.07, 0.1) + uSkyCol * 0.15, uNight * 0.85);
          float horizon = smoothstep(0.0, 0.14, d.y);
          float a = dens * horizon * 0.95;
          // stars
          vec3 star = vec3(0.0);
          if (uNight > 0.01) {
            vec2 sp = d.xz / (d.y + 0.25) * 420.0;
            float s = h(floor(sp));
            float tw = 0.7 + 0.3 * sin(uTime * 3.0 + s * 50.0);
            star = vec3(step(0.9975, s) * tw) * uNight * (1.0 - dens) * horizon;
          }
          gl_FragColor = vec4(col * a + star, max(a, length(star)));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    scene.add(this.clouds);

    // --- Lights
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95;
    sc.near = 1; sc.far = 900;
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 2.5;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a5a3a, 0.5);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xb8cde0, 0.00022);

    // --- Environment map from the sky
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(900);
    this.envScene.add(this.envSky);
    const envGround = new THREE.Mesh(
      new THREE.CircleGeometry(800, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3b4a30 })
    );
    envGround.position.y = -8;
    this.envGround = envGround;
    this.envScene.add(envGround);
    this.envDirty = true;
  }

  /** elevationDeg: -14 (night) … 65 (high noon) */
  setTimeOfDay(elevationDeg) {
    this.elevation = elevationDeg;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(-35);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    const day = THREE.MathUtils.smoothstep(elevationDeg, 3, 30);
    const dusk = THREE.MathUtils.smoothstep(elevationDeg, -8, 4);
    this.night = 1 - dusk;
    const golden = (1 - day) * dusk;

    // sky model
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.sunPosition.value.copy(this.sunDir);
      u.rayleigh.value = THREE.MathUtils.lerp(2.6, 2.0, day);
      u.turbidity.value = THREE.MathUtils.lerp(6.5, 3.0, day);
    }

    // light colours
    const sunCol = new THREE.Color('#ff8c4a').lerp(new THREE.Color('#fff3e2'), day);
    const moonCol = new THREE.Color('#7f9ccc');
    const isMoon = elevationDeg < -2;
    if (isMoon) {
      // moon opposite-ish the sun, fixed high position
      this.sun.color.copy(moonCol);
      this.sun.intensity = 0.35;
      this._lightDir = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
    } else {
      this.sun.color.copy(sunCol);
      this.sun.intensity = THREE.MathUtils.lerp(1.2, 3.4, day) * dusk;
      this._lightDir = this.sunDir.clone();
      if (this._lightDir.y < 0.06) this._lightDir.y = 0.06;
      this._lightDir.normalize();
    }
    this.hemi.intensity = THREE.MathUtils.lerp(0.05, 0.45, dusk) * (0.6 + 0.4 * day);
    this.hemi.color.set('#ffc49a').lerp(new THREE.Color('#bcd4f5'), day).lerp(new THREE.Color('#223055'), this.night);
    this.hemi.groundColor.set('#3a3a2a').lerp(new THREE.Color('#10131a'), this.night);

    const fog = new THREE.Color('#aec3d8').lerp(new THREE.Color('#d9a888'), golden * 0.8).lerp(new THREE.Color('#0b1020'), this.night);
    this.scene.fog.color.copy(fog);
    this.fogColor = fog;
    // height fog: a touch denser (morning/evening haze) when the sun is low
    this.scene.fog.density = THREE.MathUtils.lerp(0.00032, 0.0002, day) * (1 - this.night * 0.25);
    FOG.sunDir.value.copy(this._lightDir);
    FOG.sunColor.value.copy(sunCol).lerp(new THREE.Color('#ffd9a8'), 0.4).multiplyScalar(isMoon ? 0.15 : 1.05 * dusk).lerp(fog, 0.3);

    const cu = this.cloudUniforms;
    cu.uSunCol.value.copy(sunCol).lerp(new THREE.Color('#ffd0a8'), golden * 0.5);
    cu.uSkyCol.value.copy(fog);
    cu.uNight.value = this.night;

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.62, 0.52, day) + this.night * 0.25;
    this.envDirty = true;
  }

  /** Regenerate the IBL environment map (call after time changes). */
  updateEnvironment(dt = 0) {
    this._envCooldown = (this._envCooldown ?? 0) - dt;
    if (!this.envDirty || this._envCooldown > 0) return;
    this._envCooldown = 0.25; // throttle while the time slider is dragged
    this.envDirty = false;
    this.envGround.material.color.set('#3b4a30').multiplyScalar(0.25 + 0.75 * (1 - this.night));
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.03, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.9, 0.12, this.night);
  }

  /** Follow the camera: sky/cloud domes and the shadow frustum. */
  update(dt, camera, focus) {
    this.time += dt;
    this.sky.position.copy(camera.position);
    this.clouds.position.copy(camera.position);
    this.cloudUniforms.uTime.value = this.time;
    this.cloudUniforms.uCam.value.copy(camera.position);
    // shadow frustum centred slightly ahead of the car, texel-snapped to avoid shimmer
    const d = this._lightDir || this.sunDir;
    const texel = 190 / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx, focus.y, fz).addScaledVector(d, 400);
    this.sun.target.updateMatrixWorld();
  }

  setShadowQuality(size) {
    const enabled = size > 0;
    this.renderer.shadowMap.enabled = enabled;
    this.sun.castShadow = enabled;
    if (enabled) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.scene.traverse((o) => {
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true));
    });
  }
}
