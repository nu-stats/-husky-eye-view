// Fetch CDC Environmental Public Health Tracking "Access to Parks" (measure
// 1285: percent of people living within 1/2 mile of a park, 2020 edition, 2020
// census tracts) for every state, one paced request per state, and keep only
// tract GEOID -> percent.
// Output: data/source/green-space/cdc_park_access_2020_half_mile.json
//   [{ geoid, pct }]
// The Tracking API rate-limits anonymous callers (HTTP 429 after ~10 quick
// calls), so requests are spaced out and retried with a growing delay.
// Usage: node scripts/fetch-park-access.mjs [state FIPS ...]
//   With states given, only those are fetched and merged into the existing file
//   (for a state that came back empty).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'data/source/green-space/cdc_park_access_2020_half_mile.json';
const STATES = [
  '01',
  '02',
  '04',
  '05',
  '06',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
  '39',
  '40',
  '41',
  '42',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '50',
  '51',
  '53',
  '54',
  '55',
  '56',
];
const url = (state) =>
  `https://ephtracking.cdc.gov/apigateway/api/v1/getCoreHolder/1285/3296/1/${state}/1/2020/0/0?DistanceId=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchState(state) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const response = await fetch(url(state), {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 429 || response.status >= 500) {
      const wait = Math.min(120_000, 10_000 * attempt);
      console.log(
        `  ${state}: HTTP ${response.status}, retry in ${wait / 1000}s`,
      );
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`${state}: HTTP ${response.status}`);
    const body = await response.json();
    const rows = Array.isArray(body?.tableResult) ? body.tableResult : [];
    // Large states sometimes come back with an empty table under load; the
    // same request succeeds a little later.
    if (!rows.length && attempt < 8) {
      console.log(`  ${state}: empty table, retry in 20s`);
      await sleep(20_000);
      continue;
    }
    return rows
      .map((row) => ({
        geoid: String(row.geoId ?? row.geoID ?? '').padStart(11, '0'),
        pct: Number(row.dataValue),
      }))
      .filter((row) => /^\d{11}$/.test(row.geoid) && Number.isFinite(row.pct));
  }
  throw new Error(`${state}: still rate-limited after 8 attempts`);
}

const requested = process.argv.slice(2);
const states = requested.length ? requested : STATES;
const all =
  requested.length && existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, 'utf8')).filter(
        (row) => !requested.includes(row.geoid.slice(0, 2)),
      )
    : [];
const empty = [];
for (const state of states) {
  const rows = await fetchState(state);
  if (!rows.length) empty.push(state);
  all.push(...rows);
  console.log(`${state}: ${rows.length} tracts (total ${all.length})`);
  await sleep(6_000);
}
if (empty.length)
  console.log(`empty states (re-run with them): ${empty.join(' ')}`);
mkdirSync('data/source/green-space', { recursive: true });
writeFileSync(OUT, JSON.stringify(all));
console.log(`wrote ${all.length} tracts to ${OUT}`);
