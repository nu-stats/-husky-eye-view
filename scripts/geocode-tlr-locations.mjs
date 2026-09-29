// Build the TLR layer from video2_locations_with_links.csv (location,
// video_timestamp, video_link): geocode each location and write
//   data/exports/tlr_locations_geocoded.csv  (input columns + coordinates)
//   src/data/local_data/tlr/tlr.geojsonl     (pins with video links)
//
// Most locations are Chicago grid references, turned into addresses the U.S.
// Census geocoder resolves: "79th Street & Essex Avenue" is the 7900 block of
// South Essex ("7900 S Essex Ave"). The QUERIES table below records each
// reading, including spelling fixes (Kofax/Kolfax -> Colfax, Damon -> Damen).
// Neighborhoods and landmarks go to OpenStreetMap Nominatim instead.
// Usage: node scripts/geocode-tlr-locations.mjs <input.csv>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  loadTraumaCenters,
  nearestTraumaProperties,
} from './lib/nearest-trauma.mjs';

const input = process.argv[2] ?? 'data/source/video2_locations_with_links.csv';
const csvOut = 'data/exports/tlr_locations_geocoded.csv';
const outDir = 'src/data/local_data/tlr';
const USER_AGENT =
  'HuskyEyeView-TLR-geocoder/1.0 (research use; one-off batch)';

/** location -> [census address | {place: nominatim query}, precision, note]. */
const QUERIES = {
  '66th Place & Blackstone Avenue, Chicago': [
    '6630 S Blackstone Ave',
    'intersection',
  ],
  'Corner of 39th Street & Drexel Boulevard, Chicago': [
    '3900 S Drexel Blvd',
    'intersection',
  ],
  'Yates Avenue & Kolfax Avenue corridor (75th–79th St), Chicago': [
    '7700 S Colfax Ave',
    'approximate',
    'corridor midpoint; "Kolfax" read as Colfax Avenue',
  ],
  '79th Street & Essex Avenue, Chicago': ['7900 S Essex Ave', 'intersection'],
  '78th Street & Muskegon Avenue (near Exchange), Chicago': [
    '7800 S Muskegon Ave',
    'intersection',
  ],
  '7815 South Marquette Avenue, Chicago': ['7815 S Marquette Ave', 'address'],
  'Greater Grand Crossing area, Chicago': [
    { place: 'Greater Grand Crossing, Chicago, Illinois' },
    'neighborhood',
  ],
  '1300 block of East 72nd Street, Chicago': ['1300 E 72nd St', 'block'],
  '74th–75th Street & Phillips Avenue, Chicago': [
    '7450 S Phillips Ave',
    'approximate',
    'between 74th and 75th',
  ],
  "McDonald's at 2425 East 79th Street, Chicago": ['2425 E 79th St', 'address'],
  '7800 block of South Essex Avenue, Chicago': ['7800 S Essex Ave', 'block'],
  '79th Street & Luella Avenue, Chicago': ['7900 S Luella Ave', 'intersection'],
  '79th Street & Escanaba Avenue, Chicago': [
    '7900 S Escanaba Ave',
    'intersection',
  ],
  '6801 South Crandon Avenue, Chicago': ['6801 S Crandon Ave', 'address'],
  '2400 block of East 75th Street, Chicago': ['2400 E 75th St', 'block'],
  '2500 East 79th Street & Essex Avenue, Chicago': [
    '2500 E 79th St',
    'address',
  ],
  '2600 block of East 79th Street, Chicago': ['2600 E 79th St', 'block'],
  '8000 block of South Manistee Avenue, Chicago': [
    '8000 S Manistee Ave',
    'block',
  ],
  '7300 block of South Dorchester Avenue, Chicago': [
    '7300 S Dorchester Ave',
    'block',
  ],
  '7500 block of South Yates Boulevard, Chicago': [
    '7500 S Yates Blvd',
    'block',
  ],
  '7500 block of South Merrill Avenue, Chicago': [
    '7500 S Merrill Ave',
    'block',
  ],
  '2400 block of East 75th Street & South Shore, Chicago': [
    '2400 E 75th St',
    'block',
  ],
  '2400 East 79th St / 7900 South Phillips Ave, Chicago': [
    '2400 E 79th St',
    'address',
  ],
  "2400 block of East 79th Street (McDonald's), Chicago": [
    '2400 E 79th St',
    'block',
  ],
  '7400 block of South Kofax Avenue, Chicago': [
    '7400 S Colfax Ave',
    'block',
    '"Kofax" read as Colfax Avenue',
  ],
  '2700 block of East 80th Street, Chicago': ['2700 E 80th St', 'block'],
  '7500 block of South Kofax Avenue, Chicago': [
    '7500 S Colfax Ave',
    'block',
    '"Kofax" read as Colfax Avenue',
  ],
  '7500 block of South Ellis Avenue, Chicago': ['7500 S Ellis Ave', 'block'],
  'Auburn Gresham neighborhood (street unspecified), Chicago': [
    { place: 'Auburn Gresham, Chicago, Illinois' },
    'neighborhood',
  ],
  '1500 block of East 82nd Street, Chicago': ['1500 E 82nd St', 'block'],
  '7900 block of South Phillips Avenue, Chicago': [
    '7900 S Phillips Ave',
    'block',
  ],
  'East 75th Street & South Coles Avenue, Chicago': [
    '7500 S Coles Ave',
    'intersection',
  ],
  'First block of East Roosevelt Road, Chicago': ['1 E Roosevelt Rd', 'block'],
  'Chicago Midway International Airport, Chicago': [
    { place: 'Chicago Midway International Airport' },
    'landmark',
  ],
  '7600 block of South Kingston Avenue, Chicago': [
    '7600 S Kingston Ave',
    'block',
  ],
  '8600 block of South Exchange Avenue, Chicago': [
    '8600 S Exchange Ave',
    'block',
  ],
  '7800 block of South Phillips Avenue, Chicago': [
    '7800 S Phillips Ave',
    'block',
  ],
  '7800 block of South Essex Avenue, Chicago (2nd incident)': [
    '7800 S Essex Ave',
    'block',
    'same block as an earlier incident',
  ],
  'McKinley Park, Chicago': [
    { place: 'McKinley Park, Chicago, Illinois' },
    'neighborhood',
  ],
  '7000 block of South Damon Avenue, Chicago': [
    '7000 S Damen Ave',
    'block',
    '"Damon" read as Damen Avenue',
  ],
  '6900 block of South Woodlawn Avenue, Chicago': [
    '6900 S Woodlawn Ave',
    'block',
  ],
  '1931 South State Street, Chicago': ['1931 S State St', 'address'],
  '2500 block West 79th Street, Chicago': ['2500 W 79th St', 'block'],
};

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
  return rows.filter((r) => r.some((value) => value.trim()));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function census(address) {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
    `?address=${encodeURIComponent(`${address}, Chicago, IL`)}` +
    '&benchmark=Public_AR_Current&format=json';
  const body = await fetch(url, { signal: AbortSignal.timeout(30000) }).then(
    (r) => r.json(),
  );
  const match = body.result?.addressMatches?.[0];
  return match
    ? {
        lon: match.coordinates.x,
        lat: match.coordinates.y,
        matched: match.matchedAddress,
      }
    : null;
}

async function nominatim(query) {
  await sleep(1100); // Nominatim usage policy: at most one request a second
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1' +
    `&q=${encodeURIComponent(query)}`;
  const [hit] = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  }).then((r) => r.json());
  return hit
    ? { lon: Number(hit.lon), lat: Number(hit.lat), matched: hit.display_name }
    : null;
}

async function videoTitle(link) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`;
    const body = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(
      (r) => r.json(),
    );
    return body.title || '';
  } catch {
    return '';
  }
}

const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
const title = rows.length ? await videoTitle(rows[0][col.video_link]) : '';
const trauma = loadTraumaCenters();

const out = [];
const lines = [];
const seen = new Map();
for (const [index, r] of rows.entries()) {
  const location = r[col.location].trim();
  const spec = QUERIES[location];
  if (!spec) throw new Error(`No geocoding reading for "${location}"`);
  const [query, precision, note = ''] = spec;
  const hit =
    typeof query === 'string'
      ? await census(query)
      : await nominatim(query.place);
  const source = typeof query === 'string' ? 'census' : 'openstreetmap';
  console.log(
    `${location} -> ${hit ? `${hit.lat.toFixed(5)},${hit.lon.toFixed(5)} (${hit.matched})` : 'NOT FOUND'}`,
  );
  out.push([
    location,
    r[col.video_timestamp],
    r[col.video_link],
    hit ? hit.lon.toFixed(6) : '',
    hit ? hit.lat.toFixed(6) : '',
    hit ? source : 'not found',
    precision,
    typeof query === 'string' ? query : query.place,
    hit?.matched ?? '',
    note,
  ]);
  if (!hit) continue;
  // Separate incidents at the same geocoded spot would stack their pins:
  // nudge each repeat ~15 m east so every one stays clickable.
  const spot = `${hit.lon.toFixed(5)},${hit.lat.toFixed(5)}`;
  const repeats = seen.get(spot) || 0;
  seen.set(spot, repeats + 1);
  const lon = Math.round((hit.lon + repeats * 0.00018) * 1e6) / 1e6;
  const lat = Math.round(hit.lat * 1e6) / 1e6;
  const nudge = repeats
    ? 'nudged ~15 m east of an earlier pin at the same spot'
    : '';
  lines.push(
    JSON.stringify({
      type: 'Feature',
      id: `tlr-${index + 1}`,
      properties: {
        name: location,
        point_id: index + 1,
        coordinate_note: [
          precision === 'intersection' ||
          precision === 'block' ||
          precision === 'address'
            ? `geocoded ${precision} (${source === 'census' ? 'U.S. Census geocoder' : 'OpenStreetMap'})`
            : `${precision} location (${source === 'census' ? 'U.S. Census geocoder' : 'OpenStreetMap'})`,
          note,
          nudge,
        ]
          .filter(Boolean)
          .join('; '),
        ...nearestTraumaProperties(lon, lat, trauma),
        video_time: r[col.video_timestamp],
        video_url: r[col.video_link],
        ...(title && { video_title: title }),
      },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    }),
  );
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
mkdirSync('data/exports', { recursive: true });
writeFileSync(
  csvOut,
  `${[
    [
      'location',
      'video_timestamp',
      'video_link',
      'longitude',
      'latitude',
      'geocode_source',
      'geocode_precision',
      'geocode_query',
      'geocode_match',
      'geocode_note',
    ],
    ...out,
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n')}\n`,
);
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/tlr.geojsonl`, `${lines.join('\n')}\n`);
console.log(
  `\n${csvOut}: ${out.length} rows; ${outDir}/tlr.geojsonl: ${lines.length} pins`,
);
console.log(`video title: ${title || '(unavailable)'}`);
