// Voice context for area layers (life expectancy, clusters): enabled layers
// that offer getAreaContext answer for the point under the view center.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { areaLayerContexts } from './gevActions.js';

function dataManagerWith(layers) {
  return {
    layers: new Map(layers.map((l) => [l.id, { module: l.module }])),
    getAll: () => layers.map(({ id, enabled }) => ({ id, enabled })),
  };
}

const viewer = {
  camera: {
    positionCartographic: Cesium.Cartographic.fromDegrees(-87.65, 41.85, 5000),
  },
};

test('enabled area layers report what is under the view target', async () => {
  const asked = [];
  const areaLayer = (answer) => ({
    getAreaContext(point) {
      asked.push(point);
      return answer;
    },
  });
  const dataManager = dataManagerWith([
    {
      id: 'local-life-expectancy',
      enabled: true,
      module: areaLayer({
        layerId: 'local-life-expectancy',
        atPoint: { life_exp_8: 68.8 },
      }),
    },
    {
      id: 'local-county-le-clusters',
      enabled: false,
      module: areaLayer({ layerId: 'local-county-le-clusters' }),
    },
    { id: 'flights', enabled: true, module: {} },
  ]);
  const target = Cesium.Cartographic.fromDegrees(-87.67, 42.02);
  const areas = await areaLayerContexts(viewer, dataManager, {
    limit: 3,
    target,
  });
  assert.deepEqual(areas, [
    { layerId: 'local-life-expectancy', atPoint: { life_exp_8: 68.8 } },
  ]);
  assert.equal(asked.length, 1);
  assert.ok(Math.abs(asked[0].longitude - -87.67) < 1e-9);
  assert.ok(Math.abs(asked[0].latitude - 42.02) < 1e-9);
  assert.equal(asked[0].limit, 3);
});

test('a layer filter, a failing layer and a silent layer are all handled', async () => {
  const dataManager = dataManagerWith([
    {
      id: 'local-life-expectancy',
      enabled: true,
      module: {
        getAreaContext() {
          throw new Error('broken');
        },
      },
    },
    {
      // A names-only mirror layer answers null and is left out.
      id: 'local-gang-map-labels',
      enabled: true,
      module: { getAreaContext: async () => null },
    },
    {
      id: 'local-tract-le-clusters',
      enabled: true,
      module: {
        getAreaContext: () => ({ layerId: 'local-tract-le-clusters' }),
      },
    },
  ]);
  assert.deepEqual(await areaLayerContexts(viewer, dataManager), [
    { layerId: 'local-tract-le-clusters' },
  ]);
  assert.deepEqual(
    await areaLayerContexts(viewer, dataManager, {
      layerId: 'local-life-expectancy',
    }),
    [],
  );
});

test('a screen-center pick thousands of km from the camera falls back to the camera position', async () => {
  const asked = [];
  const dataManager = dataManagerWith([
    {
      id: 'local-life-expectancy',
      enabled: true,
      module: {
        getAreaContext: async (point) => {
          asked.push(point);
          return { layerId: 'local-life-expectancy' };
        },
      },
    },
  ]);
  // Camera over Chicago at 5 km; a misfired pick in the Arctic.
  const target = Cesium.Cartographic.fromDegrees(-156.8, 71.3);
  await areaLayerContexts(viewer, dataManager, { target });
  assert.ok(Math.abs(asked[0].longitude - -87.65) < 1e-9);
  assert.ok(Math.abs(asked[0].latitude - 41.85) < 1e-9);
});
