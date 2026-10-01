// Keep only the features of a GeoJSON Lines layer that lie in the United
// States (the 50 states, DC and Puerto Rico), using the Census 2024 tract
// outlines as the boundary. A feature is kept when the center of its bounding
// box falls inside a tract. Coordinates are rounded to 6 decimals (~0.1 m)
// on the way through.
// The tract shapefile comes from data/source/air-quality/ (see
// scripts/build-environment-layers.mjs for where it is downloaded).
// Usage: node scripts/filter-points-to-us.mjs <file.geojsonl> [...more files]
//   Each file is rewritten in place; the counts kept/dropped are printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { pointInRing, readShapefile } from './lib/shapefile.mjs';

const TRACT_SHP =
  'data/source/air-quality/cb_2024_us_tract_500k/cb_2024_us_tract_500k';
const CELL_DEG = 0.5;

function rings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bbox(coordinates) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (value) => {
    if (typeof value[0] === 'number') {
      if (value[0] < box[0]) box[0] = value[0];
      if (value[1] < box[1]) box[1] = value[1];
      if (value[0] > box[2]) box[2] = value[0];
      if (value[1] > box[3]) box[3] = value[1];
    } else value.forEach(visit);
  };
  visit(coordinates);
  return box;
}

/** Grid index of tract polygons by 0.5-degree cell. */
function buildIndex() {
  const index = new Map();
  for (const { geometry } of readShapefile(TRACT_SHP)) {
    for (const polygon of rings(geometry)) {
      const [w, s, e, n] = bbox(polygon[0]);
      for (let x = Math.floor(w / CELL_DEG); x <= Math.floor(e / CELL_DEG); x++) {
        for (let y = Math.floor(s / CELL_DEG); y <= Math.floor(n / CELL_DEG); y++) {
          const key = `${x},${y}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(polygon);
        }
      }
    }
  }
  return index;
}

function insideUs(index, [lon, lat]) {
  const candidates =
    index.get(`${Math.floor(lon / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`) ||
    [];
  return candidates.some(
    (polygon) =>
      pointInRing([lon, lat], polygon[0]) &&
      !polygon.slice(1).some((hole) => pointInRing([lon, lat], hole)),
  );
}

const round6 = (coordinates) =>
  typeof coordinates[0] === 'number'
    ? coordinates.map((v) => Math.round(v * 1e6) / 1e6)
    : coordinates.map(round6);

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/filter-points-to-us.mjs <file.geojsonl> ...');
  process.exit(1);
}
const index = buildIndex();
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = [];
  for (const line of lines) {
    const feature = JSON.parse(line);
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates) continue;
    const [w, s, e, n] = bbox(coordinates);
    if (!insideUs(index, [(w + e) / 2, (s + n) / 2])) continue;
    feature.geometry.coordinates = round6(coordinates);
    kept.push(JSON.stringify(feature));
  }
  writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
  console.log(`${file}: kept ${kept.length} of ${lines.length}`);
}
