// Build the nationwide context layers from the source files in data/source/
// (streamed line by line; the tract files are ~2 GB each):
//   - mappinginequality.json           -> HOLC "redlining" areas, every city
//                                         (holc_nation.geojson adds names)
//   - nation_tracts_le.geojson         -> census tracts with life expectancy
//                                         at birth (life_exp_8, USALEEP)
//   - nation_county_le.geojson         -> county life expectancy 2000-2019,
//                                         total and by race/ethnicity
//   - nation_county_le_cluster.geojson -> Local Moran's I clusters of county
//                                         life expectancy (2015)
//   - nation_tracts_le_cluster.geojson -> Local Moran's I clusters of tract
//                                         life expectancy (life_exp_8)
// Output is chunked (tracts by county, HOLC by city, counties by state) so the app
// loads only the chunks in view:
//   public/context/<layer>/index.json        [{ id, bbox:[w,s,e,n], count }]
//   public/context/<layer>/<chunk>.geojsonl  one Feature per line
// The tract files are projected in ESRI:102003 (USA Contiguous Albers Equal
// Area Conic, NAD83) and converted to WGS84 lon/lat here; the county files
// are NAD83 lon/lat. Outlines are simplified so a chunk loads quickly.
// The cluster files carry no GEOID: their SOURCE_ID is the feature's position
// in the matching life expectancy file, which is verified before use.
// Usage: node scripts/build-context-layers.mjs [layer ...]
//   layers: holc, tract-le, county-le, county-clusters, tract-clusters
//   (default: all)
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';

// Raw nationwide sources live outside public/ so a production build does not
// copy gigabytes into the output; only the chunks below are served.
const HOLC_INPUT = 'data/source/holc_nation.geojson';
const HOLC_FULL_INPUT = 'data/source/mappinginequality.json';
const TRACTS_INPUT = 'data/source/nation_tracts_le.geojson';
const COUNTY_INPUT = 'data/source/nation_county_le.geojson';
const COUNTY_CLUSTER_INPUT = 'data/source/nation_county_le_cluster.geojson';
const TRACT_CLUSTER_INPUT = 'data/source/nation_tracts_le_cluster.geojson';
const OUT_ROOT = 'public/context';
/** Douglas-Peucker tolerance in degrees (~10 m at mid latitudes). */
const SIMPLIFY_DEG = 0.0001;
/** Coarser tolerance for county outlines, drawn nationwide (~300 m). */
const COUNTY_SIMPLIFY_DEG = 0.003;

const HOLC_GRADE_LABELS = {
  A: 'Best',
  B: 'Still Desirable',
  C: 'Definitely Declining',
  D: 'Hazardous',
};

// ---- ESRI:102003 inverse (Snyder, Map Projections: A Working Manual, §14) --
const A = 6378137; // GRS80
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const RAD = Math.PI / 180;
const LON0 = -96 * RAD;

function q(phi) {
  const s = Math.sin(phi);
  return (
    (1 - E2) *
    (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
  );
}
function m(phi) {
  const s = Math.sin(phi);
  return Math.cos(phi) / Math.sqrt(1 - E2 * s * s);
}
const M1 = m(29.5 * RAD);
const M2 = m(45.5 * RAD);
const Q1 = q(29.5 * RAD);
const Q2 = q(45.5 * RAD);
const N = (M1 * M1 - M2 * M2) / (Q2 - Q1);
const C = M1 * M1 + N * Q1;
const RHO0 = (A * Math.sqrt(C - N * q(37.5 * RAD))) / N;

/** ESRI:102003 metres -> [lon, lat] degrees. */
function albersToLonLat([x, y]) {
  const rho = Math.hypot(x, RHO0 - y);
  const theta = Math.atan2(x, RHO0 - y);
  const qv = (C - (rho * rho * N * N) / (A * A)) / N;
  let phi = Math.asin(Math.max(-1, Math.min(1, qv / 2)));
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(phi);
    const one = 1 - E2 * s * s;
    const delta =
      ((one * one) / (2 * Math.cos(phi))) *
      (qv / (1 - E2) -
        s / one +
        (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
    phi += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return [(LON0 + theta / N) / RAD, phi / RAD];
}

// ---- geometry helpers ------------------------------------------------------
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** Iterative Douglas-Peucker on an open polyline of [lon, lat]. */
function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Douglas-Peucker tolerance scaled to one tract (as in
 * scripts/build-environment-layers.mjs): 0.5% of its bounding-box diagonal,
 * ~30 m for dense city tracts up to ~200 m for large rural ones.
 */
function tractTolerance(geometry) {
  const [w, s, e, n] = bboxOf(geometry);
  return Math.min(0.002, Math.max(0.0003, Math.hypot(e - w, n - s) * 0.005));
}

/** Project every vertex of a (Multi)Polygon; null for other geometry. */
function projectGeometry(geometry, project) {
  const ring = (points) => points.map(project);
  if (geometry?.type === 'Polygon')
    return { type: 'Polygon', coordinates: geometry.coordinates.map(ring) };
  if (geometry?.type === 'MultiPolygon')
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) => polygon.map(ring)),
    };
  return null;
}

/** Project, simplify and round one ring; null when it degenerates. */
function cleanRing(points, project, tolerance, round = round6) {
  const projected = points.map(project);
  // Simplify as an open line (first point repeated at the end is kept).
  let ring = simplifyLine(projected, tolerance);
  if (ring.length < 4) ring = projected; // too small to simplify safely
  const out = [];
  for (const point of ring) {
    const lon = round(point[0]);
    const lat = round(point[1]);
    const last = out[out.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) out.push([lon, lat]);
  }
  if (out.length < 3) return null;
  const [fx, fy] = out[0];
  const [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out.length >= 4 ? out : null;
}

/** Clean a (Multi)Polygon; null when nothing drawable is left. */
function cleanGeometry(
  geometry,
  project = (p) => p,
  tolerance = SIMPLIFY_DEG,
  round = round6,
) {
  const polygon = (rings) => {
    const outer = cleanRing(rings[0], project, tolerance, round);
    if (!outer) return null;
    const holes = rings
      .slice(1)
      .map((r) => cleanRing(r, project, tolerance, round))
      .filter(Boolean);
    return [outer, ...holes];
  };
  const polygons = (
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : []
  )
    .map(polygon)
    .filter(Boolean);
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

function bboxOf(geometry) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const rings =
    geometry.type === 'Polygon'
      ? geometry.coordinates
      : geometry.coordinates.flat();
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < bbox[0]) bbox[0] = lon;
      if (lat < bbox[1]) bbox[1] = lat;
      if (lon > bbox[2]) bbox[2] = lon;
      if (lat > bbox[3]) bbox[3] = lat;
    }
  }
  return bbox;
}

async function* features(path, prefilter = () => true) {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const raw of lines) {
    if (!raw.startsWith('{"type":"Feature"') || !prefilter(raw)) continue;
    yield JSON.parse(raw.replace(/,\s*$/, ''));
  }
}

/** Collects features into per-chunk files plus a bbox index. */
function createChunkWriter(layerDir) {
  const chunks = new Map();
  return {
    add(chunkId, feature) {
      let chunk = chunks.get(chunkId);
      if (!chunk) {
        chunk = { lines: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] };
        chunks.set(chunkId, chunk);
      }
      const [w, s, e, n] = bboxOf(feature.geometry);
      chunk.bbox = [
        Math.min(chunk.bbox[0], w),
        Math.min(chunk.bbox[1], s),
        Math.max(chunk.bbox[2], e),
        Math.max(chunk.bbox[3], n),
      ];
      chunk.lines.push(JSON.stringify(feature));
    },
    finish() {
      const dir = `${OUT_ROOT}/${layerDir}`;
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const index = [];
      let bytes = 0;
      for (const [id, chunk] of [...chunks].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const text = `${chunk.lines.join('\n')}\n`;
        bytes += Buffer.byteLength(text);
        writeFileSync(`${dir}/${id}.geojsonl`, text);
        index.push({
          id,
          bbox: chunk.bbox.map(round6),
          count: chunk.lines.length,
        });
      }
      writeFileSync(`${dir}/index.json`, JSON.stringify(index));
      const features = index.reduce((sum, c) => sum + c.count, 0);
      console.log(
        `${layerDir}: ${features} features in ${index.length} files, ${(bytes / 1e6).toFixed(1)} MB`,
      );
    },
  };
}

// ---- HOLC redlining, nationwide ----------------------------------------------
// Source: Mapping Inequality's complete spatial file (every HOLC area, 314
// cities; https://dsl.richmond.edu/panorama/redlining/data). The earlier
// tract-split file (holc_nation.geojson) was missing whole metros, Boston
// among them; it is now read only for the neighborhood names it carries.
// Area ids match the area-description data, so after this step re-run
// scripts/build-holc-area-descriptions.mjs (finish() clears the folder).
/** City key that survives naming differences ("Los Angeles (central)", "LA"). */
const holcCityKey = (city, state) =>
  `${String(city || '')
    .replace(/\s*\(.*\)\s*/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase()}|${state}`;

/**
 * Read the old tract-split file for (a) neighborhood names by area id and
 * (b) its features grouped by city, kept only for areas the full file lacks.
 */
async function readOldHolc(fullIds) {
  const names = new Map();
  const orphansByCity = new Map();
  try {
    for await (const f of features(HOLC_INPUT)) {
      const p = f.properties;
      const id = p.polygon_id != null ? String(p.polygon_id) : null;
      if (id && p.name && !names.has(id)) names.set(id, p.name);
      if (!id || fullIds.has(id)) continue;
      const key = holcCityKey(p.st_name, p.state);
      if (!orphansByCity.has(key)) orphansByCity.set(key, []);
      orphansByCity.get(key).push(f);
    }
  } catch {
    // Optional: without the old file, areas are titled by label only.
  }
  return { names, orphansByCity };
}

/** Chunk ids by city: "MA-Boston", "CA-LosAngeles". */
const holcChunkId = (state, city) =>
  `${String(state || 'XX').trim()}-${String(city || 'unknown').replace(/[^A-Za-z0-9]/g, '')}`;

async function buildHolc() {
  const writer = createChunkWriter('holc');
  const source = JSON.parse(readFileSync(HOLC_FULL_INPUT, 'utf8'));
  const fullIds = new Set(
    source.features.map((f) => String(f.properties.area_id)),
  );
  const { names, orphansByCity } = await readOldHolc(fullIds);
  // A city the full file renumbered keeps whichever version has more areas
  // (Waco: 22 areas in the old survey, 5 in the new file).
  const fullCount = new Map();
  for (const f of source.features) {
    const key = holcCityKey(f.properties.city, f.properties.state);
    fullCount.set(key, (fullCount.get(key) || 0) + 1);
  }
  const useOld = new Set();
  for (const [key, list] of orphansByCity) {
    const areas = new Set(list.map((f) => String(f.properties.polygon_id)))
      .size;
    if (areas > (fullCount.get(key) || 0)) useOld.add(key);
  }
  if (useOld.size)
    console.log(
      `  holc: older, more detailed survey kept for ${[...useOld].join(', ')}`,
    );
  let dropped = 0;
  for (const key of useOld) {
    for (const f of orphansByCity.get(key)) {
      const p = f.properties;
      const geometry = cleanGeometry(f.geometry);
      if (!geometry) continue;
      const grade = String(p.holc_grade || '').toUpperCase();
      const label = HOLC_GRADE_LABELS[grade];
      const city = `${p.st_name}, ${p.state}`;
      writer.add(holcChunkId(p.state, p.st_name), {
        type: 'Feature',
        id: `holc-${p.id}-${p.polygon_id}-${p.geoid ?? 'na'}`,
        properties: {
          name: `${p.holc_id} · ${p.name || city}`,
          holc_id: p.holc_id,
          holc_grade: label ? grade : '',
          city,
          summary: label
            ? `Graded ${grade} ("${label}") on the 1930s Home Owners' Loan Corporation map of ${city}.`
            : `Ungraded area on the 1930s HOLC map of ${city}.`,
          source_note: 'Mapping Inequality (University of Richmond).',
        },
        geometry,
      });
    }
  }
  for (const f of source.features) {
    const p = f.properties;
    if (useOld.has(holcCityKey(p.city, p.state))) continue;
    const geometry = cleanGeometry(f.geometry);
    if (!geometry || p.area_id == null) {
      dropped += 1;
      continue;
    }
    const grade = String(p.grade || '')
      .trim()
      .toUpperCase();
    const label = HOLC_GRADE_LABELS[grade];
    const holcId = String(p.label || '').trim() || null;
    const city = p.city ? `${p.city}, ${p.state}` : p.state || '';
    const name = names.get(String(p.area_id));
    writer.add(holcChunkId(p.state, p.city), {
      type: 'Feature',
      id: `holc-mi-${p.area_id}`,
      properties: {
        name: holcId
          ? `${holcId} · ${name || city}`
          : `HOLC area · ${name || city}`,
        holc_id: holcId,
        holc_grade: label ? grade : '',
        city,
        summary: label
          ? `Graded ${grade} ("${label}") on the 1930s Home Owners' Loan Corporation map of ${city}.`
          : `Ungraded area on the 1930s HOLC map of ${city}.`,
        source_note: 'Mapping Inequality (University of Richmond).',
      },
      geometry,
    });
  }
  writer.finish();
  if (dropped)
    console.log(`  holc: dropped ${dropped} areas with no drawable outline`);
}

// ---- Life expectancy and its clusters, every census tract --------------------
// One set of tract chunks carries both: the life-expectancy layer draws every
// tract, and the clusters layer reads the same chunks and keeps only tracts
// with a significant `cluster` (featureFilter in src/data/infrastructure.js).
// Card text is written by each layer (featureSummary), not stored per tract.
async function buildTractLifeExpectancy() {
  const clusters = await readTractClusters();
  const writer = createChunkWriter('life-expectancy');
  let dropped = 0;
  let checked = 0;
  let offCenter = 0;
  let withCluster = 0;
  for await (const f of features(TRACTS_INPUT)) {
    const p = f.properties;
    const projected = projectGeometry(f.geometry, albersToLonLat);
    const geometry =
      projected &&
      cleanGeometry(projected, (q) => q, tractTolerance(projected), round5);
    if (!geometry) {
      dropped += 1;
      continue;
    }
    // Projection sanity check: the published interior point must fall inside
    // the converted tract's bounding box.
    const [w, s, e, n] = bboxOf(geometry);
    const lat = Number(p.INTPTLAT);
    const lon = Number(p.INTPTLON);
    checked += 1;
    if (lon < w || lon > e || lat < s || lat > n) offCenter += 1;
    const years =
      Number(p.life_exp_8) > 0 ? Math.round(p.life_exp_8 * 10) / 10 : null;
    const place = p.life_exp_4 || `${p.STATEFP}${p.COUNTYFP}`;
    const cluster = clusters.get(p.GEOID);
    if (cluster) withCluster += 1;
    writer.add(`${p.STATEFP}${p.COUNTYFP}`, {
      type: 'Feature',
      id: `tract-${p.GEOID}`,
      properties: {
        name: `${p.NAMELSAD}, ${place}`,
        geoid: p.GEOID,
        life_exp_8: years,
        ...(cluster && {
          cluster: cluster.type,
          p_value: Math.round(Number(cluster.pValue) * 1000) / 1000,
        }),
      },
      geometry,
    });
  }
  writer.finish();
  console.log(
    `  life-expectancy: ${offCenter} of ${checked} tracts failed the interior-point check; dropped ${dropped} empty geometries; ${withCluster} tracts carry a significant cluster`,
  );
}

/**
 * Significant Local Moran's I results by tract GEOID, read from the cluster
 * file's properties only (its geometry duplicates the tract file's).
 * SOURCE_ID indexes the tract file; each match is confirmed by the tract's
 * outline length, which both files carry, and rows whose SOURCE_ID does not
 * line up fall back to a unique outline length + area match.
 * @returns {Promise<Map<string, {type: string, pValue: number}>>}
 */
async function readTractClusters() {
  const tracts = [];
  const byShape = new Map();
  const shapeKey = (length, area) =>
    `${Number(length).toFixed(2)}|${Math.round(Number(area))}`;
  for await (const p of featureProperties(TRACTS_INPUT)) {
    const tract = { geoid: p.GEOID, length: p.Shape_Leng };
    tracts.push(tract);
    const key = shapeKey(p.Shape_Leng, p.Shape_Area);
    byShape.set(key, byShape.has(key) ? null : tract);
  }
  const clusters = new Map();
  const counts = {};
  let byIndex = 0;
  let byOutline = 0;
  let unmatched = 0;
  for await (const p of featureProperties(TRACT_CLUSTER_INPUT)) {
    const type = CLUSTER_TYPES[p.COType] ? p.COType : null;
    counts[type ?? 'not significant'] =
      (counts[type ?? 'not significant'] || 0) + 1;
    if (!type) continue;
    let tract = tracts[p.SOURCE_ID];
    if (tract && Math.abs(tract.length - p.Shape_Leng) <= 1e-3) {
      byIndex += 1;
    } else {
      tract = byShape.get(shapeKey(p.Shape_Leng, p.Shape_Area));
      if (!tract) {
        unmatched += 1;
        continue;
      }
      byOutline += 1;
    }
    clusters.set(tract.geoid, { type, pValue: p.LMiPValue });
  }
  console.log(
    `  tract clusters: ${JSON.stringify(counts)}; matched ${byIndex} by SOURCE_ID, ${byOutline} by outline, ${unmatched} unmatched`,
  );
  return clusters;
}

// ---- Shared helpers for the county and cluster layers ------------------------
const STATE_NAMES = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  10: 'DE',
  11: 'DC',
  12: 'FL',
  13: 'GA',
  15: 'HI',
  16: 'ID',
  17: 'IL',
  18: 'IN',
  19: 'IA',
  20: 'KS',
  21: 'KY',
  22: 'LA',
  23: 'ME',
  24: 'MD',
  25: 'MA',
  26: 'MI',
  27: 'MN',
  28: 'MS',
  29: 'MO',
  30: 'MT',
  31: 'NE',
  32: 'NV',
  33: 'NH',
  34: 'NJ',
  35: 'NM',
  36: 'NY',
  37: 'NC',
  38: 'ND',
  39: 'OH',
  40: 'OK',
  41: 'OR',
  42: 'PA',
  44: 'RI',
  45: 'SC',
  46: 'SD',
  47: 'TN',
  48: 'TX',
  49: 'UT',
  50: 'VT',
  51: 'VA',
  53: 'WA',
  54: 'WV',
  55: 'WI',
  56: 'WY',
  72: 'PR',
};

/**
 * NAD83 lon/lat for county outlines. The Aleutians cross the antimeridian, so
 * eastern-hemisphere longitudes are written as < -180 to keep each polygon
 * continuous (no U.S. county otherwise has a positive longitude).
 */
const countyLonLat = ([lon, lat]) => [lon > 0 ? lon - 360 : lon, lat];

const years1 = (value) =>
  Number(value) > 0 ? Math.round(Number(value) * 10) / 10 : null;
const signed = (value) =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;

/** Parse only the properties of a one-line Feature (skips the geometry). */
function propertiesOnly(raw) {
  const start = raw.indexOf('"properties":');
  const end = raw.indexOf(',"geometry"');
  if (start < 0 || end < 0) return null;
  return JSON.parse(raw.slice(start + '"properties":'.length, end));
}

async function* featureProperties(path) {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const raw of lines) {
    if (!raw.startsWith('{"type":"Feature"')) continue;
    yield propertiesOnly(raw);
  }
}

// Local Moran's I cluster types (COType), named for life expectancy and
// colored to match the life expectancy layers (red = shorter, blue = longer).
const CLUSTER_TYPES = {
  HH: {
    label: 'long-life cluster (high–high)',
    detail: 'high, and so are its neighbors',
  },
  LL: {
    label: 'short-life cluster (low–low)',
    detail: 'low, and so are its neighbors',
  },
  HL: {
    label: 'high outlier (high–low)',
    detail: 'high while its neighbors are low',
  },
  LH: {
    label: 'low outlier (low–high)',
    detail: 'low while its neighbors are high',
  },
};

function clusterSummary(type, unit, years, yearLabel, pValue) {
  const info = CLUSTER_TYPES[type];
  const value = years === null ? 'n/a' : `${years.toFixed(1)} years`;
  return `Local Moran's I ${info.label}: this ${unit}'s life expectancy${yearLabel} (${value}) is ${info.detail} (p = ${Number(pValue).toFixed(3)}).`;
}

// ---- County life expectancy, 2000-2019 ---------------------------------------
const RACE_GROUPS = [
  ['Black', 'blktot'],
  ['White', 'whttot'],
  ['Latino', 'lattot'],
  ['Asian/Pacific Islander', 'apitot'],
  ['American Indian/Alaska Native', 'nattot'],
];

async function buildCountyLifeExpectancy() {
  const writer = createChunkWriter('county-life-expectancy');
  let dropped = 0;
  for await (const f of features(COUNTY_INPUT)) {
    const p = f.properties;
    const geometry = cleanGeometry(
      f.geometry,
      countyLonLat,
      COUNTY_SIMPLIFY_DEG,
    );
    if (!geometry) {
      dropped += 1;
      continue;
    }
    const state = STATE_NAMES[p.STATEFP10] || p.STATEFP10;
    const le19 = years1(p.total_19);
    const le00 = years1(p.total_00);
    const low = years1(p.totlow_19);
    const high = years1(p.totup_19);
    const race = RACE_GROUPS.map(([label, key]) => [
      label,
      years1(p[`${key}_19`]),
    ])
      .filter(([, value]) => value !== null)
      .map(([label, value]) => `${label} ${value.toFixed(1)}`);
    const summary =
      le19 === null
        ? 'No life expectancy estimate for this county.'
        : [
            `Life expectancy at birth, 2019: ${le19.toFixed(1)} years` +
              (low !== null && high !== null
                ? ` (uncertainty ${low.toFixed(1)}–${high.toFixed(1)}).`
                : '.'),
            le00 !== null
              ? `2000: ${le00.toFixed(1)} years (${signed(le19 - le00)} since).`
              : '',
            race.length ? `2019 by race/ethnicity: ${race.join(' · ')}.` : '',
          ]
            .filter(Boolean)
            .join(' ');
    writer.add(p.STATEFP10, {
      type: 'Feature',
      id: `county-${p.GEOID10}`,
      properties: {
        name: `${p.NAMELSAD10}, ${state}`,
        geoid: p.GEOID10,
        life_exp: le19,
        life_exp_2000: le00,
        summary,
        source_note:
          'County life expectancy 2000–2019, total and by race/ethnicity (nation_county_le).',
      },
      geometry,
    });
  }
  writer.finish();
  if (dropped)
    console.log(
      `  county-life-expectancy: dropped ${dropped} empty geometries`,
    );
}

// ---- County clusters (Local Moran's I on 2015 life expectancy) ---------------
async function buildCountyClusters() {
  // SOURCE_ID indexes the county file: either every county or only those the
  // analysis kept (the counties with an abs_change value). Pick whichever
  // reproduces every cluster row's total_15.
  const all = [];
  const kept = [];
  for await (const p of featureProperties(COUNTY_INPUT)) {
    const county = {
      name: `${p.NAMELSAD10}, ${STATE_NAMES[p.STATEFP10] || p.STATEFP10}`,
      geoid: p.GEOID10,
      state: p.STATEFP10,
      total15: p.total_15,
    };
    all.push(county);
    if (p.abs_change != null) kept.push(county);
  }
  const clusterRows = [];
  for await (const p of featureProperties(COUNTY_CLUSTER_INPUT))
    clusterRows.push(p);
  const matches = (list) =>
    clusterRows.filter(
      (p) => Math.abs((list[p.SOURCE_ID]?.total15 ?? NaN) - p.total_15) < 1e-6,
    ).length;
  const [lookup, lookupName] =
    matches(kept) >= matches(all)
      ? [kept, 'kept counties']
      : [all, 'all counties'];
  console.log(
    `  county-clusters: SOURCE_ID matches ${matches(lookup)} of ${clusterRows.length} rows (${lookupName})`,
  );

  const writer = createChunkWriter('county-clusters');
  const counts = {};
  let unmatched = 0;
  for await (const f of features(COUNTY_CLUSTER_INPUT)) {
    const p = f.properties;
    const type = CLUSTER_TYPES[p.COType] ? p.COType : null;
    counts[type ?? 'not significant'] =
      (counts[type ?? 'not significant'] || 0) + 1;
    if (!type) continue; // only significant clusters and outliers are drawn
    const county = lookup[p.SOURCE_ID];
    if (!county || Math.abs(county.total15 - p.total_15) >= 1e-6) {
      unmatched += 1;
      continue;
    }
    const geometry = cleanGeometry(
      f.geometry,
      countyLonLat,
      COUNTY_SIMPLIFY_DEG,
    );
    if (!geometry) continue;
    writer.add(county.state, {
      type: 'Feature',
      id: `county-cluster-${county.geoid}`,
      properties: {
        name: county.name,
        geoid: county.geoid,
        cluster: type,
        life_exp: years1(p.total_15),
        p_value: p.LMiPValue,
        summary: clusterSummary(
          type,
          'county',
          years1(p.total_15),
          ' in 2015',
          p.LMiPValue,
        ),
        source_note:
          "Local Moran's I (Anselin) on county life expectancy, 2015 (nation_county_le_cluster).",
      },
      geometry,
    });
  }
  writer.finish();
  console.log(
    `  county-clusters: ${JSON.stringify(counts)}; ${unmatched} significant rows could not be matched`,
  );
}

const BUILDERS = {
  holc: buildHolc,
  'tract-le': buildTractLifeExpectancy,
  'county-le': buildCountyLifeExpectancy,
  'county-clusters': buildCountyClusters,
  // Tract clusters now ride in the life-expectancy chunks (see above).
  'tract-clusters': buildTractLifeExpectancy,
};
const requested = process.argv.slice(2);
for (const name of requested.length ? requested : Object.keys(BUILDERS)) {
  if (!BUILDERS[name]) throw new Error(`Unknown layer "${name}"`);
  await BUILDERS[name]();
}
