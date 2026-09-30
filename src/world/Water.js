import * as THREE from 'three';
import { mulberry32 } from './Noise.js';
import { SEA_LEVEL, LAKE, lakeRadius } from './Terrain.js';

/**
 * Water.js
 * --------
 * Ocean (to the horizon beyond the west coast) and Lake Sakura.
 * MeshPhysicalMaterial patched with:
 *  - two scrolling tileable normal maps (large swell + fine ripples), with
 *    wave strength fading out towards the horizon to kill tiling/aliasing
 *  - depth from the terrain height texture: turquoise shallows → deep blue,
 *    see-through at the shoreline, animated foam where the water meets land
 *  - sky reflections from the scene environment map (Fresnel-weighted by the
 *    physical material), sun glints from the directional light
 */

/** Tileable fractal-noise height field → normal map (no visible wave pattern). */
function waterNormalTexture(size = 512, seed = 7) {
  const rnd = mulberry32(seed);
  const H = new Float32Array(size * size);
  let amp = 1;
  for (let o = 0; o < 6; o++) {
    const cells = 4 << o;
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const a = g[(iy % cells) * cells + (ix % cells)], b = g[(iy % cells) * cells + ((ix + 1) % cells)];
        const c = g[((iy + 1) % cells) * cells + (ix % cells)], d = g[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
        // ridged-ish: sharper crests like real wavelets
        const v = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
        H[y * size + x] += (1 - Math.abs(v * 2 - 1)) * amp;
      }
    }
    amp *= 0.5;
  }
  const data = new Uint8Array(size * size * 4);
  const h = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 3.2, dy = (h(x, y + 1) - h(x, y - 1)) * 3.2;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = (-dx / l * 0.5 + 0.5) * 255;
      data[o + 1] = (-dy / l * 0.5 + 0.5) * 255;
      data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export class Water {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.uniforms = {
      uTime: { value: 0 },
      uNormal: { value: waterNormalTexture() },
      uHeight: { value: terrain.heightTexture() },
      uWorld: { value: new THREE.Vector3(terrain.half, terrain.size, terrain.n1) },
      uDeep: { value: new THREE.Color('#0b2a3d') },
      uShallow: { value: new THREE.Color('#2f8f94') },
      uFoam: { value: new THREE.Color('#e8f2f2') },
      uNight: { value: 0 },
    };
    this.meshes = [];
  }

  _material(level, lake) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true,
      clearcoat: 0, envMapIntensity: 1.1, specularIntensity: 1,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.uniforms.uLevel = { value: level };
      sh.uniforms.uLakeTint = { value: lake ? 1 : 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterPos;
          uniform float uTime;
          uniform sampler2D uNormal;
          uniform sampler2D uHeight;
          uniform vec3 uWorld;
          uniform vec3 uDeep;
          uniform vec3 uShallow;
          uniform vec3 uFoam;
          uniform float uLevel;
          uniform float uLakeTint;
          uniform float uNight;
          float gDepth;
          float gFoam;
          float groundH(vec2 p) {
            vec2 g = (p + uWorld.x) / uWorld.y * (uWorld.z - 1.0);
            vec2 uv = (g + 0.5) / uWorld.z;
            if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return uLevel - 60.0;
            return texture2D(uHeight, uv).r;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float ground = groundH(vWaterPos.xz);
            gDepth = max(0.0, uLevel - ground);
            float shallow = exp(-gDepth * 0.22);
            vec3 deep = mix(uDeep, uDeep * vec3(0.8, 1.05, 0.9), uLakeTint);
            vec3 col = mix(deep, uShallow * mix(1.0, 0.8, uLakeTint), shallow);
            // shoreline foam: animated bands where the water gets thin
            float t = uTime;
            float band = sin(gDepth * 9.0 - t * 1.6 + vWaterPos.x * 0.05) * 0.5 + 0.5;
            float nz = texture2D(uNormal, vWaterPos.xz * 0.05 + t * 0.01).r;
            gFoam = (1.0 - smoothstep(0.05, 0.55, gDepth)) * (0.55 + 0.45 * band) * smoothstep(0.35, 0.6, nz + 0.2);
            gFoam += (1.0 - smoothstep(0.0, 0.12, gDepth)) * 0.5;
            col = mix(col, uFoam, clamp(gFoam, 0.0, 1.0));
            col *= 1.0 - uNight * 0.5;
            diffuseColor.rgb = col;
            diffuseColor.a = mix(0.35, 0.96, smoothstep(0.0, 2.5, gDepth)) + gFoam * 0.3;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(0.035, 0.6, clamp(gFoam, 0.0, 1.0));`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            float dist = length(vViewPosition);
            vec2 p = vWaterPos.xz;
            vec3 n1 = texture2D(uNormal, p * 0.0071 + vec2(uTime * 0.004, uTime * 0.003)).xyz * 2.0 - 1.0;
            vec3 n2 = texture2D(uNormal, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.031 + vec2(-uTime * 0.011, uTime * 0.008)).xyz * 2.0 - 1.0;
            vec3 n3 = texture2D(uNormal, mat2(0.28, 0.96, -0.96, 0.28) * p * 0.13 + vec2(uTime * 0.027, -uTime * 0.018)).xyz * 2.0 - 1.0;
            float fade = 1.0 - smoothstep(150.0, 2600.0, dist);
            float fine = 1.0 - smoothstep(20.0, 260.0, dist);
            vec3 nw = normalize(vec3((n1.xy * 0.9 + n2.xy * 0.55 * fade + n3.xy * 0.4 * fine) * mix(0.25, 1.0, fade), 1.0));
            nw = normalize(vec3(nw.x, nw.z, nw.y)); // tangent space → world (Y up)
            normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          }`);
    };
    return mat;
  }

  build() {
    // Ocean: a big plane from the coast out to the horizon
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(26000, 34000, 1, 1).rotateX(-Math.PI / 2), this._material(SEA_LEVEL, false));
    ocean.position.set(1900 + 13000, SEA_LEVEL, 0);
    ocean.renderOrder = 1;
    ocean.receiveShadow = true;
    ocean.name = 'Ocean';
    this.scene.add(ocean);

    // Lake: a disc that follows the irregular shoreline (+ margin)
    const shape = new THREE.Shape();
    const N = 96;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = lakeRadius(a) + 45;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
    }
    const lakeGeo = new THREE.ShapeGeometry(shape, 1).rotateX(-Math.PI / 2);
    const lake = new THREE.Mesh(lakeGeo, this._material(LAKE.level, true));
    lake.position.set(LAKE.x, LAKE.level, LAKE.z);
    lake.renderOrder = 1;
    lake.receiveShadow = true;
    lake.name = 'Lake';
    this.scene.add(lake);
    this.meshes.push(ocean, lake);
    return this;
  }

  setNight(n) {
    this.uniforms.uNight.value = n;
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
  }
}
