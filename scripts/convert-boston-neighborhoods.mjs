// Build the Boston Neighborhoods layer from boston_neighborhoods.geojson (the
// 69 neighborhood statistical areas from the Potential Years of Life Lost
// maps). The source is in NAD83 / Massachusetts Mainland (US survey feet,
// EPSG:2249), so every vertex is projected back to longitude/latitude with
// the inverse Lambert Conformal Conic (2SP) formulas (EPSG Guidance Note 7-2).
// Writes src/data/local_data/boston/neighborhoods.geojsonl.
// Usage: node scripts/convert-boston-neighborhoods.mjs [input.geojson]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input =
  process.argv[2] ?? 'data/source/boston/boston_neighborhoods.geojson';
const outDir = 'src/data/local_data/boston';
const SQ_FT_PER_SQ_MI = 5280 ** 2;

// EPSG:2249 parameters (from the file's .qmd metadata).
const US_FOOT_M = 1200 / 3937;
const A = 6378137;
const F = 1 / 298.257222101;
const E = Math.sqrt(2 * F - F * F);
const RAD = Math.PI / 180;
const LAT0 = 41 * RAD;
const LON0 = -71.5 * RAD;
const LAT1 = 42.6833333333333 * RAD;
const LAT2 = 41.7166666666667 * RAD;
const X0 = 200000;
const Y0 = 750000;

const m = (phi) => Math.cos(phi) / Math.sqrt(1 - (E * Math.sin(phi)) ** 2);
const t = (phi) =>
  Math.tan(Math.PI / 4 - phi / 2) /
  ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2);
const N =
  (Math.log(m(LAT1)) - Math.log(m(LAT2))) /
  (Math.log(t(LAT1)) - Math.log(t(LAT2)));
const FF = m(LAT1) / (N * t(LAT1) ** N);
const R0 = A * FF * t(LAT0) ** N;

/** [easting, northing] in US feet -> [lon, lat] in degrees. */
function massStatePlaneToLonLat([eastFt, northFt]) {
  const x = eastFt * US_FOOT_M - X0;
  const y = R0 - (northFt * US_FOOT_M - Y0);
  const r = Math.sign(N) * Math.hypot(x, y);
  const tp = (r / (A * FF)) ** (1 / N);
  const lon = Math.atan2(x, y) / N + LON0;
  let lat = Math.PI / 2 - 2 * Math.atan(tp);
  for (let i = 0; i < 10; i++) {
    const s = E * Math.sin(lat);
    lat = Math.PI / 2 - 2 * Math.atan(tp * ((1 - s) / (1 + s)) ** (E / 2));
  }
  return [+(lon / RAD).toFixed(6), +(lat / RAD).toFixed(6)];
}

function projectRings(value) {
  return typeof value[0] === 'number'
    ? massStatePlaneToLonLat(value)
    : value.map(projectRings);
}

function main() {
  const source = JSON.parse(readFileSync(input, 'utf8'));
  const lines = source.features.map((feature) => {
    const p = feature.properties;
    const areaSqMi = +(p.SHAPE_area / SQ_FT_PER_SQ_MI).toFixed(2);
    return JSON.stringify({
      type: 'Feature',
      id: `nsa-${p.OBJECTID}`,
      properties: {
        name: p.NSA_NAME,
        neighborhood: p.Nbhd,
        neighborhood_id: p.HOODS_PD_I,
        area_sq_mi: areaSqMi,
        summary: `One of Boston's 69 neighborhood statistical areas, in the ${p.Nbhd} group (${areaSqMi} sq mi).`,
        source_note:
          'boston_neighborhoods.geojson, Potential Years of Life Lost maps (Sep 2026)',
      },
      geometry: {
        type: feature.geometry.type,
        coordinates: projectRings(feature.geometry.coordinates),
      },
    });
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/neighborhoods.geojsonl`, `${lines.join('\n')}\n`);
  console.log(`${lines.length} areas -> ${outDir}/neighborhoods.geojsonl`);
}

main();
