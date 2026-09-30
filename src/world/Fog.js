import * as THREE from 'three';

/**
 * Fog.js
 * ------
 * Replaces three.js' exponential fog with height fog + sun in-scattering:
 *  - density falls off exponentially with altitude and is integrated along
 *    the view ray, so valleys and the sea haze over while mountain tops and
 *    the distant Fuji stay crisp (aerial perspective)
 *  - the fog colour warms towards the sun (golden haze at sunset)
 * Installed by patching the shared fog shader chunks once at start-up; every
 * material gets the extra uniforms through `patchFogMaterials(scene)`.
 * Materials that are never patched fall back to plain exponential fog.
 */

export const FOG = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  sunColor: { value: new THREE.Color(1, 0.9, 0.7) },
  falloff: { value: 0.0032 },
  base: { value: 0 },
};

let installed = false;
export function installHeightFog() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif`;
  C.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vFogWorld = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);
    #endif`;
  C.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogWorld;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
      uniform vec3 uFogSunDir;
      uniform vec3 uFogSunColor;
      uniform float uFogFalloff;
      uniform float uFogBase;
    #endif`;
  C.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        vec3 fogRay = vFogWorld - cameraPosition;
        float fogDist = length(fogRay);
        float heightTerm = 1.0;
        if (uFogFalloff > 0.0) {
          float h0 = max(cameraPosition.y - uFogBase, -50.0);
          float h1 = max(vFogWorld.y - uFogBase, -50.0);
          float dy = h1 - h0;
          float e0 = exp(-uFogFalloff * h0);
          heightTerm = abs(dy) > 0.5 ? (e0 - exp(-uFogFalloff * h1)) / (uFogFalloff * dy) : e0;
        }
        float fogFactor = 1.0 - exp(-fogDist * fogDensity * heightTerm);
        float sunAmt = pow(max(dot(fogRay / max(fogDist, 1e-3), uFogSunDir), 0.0), 6.0);
        vec3 fogCol = mix(fogColor, uFogSunColor, sunAmt * 0.75);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        vec3 fogCol = fogColor;
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, clamp(fogFactor, 0.0, 1.0));
    #endif`;
}

/** Hook every material in the scene so its shader receives the height-fog uniforms. */
export function patchFogMaterials(root) {
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) patchFogMaterial(m);
  });
}

export function patchFogMaterial(m) {
  if (!m || m.userData.heightFog || !m.fog) return;
  m.userData.heightFog = true;
  // keep program caching distinct per material type (three keys on onBeforeCompile's source)
  const key = m.customProgramCacheKey();
  m.customProgramCacheKey = () => `${key}|hfog`;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.uFogSunDir = FOG.sunDir;
    sh.uniforms.uFogSunColor = FOG.sunColor;
    sh.uniforms.uFogFalloff = FOG.falloff;
    sh.uniforms.uFogBase = FOG.base;
  };
  m.needsUpdate = true;
}
