import * as THREE from 'three';

/**
 * Instancing.js
 * -------------
 * Splits a big set of instances into spatial chunks (one InstancedMesh each)
 * so three.js can frustum-cull them — and, just as important, skip the ones
 * outside the sun's shadow frustum. Optional draw distance per chunk.
 */

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

export class ChunkedInstances {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {Array} items anything with x, z
   * @param {object} opts { chunk, castShadow, receiveShadow, maxDistance, colors (bool), write(item, matrix, color) }
   */
  constructor(scene, geometry, material, items, opts = {}) {
    const size = opts.chunk ?? 256;
    this.maxDistance = opts.maxDistance ?? Infinity;
    this.chunks = [];
    const buckets = new Map();
    for (const it of items) {
      const k = `${Math.floor(it.x / size)},${Math.floor(it.z / size)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    }
    for (const list of buckets.values()) {
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      let cx = 0, cz = 0;
      list.forEach((it, i) => {
        _c.setRGB(1, 1, 1);
        opts.write(it, _m, _c);
        mesh.setMatrixAt(i, _m);
        if (opts.colors) mesh.setColorAt(i, _c);
        cx += it.x; cz += it.z;
      });
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
      this.chunks.push({ mesh, x: cx / list.length, z: cz / list.length });
    }
    this.count = items.length;
  }

  /** Hide chunks beyond the draw distance. */
  update(cam) {
    if (!isFinite(this.maxDistance)) return;
    const d2 = this.maxDistance * this.maxDistance;
    for (const c of this.chunks) c.mesh.visible = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 < d2;
  }
}
