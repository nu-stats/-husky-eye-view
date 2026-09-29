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
// Miami-Dade homicides 1956-2011: one pin layer per decade, each in its own
// color (the 1950s and 2000s layers are partial decades). Files are written
// by scripts/convert-miami-dade-homicides.mjs.
const HOMICIDE_DECADES = Object.freeze([
  {
    key: '1950s',
    label: '1956–1959',
    color: '#f0f921',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_1950s.geojsonl',
      import.meta.url,
    ).href,
  },
  {
    key: '1960s',
    label: '1960s',
    color: '#fdb42f',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_1960s.geojsonl',
      import.meta.url,
    ).href,
  },
  {
    key: '1970s',
    label: '1970s',
    color: '#f07f4f',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_1970s.geojsonl',
      import.meta.url,
    ).href,
  },
  {
    key: '1980s',
    label: '1980s',
    color: '#d8576b',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_1980s.geojsonl',
      import.meta.url,
    ).href,
  },
  {
    key: '1990s',
    label: '1990s',
    color: '#b83289',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_1990s.geojsonl',
      import.meta.url,
    ).href,
  },
  {
    key: '2000s',
    label: '2000–2011',
    color: '#8b0aa5',
    url: new URL(
      './local_data/miami_dade_homicides/homicides_2000s.geojsonl',
      import.meta.url,
    ).href,
  },
]);
// Homicide hotspot bands (kernel density, homicides per km² over 1956-2011;
// top-weighted percentile breaks from scripts/build-miami-homicide-hotspots.mjs), off-white
// for the lowest to orange for the most concentrated.
const HOMICIDE_HOTSPOT_BANDS = Object.freeze([
  { band: 1, label: '1–3.8 per km²', color: '#fff5eb' },
  { band: 2, label: '3.8–8.7', color: '#fee6ce' },
  { band: 3, label: '8.7–16', color: '#fdd0a2' },
  { band: 4, label: '16–31', color: '#fdae6b' },
  { band: 5, label: '31–86', color: '#fd8d3c' },
  { band: 6, label: '86–532 (top 3%)', color: '#f16913' },
]);
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
const tlrUrl = new URL('./local_data/tlr/tlr.geojsonl', import.meta.url).href;
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
// Trauma centers (HIFLD Hospitals, open hospitals with a trauma designation;
// scripts/fetch-trauma-centers.mjs), colored by trauma level.
const traumaCentersUrl = new URL(
  './local_data/trauma_centers/trauma_centers.geojsonl',
  import.meta.url,
).href;
const TRAUMA_LEVELS = Object.freeze([
  {
    label: 'Level I',
    color: '#e31a1c',
    test: (p) => p.trauma_level === 'Level I',
  },
  {
    label: 'Level II',
    color: '#fd8d3c',
    test: (p) => p.trauma_level === 'Level II',
  },
  {
    label: 'Level III',
    color: '#fecc5c',
    test: (p) => p.trauma_level === 'Level III',
  },
  {
    label: 'Level IV',
    color: '#a1dab4',
    test: (p) => p.trauma_level === 'Level IV',
  },
  {
    label: 'Level V',
    color: '#41b6c4',
    test: (p) => p.trauma_level === 'Level V',
  },
  {
    label: 'Pediatric only',
    color: '#c51b8a',
    test: (p) => String(p.trauma_level).startsWith('Pediatric'),
  },
  {
    label: 'Other designation',
    color: '#bdbdbd',
    test: (p) => p.trauma_level === 'Other designation',
  },
]);
// Public housing developments (HUD; scripts/fetch-public-housing.mjs), one
// pin per development, colored by the decade its first building was built.
const publicHousingUrl = new URL(
  './local_data/public_housing/developments.geojsonl',
  import.meta.url,
).href;
const HOUSING_ERAS = Object.freeze([
  { label: 'Before 1950', color: '#bf812d', min: 0, max: 1950 },
  { label: '1950s', color: '#dfc27d', min: 1950, max: 1960 },
  { label: '1960s', color: '#f6e8c3', min: 1960, max: 1970 },
  { label: '1970s', color: '#c7eae5', min: 1970, max: 1980 },
  { label: '1980s', color: '#80cdc1', min: 1980, max: 1990 },
  { label: '1990 and later', color: '#35978f', min: 1990, max: Infinity },
]);
const housingEra = (p) =>
  Number(p.construct_year) > 0
    ? HOUSING_ERAS.find(
        (e) => p.construct_year >= e.min && p.construct_year < e.max,
      )
    : null;
// Gun Violence Archive 2015 gun deaths, geocoded by
// scripts/geocode-gva-incidents.mjs and built by scripts/build-gva-layer.mjs.
// Locked research data: served decrypted by server/providers/research.js only
// when the research key is configured (the repo carries it encrypted).
const gva2015Url = '/api/research/gva-2015';
const GVA_DEATHS = Object.freeze([
  { label: '1 killed', color: '#fc9272', min: 1, max: 2 },
  { label: '2 killed', color: '#ef3b2c', min: 2, max: 3 },
  { label: '3–4 killed', color: '#cb181d', min: 3, max: 5 },
  { label: '5 or more killed', color: '#67000d', min: 5, max: Infinity },
]);
const gvaDeaths = (p) =>
  GVA_DEATHS.find((d) => p.killed >= d.min && p.killed < d.max);
// Mass Killing Database incidents (4+ killed, 2006–2023), tract-checked and
// built by scripts/convert-mkdb-incidents.mjs.
const mkdbUrl = '/api/research/mkdb';
const MKDB_DEATHS = Object.freeze([
  { label: '4 killed', color: '#d4b9da', min: 4, max: 5 },
  { label: '5 killed', color: '#c994c7', min: 5, max: 6 },
  { label: '6–9 killed', color: '#df65b0', min: 6, max: 10 },
  { label: '10 or more killed', color: '#ce1256', min: 10, max: Infinity },
]);
const mkdbDeaths = (p) =>
  MKDB_DEATHS.find((d) => p.killed >= d.min && p.killed < d.max);
// Boston's 69 neighborhood statistical areas, reprojected from Massachusetts
// State Plane by scripts/convert-boston-neighborhoods.mjs. Each area is shaded
// by the neighborhood group the source file assigns it (its `Nbhd` field).
const bostonNeighborhoodsUrl = new URL(
  './local_data/boston/neighborhoods.geojsonl',
  import.meta.url,
).href;
const BOSTON_NEIGHBORHOOD_GROUPS = Object.freeze(
  [
    ['Allston-Brighton', '#1f77b4'],
    ['Back Bay', '#aec7e8'],
    ['Beacon Hill', '#ff7f0e'],
    ['Charlestown', '#ffbb78'],
    ['Dorchester', '#2ca02c'],
    ['East Boston', '#98df8a'],
    ['Fenway', '#d62728'],
    ['Financial District', '#ff9896'],
    ['Hyde Park', '#9467bd'],
    ['Mattapan', '#c5b0d5'],
    ['Mission Hill', '#8c564b'],
    ['Roslindale', '#c49c94'],
    ['Roxbury', '#e377c2'],
    ['South Boston', '#f7b6d2'],
    ['South End', '#bcbd22'],
    ['West Roxbury', '#17becf'],
  ].map(([label, color]) => ({
    label,
    color,
    test: (p) => p.neighborhood === label,
  })),
);

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

  // TLR: locations from the "No Limit: Chicago's Deadliest Gang" video, each
  // linked to its moment in the video (scripts/geocode-tlr-locations.mjs).
  const tlr = createLocalGeoJsonLayer(
    {
      id: 'local-tlr',
      url: tlrUrl,
      name: 'TLR',
      color: '#ff8c1a',
      icon: '●',
      source: 'Video locations',
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

  const miamiHomicideHotspots = createChunkedAreaLayer(
    {
      id: 'local-miami-homicide-hotspots',
      name: 'Miami Homicide Hotspots',
      baseUrl: 'context/miami-homicide-hotspots/',
      icon: '▦',
      source: 'Kernel density',
      sourceNote:
        'Kernel density of 13,348 Miami-Dade homicides, 1956–2011 (quartic kernel, 800 m radius, 200 m cells; bands at the 40th/65th/80th/90th/97th percentiles). 667 incidents stacked on fallback geocodes are left out.',
      featureColor: (p) =>
        HOMICIDE_HOTSPOT_BANDS.find((b) => b.band === p.band)?.color ||
        NO_DATA_COLOR,
      legend: HOMICIDE_HOTSPOT_BANDS.map((b) => ({
        label: b.label,
        color: b.color,
        test: (p) => p.band === b.band,
      })),
      fillAlpha: 0.6,
      maxHeightM: 400_000,
      maxChunks: 1,
      zoomInMessage: 'zoom in to Miami-Dade to load',
    },
    services,
  );

  // Same pins, stems and clickable cards as Chicago Events, one layer per
  // decade in that decade's color.
  const miamiHomicides = HOMICIDE_DECADES.map((decade) =>
    createLocalGeoJsonLayer(
      {
        id: `local-miami-homicides-${decade.key}`,
        name: `Miami Homicides ${decade.label}`,
        url: decade.url,
        color: decade.color,
        icon: '●',
        source: 'Miami-Dade homicides',
        labels: true,
        labelMax: 50,
        labelGridPx: 90,
        legend: [
          { label: decade.label, color: decade.color, test: () => true },
        ],
      },
      services,
    ),
  );

  const gva2015 = createLocalGeoJsonLayer(
    {
      id: 'local-gva-2015',
      name: 'Gun Deaths 2015 (GVA)',
      url: gva2015Url,
      lockedDataset: 'gva-2015',
      color: '#ef3b2c',
      icon: '●',
      source: 'Gun Violence Archive',
      labels: true,
      labelMax: 50,
      labelGridPx: 90,
      featureColor: (p) => gvaDeaths(p)?.color,
      legend: GVA_DEATHS.map((d) => ({
        label: d.label,
        color: d.color,
        test: (p) => gvaDeaths(p) === d,
      })),
    },
    services,
  );

  const mkdb = createLocalGeoJsonLayer(
    {
      id: 'local-mkdb',
      name: 'MKDB Mass Killings (2006–2023)',
      url: mkdbUrl,
      lockedDataset: 'mkdb',
      color: '#df65b0',
      icon: '●',
      source: 'Mass Killing Database',
      labels: true,
      labelMax: 50,
      labelGridPx: 90,
      featureColor: (p) => mkdbDeaths(p)?.color,
      legend: MKDB_DEATHS.map((d) => ({
        label: d.label,
        color: d.color,
        test: (p) => mkdbDeaths(p) === d,
      })),
    },
    services,
  );

  const traumaCenters = createLocalGeoJsonLayer(
    {
      id: 'local-trauma-centers',
      name: 'Trauma Centers',
      url: traumaCentersUrl,
      color: '#e31a1c',
      icon: '✚',
      source: 'HIFLD Hospitals',
      labels: true,
      labelMax: 60,
      labelGridPx: 110,
      featureColor: (p) => TRAUMA_LEVELS.find((l) => l.test(p))?.color,
      legend: TRAUMA_LEVELS,
    },
    services,
  );

  const publicHousing = createLocalGeoJsonLayer(
    {
      id: 'local-public-housing',
      name: 'Public Housing',
      url: publicHousingUrl,
      color: '#80cdc1',
      icon: '⌂',
      source: 'HUD',
      labels: true,
      labelMax: 60,
      labelGridPx: 110,
      featureColor: (p) => housingEra(p)?.color || NO_DATA_COLOR,
      legend: [
        ...HOUSING_ERAS.map((e) => ({
          label: e.label,
          color: e.color,
          test: (p) => housingEra(p) === e,
        })),
        {
          label: 'Year unknown',
          color: NO_DATA_COLOR,
          test: (p) => !housingEra(p),
        },
      ],
    },
    services,
  );

  const bostonNeighborhoods = createLocalGeoJsonLayer(
    {
      id: 'local-boston-neighborhoods',
      name: 'Boston Neighborhoods',
      url: bostonNeighborhoodsUrl,
      color: '#a2aaad',
      icon: '⬢',
      source: 'Neighborhood areas',
      labels: true,
      labelMax: 80,
      labelGridPx: 120,
      labeledAreas: true,
      featureColor: (p) =>
        BOSTON_NEIGHBORHOOD_GROUPS.find((g) => g.test(p))?.color ||
        NO_DATA_COLOR,
      legend: BOSTON_NEIGHBORHOOD_GROUPS,
    },
    services,
  );

  return [
    datacenters,
    dams,
    chicagoEvents,
    tlr,
    gangMap,
    gangMapLabels,
    famousShootings,
    holcRedlining,
    lifeExpectancy,
    tractClusters,
    countyLifeExpectancy,
    countyClusters,
    ...miamiHomicides,
    miamiHomicideHotspots,
    traumaCenters,
    publicHousing,
    gva2015,
    mkdb,
    bostonNeighborhoods,
  ];
}
