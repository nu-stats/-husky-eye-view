// Convert data/source/miami_dade_homicides.geojson (Miami-Dade homicides,
// 1956-2011, one point per incident) into compact GeoJSON Lines files, one
// per decade, read by the Miami-Dade Homicides decade pin layers. Only what
// the map and details card use is kept: year, date, victim age, victim group
// flags, narrative and census tract. Victim surnames and the undocumented
// numeric codes (method, location, circumstance...) are left out.
// Usage: node scripts/convert-miami-dade-homicides.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const input = 'data/source/miami_dade_homicides.geojson';
const outDir = 'src/data/local_data/miami_dade_homicides';

/** Decade file key; keep in step with HOMICIDE_DECADES in infrastructure.js. */
const decadeKey = (year) =>
  year < 1960
    ? '1950s'
    : year >= 2000
      ? '2000s'
      : `${Math.floor(year / 10) * 10}s`;

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

/** DOD is month*100 + day (113 = Jan 13); null when it does not decode. */
function dateLabel(year, dod) {
  const value = Number(dod);
  const month = Math.floor(value / 100);
  const day = value % 100;
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Victim group from the dataset's named 0/1 flags. */
function victimGroup(p) {
  const groups = [];
  if (p.AllBlack) groups.push('Black');
  if (p.AllWhite) groups.push('White');
  if (p.AllLatino) groups.push('Latino');
  if (p.HaitianV) groups.push('Haitian');
  if (p.WCuban || p.BCuban) groups.push('Cuban');
  return groups.join(', ');
}

const sentence = (text) => {
  const clean = String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!clean) return '';
  const capped = clean[0].toUpperCase() + clean.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

const source = JSON.parse(readFileSync(input, 'utf8'));
const byDecade = new Map();
let skipped = 0;
for (const feature of source.features) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry?.coordinates || [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    skipped += 1;
    continue;
  }
  const year = Number(p.Year);
  const date = dateLabel(year, p.DOD);
  // 888 and 999 are "unknown" codes; 0 is ambiguous (infant or missing).
  const rawAge = Number(p.Age);
  const age = rawAge > 0 && rawAge < 120 ? Math.round(rawAge) : null;
  const group = victimGroup(p);
  const victim = [age !== null ? `age ${age}` : '', group]
    .filter(Boolean)
    .join(', ');
  const summary = [
    sentence(p.Narrative),
    victim ? `Victim: ${victim}.` : '',
    p.CensusTrac ? `${p.CensusTrac}, Miami-Dade County.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const key = decadeKey(year);
  if (!byDecade.has(key)) byDecade.set(key, []);
  byDecade.get(key).push(
    JSON.stringify({
      type: 'Feature',
      id: `miami-dade-homicide-${p.id}`,
      properties: {
        name: `Homicide · ${date || year}`,
        year,
        ...(age !== null && { age }),
        ...(group && { victim_group: group }),
        summary: summary || 'No narrative recorded.',
        source_note: 'Miami-Dade homicides 1956–2011 (miami_dade_homicides).',
      },
      geometry: {
        type: 'Point',
        coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6],
      },
    }),
  );
}

mkdirSync(outDir, { recursive: true });
rmSync(`${outDir}/homicides.geojsonl`, { force: true }); // old single file
let total = 0;
for (const [key, lines] of [...byDecade].sort()) {
  writeFileSync(`${outDir}/homicides_${key}.geojsonl`, `${lines.join('\n')}\n`);
  total += lines.length;
  console.log(`  homicides_${key}.geojsonl: ${lines.length}`);
}
console.log(
  `${outDir}: ${total} homicides${skipped ? `, ${skipped} without coordinates skipped` : ''}`,
);
