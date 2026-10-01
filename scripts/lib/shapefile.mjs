// Minimal ESRI shapefile reader for the data build scripts: polygon .shp
// records (types 5, 15, 25) plus the .dbf attribute table. No dependencies.
import { readFileSync } from 'node:fs';

/** Read the .dbf attribute table as an array of plain objects. */
function readDbf(path) {
  const buf = readFileSync(path);
  const count = buf.readInt32LE(4);
  const headerLength = buf.readInt16LE(8);
  const recordLength = buf.readInt16LE(10);
  const fields = [];
  for (let offset = 32; buf[offset] !== 0x0d; offset += 32) {
    fields.push({
      name: buf.toString('latin1', offset, offset + 11).replace(/\0.*$/, ''),
      type: String.fromCharCode(buf[offset + 11]),
      length: buf[offset + 16],
    });
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    let offset = headerLength + i * recordLength + 1; // skip the deletion flag
    const row = {};
    for (const field of fields) {
      const raw = buf.toString('utf8', offset, offset + field.length).trim();
      row[field.name] =
        field.type === 'N' || field.type === 'F'
          ? raw === ''
            ? null
            : Number(raw)
          : raw;
      offset += field.length;
    }
    rows.push(row);
  }
  return rows;
}

/** Signed ring area in degrees²; negative = clockwise (a shapefile outer ring). */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Read the .shp polygons as GeoJSON geometries (null for null shapes). */
function readShpPolygons(path) {
  const buf = readFileSync(path);
  const geometries = [];
  let offset = 100;
  while (offset < buf.length) {
    const contentBytes = buf.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const type = buf.readInt32LE(start);
    if (type === 0) {
      geometries.push(null);
    } else if (type === 5 || type === 15 || type === 25) {
      const numParts = buf.readInt32LE(start + 36);
      const numPoints = buf.readInt32LE(start + 40);
      const parts = [];
      for (let p = 0; p < numParts; p++)
        parts.push(buf.readInt32LE(start + 44 + p * 4));
      const pointsAt = start + 44 + numParts * 4;
      const rings = parts.map((first, p) => {
        const last = p + 1 < numParts ? parts[p + 1] : numPoints;
        const ring = [];
        for (let k = first; k < last; k++) {
          ring.push([
            buf.readDoubleLE(pointsAt + k * 16),
            buf.readDoubleLE(pointsAt + k * 16 + 8),
          ]);
        }
        return ring;
      });
      // Clockwise rings are outers; each hole joins the outer that holds it.
      const polygons = [];
      const holes = [];
      for (const ring of rings) {
        if (ring.length < 4) continue;
        if (signedArea(ring) < 0) polygons.push([ring]);
        else holes.push(ring);
      }
      for (const hole of holes) {
        const owner =
          polygons.find((polygon) => pointInRing(hole[0], polygon[0])) ||
          polygons[0];
        if (owner) owner.push(hole);
        else polygons.push([hole]); // counter-clockwise lone ring: treat as outer
      }
      geometries.push(
        polygons.length === 0
          ? null
          : polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons },
      );
    } else {
      throw new Error(`${path}: unsupported shape type ${type}`);
    }
    offset = start + contentBytes;
  }
  return geometries;
}

export function readShapefile(base) {
  const rows = readDbf(`${base}.dbf`);
  const geometries = readShpPolygons(`${base}.shp`);
  if (rows.length !== geometries.length)
    throw new Error(
      `${base}: ${rows.length} attribute rows but ${geometries.length} shapes`,
    );
  return rows.map((properties, i) => ({ properties, geometry: geometries[i] }));
}
