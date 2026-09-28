import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { createChunkedAreaLayer } from './chunkedAreaLayer.js';

// Nationwide context layers, chunked by county under public/context/ by
// scripts/build-context-layers.mjs and loaded only for the counties in view.
const HOLC_GRADES = Object.freeze([
  { grade: 'A', label: 'A Best', color: '#76a865' },
  { grade: 'B', label: 'B Still Desirable', color: '#7cb5bd' },
  { grade: 'C', label: 'C Declining', color: '#ffff00' },
  { grade: 'D', label: 'D Hazardous', color: '#d9533c' },
]);
// USALEEP's published national quintile bins for life_exp_8 (years).
const LIFE_EXPECTANCY_BINS = Object.freeze([
  { label: '≤75.1', color: '#b2182b', min: -Infinity, max: 75.15 },
  { label: '75.2–77.5', color: '#ef8a62', min: 75.15, max: 77.55 },
  { label: '77.6–79.5', color: '#fddbc7', min: 77.55, max: 79.55 },
  { label: '79.6–81.6', color: '#67a9cf', min: 79.55, max: 81.65 },
  { label: '≥81.7', color: '#2166ac', min: 81.65, max: Infinity },
]);
const NO_DATA_COLOR = '#9e9e9e';

function lifeExpectancyBin(years) {
  if (!(Number(years) > 0)) return null;
  return LIFE_EXPECTANCY_BINS.find((b) => years >= b.min && years < b.max);
}

/** Legend rows for a layer shaded by lifeExpectancyBin(property). */
function lifeExpectancyLegend(key) {
  return [
    ...LIFE_EXPECTANCY_BINS.map((b) => ({
      label: b.label,
      color: b.color,
      test: (p) => lifeExpectancyBin(p[key]) === b,
    })),
    {
      label: 'No data',
      color: NO_DATA_COLOR,
      test: (p) => !lifeExpectancyBin(p[key]),
    },
  ];
}

// Local Moran's I cluster types for life expectancy, colored like the life
// expectancy bins (blue = longer lives, red = shorter). Only significant
// clusters and outliers are in the data.
const LIFE_EXPECTANCY_CLUSTERS = Object.freeze([
  { type: 'HH', label: 'High–High (long-life cluster)', color: '#2166ac' },
  { type: 'LL', label: 'Low–Low (short-life cluster)', color: '#b2182b' },
  { type: 'HL', label: 'High–Low outlier', color: '#92c5de' },
  { type: 'LH', label: 'Low–High outlier', color: '#f4a582' },
]);
const clusterColor = (p) =>
  LIFE_EXPECTANCY_CLUSTERS.find((c) => c.type === p.cluster)?.color ||
  NO_DATA_COLOR;
const clusterLegend = () =>
  LIFE_EXPECTANCY_CLUSTERS.map((c) => ({
    label: c.label,
    color: c.color,
    test: (p) => p.cluster === c.type,
  }));
/** County layers are drawn nationwide: every state, from space-station height. */
const COUNTY_LAYER_OPTIONS = Object.freeze({
  maxHeightM: 8_000_000,
  maxChunks: 60,
  zoomInMessage: 'zoom in to the United States to load',
});

// Resolved by Vite in builds and relative to this module in other consumers.
const datacentersUrl = new URL(
  './local_data/datacenters/datacenters.geojsonl',
  import.meta.url,
).href;
const damsUrl = new URL('./local_data/dams/dams.geojsonl', import.meta.url)
  .href;
const chicagoEventsUrl = new URL(
  './local_data/chicago_events/chicago_events.geojsonl',
  import.meta.url,
).href;
// Converted from the public "Big Bas #1 Chicagoland & Illinois Gang Map"
// (Google My Maps) by scripts/mymaps-to-geojson.mjs + build-gang-map-layers.mjs.
const gangMapUrl = new URL(
  './local_data/gang_map/gang_map.geojsonl',
  import.meta.url,
).href;
const famousShootingsUrl = new URL(
  './local_data/gang_map/famous_shootings.geojsonl',
  import.meta.url,
).href;

// Hoods without a gang line and non-hood areas keep one color per source
// My Maps layer.
const GANG_MAP_CATEGORY_COLORS = Object.freeze({
  'Chicago Hoods': '#ff3b3b',
  'Suburb Hoods': '#ff9100',
  'Illinois Hoods': '#ffd600',
  'Demolished Projects & Apartments': '#a1887f',
});
const HOOD_LAYERS = new Set([
  'Chicago Hoods',
  'Suburb Hoods',
  'Illinois Hoods',
]);
// Hood territories are shaded by primary gang (the `gang` property). The
// largest gangs get fixed, well-separated colors; the rest hash into a
// secondary palette so every territory of one gang still shares a color.
const MAJOR_GANG_COLORS = Object.freeze({
  'gangster disciples': '#1e88e5',
  'black disciples': '#00acc1',
  'latin kings': '#fdd835',
  'black p stones': '#e53935',
  'conservative vice lords': '#43a047',
  'four corner hustlers': '#8e24aa',
  'traveling vice lords': '#7cb342',
  'satan disciples': '#ffb300',
  'maniac latin disciples': '#d81b60',
  'gangster two sixes': '#f4511e',
  'new breeds': '#3949ab',
  'mafia insane vice lords': '#00897b',
});
const OTHER_GANG_COLORS = Object.freeze([
  '#90caf9',
  '#a5d6a7',
  '#ffcc80',
  '#ce93d8',
  '#ef9a9a',
  '#80deea',
  '#fff59d',
  '#bcaaa4',
  '#b0bec5',
  '#f48fb1',
]);

/** Normalize a gang name so spelling/punctuation variants share a color. */
function gangKey(gang) {
  return String(gang)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fill color for one gang map feature.
 * @param {object} properties Feature properties.
 * @returns {string|undefined}
 */
function gangMapFeatureColor(properties) {
  if (HOOD_LAYERS.has(properties.layer) && properties.gang) {
    const key = gangKey(properties.gang);
    if (MAJOR_GANG_COLORS[key]) return MAJOR_GANG_COLORS[key];
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return OTHER_GANG_COLORS[hash % OTHER_GANG_COLORS.length];
  }
  return GANG_MAP_CATEGORY_COLORS[properties.layer];
}

/**
 * Create fresh datacenter, dam, Chicago event, gang map (territories plus
 * a separate names layer) and famous shooting layers without starting or loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters, dams, Chicago events, gang map, gang map
 * labels, then famous shootings, with stable standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacenters = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'USACE',
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  const chicagoEvents = createLocalGeoJsonLayer(
    {
      id: 'local-chicago-events',
      url: chicagoEventsUrl,
      name: 'Chicago Events',
      color: '#ff3b6b', // Magenta-red
      icon: '●',
      source: 'Local',
      labels: true,
      labelMax: 50,
      labelGridPx: 90,
    },
    services,
  );

  const gangMap = createLocalGeoJsonLayer(
    {
      id: 'local-gang-map',
      url: gangMapUrl,
      name: 'Gang Map',
      color: '#ff3b3b', // Red; per-category colors below
      icon: '⬢',
      source: 'Big Bas My Maps',
      labels: true,
      labelMax: 300,
      labelGridPx: 140,
      featureColor: gangMapFeatureColor,
      labeledAreas: true,
    },
    services,
  );
  // The territories draw no names; this separate layer over the same data
  // draws only the names, so either can be on without the other.
  gangMap.setAreaLabelsVisible(false);
  const gangMapLabels = createLocalGeoJsonLayer(
    {
      id: 'local-gang-map-labels',
      url: gangMapUrl,
      name: 'Gang Map Labels',
      color: '#ff3b3b',
      icon: '🏷',
      source: 'Hood names',
      labels: true,
      labelMax: 300,
      labelGridPx: 140,
      featureColor: gangMapFeatureColor,
      labeledAreas: true,
      areaNamesOnly: true,
    },
    services,
  );

  const famousShootings = createLocalGeoJsonLayer(
    {
      id: 'local-famous-shootings',
      url: famousShootingsUrl,
      name: 'Famous Shootings',
      color: '#f5f5f5', // White
      icon: '✚',
      source: 'Big Bas My Maps',
      labels: true,
      labelMax: 120,
      labelGridPx: 110,
    },
    services,
  );

  const holcRedlining = createChunkedAreaLayer(
    {
      id: 'local-holc-redlining',
      name: 'HOLC Redlining (1930s)',
      baseUrl: 'context/holc/',
      icon: '▦',
      source: 'Mapping Inequality',
      featureColor: (p) =>
        HOLC_GRADES.find((g) => g.grade === p.holc_grade)?.color ||
        NO_DATA_COLOR,
      legend: HOLC_GRADES.map((g) => ({
        label: g.label,
        color: g.color,
        test: (p) => p.holc_grade === g.grade,
      })),
    },
    services,
  );

  const lifeExpectancy = createChunkedAreaLayer(
    {
      id: 'local-life-expectancy',
      name: 'Life Expectancy (tracts)',
      baseUrl: 'context/life-expectancy/',
      icon: '♥',
      source: 'USALEEP',
      featureColor: (p) =>
        lifeExpectancyBin(p.life_exp_8)?.color || NO_DATA_COLOR,
      legend: lifeExpectancyLegend('life_exp_8'),
    },
    services,
  );

  const tractClusters = createChunkedAreaLayer(
    {
      id: 'local-tract-le-clusters',
      name: 'Life Expectancy Clusters (tracts)',
      baseUrl: 'context/tract-clusters/',
      icon: '◈',
      source: "Local Moran's I",
      featureColor: clusterColor,
      legend: clusterLegend(),
      // Only significant tracts are stored, so a wider view stays light.
      maxHeightM: 400_000,
      maxChunks: 45,
    },
    services,
  );

  const countyLifeExpectancy = createChunkedAreaLayer(
    {
      id: 'local-county-life-expectancy',
      name: 'Life Expectancy (counties)',
      baseUrl: 'context/county-life-expectancy/',
      icon: '♥',
      source: 'County 2000–2019',
      featureColor: (p) =>
        lifeExpectancyBin(p.life_exp)?.color || NO_DATA_COLOR,
      legend: lifeExpectancyLegend('life_exp'),
      ...COUNTY_LAYER_OPTIONS,
    },
    services,
  );

  const countyClusters = createChunkedAreaLayer(
    {
      id: 'local-county-le-clusters',
      name: 'Life Expectancy Clusters (counties)',
      baseUrl: 'context/county-clusters/',
      icon: '◈',
      source: "Local Moran's I",
      featureColor: clusterColor,
      legend: clusterLegend(),
      ...COUNTY_LAYER_OPTIONS,
    },
    services,
  );

  return [
    datacenters,
    dams,
    chicagoEvents,
    gangMap,
    gangMapLabels,
    famousShootings,
    holcRedlining,
    lifeExpectancy,
    tractClusters,
    countyLifeExpectancy,
    countyClusters,
  ];
}
