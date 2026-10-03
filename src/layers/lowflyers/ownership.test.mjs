import test from 'node:test';
import assert from 'node:assert/strict';
import { createLowFlyerLayer } from './index.js';
import { createFlightState } from './state.js';
import { createLowFlyerRegistry } from '../aircraft/lowFlyerRegistry.js';

function services() {
  const names = [
    'picking',
    'sprites',
    'trails',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    lowFlyerRegistry: createLowFlyerRegistry(),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

test('low-flyer layer instances isolate policy and restoration state without requesting a source', async () => {
  let requests = 0;
  const source = {
    label: 'Fixture aircraft',
    getSnapshot() {
      requests++;
    },
  };
  const first = createLowFlyerLayer({ source, services: services() });
  const second = createLowFlyerLayer({ source, services: services() });
  assert.equal(first.id, 'lowflyers');
  first.setParams({ models3dMode: 'all' });
  assert.equal(first.getParams().models3dMode, 'all');
  assert.equal(second.getParams().models3dMode, 'proximity');
  first.testing._setLowFlyerTrackingRefreshOutcomeForTest({ ids: [] });
  assert.equal(
    (await first.resolveTrackingRestoreTarget('abc123')).status,
    'missing',
  );
  assert.equal(
    (await second.resolveTrackingRestoreTarget('abc123')).status,
    'source-unavailable',
  );
  assert.equal(requests, 0);
});

test('low-flyer source omission fails before viewer initialization', () => {
  const layer = createLowFlyerLayer({ services: services() });
  assert.throws(() => layer.init({}), /snapshot source/);
});

test('low-flyer state owns separate contact maps, motion scratch and ground sampling', () => {
  const first = createFlightState({ services: services() });
  const second = createFlightState({ services: services() });
  for (const key of [
    'records',
    'feed',
    '_billboards',
    '_positionHistory',
    '_groundSnap',
    '_scratchCarto',
    '_models',
    'lifetime',
  ]) {
    assert.notEqual(first[key], second[key], key);
  }
  assert.notEqual(first.records.data, second.records.data);
  assert.notEqual(first.records.missingPolls, second.records.missingPolls);
  assert.notEqual(first.records.geoidNCache, second.records.geoidNCache);
  assert.notEqual(
    first.feed._activeUpdateControllers,
    second.feed._activeUpdateControllers,
  );
});

test('each poll asks the source for the camera position', async () => {
  const queries = [];
  const supplied = services();
  supplied.groundFloor.warmGroundFloor = async () => {};
  supplied.meshFloor.sampleMeshFloorCells = () => {};
  const layer = createLowFlyerLayer({
    services: supplied,
    source: {
      label: 'Fixture aircraft',
      async getSnapshot(query) {
        queries.push(query);
        return {
          source: 'Fixture aircraft',
          records: [],
          complete: true,
          observedAtMs: 123000,
          freshness: 'fresh',
        };
      },
    },
  });
  const camera = {
    positionCartographic: {
      latitude: 0.7389,
      longitude: -1.2409,
      height: 9000,
    },
  };
  await layer.update({ camera });
  assert.equal(queries.length, 1);
  assert.ok(Math.abs(queries[0].latitude - 42.336) < 0.01);
  assert.ok(Math.abs(queries[0].longitude + 71.098) < 0.01);
});

test('a normalized source can retain its stale reason without changing standalone cache policy', async () => {
  let reason = 'Source is refreshing';
  const supplied = services();
  supplied.groundFloor.warmGroundFloor = async () => {};
  supplied.meshFloor.sampleMeshFloorCells = () => {};
  const layer = createLowFlyerLayer({
    services: supplied,
    source: {
      label: 'Fixture aircraft',
      async getSnapshot() {
        return {
          source: 'Fixture aircraft',
          records: [],
          complete: true,
          observedAtMs: 123000,
          stale: true,
          freshness: 'stale',
          reason,
        };
      },
    },
  });
  await layer.update({});
  assert.equal(layer.getStats().error, reason);
  assert.equal(layer.getStats().lastUpdate, 123000);
  assert.equal(layer.getStats().stale, true);
  reason = null;
  await layer.update({});
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().stale, true);
});
