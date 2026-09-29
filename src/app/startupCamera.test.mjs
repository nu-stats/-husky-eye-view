import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORTHEASTERN_CAMPUS,
  cameraPositionLookingAt,
  flyToNortheastern,
} from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToNortheastern({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('the startup view is aimed at 360 Huntington Avenue', () => {
  assert.deepEqual(NORTHEASTERN_CAMPUS, {
    latitude: 42.33985,
    longitude: -71.0892,
  });
  // 600 m up, looking 30° down to the NNE: the camera hovers ~1 km short of
  // campus along that heading (south-southwest of it), so campus is centered.
  const at = cameraPositionLookingAt(NORTHEASTERN_CAMPUS, {
    heightM: 600,
    headingDeg: 15,
    pitchDeg: -30,
  });
  const northM = (NORTHEASTERN_CAMPUS.latitude - at.latitude) * 111_320;
  const eastM =
    (NORTHEASTERN_CAMPUS.longitude - at.longitude) *
    111_320 *
    Math.cos((NORTHEASTERN_CAMPUS.latitude * Math.PI) / 180);
  assert.ok(Math.abs(Math.hypot(northM, eastM) - 600 * Math.sqrt(3)) < 1);
  assert.ok(Math.abs((Math.atan2(eastM, northM) * 180) / Math.PI - 15) < 0.01);
});
