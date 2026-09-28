// Convert public/chicago_events2.json (Esri JSON export) into the GeoJSON Lines
// format read by createLocalGeoJsonLayer. Unmapped points (NaN or 0,0) are skipped.
// Each point is joined by point_id to its caption-derived note in
// src/data/local_data/chicago_events/video_notes.json, which adds the incident
// summary and a link to the moment in the source video that discusses it.
// Usage: node scripts/convert-chicago-events.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input = 'public/chicago_events2.json';
const outDir = 'src/data/local_data/chicago_events';
const output = `${outDir}/chicago_events.geojsonl`;
const notesPath = `${outDir}/video_notes.json`;

/** "m:ss" or "h:mm:ss" to whole seconds. */
function toSeconds(time) {
  return String(time)
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

const esri = JSON.parse(readFileSync(input, 'utf8'));
const { video, notes } = JSON.parse(readFileSync(notesPath, 'utf8'));
const lines = [];
const skipped = [];
const withoutNotes = [];

for (const { attributes: a, geometry } of esri.features) {
  const x = Number(geometry?.x);
  const y = Number(geometry?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
    skipped.push(`${a.point_id}: ${a.location}`);
    continue;
  }
  const note = notes[String(a.point_id)];
  if (!note) withoutNotes.push(a.point_id);
  lines.push(
    JSON.stringify({
      type: 'Feature',
      id: `chicago-event-${a.point_id}`,
      properties: {
        name: a.location,
        point_id: a.point_id,
        coordinate_note: a.coordinate,
        ...(note && {
          victim: note.victim,
          victim_gang: note.victim_gang,
          alleged_group: note.alleged_group,
          reliability: note.reliability,
          video_summary: note.summary,
          video_time: note.time,
          video_url: `https://www.youtube.com/watch?v=${video.id}&t=${toSeconds(note.time)}s`,
          video_title: video.title,
          video_caveat: video.caveat,
        }),
      },
      geometry: {
        type: 'Point',
        coordinates: [Number(x.toFixed(6)), Number(y.toFixed(6))],
      },
    }),
  );
}

mkdirSync(outDir, { recursive: true });
writeFileSync(output, `${lines.join('\n')}\n`);
console.log(`wrote ${lines.length} features to ${output}`);
for (const entry of skipped) console.log(`  skipped (no coordinates) ${entry}`);
if (withoutNotes.length) {
  console.log(`  no video note for point_id ${withoutNotes.join(', ')}`);
}
