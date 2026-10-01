// Build the environment layers (air quality and green space) from the files in
// data/source/air-quality/ and data/source/green-space/ (downloaded
// 2026-09-30; data/source/ is not committed):
//   - cb_2024_us_tract_500k/        Census 2024 cartographic tract outlines
//                                    (2020 tracts, NAD83 lon/lat shapefile)
//   - cdc_pm25_2021_tract_mean.json CDC Tracking Downscaler PM2.5, 2021 annual
//                                    mean per tract (data.cdc.gov vpk8-vfhm,
//                                    averaged server-side; every daily row
//                                    appears twice in that table, which does
//                                    not change the mean)
//   - cdc_ozone_2022_tract_mean.json CDC Tracking Downscaler ozone, 2022
//                                    annual mean of the daily 8-hour maximum
//                                    (data.cdc.gov b72x-p96c, year = 2022)
//   - ozone_8hr_2015std_naa_shapefile/, pm25_2012std_naa_shapefile/
//                                    EPA Green Book nonattainment areas
//   - green-space/cdc_park_access_2020_half_mile.json
//                                    CDC Tracking "Access to Parks" (measure
//                                    1285, 2020, 2020 tracts): percent of people
//                                    within 1/2 mile of a park
//                                    (scripts/fetch-park-access.mjs)
//   - green-space/arealm/tl_2025_SS_arealm/
//                                    Census TIGER/Line 2025 Area Landmarks;
//                                    park MTFCC codes K2180-K2190 are kept
// Output, chunked like scripts/build-context-layers.mjs:
//   public/context/tracts-2020/          2020 tracts by county: PM2.5, ozone and
//                                        park access, shared by three layers
//   public/context/air-nonattainment/    one chunk per Green Book area
//   public/context/parks/                parks by state and 1-degree cell
// Usage: node scripts/build-environment-layers.mjs
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readShapefile } from './lib/shapefile.mjs';

const SOURCE = 'data/source/air-quality';
const GREEN = 'data/source/green-space';
const PARK_ACCESS_JSON = `${GREEN}/cdc_park_access_2020_half_mile.json`;
const AREALM_DIR = `${GREEN}/arealm`;
const TRACT_SHP = `${SOURCE}/cb_2024_us_tract_500k/cb_2024_us_tract_500k`;
const PM25_JSON = `${SOURCE}/cdc_pm25_2021_tract_mean.json`;
const OZONE_JSON = `${SOURCE}/cdc_ozone_2022_tract_mean.json`;
const OZONE_NAA_SHP = `${SOURCE}/ozone_8hr_2015std_naa_shapefile/ozone_8hr_2015std_naa`;
const PM25_NAA_SHP = `${SOURCE}/pm25_2012std_naa_shapefile/PM25_2012Std_NAA`;
const OUT_ROOT = 'public/context';
/**
 * Douglas-Peucker tolerance in degrees, scaled to each tract: 0.5% of its
 * bounding-box diagonal, between ~30 m (dense city tracts) and ~200 m (large
 * rural tracts, whose long river and coast boundaries were most of the bytes).
 */
const SIMPLIFY_MIN_DEG = 0.0003;
const SIMPLIFY_MAX_DEG = 0.002;
const SIMPLIFY_SHARE = 0.005;
const SIMPLIFY_DEG = SIMPLIFY_MIN_DEG;
function tractTolerance(geometry) {
  const [w, s, e, n] = bboxOf(geometry);
  const diagonal = Math.hypot(e - w, n - s);
  return Math.min(
    SIMPLIFY_MAX_DEG,
    Math.max(SIMPLIFY_MIN_DEG, diagonal * SIMPLIFY_SHARE),
  );
}
/** Five decimals is ~1 m, plenty for 1:500,000 outlines. */
const round5 = (v) => Math.round(v * 1e5) / 1e5;

// ---- Geometry clean-up (as in build-context-layers.mjs) ---------------------
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

function cleanRing(points, tolerance) {
  let ring = simplifyLine(points, tolerance);
  if (ring.length < 4) ring = points;
  const out = [];
  for (const [x, y] of ring) {
    const lon = round5(x);
    const lat = round5(y);
    const last = out[out.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) out.push([lon, lat]);
  }
  if (out.length < 3) return null;
  const [fx, fy] = out[0];
  const [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out.length >= 4 ? out : null;
}

function cleanGeometry(geometry, tolerance = SIMPLIFY_DEG) {
  const polygon = (rings) => {
    const outer = cleanRing(rings[0], tolerance);
    if (!outer) return null;
    return [
      outer,
      ...rings
        .slice(1)
        .map((r) => cleanRing(r, tolerance))
        .filter(Boolean),
    ];
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
          bbox: chunk.bbox.map(round5),
          count: chunk.lines.length,
        });
      }
      writeFileSync(`${dir}/index.json`, JSON.stringify(index));
      const total = index.reduce((sum, c) => sum + c.count, 0);
      console.log(
        `${layerDir}: ${total} features in ${index.length} files, ${(bytes / 1e6).toFixed(1)} MB`,
      );
    },
  };
}

// ---- Tracts: PM2.5 (2021), ozone (2022), park access (2020) ------------------
/**
 * GEOID -> value lookup over rows of a CDC download.
 * @param {string} path JSON array file.
 * @param {string} idKey Field holding the tract GEOID.
 * @param {string} valueKey Field holding the value.
 */
function readTractValues(path, idKey, valueKey) {
  const means = new Map();
  // Connecticut replaced its counties with planning regions in 2022: the 2024
  // outlines use new county codes, some CDC tables the old ones, while the
  // six-digit tract codes stayed the same. Key CT by state + tract code too,
  // where that pair is unique.
  const connecticut = new Map();
  for (const row of JSON.parse(readFileSync(path, 'utf8'))) {
    const value = Number(row[valueKey]);
    if (!row[idKey] || !Number.isFinite(value)) continue;
    const geoid = String(row[idKey]).padStart(11, '0');
    means.set(geoid, value);
    if (geoid.startsWith('09')) {
      const key = `09${geoid.slice(5)}`;
      connecticut.set(key, connecticut.has(key) ? null : value);
    }
  }
  return {
    size: means.size,
    get(geoid) {
      if (means.has(geoid)) return means.get(geoid);
      if (geoid.startsWith('09'))
        return connecticut.get(`09${geoid.slice(5)}`) ?? null;
      return null;
    },
  };
}

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

function buildTracts() {
  const pm25 = readTractValues(PM25_JSON, 'ctfips', 'mean');
  const ozone = readTractValues(OZONE_JSON, 'ctfips', 'mean');
  const parks = readTractValues(PARK_ACCESS_JSON, 'geoid', 'pct');
  const writer = createChunkWriter('tracts-2020');
  let dropped = 0;
  let withAir = 0;
  let withParks = 0;
  let water = 0;
  for (const { properties: p, geometry: raw } of readShapefile(TRACT_SHP)) {
    // Tracts that are all water carry no population and no estimate.
    if (Number(p.ALAND) === 0) {
      water += 1;
      continue;
    }
    const geometry = raw && cleanGeometry(raw, tractTolerance(raw));
    if (!geometry) {
      dropped += 1;
      continue;
    }
    const pm = round1(pm25.get(p.GEOID));
    const o3 = round1(ozone.get(p.GEOID));
    const park = round1(parks.get(p.GEOID));
    if (pm !== null || o3 !== null) withAir += 1;
    if (park !== null) withParks += 1;
    // Each layer writes its own card text from these numbers
    // (featureSummary in src/data/infrastructure.js).
    writer.add(`${p.STATEFP}${p.COUNTYFP}`, {
      type: 'Feature',
      id: `tract20-${p.GEOID}`,
      properties: {
        name: `${p.NAMELSAD}, ${p.NAMELSADCO}, ${p.STUSPS}`,
        geoid: p.GEOID,
        pm25: pm,
        o3,
        park,
      },
      geometry,
    });
  }
  writer.finish();
  console.log(
    `  tracts-2020: ${withAir} with air estimates, ${withParks} with park access; skipped ${water} all-water tracts; dropped ${dropped} empty geometries`,
  );
  console.log(
    `  source rows: PM2.5 ${pm25.size}, ozone ${ozone.size}, park access ${parks.size}`,
  );
}

// ---- EPA Green Book nonattainment areas -------------------------------------
function buildNonattainment() {
  const writer = createChunkWriter('air-nonattainment');
  let count = 0;
  const add = (pollutant, standard, p, raw, index) => {
    const geometry = cleanGeometry(raw, 0.0005);
    if (!geometry) return;
    const area = p.AREA_NAME || p.NAME || `Area ${index + 1}`;
    const status = p.Status || p.Status_120 || '';
    const id = `${pollutant}-${String(p.COMPOSID || index).replace(/[^A-Za-z0-9-]+/g, '-')}`;
    count += 1;
    writer.add(id, {
      type: 'Feature',
      id: `naa-${id}`,
      properties: {
        name: `${area} (${pollutant === 'ozone' ? 'ozone' : 'PM2.5'})`,
        pollutant,
        area_name: area,
        summary:
          `Designated nonattainment for the ${standard}.` +
          (status ? ` Status: ${status}.` : '') +
          ' Nonattainment means the area has not met the national air quality standard; these are regulatory areas, not measurements.',
        source_note: `EPA Green Book GIS download (${standard}).`,
      },
      geometry,
    });
  };
  readShapefile(OZONE_NAA_SHP).forEach(({ properties, geometry }, i) =>
    add(
      'ozone',
      '2015 8-hour ozone standard (70 ppb)',
      properties,
      geometry,
      i,
    ),
  );
  readShapefile(PM25_NAA_SHP).forEach(({ properties, geometry }, i) =>
    add(
      'pm25',
      '2012 annual PM2.5 standard (12 µg/m³)',
      properties,
      geometry,
      i,
    ),
  );
  writer.finish();
  console.log(`  air-nonattainment: ${count} areas`);
}

// ---- Parks: TIGER/Line 2025 Area Landmarks ----------------------------------
// MTFCC park codes (Census MAF/TIGER Feature Class Codes, 2025).
const PARK_KINDS = {
  K2180: 'park',
  K2181: 'national-park',
  K2182: 'national-forest',
  K2183: 'tribal-park',
  K2184: 'state-park',
  K2185: 'regional-park',
  K2186: 'county-park',
  K2187: 'county-park',
  K2188: 'city-park',
  K2189: 'private-park',
  K2190: 'other-park',
};

function buildParks() {
  const writer = createChunkWriter('parks');
  const counts = {};
  let dropped = 0;
  const states = readdirSync(AREALM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of states) {
    for (const { properties: p, geometry: raw } of readShapefile(
      `${AREALM_DIR}/${folder}/${folder}`,
    )) {
      const kind = PARK_KINDS[p.MTFCC];
      if (!kind) continue;
      const geometry = raw && cleanGeometry(raw, tractTolerance(raw));
      if (!geometry) {
        dropped += 1;
        continue;
      }
      // Chunk by state and the 1-degree cell holding the park's center, so a
      // view loads only nearby parks.
      const [w, s, e, n] = bboxOf(geometry);
      const cell = `${Math.floor((w + e) / 2)}_${Math.floor((s + n) / 2)}`;
      counts[kind] = (counts[kind] || 0) + 1;
      writer.add(`${p.STATEFP}_${cell}`.replace(/-/g, 'm'), {
        type: 'Feature',
        id: `park-${p.STATEFP}-${p.AREAID}`,
        properties: {
          name: p.FULLNAME || 'Unnamed park',
          kind,
          acres:
            Number(p.ALAND) > 0 ? Math.round(Number(p.ALAND) / 4046.86) : null,
        },
        geometry,
      });
    }
  }
  writer.finish();
  console.log(
    `  parks: ${JSON.stringify(counts)}; dropped ${dropped} empty geometries`,
  );
}

buildTracts();
buildNonattainment();
buildParks();
