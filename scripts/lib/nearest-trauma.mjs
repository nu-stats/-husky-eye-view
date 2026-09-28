// Nearest trauma center to a point, for the Chicago Events and Famous
// Shootings builds. Distances are straight-line (great-circle), not driving
// distance. Reads the trauma layer written by scripts/fetch-trauma-centers.mjs.
import { readFileSync } from 'node:fs';

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;

/** @returns {{name:string, level:string, lon:number, lat:number}[]} */
export function loadTraumaCenters(
  path = 'src/data/local_data/trauma_centers/trauma_centers.geojsonl',
) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const f = JSON.parse(line);
      const [lon, lat] = f.geometry.coordinates;
      return {
        name: f.properties.name,
        level: f.properties.trauma_level,
        lon,
        lat,
      };
    });
}

/** Great-circle distance in km. */
export function distanceKm(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function nearest(lon, lat, centers) {
  let best = null;
  for (const center of centers) {
    const km = distanceKm(lon, lat, center.lon, center.lat);
    if (!best || km < best.km) best = { center, km };
  }
  return best;
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Feature properties naming the nearest trauma center of any level and the
 * nearest adult Level I center, with straight-line distances.
 */
export function nearestTraumaProperties(lon, lat, centers) {
  const any = nearest(lon, lat, centers);
  const levelOne = nearest(
    lon,
    lat,
    centers.filter((c) => c.level === 'Level I'),
  );
  return {
    ...(any && {
      nearest_trauma_center: any.center.name,
      nearest_trauma_level: any.center.level,
      nearest_trauma_km: round2(any.km),
      nearest_trauma_miles: round2(any.km / KM_PER_MILE),
    }),
    ...(levelOne && {
      nearest_level1_center: levelOne.center.name,
      nearest_level1_km: round2(levelOne.km),
      nearest_level1_miles: round2(levelOne.km / KM_PER_MILE),
    }),
  };
}
