import * as Cesium from 'cesium';
import { isPointerFree } from './inputOwnership.js';
import { isLocalCardAction, pickLocalEntity } from './localGeojsonCore.js';

/**
 * Nationwide area layer loaded on demand. The dataset is split into chunks
 * (one GeoJSON Lines file per county or state) described by an index of
 * bounding boxes; only the chunks in view are fetched and drawn, and chunks
 * that leave the view are released. Zoomed out past `maxHeightM` nothing is
 * drawn and the panel shows a zoom-in hint.
 *
 * Each chunk is drawn as ONE ground primitive with a color per area. Entities
 * (GeoJsonDataSource) were far slower here: Cesium splits clamped entity
 * polygons into a new batch whenever their bounding rectangles overlap, and
 * neighboring tracts always overlap, so one county became dozens of separately
 * built primitives. These areas tile the map without overlapping, so a single
 * batch is safe.
 *
 * With `coarseHeightM`, a lighter copy of every chunk (under `coarse/`, same
 * ids and properties, simplified outlines) is drawn while the camera is above
 * that height, and the full-detail chunks below it.
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
/** Longest getAreaContext waits for areas still loading. */
const AREA_CONTEXT_WAIT_MS = 6000;

/**
 * Chunks whose bbox intersects the view rectangle, nearest first.
 * @param {Array<{id:string,bbox:number[]}>} index
 * @param {{west:number,south:number,east:number,north:number}} view Degrees.
 * @param {number} limit
 * @param {[number, number]} [center] [lon, lat] to measure nearness from;
 *   defaults to the middle of `view`.
 * @returns {string[]}
 */
export function chunksInView(index, view, limit, center) {
  const cx = center ? center[0] : (view.west + view.east) / 2;
  const cy = center ? center[1] : (view.south + view.north) / 2;
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

/** Polygon rings of a Polygon/MultiPolygon, as a list of polygons. */
function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** Whether a ring of [lon, lat] points contains the point (even-odd rule). */
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Whether a Polygon/MultiPolygon feature contains [lon, lat] (holes excluded). */
function featureContains(feature, lon, lat) {
  return polygonsOf(feature.geometry).some(
    ([outer, ...holes]) =>
      outer &&
      ringContains(outer, lon, lat) &&
      !holes.some((hole) => ringContains(hole, lon, lat)),
  );
}

/** Center of a feature's bounding box, [lon, lat] degrees (null if empty). */
function featureCenter(feature) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const rings of polygonsOf(feature.geometry)) {
    for (const [lon, lat] of rings[0] || []) {
      if (lon < w) w = lon;
      if (lat < s) s = lat;
      if (lon > e) e = lon;
      if (lat > n) n = lat;
    }
  }
  return Number.isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null;
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
 * @param {number} [options.coarseHeightM] Above this camera height draw the
 *   `coarse/` chunks; omit when the dataset has no coarse copy.
 * @param {string} [options.zoomInMessage] Panel hint above `maxHeightM`.
 * @param {string} [options.sourceNote] Source line for every area's details
 *   card, instead of repeating it in each feature.
 * @param {number} [options.fillAlpha] Area fill opacity (0–1).
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
    coarseHeightM = null,
    zoomInMessage = 'zoom in to a city or county to load',
    sourceNote = null,
    fillAlpha = FILL_ALPHA,
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
  /** chunk id -> { primitive, features, level } currently in the scene */
  const drawn = new Map();
  /** `${level}/${chunk id}` -> parsed features (LRU by insertion order) */
  const cache = new Map();
  const colors = new Map();

  const colorFor = (css) => {
    if (!colors.has(css))
      colors.set(
        css,
        Cesium.Color.fromCssColorString(css).withAlpha(fillAlpha),
      );
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

  async function loadChunkFeatures(chunkId, level) {
    const key = `${level}/${chunkId}`;
    if (cache.has(key)) {
      const features = cache.get(key);
      cache.delete(key);
      cache.set(key, features); // refresh LRU position
      return features;
    }
    const folder = level === 'coarse' ? 'coarse/' : '';
    const response = await fetch(
      `${base}${folder}${encodeURIComponent(chunkId)}.geojsonl`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
    const text = await response.text();
    const features = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    cache.set(key, features);
    while (cache.size > CHUNK_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      const [oldLevel, ...rest] = oldest.split('/');
      if (drawn.get(rest.join('/'))?.level === oldLevel) break;
      cache.delete(oldest);
    }
    return features;
  }

  function releaseChunk(chunkId) {
    const chunk = drawn.get(chunkId);
    if (!chunk) return;
    drawn.delete(chunkId);
    if (viewer?.selectedEntity?.__chunkedChunkId === chunkId) {
      viewer.selectedEntity = undefined;
      clearSelectedEntityContextForLayer(id);
    }
    removePrimitive(chunk.primitive);
  }

  function releaseAll() {
    for (const chunkId of [...drawn.keys()]) releaseChunk(chunkId);
    clearRetiring();
  }

  /** One ground primitive holding every area of a chunk. */
  function buildPrimitive(chunkId, features) {
    const instances = [];
    for (const feature of features) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        colorFor(featureColor(feature.properties || {}) || '#9e9e9e'),
      );
      // The pick id stands in for an entity: pickLocalEntity reads
      // __localLayerId, and a click turns it into a selection.
      const pickId = {
        __localLayerId: id,
        __chunkedChunkId: chunkId,
        feature,
      };
      for (const rings of polygonsOf(feature.geometry)) {
        if (!rings[0] || rings[0].length < 4) continue;
        const [outer, ...holes] = rings.map((ring) =>
          Cesium.Cartesian3.fromDegreesArray(ring.flat()),
        );
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                outer,
                holes.map((hole) => new Cesium.PolygonHierarchy(hole)),
              ),
            }),
            id: pickId,
            attributes: { color },
          }),
        );
      }
    }
    if (!instances.length) return null;
    return new Cesium.GroundPrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
  }

  /** Primitives replaced by another detail level, removed once it is ready. */
  let retiring = [];
  let retireRemover = null;

  function removePrimitive(primitive) {
    try {
      viewer?.scene?.groundPrimitives?.remove(primitive);
    } catch {
      /* already gone */
    }
  }

  function clearRetiring() {
    for (const { old } of retiring) removePrimitive(old);
    retiring = [];
    retireRemover?.();
    retireRemover = null;
  }

  /** Keep `old` on screen until `replacement` has finished building. */
  function retire(old, replacement) {
    retiring.push({ old, replacement, since: Date.now() });
    retireRemover ||= viewer.scene.postRender?.addEventListener(() => {
      const now = Date.now();
      retiring = retiring.filter(
        ({ old: previous, replacement: next, since }) => {
          const done =
            next.ready || next.isDestroyed?.() || now - since > 10_000;
          if (done) removePrimitive(previous);
          return !done;
        },
      );
      if (!retiring.length) {
        retireRemover?.();
        retireRemover = null;
      } else {
        governorRequestRender?.(`chunked-area:${id}`);
      }
    });
    if (!retireRemover) clearRetiring(); // no render hook: swap at once
  }

  async function drawChunk(chunkId, level, gen) {
    const features = await loadChunkFeatures(chunkId, level);
    if (gen !== generation || !enabled || destroyed) return;
    const previous = drawn.get(chunkId);
    if (previous?.level === level) return;
    const primitive = buildPrimitive(chunkId, features);
    if (!primitive) {
      releaseChunk(chunkId);
      return;
    }
    viewer.scene.groundPrimitives.add(primitive);
    drawn.set(chunkId, { primitive, features, level });
    if (previous) retire(previous.primitive, primitive);
  }

  /** Reconcile the drawn chunks with the current camera view. */
  /** The latest reconcile, so readers can wait for areas still loading. */
  let currentRefresh = Promise.resolve();
  function refresh() {
    currentRefresh = reconcileView();
    return currentRefresh;
  }

  async function reconcileView() {
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
    const level =
      coarseHeightM !== null && height > coarseHeightM ? 'coarse' : 'detail';
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
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    // A tilted camera's rectangle runs out to the horizon (and a hidden,
    // zero-size canvas yields the whole globe), so bound it to a box around
    // the camera sized by height, and load the chunks nearest the camera.
    const half = Math.max(0.5, (height / 111_000) * 4);
    const view = rect
      ? {
          west: Math.max(Cesium.Math.toDegrees(rect.west), lon - half),
          south: Math.max(Cesium.Math.toDegrees(rect.south), lat - half),
          east: Math.min(Cesium.Math.toDegrees(rect.east), lon + half),
          north: Math.min(Cesium.Math.toDegrees(rect.north), lat + half),
        }
      : {
          // Horizon-up views have no ground rectangle: use a box under the camera.
          west: lon - 0.5,
          south: lat - 0.5,
          east: lon + 0.5,
          north: lat + 0.5,
        };
    const wanted = new Set(chunksInView(list, view, maxChunks, [lon, lat]));
    for (const chunkId of [...drawn.keys()]) {
      if (!wanted.has(chunkId)) releaseChunk(chunkId);
    }
    // Chunks at the other detail level stay on screen until their
    // replacement is ready (see retire), so switching never blanks the map.
    const missing = [...wanted].filter(
      (chunkId) => drawn.get(chunkId)?.level !== level,
    );
    if (!missing.length) {
      notifyRowControls();
      return;
    }
    pending += 1;
    notifyRowControls();
    try {
      const results = await Promise.allSettled(
        missing.map((chunkId) => drawChunk(chunkId, level, gen)),
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

  /**
   * Turn a picked area into a selection. A light entity (not added to the
   * scene) carries the context the details card and voice tools read.
   */
  function selectArea(target) {
    const { feature, __chunkedChunkId: chunkId } = target;
    const props = {
      ...(feature.properties || {}),
      ...(sourceNote && { source_note: sourceNote }),
    };
    const center = featureCenter(feature);
    const entity = new Cesium.Entity({
      id: `${id}:${feature.id ?? props.name ?? 'area'}`,
      name: props.name || name,
      position: center
        ? Cesium.Cartesian3.fromDegrees(center[0], center[1])
        : undefined,
      properties: props,
    });
    entity.__localLayerId = id;
    entity.__chunkedChunkId = chunkId;
    registerEntityContext(entity, {
      id: entity.id,
      layerId: id,
      layerName: name,
      source,
      dataSource: drawn.get(chunkId)?.primitive,
      label: props.name || name,
      properties: props,
      latitude: center ? Number(center[1].toFixed(6)) : undefined,
      longitude: center ? Number(center[0].toFixed(6)) : undefined,
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
      if (target && target.__localLayerId === id && target.feature)
        selectArea(target);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function countBy(test) {
    let count = 0;
    for (const chunk of drawn.values()) {
      for (const feature of chunk.features) {
        if (test(feature.properties || {})) count += 1;
      }
    }
    return count;
  }

  function loadedCount() {
    let count = 0;
    for (const chunk of drawn.values()) count += chunk.features.length;
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

    /**
     * What this layer shows around a point, for voice and other readers: the
     * area containing the point (if loaded), the nearest other areas, and the
     * legend counts over what is loaded. Areas only exist in chunks that are
     * drawn, so a zoomed-out or disabled layer reports its status instead.
     * @param {{longitude:number, latitude:number, limit?:number}} point
     * @returns {object}
     */
    getAreaContext: async ({ longitude, latitude, limit = 5 } = {}) => {
      const base = { layerId: id, layerName: name, source };
      // Right after a fly-to the chunks for the new view may not even have
      // started loading: reconcile with the current camera now and wait
      // (bounded), following any newer reconcile that supersedes ours, so the
      // answer covers where the camera is now.
      if (enabled && !destroyed && viewer) {
        const deadline = Date.now() + AREA_CONTEXT_WAIT_MS;
        let awaited = refresh();
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await Promise.race([
            awaited.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, remaining)),
          ]);
          if (currentRefresh === awaited || Date.now() >= deadline) break;
          awaited = currentRefresh;
        }
      }
      if (!enabled) return { ...base, status: 'disabled' };
      if (status === 'zoom-in')
        return { ...base, status: 'zoom-in', statusMessage: zoomInMessage };
      const withNote = (properties) => ({
        ...properties,
        ...(sourceNote && { source_note: sourceNote }),
      });
      let atPoint = null;
      const nearby = [];
      for (const chunk of drawn.values()) {
        for (const feature of chunk.features) {
          if (!atPoint && featureContains(feature, longitude, latitude)) {
            atPoint = feature;
            continue;
          }
          const center = featureCenter(feature);
          if (!center) continue;
          const dx =
            (center[0] - longitude) * Math.cos((latitude * Math.PI) / 180);
          const dy = center[1] - latitude;
          nearby.push({ feature, d2: dx * dx + dy * dy });
        }
      }
      nearby.sort((a, b) => a.d2 - b.d2);
      return {
        ...base,
        status: 'loaded',
        loadedAreas: loadedCount(),
        atPoint: atPoint ? withNote(atPoint.properties || {}) : null,
        nearby: nearby.slice(0, Math.max(0, limit)).map(({ feature, d2 }) => ({
          ...withNote(feature.properties || {}),
          distanceKm: Math.round(Math.sqrt(d2) * 111.2 * 10) / 10,
        })),
        legend: legend.map((item) => ({
          label: item.label,
          count: countBy(item.test),
        })),
      };
    },

    /** Test/QA seam: chunk ids currently drawn. */
    getDrawnChunkIds: () => [...drawn.keys()],
    /** Test/QA seam: detail level ('detail' | 'coarse') of each drawn chunk. */
    getDrawnLevels: () =>
      Object.fromEntries([...drawn].map(([key, chunk]) => [key, chunk.level])),
  };
}
