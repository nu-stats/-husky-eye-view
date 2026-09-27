// Display-panel Labels row: the toggle and Size slider drive the local label
// settings and are remembered between visits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_LABELS_STORAGE_KEY,
  MapLabelControls,
} from './mapLabelControls.js';
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
    'map-labels-toggle': fakeElement(),
    'map-labels-slider-row': fakeElement(),
    'map-labels-size-slider': fakeElement({ min: '40', max: '150', value: '100' }),
    'map-labels-size-value': fakeElement(),
  };
  const store = new Map(
    saved ? [[MAP_LABELS_STORAGE_KEY, JSON.stringify(saved)]] : [],
  );
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const applied = [];
  const lifetime = new UiLifetime();
  new MapLabelControls({
    lifetime,
    apply: (settings) => applied.push(settings),
    root: { getElementById: (id) => elements[id] },
    storage,
  });
  return { elements, applied, store, lifetime };
}

test('defaults to visible at 100% and applies it on start', () => {
  const env = setup();
  assert.deepEqual(env.applied.at(-1), { visible: true, scale: 1 });
  assert.equal(env.elements['map-labels-size-value'].textContent, '100%');
  assert.ok(env.elements['map-labels-toggle'].classList.contains('active'));
  env.lifetime.destroy();
});

test('toggle hides labels and the slider resizes them, and both persist', () => {
  const env = setup();
  const toggle = env.elements['map-labels-toggle'];
  const slider = env.elements['map-labels-size-slider'];

  toggle.fire('click');
  assert.deepEqual(env.applied.at(-1), { visible: false, scale: 1 });
  assert.equal(toggle.attributes['aria-pressed'], 'false');
  assert.equal(
    env.elements['map-labels-slider-row'].classList.contains('visible'),
    false,
  );

  toggle.fire('click');
  slider.value = '60';
  slider.fire('input');
  assert.deepEqual(env.applied.at(-1), { visible: true, scale: 0.6 });
  assert.equal(env.elements['map-labels-size-value'].textContent, '60%');
  assert.deepEqual(JSON.parse(env.store.get(MAP_LABELS_STORAGE_KEY)), {
    visible: true,
    percent: 60,
  });
  env.lifetime.destroy();
});

test('a saved setting is restored on the next visit', () => {
  const env = setup({ visible: false, percent: 70 });
  assert.deepEqual(env.applied.at(-1), { visible: false, scale: 0.7 });
  assert.equal(env.elements['map-labels-size-slider'].value, '70');
  env.lifetime.destroy();
});
