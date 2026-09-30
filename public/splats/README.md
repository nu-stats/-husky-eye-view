# 3D Captures (Gaussian splats)

The **3D Captures (splats)** layer in Data Layers loads every capture listed in
`captures.json` and places it on the globe at its real location. Each capture
gets a **FLY TO** button under the layer's row.

## Adding a capture

1. Capture the place: dozens to hundreds of overlapping photos, or a slow video
   circling it (phone walkaround or drone orbit).
2. Build the splat with a tool such as Polycam, Luma, Postshot or Nerfstudio.
3. Convert it to **3D Tiles** whose glTF uses the `KHR_gaussian_splatting` and
   `KHR_gaussian_splatting_compression_spz_2` extensions, placed at its real
   location (Cesium ion does this; a plain `.ply` will not load).
4. Copy the tileset folder here, e.g. `public/splats/my-capture/tileset.json`.
5. Add it to `captures.json`:

   ```json
   { "name": "My capture", "tileset": "/splats/my-capture/tileset.json", "credit": "Who made it" }
   ```

Reload the page and turn the layer on. A listed capture whose files are missing
is skipped.

## The sample tower

`cesium-tower/` is CesiumJS test data (Apache-2.0) and is git-ignored. To get it,
download `tileset.json` and `0/0.glb` from
`https://github.com/CesiumGS/cesium/tree/main/Specs/Data/Cesium3DTiles/GaussianSplats/tower`
into `public/splats/cesium-tower/`.
