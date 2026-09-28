// Clickable local overlay cards: a feature with source notes (Chicago Events)
// publishes a card whose click selects the feature, which is what opens the
// details card with the caption summary and video link.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createLocalGeoJsonLayer,
  createSharedGeoJsonLinesSource,
  getLocalLabelSettings,
  setLocalLabelSettings,
} from './localGeojson.js';

class MockEvent {
  constructor() {
    this.listeners = new Set();
  }
  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  raise(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

// Small squares: Cesium's default point marker needs a browser canvas, and the
// card behavior does not depend on geometry (it keys off the properties).
const square = (lon, lat, d = 0.001) => ({
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
const NOTED = {
  type: 'Feature',
  id: 'chicago-event-3',
  properties: {
    name: '55th Street & King Drive, Chicago',
    victim: '"Gotti" (Michael Lee, 23)',
    video_summary: 'Summary from the captions.',
    video_time: '12:28',
    video_url: 'https://www.youtube.com/watch?v=q4uyyph017M&t=748s',
  },
  geometry: square(-87.61815, 41.79034),
};
const PLAIN = {
  type: 'Feature',
  id: 'chicago-event-99',
  properties: { name: 'No notes here' },
  geometry: square(-87.6, 41.8),
};

async function createCardHarness({
  features,
  hitTest,
  layerOptions = {},
  cameraHeight = 20_000,
}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const selected = [];
  globalThis.window = {
    dispatchEvent(event) {
      if (event.type === 'gev:entity-selected') selected.push(event.detail);
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const preRender = new MockEvent();
  const published = [];
  let clickAction = null;
  const flights = [];
  const added = [];
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add: (ds) => (added.push(ds), ds),
      remove: () => true,
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-87.61, 41.79, cameraHeight),
      positionCartographic: { height: cameraHeight },
      frustum: { fov: Math.PI / 3 },
      moveEnd: new MockEvent(),
      flyTo: (options) => flights.push(options),
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender,
      sampleHeightSupported: false,
      screenSpaceCameraController: { enableInputs: true },
      pick: () => null,
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-chicago-events',
    url: '/chicago_events.geojsonl',
    name: 'Chicago Events',
    color: '#ff3b6b',
    overlayHost: {
      setVisible() {},
      clearSource() {},
      setEntries: (_source, entries) => published.push(entries),
      hitTest,
    },
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        clickAction = action;
      },
      destroy() {},
    }),
    ...layerOptions,
  });
  try {
    await layer.enable(viewer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  preRender.raise();
  return {
    layer,
    viewer,
    selected,
    flights,
    entities: () => added.flatMap((ds) => ds.entities.values),
    entries: () => published.at(-1) || [],
    publishCount: () => published.length,
    walk: () => preRender.raise(),
    click: (x = 400, y = 300) =>
      clickAction({ position: new Cesium.Cartesian2(x, y) }),
    cleanup() {
      layer.destroy(viewer);
      globalThis.window = originalWindow;
    },
  };
}

test('only features with source notes publish a clickable card', async () => {
  const env = await createCardHarness({
    features: [NOTED, PLAIN],
    hitTest: () => null,
  });
  try {
    const entries = env.entries();
    const noted = entries.find((e) => e.id === 'chicago-event-3');
    const plain = entries.find((e) => e.id === 'chicago-event-99');
    assert.ok(noted && plain, 'both cards are published');
    assert.equal(noted.interactive, true);
    assert.equal(typeof noted.activate, 'function');
    assert.match(noted.accessibilityLabel, /details$/);
    assert.equal(plain.interactive, false);
    assert.equal(plain.activate, undefined);
    assert.deepEqual(noted.details, [
      '"Gotti" (Michael Lee, 23)',
      'Video 12:28 · click for details',
    ]);
  } finally {
    env.cleanup();
  }
});

test('clicking a notes card selects its feature and flies to it', async () => {
  let card = null;
  const env = await createCardHarness({
    features: [NOTED],
    hitTest: (_x, _y, options) =>
      card && options.filter(card.entry) ? card : null,
  });
  try {
    const entry = env.entries().find((e) => e.id === 'chicago-event-3');
    // The host hands back its normalized copy, which keeps `activate` and
    // `source` but none of the source's other fields.
    card = {
      sourceId: 'local-chicago-events',
      entry: { source: entry.source, activate: entry.activate },
    };
    env.click();
    assert.equal(env.selected.length, 1, 'the card click selected a feature');
    const record = env.selected[0];
    assert.equal(record.layerId, 'local-chicago-events');
    assert.equal(record.properties.video_url, NOTED.properties.video_url);
    assert.equal(record.properties.video_summary, 'Summary from the captions.');
    assert.equal(env.flights.length, 1, 'the camera flies to the event');
  } finally {
    env.cleanup();
  }
});

test('a local card from another layer wins the click and this layer yields', async () => {
  const env = await createCardHarness({
    features: [NOTED],
    hitTest: (_x, _y, options) => {
      const other = {
        sourceId: 'local-famous-shootings',
        entry: { source: 'local-famous-shootings', activate() {} },
      };
      return options.filter(other.entry) ? other : null;
    },
  });
  try {
    env.click();
    assert.equal(env.selected.length, 0);
    assert.equal(env.flights.length, 0);
  } finally {
    env.cleanup();
  }
});

test('the Display Labels switch hides every local label and restores it', async () => {
  const env = await createCardHarness({
    features: [NOTED],
    hitTest: () => null,
  });
  try {
    assert.equal(env.entries().length, 1, 'labels start visible');
    setLocalLabelSettings({ visible: false });
    env.walk();
    assert.deepEqual(env.entries(), [], 'hidden labels publish nothing');
    setLocalLabelSettings({ visible: true });
    env.walk();
    assert.equal(env.entries().length, 1, 'labels come back');
  } finally {
    setLocalLabelSettings({ visible: true, scale: 1 });
    env.cleanup();
  }
});

test('a names-only area layer publishes labels but draws and registers nothing', async () => {
  const HOOD = {
    type: 'Feature',
    id: 'hood-1',
    properties: { name: 'Low End', gang: 'GD' },
    geometry: square(-87.61, 41.79),
  };
  const env = await createCardHarness({
    features: [HOOD],
    hitTest: () => null,
    cameraHeight: 3_000,
    layerOptions: {
      id: 'local-gang-map-labels',
      labeledAreas: true,
      areaNamesOnly: true,
    },
  });
  try {
    assert.deepEqual(
      env.entries().map((e) => e.id),
      ['area:hood-1'],
      'the area name is published without the fill layer',
    );
    assert.ok(
      env.entities().every((e) => !e.polygon && !e.point && !e.billboard),
      'no fill, pin or marker is drawn',
    );
    env.click();
    assert.equal(env.selected.length, 0, 'nothing is selectable');
  } finally {
    env.cleanup();
  }
});

test('the label Size slider resizes cards already on the map', async () => {
  const env = await createCardHarness({
    features: [NOTED],
    hitTest: () => null,
  });
  try {
    assert.equal(env.entries()[0].distanceScale.nearValue, 1);
    const before = env.publishCount();
    setLocalLabelSettings({ scale: 0.5 });
    env.walk();
    assert.ok(
      env.publishCount() > before,
      'the resized cards are re-published',
    );
    const curve = env.entries()[0].distanceScale;
    assert.equal(curve.nearValue, 0.5);
    assert.equal(curve.farValue, 0.31);
    // Out-of-range sizes are clamped to the slider's bounds.
    assert.equal(setLocalLabelSettings({ scale: 9 }).scale, 1.5);
    assert.equal(getLocalLabelSettings().scale, 1.5);
  } finally {
    setLocalLabelSettings({ visible: true, scale: 1 });
    env.cleanup();
  }
});

test('a shared source downloads once and aborts only when every layer aborts', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, { signal }) => {
    calls.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      setTimeout(
        () =>
          resolve({
            ok: true,
            text: async () => `${JSON.stringify(PLAIN)}\n`,
          }),
        5,
      );
    });
  };
  try {
    const source = createSharedGeoJsonLinesSource('/shared.geojsonl');
    const a = new AbortController();
    const b = new AbortController();
    const first = source.load(a.signal);
    const second = source.load(b.signal);
    a.abort();
    assert.equal(calls[0].aborted, false, 'one layer still needs it');
    const [one, two] = await Promise.all([first, second]);
    assert.equal(calls.length, 1, 'fetched once');
    assert.equal(one, two, 'both layers get the same parsed features');
    assert.equal(await source.load(), one, 'later loads reuse the result');
    assert.equal(calls.length, 1);

    const lone = createSharedGeoJsonLinesSource('/lone.geojsonl');
    const c = new AbortController();
    const pending = lone.load(c.signal);
    c.abort();
    await assert.rejects(pending);
    assert.equal(
      calls.at(-1).aborted,
      true,
      'the last waiter aborts the fetch',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Miami homicide pins get Chicago-style clickable cards, per-feature colors and a legend', async () => {
  const HOMICIDE = {
    type: 'Feature',
    id: 'miami-dade-homicide-607',
    properties: {
      name: 'Homicide · Jan 13, 2011',
      year: 2011,
      age: 20,
      victim_group: 'Black',
      summary: 'Victim shot during a robbery.',
    },
    geometry: square(-87.61, 41.79),
  };
  const OLDER = {
    ...HOMICIDE,
    id: 'miami-dade-homicide-12',
    properties: { ...HOMICIDE.properties, year: 1963 },
    geometry: square(-87.6, 41.8),
  };
  const decade = (p) => (p.year >= 2000 ? '#8b0aa5' : '#fdb42f');
  const env = await createCardHarness({
    features: [HOMICIDE, OLDER],
    hitTest: () => null,
    layerOptions: {
      id: 'local-miami-homicides-2000s',
      featureColor: decade,
      legend: [
        { label: '1960s', color: '#fdb42f', test: (p) => p.year < 1970 },
        { label: '2000–2011', color: '#8b0aa5', test: (p) => p.year >= 2000 },
      ],
    },
  });
  try {
    const card = env.entries().find((e) => e.id === 'miami-dade-homicide-607');
    assert.ok(card, 'the homicide card is published');
    assert.equal(card.interactive, true, 'a summary makes the card clickable');
    assert.deepEqual(card.details, ['Age 20 · Black', 'Click for details']);
    assert.deepEqual(
      env.layer.getRowControls().legend.map((l) => [l.label, l.count]),
      [
        ['1960s', 1],
        ['2000–2011', 1],
      ],
    );
  } finally {
    env.cleanup();
  }
});

test('a point layer reports its nearest sites and how many are close, for voice', async () => {
  const site = (id, name, lon, lat) => ({
    type: 'Feature',
    id,
    properties: { name, summary: `${name} summary`, tags: { big: 'blob' } },
    geometry: square(lon, lat),
  });
  const env = await createCardHarness({
    features: [
      site('ph-1', 'Near Homes', -87.61, 41.79),
      site('ph-2', 'Mid Homes', -87.58, 41.79),
      site('ph-3', 'Far Homes', -87.0, 41.0),
    ],
    hitTest: () => null,
    layerOptions: { id: 'local-public-housing' },
  });
  try {
    const context = await env.layer.getAreaContext({
      longitude: -87.61,
      latitude: 41.79,
      limit: 2,
      radiusKm: 5,
    });
    assert.equal(context.status, 'loaded');
    assert.equal(context.layerId, 'local-public-housing');
    assert.equal(context.loadedFeatures, 3);
    assert.equal(context.countWithin, 2, 'two sites lie within 5 km');
    assert.deepEqual(
      context.nearby.map((s) => s.name),
      ['Near Homes', 'Mid Homes'],
    );
    assert.ok(
      context.nearby[1].distanceKm > 2 && context.nearby[1].distanceKm < 3,
    );
    assert.equal(
      'tags' in context.nearby[0],
      false,
      'nested blobs are dropped',
    );
  } finally {
    env.cleanup();
  }
});
