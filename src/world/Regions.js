import { coastLine, ISLAND, LAKE } from './Terrain.js';

/**
 * Regions.js
 * ----------
 * The ten regions of the map (named after Horizon Japan's) with where their
 * name is written on the world map, and a lookup for the HUD banner.
 */

export const REGIONS = [
  { name: 'TOKYO CITY', x: -2010, z: 330 },
  { name: 'LEGEND\nISLAND', x: -3560, z: -80 },
  { name: 'ITO', x: -2080, z: -2750 },
  { name: 'NANGAN', x: 700, z: -2950 },
  { name: 'MINAMINO', x: 1650, z: -1150 },
  { name: 'OHTANI', x: -520, z: -900 },
  { name: 'HOKUBU', x: -700, z: 2080 },
  { name: 'SHIMANOYAMA', x: 2100, z: 2350 },
  { name: 'TAKASHIRO', x: 1700, z: 3350 },
  { name: 'SOTOYAMA', x: -1500, z: 3250 },
];

/** Region name at x,z (towns and the festival are resolved by the caller first). */
export function regionName(x, z) {
  if (Math.hypot(x - ISLAND.x, z - ISLAND.z) < ISLAND.r + 150) return 'Legend Island';
  if (x < coastLine(z) - 40) return z > -1500 && z < 400 ? 'Tokyo Bay' : 'Pacific Ocean';
  if (z > 2450 + (x > 0 ? 0 : 100)) return x > 0 ? 'Takashiro' : 'Sotoyama';
  const sx = (x - LAKE.x) / 1250, sz = (z - LAKE.z) / 1000;
  if (sx * sx + sz * sz < 1) return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 200 ? 'Lake Haruna' : 'Shimanoyama';
  if (z > 1000) return 'Hokubu';
  if (x < -1550 && z < -1250) return 'Ito';
  if (z < -2100) return 'Nangan';
  if (x > 600) return 'Minamino';
  return 'Ohtani';
}
