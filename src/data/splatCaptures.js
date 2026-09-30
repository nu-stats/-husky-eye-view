import * as Cesium from 'cesium';

/**
 * 3D Captures: Gaussian splat scenes placed on the globe at their real
 * locations. CesiumJS renders 3D Tiles whose glTF uses the
 * KHR_gaussian_splatting and KHR_gaussian_splatting_compression_spz_2
 * extensions; a raw .ply/.spz has to be converted to that first.
 *
 * Captures are listed in public/splats/captures.json:
 *   [{ "name": "…", "tileset": "/splats/<folder>/tileset.json", "credit": "…" }]
 * A listed capture whose files are missing is skipped, so the list can name
 * sample data that is not committed.
 */
export const SPLAT_CATALOG_URL = '/splats/captures.json';

/** "44.52°N, 93.17°W" for a tileset's bounding-sphere center. */
function captureLocation(tileset) {
  const center = tileset?.boundingSphere?.center;
  if (!center) return '';
  const carto = Cesium.Cartographic.fromCartesian(center);
  if (!carto) return '';
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Create the 3D Captures layer without loading anything.
 * @param {object} [options]
 * @param {string} [options.catalogUrl] Capture list location.
 * @param {Function} [options.fetchImpl] fetch(url, init).
 * @param {Function} [options.loadTileset] url -> Promise<Cesium3DTileset>.
 */
export function createSplatCapturesLayer({
  catalogUrl = SPLAT_CATALOG_URL,
  fetchImpl = (...args) => fetch(...args),
  loadTileset = (url) => Cesium.Cesium3DTileset.fromUrl(url),
} = {}) {
  let viewerRef = null;
  let loaded = [];
  let skipped = [];
  let error = null;
  let lastUpdate = null;
  let rowControlsListener = null;
  // Bumped on every enable/disable so a slow load cannot land after a toggle.
  let generation = 0;

  const notifyRowControls = () => {
    try {
      rowControlsListener?.();
    } catch {
      // The panel re-renders on its own cadence too.
    }
  };

  const flyToCapture = (tileset) => {
    const viewer = viewerRef;
    const radius = tileset?.boundingSphere?.radius;
    if (!viewer?.camera || !radius) return;
    viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
      duration: 2.5,
      offset: new Cesium.HeadingPitchRange(0.6, -0.3, radius * 3),
    });
  };

  const readCatalog = async () => {
    const response = await fetchImpl(catalogUrl, { cache: 'no-store' });
    if (response.status === 404) return [];
    if (!response.ok)
      throw new Error(`Capture list unavailable (HTTP ${response.status})`);
    const list = await response.json();
    return Array.isArray(list)
      ? list.filter((entry) => typeof entry?.tileset === 'string')
      : [];
  };

  const removeAll = () => {
    for (const { tileset } of loaded) {
      try {
        viewerRef?.scene?.primitives?.remove(tileset);
      } catch {
        // Already gone with the scene.
      }
    }
    loaded = [];
  };

  return {
    id: 'local-3d-captures',
    name: '3D Captures (splats)',
    icon: '◉',
    source: 'Gaussian splats',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async () => {},
    update: async () => {},

    enable: async (viewer) => {
      const gen = ++generation;
      viewerRef = viewer;
      error = null;
      skipped = [];
      let entries;
      try {
        entries = await readCatalog();
      } catch (failure) {
        error = failure?.message || String(failure);
        return true;
      }
      for (const entry of entries) {
        try {
          const tileset = await loadTileset(entry.tileset);
          if (gen !== generation) {
            tileset?.destroy?.();
            return true;
          }
          viewer.scene.primitives.add(tileset);
          loaded.push({ entry, tileset, where: captureLocation(tileset) });
        } catch {
          if (gen !== generation) return true;
          skipped.push(entry.name || entry.tileset);
        }
      }
      lastUpdate = Date.now();
      viewer.scene.requestRender?.();
      notifyRowControls();
      return true;
    },

    disable: async () => {
      generation += 1;
      removeAll();
      notifyRowControls();
      return true;
    },

    destroy: () => {
      generation += 1;
      removeAll();
    },

    getStats: () => ({
      count: loaded.length,
      lastUpdate,
      error:
        error ||
        (!loaded.length && skipped.length
          ? `No capture files found (${skipped.length} listed in captures.json)`
          : null),
    }),

    // Captures are small and can be anywhere on Earth, so each one gets a
    // chip under the row that flies the camera to it.
    getRowControls: () => ({
      chips: loaded.map(({ entry, tileset, where }, index) => ({
        id: `capture-${index}`,
        label: `FLY TO ${String(entry.name || 'CAPTURE').toUpperCase()}`,
        title: [where, entry.credit].filter(Boolean).join(' · '),
        onClick: () => flyToCapture(tileset),
      })),
      legend: [],
    }),
    setRowControlsListener: (listener) => {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
  };
}
