// Convert a public Google My Maps map into a GeoJSON FeatureCollection.
// Used when the map's KML export is disabled: the public viewer page embeds
// every layer and feature in its `_pageData` payload.
//
// Usage:
//   node scripts/mymaps-to-geojson.mjs <map-url-or-mid-or-saved-viewer.html> [out.geojson]
//
// Each feature gets `layer`, `name`, `description` and any other My Maps
// attribute columns as properties. Coordinates are written [lng, lat].
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [input, outArg] = process.argv.slice(2);
if (!input) {
  console.error(
    'usage: node scripts/mymaps-to-geojson.mjs <map-url|mid|viewer.html> [out.geojson]',
  );
  process.exit(1);
}

async function loadViewerHtml(source) {
  if (existsSync(source)) return readFileSync(source, 'utf8');
  const mid = /[?&]mid=([^&#]+)/.exec(source)?.[1] ?? source;
  const url = `https://www.google.com/maps/d/viewer?mid=${encodeURIComponent(mid)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    },
  });
  if (!response.ok)
    throw new Error(`viewer page returned HTTP ${response.status}`);
  return response.text();
}

function extractPageData(html) {
  const marker = 'var _pageData = "';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('no _pageData found (is the map public?)');
  // Scan to the closing quote manually; the payload is too large for a regex.
  let end = start + marker.length;
  while (end < html.length && html[end] !== '"')
    end += html[end] === '\\' ? 2 : 1;
  // The payload is a JS string literal; normalize \xNN escapes so JSON can read it.
  const literal = html
    .slice(start + marker.length, end)
    .replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1');
  return JSON.parse(JSON.parse(`"${literal}"`));
}

const isCoord = (a) =>
  Array.isArray(a) &&
  a.length === 2 &&
  typeof a[0] === 'number' &&
  typeof a[1] === 'number';
const unwrapCoord = (a) =>
  isCoord(a) ? a : Array.isArray(a) && isCoord(a[0]) ? a[0] : null;
const isCoordList = (a) =>
  Array.isArray(a) && a.length > 0 && a.every((e) => unwrapCoord(e));
const toLngLat = (e) => {
  const [lat, lng] = unwrapCoord(e);
  return [lng, lat];
};

// Collect every coordinate list, remembering which array holds it so rings
// that share a parent become one polygon (outer ring followed by holes).
function collectLists(node, parent, out) {
  if (!Array.isArray(node)) return out;
  if (isCoordList(node)) {
    out.push({ parent, coords: node.map(toLngLat) });
    return out;
  }
  for (const child of node) collectLists(child, node, out);
  return out;
}

function closeRing(ring) {
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function geometryOf(feature) {
  const [, point, line, polygon] = feature;
  if (point) {
    const [list] = collectLists(point, null, []);
    return list ? { type: 'Point', coordinates: list.coords[0] } : null;
  }
  if (line) {
    const lists = collectLists(line, null, []).map((l) => l.coords);
    if (!lists.length) return null;
    return lists.length === 1
      ? { type: 'LineString', coordinates: lists[0] }
      : { type: 'MultiLineString', coordinates: lists };
  }
  if (polygon) {
    const groups = new Map();
    for (const { parent, coords } of collectLists(polygon, null, [])) {
      if (coords.length < 3) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(closeRing(coords));
    }
    const polygons = [...groups.values()];
    if (!polygons.length) return null;
    return polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }
  return null;
}

function propertiesOf(feature, layerName) {
  const properties = { layer: layerName };
  const attributes = Array.isArray(feature[5]) ? feature[5] : [];
  for (const attribute of attributes) {
    if (!Array.isArray(attribute) || typeof attribute[0] !== 'string') continue;
    const value = Array.isArray(attribute[1]) ? attribute[1][0] : attribute[1];
    if (value != null && value !== '') properties[attribute[0]] = value;
  }
  return properties;
}

const pageData = extractPageData(await loadViewerHtml(input));
const map = pageData[1];
const mapTitle = map[2];
const features = [];
const summary = [];

for (const layer of map[6] ?? []) {
  const layerName = layer[2];
  const records = layer[12]?.[0]?.[13]?.[0] ?? [];
  let written = 0;
  for (const record of records) {
    const geometry = geometryOf(record);
    if (!geometry) continue;
    features.push({
      type: 'Feature',
      id: record[0],
      properties: propertiesOf(record, layerName),
      geometry,
    });
    written += 1;
  }
  summary.push(`${String(written).padStart(5)}  ${layerName}`);
}

const slug = String(mapTitle || 'mymaps')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '');
const outPath = outArg ?? `${slug}.geojson`;
writeFileSync(
  outPath,
  JSON.stringify({ type: 'FeatureCollection', name: mapTitle, features }),
);

console.log(`"${mapTitle}" -> ${outPath}`);
console.log(summary.join('\n'));
console.log(`${String(features.length).padStart(5)}  total features`);
