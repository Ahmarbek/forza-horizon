import { SURFACE } from '../Vehicle.js';
import { fbm } from './Noise.js';

/**
 * Surfaces.js
 * -----------
 * 2 m grid over the whole world answering "what is the tyre standing on?"
 * Roads (asphalt, gravel shoulders, dirt tracks), paved areas and beaches are
 * painted up front; everything else is classified lazily from the terrain
 * (snow above the snow line, rock on steep slopes, sand at the shoreline,
 * dirt patches, grass) the first time a wheel touches that cell.
 */

const CELL = 2;

export class SurfaceMap {
  constructor(terrain) {
    this.terrain = terrain;
    this.half = terrain.half;
    this.res = Math.round(terrain.size / CELL);
    this.grid = new Uint8Array(this.res * this.res); // 0 = not classified yet
  }

  _idx(x, z) {
    const ix = Math.floor((x + this.half) / CELL), iz = Math.floor((z + this.half) / CELL);
    if (ix < 0 || iz < 0 || ix >= this.res || iz >= this.res) return -1;
    return iz * this.res + ix;
  }

  /** Paint a route: `inner` surface out to the half width, `shoulder` beyond it. */
  paintRoute(route, inner = SURFACE.asphalt, shoulder = SURFACE.gravel, shoulderWidth = 2.4) {
    const hw = route.width / 2;
    const reach = hw + shoulderWidth;
    const rc = Math.ceil(reach / CELL) + 1;
    const g = this.grid, R = this.res;
    for (let i = 0; i < route.count; i++) {
      const x = route.xs[i], z = route.zs[i];
      const cx = Math.floor((x + this.half) / CELL), cz = Math.floor((z + this.half) / CELL);
      for (let dz = -rc; dz <= rc; dz++) {
        const iz = cz + dz;
        if (iz < 0 || iz >= R) continue;
        for (let dx = -rc; dx <= rc; dx++) {
          const ix = cx + dx;
          if (ix < 0 || ix >= R) continue;
          const px = -this.half + (ix + 0.5) * CELL, pz = -this.half + (iz + 0.5) * CELL;
          const d = Math.hypot(px - x, pz - z);
          const k = iz * R + ix;
          if (d <= hw + 0.6) g[k] = inner.id;
          else if (d <= reach && g[k] !== inner.id && g[k] !== SURFACE.asphalt.id) g[k] = shoulder.id;
        }
      }
    }
  }

  paintRect(minX, minZ, maxX, maxZ, surface) {
    for (let z = minZ; z <= maxZ; z += CELL) {
      for (let x = minX; x <= maxX; x += CELL) {
        const k = this._idx(x, z);
        if (k >= 0) this.grid[k] = surface.id;
      }
    }
  }

  paintCircle(cx, cz, r, surface, onlyEmpty = false) {
    for (let z = cz - r; z <= cz + r; z += CELL) {
      for (let x = cx - r; x <= cx + r; x += CELL) {
        if ((x - cx) ** 2 + (z - cz) ** 2 > r * r) continue;
        const k = this._idx(x, z);
        if (k >= 0 && (!onlyEmpty || this.grid[k] === 0)) this.grid[k] = surface.id;
      }
    }
  }

  /** Surface object at world x,z. */
  at(x, z) {
    const k = this._idx(x, z);
    if (k < 0) return SURFACE.grass;
    let id = this.grid[k];
    if (id === 0) id = this.grid[k] = this._classify(x, z);
    return SURFACE_BY_ID[id];
  }

  _classify(x, z) {
    const t = this.terrain;
    const h = t.heightAt(x, z);
    const e = 2;
    const slope = Math.hypot(t.heightAt(x + e, z) - t.heightAt(x - e, z), t.heightAt(x, z + e) - t.heightAt(x, z - e)) / (2 * e);
    const snowLine = (t.snowLine ?? 230) - 160 * Math.min(1, Math.max(0, (z - 2400) / 800)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (z - 2400) / 800)));
    if (h > snowLine + fbm(x / 40, z / 40, 2) * 50 && slope < 0.8) return SURFACE.snow.id;
    if (slope > 0.55) return SURFACE.rock.id;
    const water = t.waterLevel ?? -1000;
    if (h < water + 2.2) return SURFACE.sand.id;
    if (t.isFarmland && t.isFarmland(x, z)) return SURFACE.dirt.id;
    if (fbm(x / 83 + 7, z / 83 + 7, 3) > 0.34) return SURFACE.dirt.id;
    return SURFACE.grass.id;
  }
}

const SURFACE_BY_ID = [];
for (const s of Object.values(SURFACE)) SURFACE_BY_ID[s.id] = s;
