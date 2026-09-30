// Nationwide chunked area layers (HOLC redlining, tract life expectancy):
// only the county chunks in view are fetched and drawn, zoomed-out views ask
// the user to zoom in, and clicking an area selects it for the details card.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  chunksInView,
  createChunkedAreaLayer,
  horizonViewBox,
  viewPoseMoved,
} from './chunkedAreaLayer.js';

class MockEvent {
  constructor() {
    this.listeners = new Set();
  }
  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  raise() {
    for (const listener of [...this.listeners]) listener();
  }
}

const square = (lon, lat, d = 0.01) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon - d, lat - d],
      [lon + d, lat - d],
      [lon + d, lat + d],
      [lon - d, lat - d],
    ],
  ],
});

const INDEX = [
  { id: '17031', bbox: [-88.3, 41.4, -87.5, 42.2], count: 1 }, // Cook, IL
  { id: '06037', bbox: [-118.9, 33.7, -117.6, 34.8], count: 1 }, // LA, CA
];
const CHUNKS = {
  17031: {
    type: 'Feature',
    id: 'tract-17031010100',
    properties: {
      name: 'Census Tract 101, Cook County, IL',
      geoid: '17031010100',
      life_exp_8: 68.8,
      summary: 'Life expectancy at birth: 68.8 years.',
    },
    geometry: square(-87.67, 42.02),
  },
  '06037': {
    type: 'Feature',
    id: 'tract-06037101110',
    properties: { name: 'LA tract', life_exp_8: 80.1, summary: 'x' },
    geometry: square(-118.3, 34.2),
  },
};

test('chunksInView keeps intersecting chunks, nearest first, up to the limit', () => {
  const index = [
    { id: 'far', bbox: [10, 10, 11, 11] },
    { id: 'edge', bbox: [0.9, 0.9, 2, 2] },
    { id: 'center', bbox: [0.4, 0.4, 0.6, 0.6] },
  ];
  const view = { west: 0, south: 0, east: 1, north: 1 };
  assert.deepEqual(chunksInView(index, view, 10), ['center', 'edge']);
  assert.deepEqual(chunksInView(index, view, 1), ['center']);
});

async function createHarness({ heightM = 20_000, layerOptions = {} } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const fetched = [];
  const selected = [];
  globalThis.window = {
    dispatchEvent(event) {
      if (event.type === 'gev:entity-selected') selected.push(event.detail);
    },
  };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith('index.json')) {
      return { ok: true, status: 200, json: async () => INDEX };
    }
    const id = decodeURIComponent(
      url.split('/').pop().replace('.geojsonl', ''),
    );
    return {
      ok: true,
      status: 200,
      text: async () => `${JSON.stringify(CHUNKS[id])}\n`,
    };
  };
  const moveEnd = new MockEvent();
  const preRender = new MockEvent();
  const added = [];
  let clickAction = null;
  let pickResult = null;
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add: async (ds) => added.push(ds),
      remove: (ds) => {
        const i = added.indexOf(ds);
        if (i >= 0) added.splice(i, 1);
        return true;
      },
    },
    camera: {
      moveEnd,
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -87.65,
        41.85,
        heightM,
      ),
      // A view over Chicago only.
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(-87.9, 41.6, -87.4, 42.1),
    },
    scene: {
      canvas: {},
      pick: () => pickResult,
      requestRender() {},
      preRender,
    },
  };
  const layer = createChunkedAreaLayer(
    {
      id: 'local-life-expectancy',
      name: 'Life Expectancy (tracts)',
      baseUrl: '/context/life-expectancy',
      featureColor: (p) => (p.life_exp_8 < 75 ? '#b2182b' : '#2166ac'),
      legend: [
        { label: 'low', color: '#b2182b', test: (p) => p.life_exp_8 < 75 },
      ],
      screenSpaceEventHandlerFactory: () => ({
        setInputAction(action) {
          clickAction = action;
        },
        destroy() {},
      }),
      ...layerOptions,
    },
    {
      overlayHost: { hitTest: () => null },
      registerEntityContext: (entity, meta) => {
        entity.__gevContextId = meta.id;
        entity.__meta = meta;
      },
      selectEntityContext: (entity) => selected.push(entity.__meta),
      clearSelectedEntityContextForLayer() {},
      removeEntityContextsForLayer() {},
      governorRequestRender() {},
    },
  );
  return {
    layer,
    viewer,
    fetched,
    added,
    selected,
    moveEnd,
    preRender,
    setPick: (entity) => {
      pickResult = entity ? { id: entity } : null;
    },
    click: () => clickAction({ position: new Cesium.Cartesian2(10, 10) }),
    cleanup() {
      layer.destroy(viewer);
      globalThis.fetch = originalFetch;
      globalThis.window = originalWindow;
    },
  };
}

test('a camera that never stops (cockpit, follow) still reloads the view it has moved to', async () => {
  const env = await createHarness();
  try {
    await env.layer.enable(env.viewer);
    assert.deepEqual(env.layer.getDrawnChunkIds(), ['17031']);
    // Fly to Los Angeles without ever raising moveEnd, like the cockpit camera.
    env.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      -118.3,
      34.2,
      20_000,
    );
    env.viewer.camera.computeViewRectangle = () =>
      Cesium.Rectangle.fromDegrees(-118.6, 33.9, -118.0, 34.5);
    env.preRender.raise();
    for (let i = 0; i < 50; i++) {
      if (env.layer.getDrawnChunkIds()[0] === '06037') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(env.layer.getDrawnChunkIds(), ['06037']);
    await env.layer.disable(env.viewer);
    assert.equal(env.preRender.listeners.size, 0, 'no frame work while off');
  } finally {
    env.cleanup();
  }
});

test('a horizon view loads the ground ahead of the camera, not only beneath it', () => {
  // 10 km up, west of Cook County (bbox west edge -88.3).
  const pose = { longitude: -89.0, latitude: 41.8, height: 10_000 };
  const east = horizonViewBox({ ...pose, heading: Math.PI / 2 });
  const west = horizonViewBox({ ...pose, heading: -Math.PI / 2 });
  assert.deepEqual(chunksInView(INDEX, east, 10), ['17031']);
  assert.deepEqual(chunksInView(INDEX, west, 10), []);
  // Looking east, the box reaches about 60 km ahead (6 × height).
  assert.ok(east.east > -88.0 && east.east < -87.8, String(east.east));
  assert.ok(east.west <= -89.0 - 0.3, 'the ground beneath stays included');
});

test('a near-level camera ignores Cesium’s meaningless wide rectangle and loads what is ahead', async () => {
  const env = await createHarness();
  try {
    // West of Cook County, 10 km up, looking east almost level, like a cockpit.
    env.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      -89.0,
      41.8,
      10_000,
    );
    env.viewer.camera.pitch = Cesium.Math.toRadians(-6);
    env.viewer.camera.heading = Math.PI / 2;
    // A wide box whose center is far off (the old code drew Los Angeles).
    env.viewer.camera.computeViewRectangle = () =>
      Cesium.Rectangle.fromDegrees(-125, 30, -95, 45);
    await env.layer.enable(env.viewer);
    assert.deepEqual(env.layer.getDrawnChunkIds(), ['17031']);
  } finally {
    env.cleanup();
  }
});

test('viewPoseMoved: travel, turning or climbing counts; jitter does not', () => {
  const at = { longitude: -87.65, latitude: 41.85, height: 10_000, heading: 0 };
  assert.equal(viewPoseMoved(at, { ...at }), false);
  assert.equal(viewPoseMoved(at, { ...at, longitude: -87.649 }), false);
  // A quarter of the 10 km height is 2.5 km; 0.04° of longitude is ~3.3 km.
  assert.equal(viewPoseMoved(at, { ...at, longitude: -87.61 }), true);
  assert.equal(viewPoseMoved(at, { ...at, heading: 0.5 }), true);
  assert.equal(viewPoseMoved(at, { ...at, height: 16_000 }), true);
  assert.equal(viewPoseMoved(null, at), false);
});

test('only the counties in view are fetched and drawn', async () => {
  const env = await createHarness();
  try {
    await env.layer.enable(env.viewer);
    assert.deepEqual(env.layer.getDrawnChunkIds(), ['17031']);
    assert.ok(env.fetched.some((u) => u.endsWith('/17031.geojsonl')));
    assert.ok(
      !env.fetched.some((u) => u.endsWith('/06037.geojsonl')),
      'Los Angeles is never downloaded for a Chicago view',
    );
    assert.equal(env.layer.getStats().count, 1);
    assert.deepEqual(
      env.layer.getRowControls().legend.map((l) => [l.label, l.count]),
      [['low', 1]],
    );
  } finally {
    env.cleanup();
  }
});

test('zoomed out past the threshold nothing loads and the panel says zoom in', async () => {
  const env = await createHarness({ heightM: 5_000_000 });
  try {
    await env.layer.enable(env.viewer);
    assert.deepEqual(env.layer.getDrawnChunkIds(), []);
    assert.equal(env.fetched.length, 0);
    const stats = env.layer.getStats();
    assert.equal(stats.status, 'zoom-in');
    assert.match(stats.statusMessage, /zoom in/);
  } finally {
    env.cleanup();
  }
});

test('a nationwide layer loads at country height and has its own zoom hint', async () => {
  const wide = await createHarness({
    heightM: 5_000_000,
    layerOptions: {
      maxHeightM: 8_000_000,
      zoomInMessage: 'zoom in to the United States to load',
    },
  });
  try {
    await wide.layer.enable(wide.viewer);
    assert.deepEqual(wide.layer.getDrawnChunkIds(), ['17031']);
    assert.equal(wide.layer.getStats().status, undefined);
  } finally {
    wide.cleanup();
  }
  const space = await createHarness({
    heightM: 20_000_000,
    layerOptions: {
      maxHeightM: 8_000_000,
      zoomInMessage: 'zoom in to the United States to load',
    },
  });
  try {
    await space.layer.enable(space.viewer);
    assert.equal(
      space.layer.getStats().statusMessage,
      'zoom in to the United States to load',
    );
  } finally {
    space.cleanup();
  }
});

test('clicking an area selects it with its summary', async () => {
  const env = await createHarness();
  try {
    await env.layer.enable(env.viewer);
    const entity = env.added[0].entities.values[0];
    env.setPick(entity);
    env.click();
    assert.equal(env.selected.length, 1);
    const record = env.selected[0];
    assert.equal(record.layerId, 'local-life-expectancy');
    assert.equal(record.properties.life_exp_8, 68.8);
    assert.match(record.properties.summary, /68\.8 years/);
    assert.ok(Number.isFinite(record.latitude));
  } finally {
    env.cleanup();
  }
});

test('area context names the area under a point, its neighbors and the legend (voice)', async () => {
  const env = await createHarness({
    layerOptions: { sourceNote: 'USALEEP tract life expectancy.' },
  });
  try {
    await env.layer.enable(env.viewer);
    const context = await env.layer.getAreaContext({
      longitude: -87.662,
      latitude: 42.015,
    });
    assert.equal(context.status, 'loaded');
    assert.equal(context.layerId, 'local-life-expectancy');
    assert.equal(context.atPoint.name, 'Census Tract 101, Cook County, IL');
    assert.equal(context.atPoint.life_exp_8, 68.8);
    assert.equal(context.atPoint.source_note, 'USALEEP tract life expectancy.');
    assert.deepEqual(context.legend, [{ label: 'low', count: 1 }]);

    // Outside every area: no atPoint, but the nearest area with its distance.
    const nearby = await env.layer.getAreaContext({
      longitude: -87.7,
      latitude: 41.9,
    });
    assert.equal(nearby.atPoint, null);
    assert.equal(nearby.nearby[0].name, 'Census Tract 101, Cook County, IL');
    assert.ok(nearby.nearby[0].distanceKm > 5);

    env.layer.disable(env.viewer);
    assert.equal(
      (await env.layer.getAreaContext({ longitude: -87.662, latitude: 42.015 }))
        .status,
      'disabled',
    );
  } finally {
    env.cleanup();
  }
  const high = await createHarness({ heightM: 5_000_000 });
  try {
    await high.layer.enable(high.viewer);
    const context = await high.layer.getAreaContext({
      longitude: -87.662,
      latitude: 42.015,
    });
    assert.equal(context.status, 'zoom-in');
    assert.match(context.statusMessage, /zoom in/);
  } finally {
    high.cleanup();
  }
});

test('fillAlpha sets the area fill opacity', async () => {
  const env = await createHarness({ layerOptions: { fillAlpha: 0.6 } });
  try {
    await env.layer.enable(env.viewer);
    const entity = env.added[0].entities.values[0];
    const color = entity.polygon.material.color.getValue(
      Cesium.JulianDate.now(),
    );
    assert.ok(Math.abs(color.alpha - 0.6) < 1e-6);
  } finally {
    env.cleanup();
  }
});

test('disable releases every drawn county', async () => {
  const env = await createHarness();
  try {
    await env.layer.enable(env.viewer);
    assert.equal(env.added.length, 1);
    env.layer.disable(env.viewer);
    assert.equal(env.added.length, 0);
    assert.deepEqual(env.layer.getDrawnChunkIds(), []);
  } finally {
    env.cleanup();
  }
});
