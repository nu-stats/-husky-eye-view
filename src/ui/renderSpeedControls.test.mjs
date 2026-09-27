// Display-panel Speed row: the toggle turns off anti-aliasing and lowers the
// render resolution to the slider's share, and the choice is remembered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_SPEED_STORAGE_KEY,
  RenderSpeedControls,
  applyRenderSpeed,
} from './renderSpeedControls.js';
import { UiLifetime } from './uiLifetime.js';

function fakeElement(extra = {}) {
  const classes = new Set();
  const listeners = {};
  return {
    attributes: {},
    textContent: '',
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    fire: (type) => listeners[type]?.({}),
    ...extra,
  };
}

function setup(saved) {
  const elements = {
    'render-speed-toggle': fakeElement(),
    'render-speed-row': fakeElement(),
    'render-speed-slider': fakeElement({ min: '50', max: '100', value: '75' }),
    'render-speed-value': fakeElement(),
  };
  const store = new Map(
    saved ? [[RENDER_SPEED_STORAGE_KEY, JSON.stringify(saved)]] : [],
  );
  const applied = [];
  const lifetime = new UiLifetime();
  new RenderSpeedControls({
    lifetime,
    apply: (setting) => applied.push(setting),
    root: { getElementById: (id) => elements[id] },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
  });
  return { elements, applied, store, lifetime };
}

test('starts off (full quality) and applies that on start', () => {
  const env = setup();
  assert.deepEqual(env.applied.at(-1), { fast: false, scale: 0.75 });
  assert.equal(
    env.elements['render-speed-toggle'].classList.contains('active'),
    false,
  );
  env.lifetime.destroy();
});

test('the toggle and Resolution slider apply and persist', () => {
  const env = setup();
  env.elements['render-speed-toggle'].fire('click');
  assert.deepEqual(env.applied.at(-1), { fast: true, scale: 0.75 });
  assert.ok(env.elements['render-speed-row'].classList.contains('visible'));
  const slider = env.elements['render-speed-slider'];
  slider.value = '60';
  slider.fire('input');
  assert.deepEqual(env.applied.at(-1), { fast: true, scale: 0.6 });
  assert.equal(env.elements['render-speed-value'].textContent, '60%');
  assert.deepEqual(JSON.parse(env.store.get(RENDER_SPEED_STORAGE_KEY)), {
    fast: true,
    percent: 60,
  });
  env.lifetime.destroy();
});

test('a saved setting is restored on the next visit', () => {
  const env = setup({ fast: true, percent: 50 });
  assert.deepEqual(env.applied.at(-1), { fast: true, scale: 0.5 });
  env.lifetime.destroy();
});

test('applyRenderSpeed sets resolution and anti-aliasing on the viewer', () => {
  let renders = 0;
  const viewer = {
    resolutionScale: 1,
    scene: { msaaSamples: 4, requestRender: () => renders++ },
  };
  applyRenderSpeed(viewer, { fast: true, scale: 0.7 });
  assert.equal(viewer.resolutionScale, 0.7);
  assert.equal(viewer.scene.msaaSamples, 1);
  applyRenderSpeed(viewer, { fast: false, scale: 0.7 });
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(renders, 2);
});
