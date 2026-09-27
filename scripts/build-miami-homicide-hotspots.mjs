// Build the Miami-Dade homicide hotspot surface from
// data/source/miami_dade_homicides.geojson: a kernel density estimate
// (quartic kernel) of every homicide 1956-2011 on a regular grid, classed into
// top-weighted percentile bands and written as ground cells for the chunked area layer:
//   public/context/miami-homicide-hotspots/index.json
//   public/context/miami-homicide-hotspots/miami-dade.geojsonl
// Adjacent cells of the same band in a row are merged into one rectangle, so
// the file stays small. Cells below MIN_DENSITY are left empty (no fill).
// The band breaks and counts are printed; HOMICIDE_HOTSPOT_BANDS and the source
// note in src/data/infrastructure.js carry the same values.
// Usage: node scripts/build-miami-homicide-hotspots.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const INPUT = 'data/source/miami_dade_homicides.geojson';
const OUT_DIR = 'public/context/miami-homicide-hotspots';
/** Kernel radius (m): about a dozen city blocks. */
const BANDWIDTH_M = 800;
const CELL_M = 200;
/** Homicides per km² (whole period) below which a cell is not drawn. */
const MIN_DENSITY = 1;
const BANDS = 6;

/**
 * A coordinate shared by this many incidents with STACK_MIN_ADDRESSES or more
 * different addresses is a fallback geocode (one point stands in for 277
 * incidents county-wide; others are street-level matches), not a place. Such
 * stacks are left out of the density so they do not show as false hotspots;
 * the pin layers still show them.
 */
const STACK_MIN_INCIDENTS = 10;
const STACK_MIN_ADDRESSES = 3;

const features = JSON.parse(readFileSync(INPUT, 'utf8')).features.filter(
  (f) =>
    Number.isFinite(f.geometry?.coordinates?.[0]) &&
    Number.isFinite(f.geometry?.coordinates?.[1]),
);
const stackKey = (f) =>
  f.geometry.coordinates.map((v) => v.toFixed(5)).join(',');
const stacks = new Map();
for (const f of features) {
  const key = stackKey(f);
  if (!stacks.has(key)) stacks.set(key, { count: 0, addresses: new Set() });
  const stack = stacks.get(key);
  stack.count += 1;
  stack.addresses.add(String(f.properties?.Incident_a ?? '').toLowerCase());
}
const isFallbackStack = (f) => {
  const stack = stacks.get(stackKey(f));
  return (
    stack.count >= STACK_MIN_INCIDENTS &&
    stack.addresses.size >= STACK_MIN_ADDRESSES
  );
};
const points = features
  .filter((f) => !isFallbackStack(f))
  .map((f) => f.geometry.coordinates);
const excluded = features.length - points.length;

// Local equirectangular metres around the data's center; accurate to well
// under a cell across one county.
const lon0 = points.reduce((s, [lon]) => s + lon, 0) / points.length;
const lat0 = points.reduce((s, [, lat]) => s + lat, 0) / points.length;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((lat0 * Math.PI) / 180);
const toXY = ([lon, lat]) => [
  (lon - lon0) * M_PER_DEG_LON,
  (lat - lat0) * M_PER_DEG_LAT,
];
const toLonLat = (x, y) => [
  Math.round((lon0 + x / M_PER_DEG_LON) * 1e6) / 1e6,
  Math.round((lat0 + y / M_PER_DEG_LAT) * 1e6) / 1e6,
];

const xy = points.map(toXY);
const minX = Math.min(...xy.map((p) => p[0])) - BANDWIDTH_M;
const maxX = Math.max(...xy.map((p) => p[0])) + BANDWIDTH_M;
const minY = Math.min(...xy.map((p) => p[1])) - BANDWIDTH_M;
const maxY = Math.max(...xy.map((p) => p[1])) + BANDWIDTH_M;
const cols = Math.ceil((maxX - minX) / CELL_M);
const rows = Math.ceil((maxY - minY) / CELL_M);

// Quartic (biweight) kernel, the ArcGIS Kernel Density default, evaluated at
// cell centers; units: homicides per km² over the whole period.
const density = new Float64Array(cols * rows);
const h2 = BANDWIDTH_M * BANDWIDTH_M;
const norm = (3 / (Math.PI * h2)) * 1e6;
const reach = Math.ceil(BANDWIDTH_M / CELL_M);
for (const [px, py] of xy) {
  const ci = Math.floor((px - minX) / CELL_M);
  const cj = Math.floor((py - minY) / CELL_M);
  for (
    let j = Math.max(0, cj - reach);
    j <= Math.min(rows - 1, cj + reach);
    j++
  ) {
    const cy = minY + (j + 0.5) * CELL_M;
    for (
      let i = Math.max(0, ci - reach);
      i <= Math.min(cols - 1, ci + reach);
      i++
    ) {
      const cx = minX + (i + 0.5) * CELL_M;
      const d2 = (cx - px) ** 2 + (cy - py) ** 2;
      if (d2 >= h2) continue;
      const t = 1 - d2 / h2;
      density[j * cols + i] += norm * t * t;
    }
  }
}

// Percentile breaks over the drawn cells, weighted to the top so only true
// hotspots turn orange: the highest band is the top 3% of cells, the next the
// following 7%, and the off-white bands cover the lower 65%.
const BAND_PERCENTILES = [0.4, 0.65, 0.8, 0.9, 0.97];
const drawn = [...density]
  .filter((v) => v >= MIN_DENSITY)
  .sort((a, b) => a - b);
const breaks = [
  MIN_DENSITY,
  ...BAND_PERCENTILES.map((p) => drawn[Math.floor(p * drawn.length)]),
  drawn[drawn.length - 1],
];
const bandOf = (v) => {
  if (v < MIN_DENSITY) return 0;
  for (let k = BANDS; k >= 1; k--) if (v >= breaks[k - 1]) return k;
  return 1;
};
const fmt = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const bandLabels = Array.from(
  { length: BANDS },
  (_, k) => `${fmt(breaks[k])}–${fmt(breaks[k + 1])}`,
);

// Merge same-band runs along each row into rectangles.
const lines = [];
let west = Infinity;
let south = Infinity;
let east = -Infinity;
let north = -Infinity;
for (let j = 0; j < rows; j++) {
  let i = 0;
  while (i < cols) {
    const band = bandOf(density[j * cols + i]);
    let end = i + 1;
    while (end < cols && bandOf(density[j * cols + end]) === band) end++;
    if (band > 0) {
      const x0 = minX + i * CELL_M;
      const x1 = minX + end * CELL_M;
      const y0 = minY + j * CELL_M;
      const y1 = y0 + CELL_M;
      const ring = [
        toLonLat(x0, y0),
        toLonLat(x1, y0),
        toLonLat(x1, y1),
        toLonLat(x0, y1),
        toLonLat(x0, y0),
      ];
      for (const [lon, lat] of ring) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      lines.push(
        JSON.stringify({
          type: 'Feature',
          id: `hotspot-${j}-${i}`,
          properties: {
            name: `Homicide hotspot · band ${band} of ${BANDS}`,
            band,
            summary: `Homicide density ${bandLabels[band - 1]} per km² across 1956–2011 (band ${band} of ${BANDS}, where ${BANDS} is the most concentrated).`,
          },
          geometry: { type: 'Polygon', coordinates: [ring] },
        }),
      );
    }
    i = end;
  }
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const text = `${lines.join('\n')}\n`;
writeFileSync(`${OUT_DIR}/miami-dade.geojsonl`, text);
writeFileSync(
  `${OUT_DIR}/index.json`,
  JSON.stringify([
    { id: 'miami-dade', bbox: [west, south, east, north], count: lines.length },
  ]),
);
console.log(
  `${OUT_DIR}: ${lines.length} cells (${cols}×${rows} grid), ${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB`,
);
console.log(
  `  bands (homicides per km², 1956–2011): ${bandLabels.join(' | ')}`,
);
console.log(
  `  ${points.length} homicides in the density; ${excluded} stacked fallback geocodes left out`,
);
