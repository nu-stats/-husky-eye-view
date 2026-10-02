# Datacenters

OpenStreetMap-derived datacenter features bundled for the local infrastructure
layer.

- Source: OpenStreetMap contributors
- License: Open Database License (ODbL) 1.0
- Feature count: 4,351
- Runtime file: `datacenters.geojsonl`

The public-release snapshot removes contact-oriented tags such as email, phone,
fax, mobile, and WhatsApp values. The application does not display or depend on
those fields; it uses feature identity, geometry, name, operator, and capacity
metadata. The remaining derived database continues to be distributed under
ODbL 1.0 with the required OpenStreetMap attribution.

The original extraction date and query were not recorded alongside this
snapshot. Future refreshes should record both before replacing the file.

## United States only (since v0.1.3)

The runtime file keeps only features inside the United States (50 states, DC and
Puerto Rico): 1,549 of the original 4,351 features. The filter uses the Census 2024 tract
outlines as the boundary; see `scripts/filter-points-to-us.mjs`.
