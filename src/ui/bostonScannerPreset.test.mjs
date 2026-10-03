import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import outline from '../data/local_data/boston/city-outline.json' with { type: 'json' };
import {
  installBostonScannerPreset,
  scannerPresetTitle,
  scannerViewPoint,
} from './bostonScannerPreset.js';

const BOSTON_CITY_RINGS = outline.rings;

const cartesian = (lat, lon) => Cesium.Cartesian3.fromDegrees(lon, lat, 0);
const cartographic = (lat, lon, height = 1000) =>
  Cesium.Cartographic.fromDegrees(lon, lat, height);

function harness({ center, camera, cockpit = false }) {
  const links = [0, 1, 2].map(() => ({ hidden: true, href: '', title: '' }));
  const classes = new Set(cockpit ? ['cockpit-mode'] : []);
  const documentRef = {
    body: { classList: { contains: (name) => classes.has(name) } },
    querySelectorAll: (selector) =>
      selector === '[data-boston-scanner]' ? links : [],
  };
  const moveEnd = new Set();
  const state = { center, camera };
  const viewer = {
    scene: {
      canvas: { clientWidth: 1920, clientHeight: 1080 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      pickEllipsoid: () =>
        state.center
          ? cartesian(state.center.lat, state.center.lon)
          : undefined,
      get positionCartographic() {
        return cartographic(state.camera.lat, state.camera.lon);
      },
      moveEnd: {
        addEventListener: (fn) => {
          moveEnd.add(fn);
          return () => moveEnd.delete(fn);
        },
      },
    },
  };
  const listeners = new Map();
  const windowRef = {
    setInterval: () => 7,
    clearInterval: () => {},
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  return {
    links,
    classes,
    documentRef,
    viewer,
    windowRef,
    state,
    moveEnd,
    listeners,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the preset appears over Boston and links to the official feed', async () => {
  const h = harness({
    center: { lat: 42.3398, lon: -71.0892 },
    camera: { lat: 42.2, lon: -71.1 },
  });
  const preset = installBostonScannerPreset({
    viewer: h.viewer,
    documentRef: h.documentRef,
    windowRef: h.windowRef,
    loadRings: async () => BOSTON_CITY_RINGS,
  });
  await settle();
  assert.equal(preset.available, true);
  for (const link of h.links) {
    assert.equal(link.hidden, false);
    assert.equal(link.href, 'https://radio.rapidsos.com/boston');
    assert.match(link.title, /over Boston/);
  }
  preset.destroy();
});

test('the preset hides once the view center is more than 15 miles out', async () => {
  const h = harness({
    center: { lat: 42.3398, lon: -71.0892 },
    camera: { lat: 42.3, lon: -71.1 },
  });
  const preset = installBostonScannerPreset({
    viewer: h.viewer,
    documentRef: h.documentRef,
    windowRef: h.windowRef,
    loadRings: async () => BOSTON_CITY_RINGS,
  });
  await settle();
  h.state.center = { lat: 42.2626, lon: -71.8023 }; // Worcester
  for (const fn of h.moveEnd) fn();
  assert.equal(preset.available, false);
  assert.ok(h.links.every((link) => link.hidden));
  preset.destroy();
  assert.equal(h.moveEnd.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('in the cockpit the aircraft position decides, not the far horizon', async () => {
  const h = harness({
    center: { lat: 42.3398, lon: -71.0892 }, // looking toward Boston...
    camera: { lat: 41.824, lon: -71.4128 }, // ...from over Providence
    cockpit: true,
  });
  const preset = installBostonScannerPreset({
    viewer: h.viewer,
    documentRef: h.documentRef,
    windowRef: h.windowRef,
    loadRings: async () => BOSTON_CITY_RINGS,
  });
  await settle();
  assert.equal(preset.available, false);
  h.state.camera = { lat: 42.36, lon: -71.2 }; // over Waltham
  h.listeners.get('gev:cockpit-mode-changed')();
  assert.equal(preset.available, true);
  preset.destroy();
});

test('view point falls back to the camera when the screen center misses the globe', () => {
  const h = harness({ center: null, camera: { lat: 42.36, lon: -71.06 } });
  const point = scannerViewPoint(h.viewer);
  assert.ok(Math.abs(point.lat - 42.36) < 1e-6);
  assert.ok(Math.abs(point.lon + 71.06) < 1e-6);
});

test('title says how far the view is from Boston', () => {
  assert.match(scannerPresetTitle(0), /over Boston/);
  assert.match(scannerPresetTitle(7.25), /7\.3 mi from Boston/);
  assert.match(scannerPresetTitle(3), /delayed about 5 minutes/);
});

test('links rendered after install are still managed', async () => {
  const h = harness({
    center: { lat: 42.3398, lon: -71.0892 },
    camera: { lat: 42.3, lon: -71.1 },
  });
  const late = [];
  const documentRef = {
    ...h.documentRef,
    querySelectorAll: (selector) =>
      selector === '[data-boston-scanner]' ? late : [],
  };
  const preset = installBostonScannerPreset({
    viewer: h.viewer,
    documentRef,
    windowRef: h.windowRef,
    loadRings: async () => BOSTON_CITY_RINGS,
  });
  await settle();
  late.push({ hidden: true, href: '', title: '' });
  preset.refresh();
  assert.equal(late[0].hidden, false);
  preset.destroy();
});

test('without a viewer nothing is installed', () => {
  const preset = installBostonScannerPreset({
    viewer: null,
    documentRef: { querySelectorAll: () => [] },
  });
  assert.doesNotThrow(() => preset.refresh());
  assert.doesNotThrow(() => preset.destroy());
});
