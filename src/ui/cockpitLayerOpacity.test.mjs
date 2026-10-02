import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKPIT_LAYER_OPACITY_DEFAULT,
  applyLayerOpacity,
  clampCockpitLayerOpacity,
  releaseLayerOpacity,
  setLayerOpacity,
} from './cockpitLayerOpacity.js';

function cockpit() {
  const pushed = [];
  return {
    active: true,
    layerOpacityPercent: null,
    layerOpacityTimer: null,
    layerOpacityInput: { value: '' },
    layerOpacityValue: { textContent: '' },
    services: { setAreaFillAlpha: (alpha) => pushed.push(alpha) },
    pushed,
  };
}

test('the cockpit applies its layer opacity on entry and hands it back on exit', () => {
  const view = cockpit();
  applyLayerOpacity.call(view);
  assert.deepEqual(view.pushed, [COCKPIT_LAYER_OPACITY_DEFAULT / 100]);
  assert.equal(view.layerOpacityValue.textContent, '70%');
  releaseLayerOpacity.call(view);
  assert.deepEqual(view.pushed.at(-1), null, 'each layer gets its own look back');
});

test('the LAYERS slider clamps, shows its value and applies (debounced while dragging)', async () => {
  const view = cockpit();
  assert.equal(setLayerOpacity.call(view, 150, { immediate: true }), 95);
  assert.equal(view.pushed.at(-1), 0.95);
  assert.equal(view.layerOpacityValue.textContent, '95%');
  setLayerOpacity.call(view, 40);
  assert.equal(view.layerOpacityInput.value, '40');
  assert.equal(view.pushed.at(-1), 0.95, 'dragging waits a moment');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(view.pushed.at(-1), 0.4);
  // Outside the cockpit the value is remembered but nothing is recolored.
  view.active = false;
  setLayerOpacity.call(view, 60, { immediate: true });
  assert.equal(view.pushed.at(-1), 0.4);
  assert.equal(clampCockpitLayerOpacity('x'), COCKPIT_LAYER_OPACITY_DEFAULT);
  assert.equal(clampCockpitLayerOpacity(5), 20);
});
