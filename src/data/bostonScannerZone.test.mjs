import test from 'node:test';
import assert from 'node:assert/strict';
import outline from './local_data/boston/city-outline.json' with { type: 'json' };
import {
  BOSTON_SCANNER_RADIUS_MILES,
  BOSTON_SCANNER_URL,
  bostonScannerAvailable,
  milesFromBoston,
} from './bostonScannerZone.js';

const BOSTON_CITY_RINGS = outline.rings;

test('the scanner zone is 15 miles around the official BPD public feed', () => {
  assert.equal(BOSTON_SCANNER_RADIUS_MILES, 15);
  assert.equal(BOSTON_SCANNER_URL, 'https://radio.rapidsos.com/boston');
});

test('distance math: a point 0.1 degree of longitude east of a ring edge at the equator', () => {
  const square = [
    [
      [-0.01, -0.01],
      [0.01, -0.01],
      [0.01, 0.01],
      [-0.01, 0.01],
      [-0.01, -0.01],
    ],
  ];
  assert.equal(milesFromBoston(0, 0, square), 0);
  // 0.1 deg of longitude at the equator = 11.132 km = 6.917 mi.
  assert.ok(Math.abs(milesFromBoston(0, 0.11, square) - 6.917) < 0.01);
});

test('points inside Boston are zero miles away', () => {
  assert.equal(milesFromBoston(42.3398, -71.0892, BOSTON_CITY_RINGS), 0); // Northeastern
  assert.equal(milesFromBoston(42.3601, -71.0589, BOSTON_CITY_RINGS), 0); // City Hall
});

test('nearby cities are offered the scanner; distant ones are not', () => {
  const offered = [
    ['Cambridge', 42.3736, -71.119],
    ['Quincy', 42.2529, -71.0023],
    ['Framingham', 42.2793, -71.4162],
  ];
  for (const [name, lat, lon] of offered)
    assert.ok(bostonScannerAvailable(lat, lon, BOSTON_CITY_RINGS), name);
  const refused = [
    ['Worcester', 42.2626, -71.8023],
    ['Providence', 41.824, -71.4128],
    ['New York', 40.7128, -74.006],
  ];
  for (const [name, lat, lon] of refused)
    assert.equal(
      bostonScannerAvailable(lat, lon, BOSTON_CITY_RINGS),
      false,
      name,
    );
});

test('missing input never offers the scanner', () => {
  assert.equal(milesFromBoston(Number.NaN, -71, BOSTON_CITY_RINGS), Infinity);
  assert.equal(milesFromBoston(42.36, -71.06, []), Infinity);
});
