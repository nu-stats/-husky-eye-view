// Build the GVA 2015 gun deaths map layer from the geocoded CSV written by
// scripts/geocode-gva-incidents.mjs:
//   data/exports/gva_2015_incidents_geocoded.csv -> src/data/local_data/gva_2015/incidents.geojsonl
// Usage: node scripts/build-gva-layer.mjs [input.csv]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'data/exports/gva_2015_incidents_geocoded.csv';
const outDir = 'src/data/local_data/gva_2015';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1);
}

/** "7/16/15" -> "2015-07-16". */
function isoDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(value.trim());
  if (!m) return value;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const niceDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return m ? `${MONTHS[m - 1]} ${d}, ${y}` : iso;
};

const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
const col = Object.fromEntries(header.map((name, i) => [name, i]));
const lines = [];
for (const r of rows) {
  const lat = Number(r[col.latitude]);
  const lon = Number(r[col.longitude]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0)
  )
    continue;
  const killed = Number(r[col.num_killed]) || 0;
  const injured = Number(r[col.num_injured]) || 0;
  const date = isoDate(r[col.incident_date]);
  const place =
    r[col.city_or_county_original_gva] ||
    r[col.city_or_county_guardian_corrected];
  const address = /^n\/?a$/i.test(r[col.address].trim())
    ? ''
    : r[col.address].trim();
  const precision = r[col.geocode_precision] || 'as-published';
  lines.push(
    JSON.stringify({
      type: 'Feature',
      id: `gva-${r[col.gva_id]}-${lines.length}`,
      properties: {
        name: address ? `${address}, ${place}` : `${place}, ${r[col.state]}`,
        date,
        killed,
        injured,
        state: r[col.state],
        summary: `${niceDate(date)}: ${killed} killed${injured ? `, ${injured} injured` : ''}. ${[address, place, r[col.state]].filter(Boolean).join(', ')}.${precision === 'as-published' ? '' : ` Location precision: ${precision} (geocoded).`}`,
        source_url: r[col.gva_url].replace(/^http:\/\//, 'https://'),
        source_note:
          'Gun Violence Archive, 2015 gun deaths (Guardian-corrected release).',
      },
      geometry: {
        type: 'Point',
        coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6],
      },
    }),
  );
}
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/incidents.geojsonl`, `${lines.join('\n')}\n`);
console.log(`${outDir}/incidents.geojsonl: ${lines.length} incidents`);
