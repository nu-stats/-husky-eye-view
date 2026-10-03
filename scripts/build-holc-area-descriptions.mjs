#!/usr/bin/env node
// Build public/context/holc/area-descriptions.json: for every HOLC area that
// has a 1930s area description, the path of its page on Mapping Inequality,
// where the transcription and the scanned original form live.
//
// Input: data/source/holc_area_descriptions/ad_data.json, from
// https://github.com/americanpanorama/HOLC_Area_Description_Data (the scans
// are public domain; see that project for terms).
//
// Output: { "<area_id>": "<ST>/<CitySlug>/<label>" }. HOLC map features carry
// the same area id in their feature id (holc-<city_id>-<area_id>-<geoid>), so
// the map card can link straight to
// https://dsl.richmond.edu/panorama/redlining/map/<ST>/<CitySlug>/area_descriptions/<label>
//
//   node scripts/build-holc-area-descriptions.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { holcCitySlug } from '../src/data/holcAreaDescriptions.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const INPUT = `${root}data/source/holc_area_descriptions/ad_data.json`;
const OUTPUT = `${root}public/context/holc/area-descriptions.json`;

const rows = JSON.parse(readFileSync(INPUT, 'utf8'));
const index = {};
let skipped = 0;
for (const row of rows) {
  const state = String(row.state || '').trim();
  const slug = holcCitySlug(row.city);
  const label = String(row.label || '').trim();
  if (
    !row.area_id ||
    !/^[A-Z]{2}$/.test(state) ||
    !slug ||
    !/^[A-Za-z0-9-]+$/.test(label)
  ) {
    skipped += 1;
    continue;
  }
  index[row.area_id] = `${state}/${slug}/${label}`;
}
writeFileSync(OUTPUT, `${JSON.stringify(index)}\n`);
console.log(
  `wrote ${OUTPUT}: ${Object.keys(index).length} area descriptions` +
    (skipped ? ` (${skipped} rows skipped)` : ''),
);
