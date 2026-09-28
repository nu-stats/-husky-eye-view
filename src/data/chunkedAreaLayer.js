import * as Cesium from 'cesium';
import { isPointerFree } from './inputOwnership.js';
import { isLocalCardAction, pickLocalEntity } from './localGeojsonCore.js';

/**
 * Nationwide area layer loaded on demand. The dataset is split into chunks
 * (one GeoJSON Lines file per county) described by an index of bounding
 * boxes; only the chunks in view are fetched and drawn, and chunks that leave
 * the view are released. Zoomed out past `maxHeightM` nothing is drawn and the
 * panel shows a zoom-in hint.
 *
 * Areas are shaded by `featureColor(properties)` and are selectable: a click
 * publishes the feature's context, which opens the details card for features
 * carrying a `summary`.
 */

/** Default camera height above which the layer asks the user to zoom in. */
export const CHUNKED_AREA_MAX_HEIGHT_M = 250_000;
/** Default cap on chunks drawn at once (nearest to the view center first). */
export const CHUNKED_AREA_MAX_CHUNKS = 30;
/** Parsed chunks kept after leaving the view, so panning back is instant. */
const CHUNK_CACHE_LIMIT = 90;
const FILL_ALPHA = 0.4;

/**
 * Chunks whose bbox intersects the view rectangle, nearest center first.
 * @param {Array<{id:string,bbox:number[]}>} index
 * @param {{west:number,south:number,east:number,north:number}} view Degrees.
 * @param {number} limit
 * @returns {string[]}
 */
export function chunksInView(index, view, limit) {
  const cx = (view.west + view.east) / 2;
  const cy = (view.south + view.north) / 2;
  return index
    .filter(
      ({ bbox: [w, s, e, n] }) =>
        e >= view.west && w <= view.east && n >= view.south && s <= view.north,
    )
    .map((chunk) => {
      const [w, s, e, n] = chunk.bbox;
      const dx = (w + e) / 2 - cx;
      const dy = (s + n) / 2 - cy;
      return { id: chunk.id, d: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((chunk) => chunk.id);
}

/**
 * @param {object} options
 * @param {string} options.id Layer id.
 * @param {string} options.name Panel label.
 * @param {string} options.baseUrl Directory URL holding index.json and chunks.
 * @param {function(object):string} options.featureColor Fill color per feature.
 * @param {Array<{label:string,color:string,blurb?:string,test:function(object):boolean}>} [options.legend]
 * @param {string} [options.icon]
 * @param {string} [options.source]
 * @param {number} [options.maxHeightM]
 * @param {number} [options.maxChunks]
 * @param {string} [options.zoomInMessage] Panel hint above `maxHeightM`.
 * @param {Function} [options.screenSpaceEventHandlerFactory] Test seam.
 * @param {object} services Shared context/overlay operations.
 */
export function createChunkedAreaLayer(
  {
    id,
    name,
    baseUrl,
    featureColor,
    legend = [],
    icon = '▦',
    source = 'Local',
    maxHeightM = CHUNKED_AREA_MAX_HEIGHT_M,
    maxChunks = CHUNKED_AREA_MAX_CHUNKS,
    zoomInMessage = 'zoom in to a city or county to load',
    screenSpaceEventHandlerFactory = (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
  },
  {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  },
) {
  // Relative directories resolve against the page, so the app still finds
  // its data when it is served under a non-root base path.
  const base = (() => {
    const raw = String(baseUrl).replace(/\/?$/, '/');
    try {
      return new URL(raw, globalThis.document?.baseURI).href;
    } catch {
      return raw;
    }
  })();
  let viewer = null;
  let enabled = false;
  let destroyed = false;
  let index = null;
  let indexPromise = null;
  let error = null;
  let status = null;
  let lastUpdate = null;
  let generation = 0;
  let pending = 0;
  let clickHandler = null;
  let moveEndRemover = null;
  let rowControlsListener = null;
  /** chunk id -> Cesium.GeoJsonDataSource currently in the scene */
  const drawn = new Map();
  /** chunk id -> parsed features (LRU by insertion order) */
  const cache = new Map();
  const colors = new Map();

  const colorFor = (css) => {
    if (!colors.has(css)) colors.set(css, Cesium.Color.fromCssColorString(css));
    return colors.get(css);
  };

  function notifyRowControls() {
    try {
      rowControlsListener?.();
    } catch {
      /* the panel re-renders on its own cadence too */
    }
  }

  async function loadIndex() {
    if (index) return index;
    indexPromise ||= (async () => {
      const response = await fetch(`${base}index.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
      const parsed = await response.json();
      if (!Array.isArray(parsed)) throw new Error('index is malformed');
      index = parsed;
      return index;
    })();
    try {
      return await indexPromise;
    } finally {
      indexPromise = null;
    }
  }

  async function loadChunkFeatures(chunkId) {
    if (cache.has(chunkId)) {
      const features = cache.get(chunkId);
      cache.delete(chunkId);
      cache.set(chunkId, features); // refresh LRU position
      return features;
    }
    const response = await fetch(
      `${base}${encodeURIComponent(chunkId)}.geojsonl`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
    const text = await response.text();
    const features = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    cache.set(chunkId, features);
    while (cache.size > CHUNK_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (drawn.has(oldest)) break;
      cache.delete(oldest);
    }
    return features;
  }

  function releaseChunk(chunkId) {
    const dataSource = drawn.get(chunkId);
    if (!dataSource) return;
    drawn.delete(chunkId);
    if (viewer?.selectedEntity?.__chunkedChunkId === chunkId) {
      viewer.selectedEntity = undefined;
      clearSelectedEntityContextForLayer(id);
    }
    try {
      viewer?.dataSources?.remove(dataSource, true);
    } catch {
      /* already gone */
    }
  }

  function releaseAll() {
    for (const chunkId of [...drawn.keys()]) releaseChunk(chunkId);
  }

  async function drawChunk(chunkId, gen) {
    const features = await loadChunkFeatures(chunkId);
    if (gen !== generation || !enabled || destroyed || drawn.has(chunkId))
      return;
    const dataSource = await Cesium.GeoJsonDataSource.load(
      { type: 'FeatureCollection', features },
      { clampToGround: true },
    );
    if (gen !== generation || !enabled || destroyed || drawn.has(chunkId))
      return;
    dataSource.name = `${name} ${chunkId}`;
    for (const entity of dataSource.entities.values) {
      entity.__localLayerId = id;
      entity.__chunkedChunkId = chunkId;
      if (!entity.polygon) continue;
      const props =
        entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
      entity.polygon.material = new Cesium.ColorMaterialProperty(
        colorFor(featureColor(props) || '#9e9e9e').withAlpha(FILL_ALPHA),
      );
      entity.polygon.outline = false;
    }
    drawn.set(chunkId, dataSource);
    await viewer.dataSources.add(dataSource);
    if (gen !== generation || !enabled || destroyed) {
      releaseChunk(chunkId);
    }
  }

  /** Reconcile the drawn chunks with the current camera view. */
  async function refresh() {
    if (!enabled || destroyed || !viewer) return;
    const gen = ++generation;
    const height = viewer.camera.positionCartographic?.height;
    if (!(height <= maxHeightM)) {
      status = 'zoom-in';
      releaseAll();
      notifyRowControls();
      governorRequestRender?.(`chunked-area:${id}`);
      return;
    }
    status = null;
    let list;
    try {
      list = await loadIndex();
      error = null;
    } catch (err) {
      error = `index unavailable (${err?.message || 'error'})`;
      return;
    }
    if (gen !== generation || !enabled) return;
    const rect = viewer.camera.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
    );
    const carto = viewer.camera.positionCartographic;
    const view = rect
      ? {
          west: Cesium.Math.toDegrees(rect.west),
          south: Cesium.Math.toDegrees(rect.south),
          east: Cesium.Math.toDegrees(rect.east),
          north: Cesium.Math.toDegrees(rect.north),
        }
      : {
          // Horizon-up views have no ground rectangle: use a box under the camera.
          west: Cesium.Math.toDegrees(carto.longitude) - 0.5,
          south: Cesium.Math.toDegrees(carto.latitude) - 0.5,
          east: Cesium.Math.toDegrees(carto.longitude) + 0.5,
          north: Cesium.Math.toDegrees(carto.latitude) + 0.5,
        };
    const wanted = new Set(chunksInView(list, view, maxChunks));
    for (const chunkId of [...drawn.keys()]) {
      if (!wanted.has(chunkId)) releaseChunk(chunkId);
    }
    const missing = [...wanted].filter((chunkId) => !drawn.has(chunkId));
    if (!missing.length) {
      notifyRowControls();
      return;
    }
    pending += 1;
    try {
      const results = await Promise.allSettled(
        missing.map((chunkId) => drawChunk(chunkId, gen)),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      error = failed.length
        ? `${failed.length} area file(s) failed to load`
        : null;
      if (!failed.length) lastUpdate = Date.now();
    } finally {
      pending -= 1;
    }
    notifyRowControls();
    governorRequestRender?.(`chunked-area:${id}`);
  }

  function selectArea(entity) {
    const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
    const hierarchy = entity.polygon?.hierarchy?.getValue(
      Cesium.JulianDate.now(),
    );
    const center = hierarchy?.positions?.length
      ? Cesium.Cartographic.fromCartesian(
          Cesium.BoundingSphere.fromPoints(hierarchy.positions).center,
        )
      : null;
    registerEntityContext(entity, {
      id: `${id}:${entity.id}`,
      layerId: id,
      layerName: name,
      source,
      dataSource: drawn.get(entity.__chunkedChunkId),
      label: props.name || name,
      properties: props,
      latitude: center
        ? Number(Cesium.Math.toDegrees(center.latitude).toFixed(6))
        : undefined,
      longitude: center
        ? Number(Cesium.Math.toDegrees(center.longitude).toFixed(6))
        : undefined,
    });
    viewer.selectedEntity = entity;
    selectEntityContext(entity);
  }

  function installClickHandler() {
    if (clickHandler) return;
    clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js).
      if (!isPointerFree()) return;
      if (!enabled) return;
      // Clickable local cards and pins win over areas, exactly as the other
      // local layers resolve the same click.
      if (
        overlayHost?.hitTest?.(click.position.x, click.position.y, {
          filter: isLocalCardAction,
        })
      )
        return;
      const target = pickLocalEntity(viewer.scene, click.position);
      if (target && target.__localLayerId === id) selectArea(target);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function countBy(test) {
    let count = 0;
    for (const dataSource of drawn.values()) {
      for (const entity of dataSource.entities.values) {
        const props =
          entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
        if (test(props)) count += 1;
      }
    }
    return count;
  }

  function loadedCount() {
    let count = 0;
    for (const dataSource of drawn.values())
      count += dataSource.entities.values.length;
    return count;
  }

  return {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async () => {},
    update: async () => {},

    enable: async (activeViewer) => {
      if (destroyed) return;
      viewer = activeViewer;
      enabled = true;
      installClickHandler();
      moveEndRemover ||= viewer.camera.moveEnd.addEventListener(() => {
        refresh();
      });
      await refresh();
    },

    disable: () => {
      enabled = false;
      generation += 1;
      moveEndRemover?.();
      moveEndRemover = null;
      releaseAll();
      clearSelectedEntityContextForLayer(id);
      removeEntityContextsForLayer(id);
      status = null;
      notifyRowControls();
    },

    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      enabled = false;
      generation += 1;
      moveEndRemover?.();
      moveEndRemover = null;
      releaseAll();
      removeEntityContextsForLayer(id);
      clickHandler?.destroy();
      clickHandler = null;
      cache.clear();
      index = null;
    },

    getStats: () => ({
      count: loadedCount(),
      lastUpdate,
      error,
      ...(pending > 0 && {
        loading: true,
        loadingLabel: 'loading areas in view...',
      }),
      ...(status === 'zoom-in' && {
        status: 'zoom-in',
        statusMessage: zoomInMessage,
      }),
    }),

    getRowControls: () => ({
      chips: [],
      legend: enabled
        ? legend.map((item) => ({
            label: item.label,
            color: item.color,
            blurb: item.blurb,
            count: countBy(item.test),
          }))
        : [],
    }),
    setRowControlsListener: (listener) => {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** Test/QA seam: chunk ids currently drawn. */
    getDrawnChunkIds: () => [...drawn.keys()],
  };
}
