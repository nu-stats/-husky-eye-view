// Fill in coordinates for Gun Violence Archive incidents that have none.
// Rows GVA already geocoded keep their coordinates. The rest are tried with
// the U.S. Census Bureau geocoder (street addresses), OpenStreetMap Overpass
// (the node where two streets of an intersection meet), then OpenStreetMap
// Nominatim (intersections, other places; 1 request/second per its usage
// policy), then the town itself. Two columns record how each row was placed:
//   geocode_source    gva | census | openstreetmap | openstreetmap-city | openstreetmap-county
//   geocode_precision as-published | address | intersection | street | city | county
// Usage: node scripts/geocode-gva-incidents.mjs <input.csv> <output.csv>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    'usage: node scripts/geocode-gva-incidents.mjs <input.csv> <output.csv>',
  );
  process.exit(1);
}

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
const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const STATE_ABBR = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
};
const USER_AGENT =
  'HuskyEyeView-GVA-geocoder/1.0 (research use; one-off batch)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Rough great-circle distance between two {x: lon, y: lat} points, km. */
const distanceKm = (p, q) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((q.y - p.y) * rad) / 2) ** 2 +
    Math.cos(p.y * rad) *
      Math.cos(q.y * rad) *
      Math.sin(((q.x - p.x) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
const QUEENS_POSTAL_TOWNS = [
  'Jamaica',
  'Flushing',
  'Astoria',
  'Long Island City',
  'Corona',
  'Elmhurst',
  'Jackson Heights',
  'East Elmhurst',
  'Queens Village',
  'Far Rockaway',
  'Arverne',
  'Rockaway Park',
  'Ridgewood',
  'Woodside',
  'Sunnyside',
  'Forest Hills',
  'Rego Park',
  'Kew Gardens',
  'Richmond Hill',
  'Woodhaven',
  'Ozone Park',
  'South Ozone Park',
  'Howard Beach',
  'Hollis',
  'Saint Albans',
  'Springfield Gardens',
  'Rosedale',
  'Cambria Heights',
  'Fresh Meadows',
  'Bayside',
  'Oakland Gardens',
  'Little Neck',
  'Whitestone',
  'College Point',
  'Maspeth',
  'Middle Village',
  'Glen Oaks',
  'Bellerose',
  'Floral Park',
];

/** "Fort Lauderdale (Lauderhill)" -> "Lauderhill": the specific place. */
function placeOf(cityField) {
  const inner = /\(([^)]+)\)/.exec(cityField);
  return (inner ? inner[1] : cityField).trim();
}
/** "2900 block of NW 55th Ave" -> "2900 NW 55th Ave". */
function streetAddress(address) {
  return address.replace(/\bblock of\s+/i, '').trim();
}
const isIntersection = (address) => /\s(and|&|at)\s/i.test(address);
const hasAddress = (address) => address && !/^n\/?a$/i.test(address.trim());

async function census(address, place, state) {
  const params = new URLSearchParams({
    address: `${address}, ${place}, ${state}`,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const response = await fetch(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`,
  );
  if (!response.ok) return null;
  const match = (await response.json())?.result?.addressMatches?.[0];
  return match
    ? {
        x: match.coordinates.x,
        y: match.coordinates.y,
        label: match.matchedAddress,
      }
    : null;
}

let lastNominatim = 0;
async function nominatim(params) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const query = new URLSearchParams({
    ...params,
    countrycodes: 'us',
    format: 'jsonv2',
    limit: '1',
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${query}`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!response.ok) return null;
  const hit = (await response.json())?.[0];
  return hit
    ? {
        x: Number(hit.lon),
        y: Number(hit.lat),
        label: hit.display_name,
        kind: hit.addresstype,
      }
    : null;
}

/**
 * The node where two named streets meet inside a town, from OpenStreetMap
 * (Overpass API), or null.
 */
async function intersection(address, place, state) {
  const [a, b] = address.split(/\s(?:and|&|at)\s/i).map((s) => s.trim());
  if (!a || !b) return null;
  // Overpass regexes are POSIX: no \s, so runs of spaces become ' +'.
  const pattern = (name) =>
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, ' +')}$`;
  const query = `[out:json][timeout:25];
area["name"="${place.replace(/"/g, '')}"]["boundary"="administrative"]->.town;
way(area.town)["highway"]["name"~"${pattern(a)}",i]->.a;
way(area.town)["highway"]["name"~"${pattern(b)}",i]->.b;
node(w.a)(w.b);
out 1;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!response.ok) return null;
  const node = (await response.json())?.elements?.[0];
  if (!node) return null;
  // Town names repeat across states: accept the meeting point only if it is
  // near this state's town of that name.
  const town = await nominatim({ city: place, state });
  if (!town || distanceKm(town, { x: node.lon, y: node.lat }) > 60) return null;
  return node
    ? {
        x: node.lon,
        y: node.lat,
        label: `${a} & ${b}, ${place}, ${state} (OSM node ${node.id})`,
      }
    : null;
}

const [header, ...allRows] = parseCsv(readFileSync(input, 'utf8'));
const col = Object.fromEntries(header.map((name, i) => [name, i]));
// Lines with no incident id (stray rows of empty cells) are not incidents.
const rows = allRows.filter((row) => String(row[col.gva_id] ?? '').trim());
const blankLines = allRows.length - rows.length;
const outHeader = [
  ...header,
  'geocode_source',
  'geocode_precision',
  'geocode_match',
];
const report = [];
for (const row of rows) {
  const lat = Number(row[col.latitude]);
  const lon = Number(row[col.longitude]);
  const placed =
    row[col.latitude] !== '' &&
    row[col.longitude] !== '' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    !(lat === 0 && lon === 0);
  if (placed) {
    row.push('gva', 'as-published', '');
    continue;
  }
  const address = row[col.address] || '';
  const place = placeOf(
    row[col.city_or_county_original_gva] ||
      row[col.city_or_county_guardian_corrected],
  );
  const state = STATE_ABBR[row[col.state]] || row[col.state];
  // GVA's place is sometimes a county ("Rankin County"), not a town.
  const isCounty = /\bcounty\b/i.test(place);
  const locality = isCounty ? { county: place } : { city: place };
  let hit = null;
  let source = '';
  let precision = '';
  if (hasAddress(address) && !isIntersection(address)) {
    hit = await census(streetAddress(address), place, state);
    // The Census geocoder needs a Queens address's postal town, not
    // "Queens". Hyphenated Queens house numbers are unique borough-wide, so
    // the first town that matches is the right place.
    for (const town of place === 'Queens' && !hit ? QUEENS_POSTAL_TOWNS : []) {
      hit = await census(streetAddress(address), town, state);
      if (hit) break;
    }
    if (hit) [source, precision] = ['census', 'address'];
  }
  if (!hit && hasAddress(address) && isIntersection(address) && !isCounty) {
    hit = await intersection(address, place, state);
    if (hit) [source, precision] = ['openstreetmap', 'intersection'];
  }
  if (!hit && hasAddress(address)) {
    const street = isIntersection(address)
      ? address.replace(/\s(and|at)\s/i, ' & ')
      : streetAddress(address);
    hit = await nominatim({ street, ...locality, state });
    // A road match found the street but not the house number.
    if (hit)
      [source, precision] = [
        'openstreetmap',
        isIntersection(address) || hit.kind === 'road' ? 'street' : 'address',
      ];
    if (!hit && isIntersection(address)) {
      // Intersections Nominatim cannot resolve: place on the first street.
      hit = await nominatim({
        street: address.split(/\s(?:and|&|at)\s/i)[0],
        ...locality,
        state,
      });
      if (hit) [source, precision] = ['openstreetmap', 'street'];
    }
  }
  if (!hit) {
    hit = await nominatim({ ...locality, state });
    if (hit)
      [source, precision] = isCounty
        ? ['openstreetmap-county', 'county']
        : ['openstreetmap-city', 'city'];
  }
  if (hit) {
    row[col.latitude] = String(Math.round(hit.y * 1e6) / 1e6);
    row[col.longitude] = String(Math.round(hit.x * 1e6) / 1e6);
  }
  row.push(source || 'not-found', precision, hit?.label || '');
  report.push(
    `${row[col.gva_id]}: ${address}, ${place}, ${state} -> ${source || 'NOT FOUND'} ${precision} ${hit ? `${hit.y.toFixed(5)},${hit.x.toFixed(5)} (${hit.label})` : ''}`,
  );
}

writeFileSync(
  output,
  `${[outHeader, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`,
);
console.log(
  `${rows.length} incidents (${blankLines} blank lines dropped); ${report.length} needed geocoding`,
);
for (const line of report) console.log(`  ${line}`);
