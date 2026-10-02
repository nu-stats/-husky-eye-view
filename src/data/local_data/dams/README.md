# Dams

Extracted from local decoded OpenInfraMap/PostGIS layers.

Filters: `waterway=dam`, `man_made=dam`, or `building=dam`.

Feature count: 704

Runtime output: `dams.geojsonl`

License: Open Database License (ODbL) 1.0. Keep the OpenStreetMap contributor
attribution and the Open Infrastructure Map source credit when redistributing
this derived database.

The public-release snapshot removes contact-oriented fields and note values
that contain email or phone identifiers. The runtime layer does not display or
depend on those fields. The runtime JSONL file (`dams.geojsonl`) carries that
privacy transform.

## United States only (since v0.1.3)

The runtime file keeps only features inside the United States (50 states, DC and
Puerto Rico): 66 of the original 704 features. The filter uses the Census 2024 tract
outlines as the boundary; see `scripts/filter-points-to-us.mjs`.
