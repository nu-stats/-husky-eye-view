// Download U.S. hospitals with a trauma designation from the HIFLD Hospitals
// layer (DHS / Oak Ridge National Laboratory; FEMA's live copy, since HIFLD
// Open was retired in 2025) and write:
//   data/source/hifld_hospitals_trauma.json                 raw download
//   data/exports/trauma_centers.csv                          one row per hospital, x/y
//   src/data/local_data/trauma_centers/trauma_centers.geojsonl  map layer
// Only OPEN hospitals whose TRAUMA field names a designation are kept;
// "NOT AVAILABLE" means unknown in HIFLD, not "no trauma unit".
// Usage: node scripts/fetch-trauma-centers.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const SERVICE =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6/query';
const FIELDS = [
  'ID',
  'NAME',
  'ADDRESS',
  'CITY',
  'STATE',
  'ZIP',
  'COUNTY',
  'TYPE',
  'STATUS',
  'TRAUMA',
  'HELIPAD',
  'BEDS',
  'LATITUDE',
  'LONGITUDE',
  'SOURCE',
  'SOURCEDATE',
];
const PAGE = 2000;

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({
      where: "TRAUMA IS NOT NULL AND TRAUMA <> 'NOT AVAILABLE'",
      outFields: FIELDS.join(','),
      returnGeometry: 'false',
      orderByFields: 'FID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'json',
    });
    const response = await fetch(`${SERVICE}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json();
    if (page.error) throw new Error(page.error.message);
    rows.push(...page.features.map((f) => f.attributes));
    if (!page.exceededTransferLimit && page.features.length < PAGE) break;
  }
  return rows;
}

/**
 * Collapse HIFLD's free-text TRAUMA values to one level for coloring: the
 * best adult level, else the best pediatric level, else the state's own
 * designation code.
 */
export function traumaLevel(raw) {
  const text = String(raw || '').toUpperCase();
  const levels = [...text.matchAll(/LEVEL\s+(V|IV|III|II|I)\b([^,/]*)/g)].map(
    ([, roman, rest]) => ({
      n: { I: 1, II: 2, III: 3, IV: 4, V: 5 }[roman],
      pediatric: /PEDIATRIC/.test(rest) && !/ADULT/.test(rest),
      rehab: /REHAB/.test(rest),
    }),
  );
  const adult = levels.filter((l) => !l.pediatric && !l.rehab);
  const pediatric = levels.filter((l) => l.pediatric && !l.rehab);
  const best = (list) => Math.min(...list.map((l) => l.n));
  const roman = ['', 'I', 'II', 'III', 'IV', 'V'];
  if (adult.length) return `Level ${roman[best(adult)]}`;
  if (pediatric.length) return `Pediatric Level ${roman[best(pediatric)]}`;
  if (/PEDIATRIC/.test(text)) return 'Pediatric';
  return 'Other designation';
}

const clean = (value) =>
  value === null || value === undefined ? '' : String(value).trim();
const csvCell = (value) => {
  const text = clean(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const title = (value) =>
  clean(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

const raw = await fetchAll();
mkdirSync('data/source', { recursive: true });
writeFileSync('data/source/hifld_hospitals_trauma.json', JSON.stringify(raw));

const hospitals = raw
  .filter((r) => clean(r.STATUS).toUpperCase() === 'OPEN')
  .filter((r) => Number.isFinite(r.LATITUDE) && Number.isFinite(r.LONGITUDE))
  .map((r) => ({
    id: clean(r.ID),
    name: title(r.NAME),
    address: title(r.ADDRESS),
    city: title(r.CITY),
    state: clean(r.STATE),
    zip: clean(r.ZIP),
    county: title(r.COUNTY),
    trauma_designation: clean(r.TRAUMA),
    trauma_level: traumaLevel(r.TRAUMA),
    hospital_type: title(r.TYPE),
    beds: r.BEDS > 0 ? r.BEDS : '',
    helipad: clean(r.HELIPAD),
    x: Math.round(r.LONGITUDE * 1e6) / 1e6,
    y: Math.round(r.LATITUDE * 1e6) / 1e6,
    source_date: r.SOURCEDATE
      ? new Date(r.SOURCEDATE).toISOString().slice(0, 10)
      : '',
  }))
  .sort(
    (a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name),
  );

const columns = Object.keys(hospitals[0]);
mkdirSync('data/exports', { recursive: true });
writeFileSync(
  'data/exports/trauma_centers.csv',
  `${[columns.join(','), ...hospitals.map((h) => columns.map((c) => csvCell(h[c])).join(','))].join('\n')}\n`,
);

const layerDir = 'src/data/local_data/trauma_centers';
mkdirSync(layerDir, { recursive: true });
writeFileSync(
  `${layerDir}/trauma_centers.geojsonl`,
  `${hospitals
    .map((h) =>
      JSON.stringify({
        type: 'Feature',
        id: `trauma-${h.id}`,
        properties: {
          name: h.name,
          trauma_level: h.trauma_level,
          trauma_designation: h.trauma_designation,
          address: [h.address, h.city, h.state].filter(Boolean).join(', '),
          summary: `${h.trauma_level} trauma designation (${h.trauma_designation}). ${[h.address, h.city, h.state, h.zip].filter(Boolean).join(', ')}.${h.helipad === 'Y' ? ' Helipad.' : ''}`,
          source_note: `HIFLD Hospitals (DHS/ORNL), trauma field as of ${h.source_date || '2025'}; open hospitals only.`,
        },
        geometry: { type: 'Point', coordinates: [h.x, h.y] },
      }),
    )
    .join('\n')}\n`,
);

const byLevel = {};
for (const h of hospitals)
  byLevel[h.trauma_level] = (byLevel[h.trauma_level] || 0) + 1;
console.log(
  `downloaded ${raw.length} designated hospitals; kept ${hospitals.length} open with coordinates`,
);
console.log(JSON.stringify(byLevel));
