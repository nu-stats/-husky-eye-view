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
/** Longest getAreaContext waits for areas still loading. */
const AREA_CONTEXT_WAIT_MS = 6000;
/**
 * A camera that never stops (Cockpit, a tracked follow, a route flight, a
 * continuous orbit) never emits moveEnd, so the view is also rechecked at
 * most this often while frames render, and reloaded once it has moved on.
 */
const MOTION_CHECK_MS = 1500;
const MOTION_MIN_TRAVEL_M = 1500;
const MOTION_HEADING_CHANGE_RAD = Cesium.Math.toRadians(25);
const EARTH_RADIUS_M = 6_371_000;
/** Cameras pitched shallower than this look at the horizon, not the ground. */
const SHALLOW_PITCH_RAD = Cesium.Math.toRadians(-25);

/**
 * Ground box for a horizon-up view (no ground rectangle): the area around the
 * camera plus the stretch it is looking toward, so a cockpit sees the ground
 * ahead of the aircraft, not only beneath it.
 * @param {{longitude:number, latitude:number, height:number, heading:number}} pose
 *   Degrees, meters, heading in radians.
 * @returns {{west:number,south:number,east:number,north:number}} Degrees.
 */
export function horizonViewBox({ longitude, latitude, height, heading }) {
  const aheadM = Math.min(80_000, Math.max(8_000, (height || 0) * 6));
  const d = aheadM / EARTH_RADIUS_M;
  const lat1 = Cesium.Math.toRadians(latitude);
  const lon1 = Cesium.Math.toRadians(longitude);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(heading || 0),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(heading || 0) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  const aheadLon = Cesium.Math.toDegrees(lon2);
  const aheadLat = Cesium.Math.toDegrees(lat2);
  const pad = 0.35;
  return {
    west: Math.min(longitude, aheadLon) - pad,
    east: Math.max(longitude, aheadLon) + pad,
    south: Math.min(latitude, aheadLat) - pad,
    north: Math.max(latitude, aheadLat) + pad,
  };
}

/**
 * Whether a moving camera has left the view last loaded: it traveled a
 * quarter of its height (at least 1.5 km), turned 25°, or changed height by
 * half again.
 * @param {{longitude:number, latitude:number, height:number, heading:number}} previous
 * @param {{longitude:number, latitude:number, height:number, heading:number}} next
 * @returns {boolean}
 */
export function viewPoseMoved(previous, next) {
  if (!previous || !next) return false;
  const rad = Math.PI / 180;
  const dLat = (next.latitude - previous.latitude) * rad;
  const dLon =
    (next.longitude - previous.longitude) *
    rad *
    Math.cos(((next.latitude + previous.latitude) / 2) * rad);
  const travelM = Math.hypot(dLat, dLon) * EARTH_RADIUS_M;
  if (travelM >= Math.max(MOTION_MIN_TRAVEL_M, 0.25 * Math.abs(next.height)))
    return true;
  const turn = Math.abs(
    ((next.heading - previous.heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
  );
  if (turn >= MOTION_HEADING_CHANGE_RAD) return true;
  const low = Math.max(1, Math.min(previous.height, next.height));
  return Math.max(previous.height, next.height) / low >= 1.5;
}

/** Polygon rings of a Polygon/MultiPolygon geometry, as [outer, ...holes][]. */
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
 * @param {string} [options.sourceNote] Source line for every area's details
 *   card, instead of repeating it in each feature.
 * @param {function(object):string} [options.featureSummary] Builds the
 *   details-card summary from a feature's properties, so several layers can
 *   share one set of chunks and still describe it their own way.
 * @param {function(object):boolean} [options.featureFilter] Keeps only the
 *   features whose properties pass, e.g. the significant tracts of a shared
 *   tract set.
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
    zoomInMessage = 'zoom in to a city or county to load',
    sourceNote = null,
    featureSummary = null,
    featureFilter = null,
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
  let frameRemover = null;
  let lastViewPose = null;
  let lastMotionCheckMs = 0;
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
      .map((line) => JSON.parse(line))
      .filter(
        (feature) => !featureFilter || featureFilter(feature.properties || {}),
      );
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
        colorFor(featureColor(props) || '#9e9e9e').withAlpha(fillAlpha),
      );
      entity.polygon.outline = false;
    }
    drawn.set(chunkId, dataSource);
    await viewer.dataSources.add(dataSource);
    if (gen !== generation || !enabled || destroyed) {
      releaseChunk(chunkId);
    }
  }

  /** Camera position and heading in degrees/meters/radians, or null. */
  function currentPose() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      longitude: Cesium.Math.toDegrees(carto.longitude),
      latitude: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      heading: viewer.camera.heading ?? 0,
    };
  }

  /** Recheck a camera that keeps moving (see MOTION_CHECK_MS). */
  function onFrame() {
    const now = Date.now();
    if (now - lastMotionCheckMs < MOTION_CHECK_MS) return;
    lastMotionCheckMs = now;
    if (!enabled || destroyed || pending > 0) return;
    if (viewPoseMoved(lastViewPose, currentPose())) refresh();
  }

  /** The latest reconcile, so readers can wait for the view to finish loading. */
  let currentRefresh = Promise.resolve();
  function refresh() {
    currentRefresh = reconcileView();
    return currentRefresh;
  }

  /** Reconcile the drawn chunks with the current camera view. */
  async function reconcileView() {
    if (!enabled || destroyed || !viewer) return;
    const gen = ++generation;
    lastViewPose = currentPose();
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
    // A near-level camera (a cockpit, a street-level look) gets no useful
    // ground rectangle from Cesium: it reports a fixed ~9°-wide box that even
    // reaches behind the camera. Such views use the ground-ahead box instead.
    const shallow = (viewer.camera.pitch ?? -Math.PI / 2) > SHALLOW_PITCH_RAD;
    const rect = shallow
      ? undefined
      : viewer.camera.computeViewRectangle?.(
          viewer.scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        );
    const pose = currentPose();
    const view = rect
      ? {
          west: Cesium.Math.toDegrees(rect.west),
          south: Cesium.Math.toDegrees(rect.south),
          east: Cesium.Math.toDegrees(rect.east),
          north: Cesium.Math.toDegrees(rect.north),
        }
      : // Horizon-up views have no ground rectangle: use the ground around
        // the camera and ahead of it.
        horizonViewBox(pose);
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

  /** A feature's properties plus the layer-level summary and source line. */
  function describe(properties) {
    return {
      ...properties,
      ...(featureSummary && { summary: featureSummary(properties) }),
      ...(sourceNote && { source_note: sourceNote }),
    };
  }

  function selectArea(entity) {
    const props = describe(
      entity.properties?.getValue?.(Cesium.JulianDate.now()) || {},
    );
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
      frameRemover ||=
        viewer.scene?.preRender?.addEventListener?.(onFrame) || null;
      await refresh();
    },

    disable: () => {
      enabled = false;
      generation += 1;
      moveEndRemover?.();
      moveEndRemover = null;
      frameRemover?.();
      frameRemover = null;
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
      frameRemover?.();
      frameRemover = null;
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
     * @returns {Promise<object>}
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
      const withNote = describe;
      let atPoint = null;
      const nearby = [];
      for (const chunkId of drawn.keys()) {
        for (const feature of cache.get(chunkId) || []) {
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
  };
}
