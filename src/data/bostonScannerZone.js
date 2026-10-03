/**
 * Where the Boston Police scanner preset is offered: within 15 miles of the
 * Boston city boundary. The audio itself is the department's official public
 * feed (RapidSOS, delayed about five minutes, personal non-commercial use), so
 * the app only links to it and never relays the stream.
 */

export const BOSTON_SCANNER_URL = 'https://radio.rapidsos.com/boston';
export const BOSTON_SCANNER_RADIUS_MILES = 15;

const KM_PER_MILE = 1.609344;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

/** Ray-casting point-in-ring. ring = [[lon, lat], …]. */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Distance in km from the origin to segment a-b, all in local km coordinates. */
function originToSegmentKm(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2))
    : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Miles from a point to the Boston city boundary; 0 inside the city.
 * Uses a local flat projection around the point, which is well within a
 * percent of the true distance at these ranges.
 * @param {number} lat
 * @param {number} lon
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} rings
 * @returns {number}
 */
export function milesFromBoston(lat, lon, rings) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !rings?.length)
    return Infinity;
  const kmPerDegLon =
    KM_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
  let bestKm = Infinity;
  for (const ring of rings) {
    if (pointInRing(lon, lat, ring)) return 0;
    for (let i = 1; i < ring.length; i++) {
      const km = originToSegmentKm(
        (ring[i - 1][0] - lon) * kmPerDegLon,
        (ring[i - 1][1] - lat) * KM_PER_DEG_LAT,
        (ring[i][0] - lon) * kmPerDegLon,
        (ring[i][1] - lat) * KM_PER_DEG_LAT,
      );
      if (km < bestKm) bestKm = km;
    }
  }
  return bestKm / KM_PER_MILE;
}

/** True when the scanner preset should be offered for this point. */
export function bostonScannerAvailable(lat, lon, rings) {
  return milesFromBoston(lat, lon, rings) <= BOSTON_SCANNER_RADIUS_MILES;
}
