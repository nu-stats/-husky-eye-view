import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createSplatCapturesLayer } from './splatCaptures.js';

function fakeViewer() {
  const primitives = [];
  const flights = [];
  return {
    primitives,
    flights,
    scene: {
      requestRender() {},
      primitives: {
        add: (value) => primitives.push(value),
        remove: (value) => primitives.splice(primitives.indexOf(value), 1),
      },
    },
    camera: {
      flyToBoundingSphere: (sphere, options) =>
        flights.push({ sphere, options }),
    },
  };
}

// A capture near the sample tower (44.52 N, 93.17 W).
const TOWER = Cesium.Cartesian3.fromDegrees(-93.1715, 44.5168, 300);
const tileset = (radius = 38) => ({
  boundingSphere: new Cesium.BoundingSphere(TOWER, radius),
  destroyed: false,
  destroy() {
    this.destroyed = true;
  },
});

const catalog = (entries) => async () => ({
  ok: true,
  status: 200,
  json: async () => entries,
});

test('listed captures load onto the globe, missing ones are skipped, and each gets a fly-to chip', async () => {
  const viewer = fakeViewer();
  const made = tileset();
  const layer = createSplatCapturesLayer({
    fetchImpl: catalog([
      {
        name: 'Tower',
        tileset: '/splats/tower/tileset.json',
        credit: 'Cesium',
      },
      { name: 'Gone', tileset: '/splats/missing/tileset.json' },
      { name: 'No tileset field' },
    ]),
    loadTileset: async (url) => {
      if (url.includes('missing')) throw new Error('404');
      return made;
    },
  });
  let notified = 0;
  layer.setRowControlsListener(() => notified++);
  await layer.enable(viewer);
  assert.deepEqual(viewer.primitives, [made]);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  assert.equal(notified, 1, 'the panel hears that the chips changed');
  const [chip] = layer.getRowControls().chips;
  assert.equal(chip.label, 'FLY TO TOWER');
  assert.match(chip.title, /^44\.52°N, 93\.17°W · Cesium$/);
  chip.onClick();
  assert.equal(viewer.flights.length, 1);
  assert.equal(viewer.flights[0].options.offset.range, 38 * 3);

  await layer.disable(viewer);
  assert.deepEqual(viewer.primitives, []);
  assert.deepEqual(layer.getRowControls().chips, []);
});

test('a list whose files are all missing says so instead of looking empty', async () => {
  const layer = createSplatCapturesLayer({
    fetchImpl: catalog([{ name: 'Gone', tileset: '/splats/x/tileset.json' }]),
    loadTileset: async () => {
      throw new Error('404');
    },
  });
  await layer.enable(fakeViewer());
  assert.equal(layer.getStats().count, 0);
  assert.match(layer.getStats().error, /No capture files found \(1 listed/);
});

test('no capture list is simply an empty layer; a broken one is an error', async () => {
  const empty = createSplatCapturesLayer({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await empty.enable(fakeViewer());
  assert.deepEqual(empty.getStats(), {
    count: 0,
    lastUpdate: empty.getStats().lastUpdate,
    error: null,
  });
  const broken = createSplatCapturesLayer({
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await broken.enable(fakeViewer());
  assert.match(broken.getStats().error, /HTTP 500/);
});

test('turning the layer off mid-load discards the late tileset', async () => {
  const viewer = fakeViewer();
  let release;
  const late = tileset();
  const layer = createSplatCapturesLayer({
    fetchImpl: catalog([
      { name: 'Slow', tileset: '/splats/slow/tileset.json' },
    ]),
    loadTileset: () =>
      new Promise((resolve) => {
        release = () => resolve(late);
      }),
  });
  const enabling = layer.enable(viewer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await layer.disable(viewer);
  release();
  await enabling;
  assert.deepEqual(viewer.primitives, []);
  assert.equal(late.destroyed, true);
});
