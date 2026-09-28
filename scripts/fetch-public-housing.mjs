// Download every HUD public housing building (HUD Public Housing Buildings,
// HUD eGIS, updated quarterly) and write:
//   data/source/hud_public_housing_buildings.json      raw download
//   data/exports/public_housing_buildings.csv            one row per building, x/y, construction year
//   src/data/local_data/public_housing/developments.geojsonl
//       map layer: one pin per development (its buildings' mean location),
//       with the construction year range and unit/building counts
// Usage: node scripts/fetch-public-housing.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const SERVICE =
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Buildings/FeatureServer/0/query';
const FIELDS = [
  'OBJECTID',
  'NATIONAL_BLDG_ID',
  'PARTICIPANT_CODE',
  'FORMAL_PARTICIPANT_NAME',
  'DEVELOPMENT_CODE',
  'PROJECT_NAME',
  'BUILDING_NAME',
  'BUILDING_TYPE_CODE',
  'BUILDING_STATUS_TYPE_CODE',
  'CONSTRUCT_DATE',
  'DOFA_ACTUAL_DT',
  'TOTAL_DWELLING_UNITS',
  'STD_ADDR',
  'STD_CITY',
  'STD_ST',
  'STD_ZIP5',
  'LAT',
  'LON',
];
const PAGE = 1000; // the service's maxRecordCount
const CONCURRENCY = 4;

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: FIELDS.join(','),
    returnGeometry: 'false',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'json',
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${SERVICE}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json();
      if (page.error) throw new Error(page.error.message);
      return page.features.map((f) => f.attributes);
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function fetchAll() {
  const countParams = new URLSearchParams({
    where: '1=1',
    returnCountOnly: 'true',
    f: 'json',
  });
  const { count } = await (await fetch(`${SERVICE}?${countParams}`)).json();
  const offsets = [];
  for (let offset = 0; offset < count; offset += PAGE) offsets.push(offset);
  const pages = new Array(offsets.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < offsets.length) {
        const index = next++;
        pages[index] = await fetchPage(offsets[index]);
        if (index % 25 === 0)
          console.log(`  ${Math.min(count, (index + 1) * PAGE)} / ${count}`);
      }
    }),
  );
  const rows = pages.flat();
  const unique = new Map(rows.map((r) => [r.OBJECTID, r]));
  return { count, rows: [...unique.values()] };
}

const clean = (value) =>
  value === null || value === undefined ? '' : String(value).trim();
const csvCell = (value) => {
  const text = clean(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const isoDate = (ms) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
// A few records carry impossible future construction dates (2050s data-entry
// errors); their year is left blank, and construct_date keeps the raw value.
const LATEST_VALID_YEAR = new Date().getUTCFullYear();
const yearOf = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const year = new Date(ms).getUTCFullYear();
  return year <= LATEST_VALID_YEAR ? year : '';
};

const { count, rows } = await fetchAll();
mkdirSync('data/source', { recursive: true });
writeFileSync(
  'data/source/hud_public_housing_buildings.json',
  JSON.stringify(rows),
);

const buildings = rows
  .filter((r) => Number.isFinite(r.LAT) && Number.isFinite(r.LON))
  .map((r) => ({
    national_bldg_id: clean(r.NATIONAL_BLDG_ID),
    development_code: clean(r.DEVELOPMENT_CODE),
    project_name: clean(r.PROJECT_NAME),
    building_name: clean(r.BUILDING_NAME),
    housing_authority: clean(r.FORMAL_PARTICIPANT_NAME),
    housing_authority_code: clean(r.PARTICIPANT_CODE),
    building_type: clean(r.BUILDING_TYPE_CODE),
    building_status: clean(r.BUILDING_STATUS_TYPE_CODE),
    construct_year: yearOf(r.CONSTRUCT_DATE),
    construct_date: isoDate(r.CONSTRUCT_DATE),
    full_availability_date: isoDate(r.DOFA_ACTUAL_DT),
    units: Number.isFinite(r.TOTAL_DWELLING_UNITS)
      ? r.TOTAL_DWELLING_UNITS
      : '',
    address: clean(r.STD_ADDR).replace(/\s+/g, ' '),
    city: clean(r.STD_CITY).replace(/\s+/g, ' '),
    state: clean(r.STD_ST),
    zip: clean(r.STD_ZIP5),
    x: Math.round(r.LON * 1e6) / 1e6,
    y: Math.round(r.LAT * 1e6) / 1e6,
  }))
  .sort(
    (a, b) =>
      a.state.localeCompare(b.state) ||
      a.development_code.localeCompare(b.development_code) ||
      a.national_bldg_id.localeCompare(b.national_bldg_id),
  );

const columns = Object.keys(buildings[0]);
mkdirSync('data/exports', { recursive: true });
writeFileSync(
  'data/exports/public_housing_buildings.csv',
  `${[columns.join(','), ...buildings.map((b) => columns.map((c) => csvCell(b[c])).join(','))].join('\n')}\n`,
);

// One pin per development.
const developments = new Map();
for (const b of buildings) {
  const key = b.development_code || `bldg-${b.national_bldg_id}`;
  if (!developments.has(key)) developments.set(key, []);
  developments.get(key).push(b);
}
const lines = [];
for (const [code, list] of developments) {
  const years = list.map((b) => b.construct_year).filter((y) => y > 1900);
  const first = years.length ? Math.min(...years) : null;
  const last = years.length ? Math.max(...years) : null;
  const units = list.reduce((sum, b) => sum + (Number(b.units) || 0), 0);
  const x = list.reduce((s, b) => s + b.x, 0) / list.length;
  const y = list.reduce((s, b) => s + b.y, 0) / list.length;
  const b0 = list[0];
  const name = b0.project_name || `Development ${code}`;
  const built =
    first === null
      ? 'unknown'
      : first === last
        ? `${first}`
        : `${first}–${last}`;
  lines.push(
    JSON.stringify({
      type: 'Feature',
      id: `public-housing-${code}`,
      properties: {
        name,
        development_code: code,
        construct_year: first,
        construct_year_last: last,
        buildings: list.length,
        units,
        housing_authority: b0.housing_authority,
        summary: `Public housing development built ${built}: ${list.length} building${list.length === 1 ? '' : 's'}, ${units} units. ${b0.city}, ${b0.state}. Housing authority: ${b0.housing_authority || 'n/a'}.`,
        source_note:
          'HUD Public Housing Buildings (HUD eGIS), construction dates per building.',
      },
      geometry: {
        type: 'Point',
        coordinates: [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6],
      },
    }),
  );
}
const layerDir = 'src/data/local_data/public_housing';
mkdirSync(layerDir, { recursive: true });
writeFileSync(`${layerDir}/developments.geojsonl`, `${lines.join('\n')}\n`);

const withYear = buildings.filter((b) => b.construct_year !== '').length;
console.log(
  `service count ${count}; downloaded ${rows.length}; ${buildings.length} buildings with coordinates (${withYear} with a construction year); ${developments.size} developments`,
);
