// Build the MKDB (Mass Killing Database) map layer from the tract-matched
// incident workbook:
//   data/source/national_tracts_incidents_only.xlsx
//     -> data/restricted/exports/mkdb_incidents_geocoded.csv  (every column + checks)
//     -> data/restricted/mkdb/incidents.geojsonl
// The workbook already carries longitude/latitude per incident. Each point is
// checked against the U.S. Census geocoder: the census tract at the point must
// be the tract the row was matched to (2010 tracts for the 2006-2010 and
// 2011-2015 ACS periods, 2020 tracts for 2017-2021). Answers are cached in
// data/source/mkdb_tract_check.json, so re-runs are offline.
// Usage: node scripts/convert-mkdb-incidents.mjs [input.xlsx]
// data/restricted/ is git-ignored; then run scripts/lock-research-data.mjs to
// refresh the encrypted copy the map loads (data/research/).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {
  loadTraumaCenters,
  nearestTraumaProperties,
} from './lib/nearest-trauma.mjs';

const input =
  process.argv[2] ?? 'data/source/national_tracts_incidents_only.xlsx';
const cachePath = 'data/source/mkdb_tract_check.json';
const csvPath = 'data/restricted/exports/mkdb_incidents_geocoded.csv';
const outDir = 'data/restricted/mkdb';

/** Read the named entries of a zip archive (an .xlsx is a zip of XML). */
function readZipEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${input} is not a zip/xlsx file`);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Rows of the first worksheet, as arrays of strings/numbers. */
function readFirstSheet(path) {
  const entries = readZipEntries(readFileSync(path));
  const shared = [];
  const strings = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  for (const si of strings.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(
      decodeXml(
        [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((m) => m[1])
          .join(''),
      ),
    );
  }
  const xml = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  const rows = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cell of row[1].matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const [, ref, attrs, inner = ''] = cell;
      const type = attrs.match(/t="(\w+)"/)?.[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)];
      else if (type === 'inlineStr')
        value = decodeXml(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
      else if (type === 'str') value = decodeXml(v ?? '');
      else if (v != null) value = Number(v);
      values[columnIndex(ref)] = value;
    }
    rows.push(Array.from(values, (value) => value ?? ''));
  }
  return rows;
}

/** Excel serial day -> ISO date. */
const excelDate = (serial) =>
  new Date(Date.UTC(1899, 11, 30) + serial * 864e5).toISOString().slice(0, 10);
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const niceDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
/** NHGIS GISJOIN (G SS 0 CCC 0 TTTTTT) -> 11-digit tract GEOID. */
const gisjoinGeoid = (code) =>
  `${code.slice(1, 3)}${code.slice(4, 7)}${code.slice(8, 14)}`;

async function tractAt(lon, lat, vintage) {
  const url =
    'https://geocoding.geo.census.gov/geocoder/geographies/coordinates' +
    `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=${vintage}` +
    '&layers=Census%20Tracts&format=json';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return body.result?.geographies?.['Census Tracts']?.[0]?.GEOID ?? '';
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}

const [header, ...rows] = readFirstSheet(input);
const col = Object.fromEntries(
  header.map((name, i) => [name, i]).filter(([name]) => name),
);
const keep = header
  .map((name, i) => [name, i])
  .filter(([name]) => name)
  .map(([, i]) => i);

const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf8'))
  : {};
const pending = rows.filter((r) => !(String(r[col.incident_i]) in cache));
let done = 0;
async function worker() {
  while (pending.length) {
    const r = pending.shift();
    const vintage =
      r[col.year] === '2017-2021' ? 'Census2020_Current' : 'Census2010_Current';
    try {
      cache[r[col.incident_i]] = await tractAt(
        r[col.longitude],
        r[col.latitude],
        vintage,
      );
    } catch (error) {
      console.warn(`incident ${r[col.incident_i]}: ${error.message}`);
    }
    if (++done % 50 === 0) console.log(`checked ${done} points`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`);

const trauma = loadTraumaCenters();
const pct = (value) =>
  Number.isFinite(value) && value !== '' ? `${value.toFixed(1)}%` : '';
const checks = new Map();
const csvRows = [];
const lines = [];
for (const r of rows) {
  const lon = Number(r[col.longitude]);
  const lat = Number(r[col.latitude]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon))
    continue;
  const expected = gisjoinGeoid(String(r[col.gisjoin]));
  const found = cache[r[col.incident_i]];
  const check =
    found == null
      ? 'not checked'
      : found === expected
        ? 'match'
        : found.slice(0, 5) === expected.slice(0, 5)
          ? 'same county'
          : found
            ? 'different county'
            : 'no tract at point';
  checks.set(check, (checks.get(check) || 0) + 1);
  const date = excelDate(Number(r[col.date]));
  csvRows.push([
    ...keep.map((i) => (i === col.date ? date : r[i])),
    check,
    found ?? '',
  ]);

  const killed = Number(r[col.num_victim]) || 0;
  const injured = Number(r[col.num_vict_1]) || 0;
  const offenders = Number(r[col.num_offend]);
  const weapon = [r[col.firstcod], r[col.secondcod]]
    .map((v) => String(v).trim())
    .filter(Boolean)
    .join(', ');
  const situation = String(r[col.situation_]).trim();
  const place = `${r[col.city]}, ${r[col.state]}`;
  const tractFacts = [
    pct(r[col.ppoverty_t]) && `${pct(r[col.ppoverty_t])} in poverty`,
    Number(r[col.medinc_t]) > 0 &&
      `median household income $${Math.round(r[col.medinc_t]).toLocaleString('en-US')}`,
    pct(r[col.pnhw_t]) && `${pct(r[col.pnhw_t])} white`,
    pct(r[col.pnhb_t]) && `${pct(r[col.pnhb_t])} Black`,
    pct(r[col.phsp_t]) && `${pct(r[col.phsp_t])} Hispanic/Latino`,
    pct(r[col.pvachh_t]) && `${pct(r[col.pvachh_t])} vacant housing`,
  ].filter(Boolean);
  const summary = [
    `${niceDate(date)}: ${killed} killed${injured ? `, ${injured} injured` : ''}. ${place}.`,
    [
      weapon && `Cause: ${weapon}`,
      r[col.type] && `Type: ${r[col.type]}`,
      situation && `Circumstance: ${situation}`,
      r[col.location] && `Location: ${r[col.location]}`,
      Number.isFinite(offenders) && `Offenders: ${offenders}`,
    ]
      .filter(Boolean)
      .join(' · '),
    String(r[col.narrative]).trim(),
    tractFacts.length
      ? `${r[col.name]} (ACS ${r[col.year]}): ${tractFacts.join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  lines.push(
    JSON.stringify({
      type: 'Feature',
      id: `mkdb-${r[col.incident_i]}`,
      properties: {
        name: place,
        date,
        killed,
        injured,
        offenders: Number.isFinite(offenders) ? offenders : null,
        weapon,
        situation,
        incident_type: r[col.type],
        location_type: r[col.location],
        tract: r[col.name],
        acs_period: r[col.year],
        pct_poverty_tract: Number(r[col.ppoverty_t]),
        median_income_tract: Number(r[col.medinc_t]),
        summary,
        ...nearestTraumaProperties(lon, lat, trauma),
        source_note:
          'Mass Killing Database (MKDB), 2006–2023: incidents with 4 or more killed; tract context from ACS 5-year estimates.',
      },
      geometry: {
        type: 'Point',
        coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6],
      },
    }),
  );
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
mkdirSync('data/restricted/exports', { recursive: true });
writeFileSync(
  csvPath,
  `${[
    [...keep.map((i) => header[i]), 'tract_check', 'census_tract_at_point'],
    ...csvRows,
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n')}\n`,
);
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/incidents.geojsonl`, `${lines.join('\n')}\n`);
console.log(`${csvPath}: ${csvRows.length} rows`);
console.log(`${outDir}/incidents.geojsonl: ${lines.length} incidents`);
console.log('tract check:', Object.fromEntries(checks));
