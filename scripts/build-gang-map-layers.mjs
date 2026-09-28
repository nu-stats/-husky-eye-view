// Split the converted Big Bas gang map GeoJSON into the two GeoJSON Lines
// datasets read by createLocalGeoJsonLayer: the gang map (drawn territories
// only) in one file, and the "Famous Shootings" layer in its own file.
// Every single-point feature (point-only hoods, neighborhoods, nation
// birthplaces, demolished-project points) and the disputed/dying/unknown hoods
// category are left out of the gang map.
// Usage: node scripts/build-gang-map-layers.mjs [public/big_bas_chicagoland_gang_map.geojson]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'public/big_bas_chicagoland_gang_map.geojson';
const outDir = 'src/data/local_data/gang_map';
const SHOOTINGS_LAYER = 'Famous Shootings';
const EXCLUDED_LAYERS = new Set(['Disputed, Dying & Unknown Hoods']);

const { features } = JSON.parse(readFileSync(input, 'utf8'));
const gangMap = [];
const shootings = [];
let skipped = 0;
for (const feature of features) {
  const layer = feature.properties?.layer;
  if (layer === SHOOTINGS_LAYER) {
    shootings.push(JSON.stringify(feature));
    continue;
  }
  const isPoint = feature.geometry?.type === 'Point';
  if (EXCLUDED_LAYERS.has(layer) || isPoint) {
    skipped += 1;
    continue;
  }
  // Primary gang: the first name on the description's "Gang(s):" line, used
  // to color territories by gang.
  const gangLine = /^Gangs?:\s*(.+)$/m.exec(
    feature.properties?.description ?? '',
  );
  const gang = gangLine?.[1]
    .split(/\s*(?:&|,|\/|\band\b)\s*/)[0]
    .replace(/^[\s(]+|[\s)]+$/g, '')
    .trim();
  if (gang) feature.properties = { ...feature.properties, gang };
  gangMap.push(JSON.stringify(feature));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/gang_map.geojsonl`, `${gangMap.join('\n')}\n`);
writeFileSync(
  `${outDir}/famous_shootings.geojsonl`,
  `${shootings.join('\n')}\n`,
);
console.log(
  `gang_map.geojsonl: ${gangMap.length} features (${skipped} left out)`,
);
console.log(`famous_shootings.geojsonl: ${shootings.length} features`);
