import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Shaders.js
 * ----------
 * Custom GLSL used across the prototype:
 *  - Dynamic gradient sky dome with sun disk, glow and horizon haze
 *  - Procedural ground shader (world-space noise injected into MeshStandard)
 *  - Additive taillight glow billboards driven by brake input
 *  - Falling sakura petal particles
 *  - Speed blur + vignette post-effect and the EffectComposer pipeline
 */

// Shared GLSL value-noise helpers.
const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.1, 9.2);
      a *= 0.5;
    }
    return v;
  }
`;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------
export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'DynamicSky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() },
      uZenith: { value: new THREE.Color('#2f6fd6') },
      uHorizon: { value: new THREE.Color('#bfd9f2') },
      uGround: { value: new THREE.Color('#6d7f8f') },
      uSunColor: { value: new THREE.Color('#fff2d6') },
      uSunset: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // push to far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunColor;
      uniform float uSunset;
      uniform float uTime;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        // Base vertical gradient
        float t = pow(clamp(h, 0.0, 1.0), 0.45);
        vec3 col = mix(uHorizon, uZenith, t);
        // Warm sunset band near the horizon, strongest towards the sun
        float sunAmt = max(dot(dir, uSunDir), 0.0);
        vec3 warm = vec3(1.0, 0.55, 0.3);
        col = mix(col, warm, uSunset * pow(1.0 - clamp(h, 0.0, 1.0), 6.0) * (0.35 + 0.65 * pow(sunAmt, 3.0)));
        // Below horizon fades into ground haze
        col = mix(col, uGround, smoothstep(0.0, -0.25, h));
        // Soft cirrus clouds
        if (h > 0.0) {
          vec2 uv = dir.xz / (h + 0.15) * 1.3;
          float c = fbm(uv + vec2(uTime * 0.004, uTime * 0.002));
          c = smoothstep(0.55, 0.85, c) * smoothstep(0.0, 0.25, h);
          col = mix(col, mix(vec3(1.0), uSunColor, 0.4), c * 0.55);
        }
        // Sun glow + disk (HDR so bloom catches it)
        col += uSunColor * pow(sunAmt, 8.0) * 0.35;
        col += uSunColor * pow(sunAmt, 64.0) * 0.8;
        col += uSunColor * smoothstep(0.9993, 0.9997, sunAmt) * 12.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Ground (grass / dirt) — MeshStandardMaterial with injected world-space noise
// ---------------------------------------------------------------------------
export function createGroundMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        vec2 gp = vWorldPos.xz;
        float large = fbm(gp * 0.012);
        float mid = fbm(gp * 0.08);
        float fine = vnoise(gp * 1.7);
        vec3 grassA = vec3(0.16, 0.30, 0.07);
        vec3 grassB = vec3(0.30, 0.42, 0.12);
        vec3 dirt = vec3(0.34, 0.28, 0.20);
        vec3 petals = vec3(0.95, 0.62, 0.75);
        vec3 g = mix(grassA, grassB, smoothstep(0.3, 0.7, large));
        g = mix(g, dirt, smoothstep(0.62, 0.8, mid) * 0.55);
        g *= 0.85 + 0.3 * fine;
        // scattered fallen blossom petals
        float p = step(0.985, hash12(floor(gp * 3.0))) * smoothstep(0.45, 0.6, large);
        g = mix(g, petals, p * 0.8);
        diffuseColor.rgb *= g;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp(0.8 + 0.2 * vnoise(vWorldPos.xz * 0.5), 0.0, 1.0);'
      );
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Taillight glow (additive billboard quad, brightness follows brake input)
// ---------------------------------------------------------------------------
export function createTaillightGlowMaterial(color = '#ff1030') {
  return new THREE.ShaderMaterial({
    name: 'TaillightGlow',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 0.35 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(2.0, 2.0);
        // horizontally stretched streak + round core
        float core = exp(-dot(p * vec2(1.2, 3.5), p * vec2(1.2, 3.5)) * 3.0);
        float streak = exp(-abs(p.y) * 14.0) * (1.0 - smoothstep(0.2, 1.0, abs(p.x)));
        float a = (core + streak * 0.5) * uIntensity;
        gl_FragColor = vec4(uColor * a * 2.5, a);
      }
    `,
  });
}

/** Emissive lens material for tail/brake lights (bloom source). */
export function createLightLensMaterial(color, intensity) {
  return new THREE.MeshStandardMaterial({
    color: 0x220000,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.3,
    metalness: 0,
  });
}

// ---------------------------------------------------------------------------
// Falling sakura petals (GPU animated points around the camera)
// ---------------------------------------------------------------------------
export function createPetalMaterial() {
  return new THREE.ShaderMaterial({
    name: 'Petals',
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: 60 },
      uWind: { value: new THREE.Vector2(1.2, 0.4) },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCenter;
      uniform float uBox;
      uniform vec2 uWind;
      uniform float uPixelRatio;
      attribute float aSeed;
      varying float vSeed;
      varying float vFade;
      void main() {
        vSeed = aSeed;
        vec3 p = position;
        float fall = uTime * (0.6 + aSeed * 0.8);
        p.y = mod(p.y - fall, 22.0);
        p.x += uWind.x * uTime + sin(uTime * 1.3 + aSeed * 40.0) * 0.8;
        p.z += uWind.y * uTime + cos(uTime * 1.1 + aSeed * 23.0) * 0.8;
        // Wrap into a box centred on the camera so particles are always near
        vec3 rel = p - uCenter;
        rel.xz = mod(rel.xz + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 world = vec3(uCenter.x + rel.x, p.y, uCenter.z + rel.z);
        vec4 mv = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (4.0 + aSeed * 4.0) * uPixelRatio * (30.0 / -mv.z);
        vFade = smoothstep(uBox * 0.5, uBox * 0.3, length(rel.xz)) * smoothstep(0.0, 2.0, p.y);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vSeed;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float ang = vSeed * 6.2831;
        c = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
        float d = length(c * vec2(1.0, 1.9));
        float a = smoothstep(0.5, 0.35, d) * vFade * 0.9;
        if (a < 0.01) discard;
        vec3 col = mix(vec3(1.0, 0.72, 0.84), vec3(1.0, 0.9, 0.95), vSeed);
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Post-processing: speed blur + vignette
// ---------------------------------------------------------------------------
export const SpeedBlurShader = {
  name: 'SpeedBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.52) },
    uVignette: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform vec2 uCenter;
    uniform float uVignette;
    varying vec2 vUv;
    const int SAMPLES = 10;
    void main() {
      vec2 dir = vUv - uCenter;
      float dist = length(dir);
      // Only blur toward the edges, keep the car sharp
      float mask = smoothstep(0.12, 0.55, dist);
      vec2 stepv = dir * uStrength * mask * 0.045 / float(SAMPLES);
      vec4 acc = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float w = 1.0 - float(i) / float(SAMPLES) * 0.6;
        acc += texture2D(tDiffuse, vUv - stepv * float(i)) * w;
        total += w;
      }
      vec4 col = acc / total;
      float vig = smoothstep(0.85, 0.25, dist * (1.0 + uStrength * 0.25));
      col.rgb *= mix(1.0 - uVignette, 1.0, vig);
      gl_FragColor = col;
    }
  `,
};

/**
 * Build the post pipeline: Render → Bloom → SpeedBlur → Output (tone map + sRGB).
 */
export function createPostProcessing(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  // MSAA HDR target so the composer path keeps anti-aliasing.
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    samples: renderer.capabilities.isWebGL2 === false ? 0 : 4,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.5, 0.92);
  const blurPass = new ShaderPass(SpeedBlurShader);
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(blurPass);
  composer.addPass(outputPass);

  return {
    composer,
    bloomPass,
    blurPass,
    blurEnabled: true,
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
      bloomPass.resolution.set(w, h);
    },
    /** speed01: 0..1 normalised speed */
    setSpeed(speed01) {
      const s = this.blurEnabled ? Math.max(0, speed01 - 0.35) / 0.65 : 0;
      blurPass.uniforms.uStrength.value = s * s * 1.6;
      blurPass.enabled = s > 0.001 || blurPass.uniforms.uVignette.value > 0;
    },
    render(dt) {
      composer.render(dt);
    },
  };
}
