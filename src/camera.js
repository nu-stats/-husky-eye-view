import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * Default: fly to Northeastern's campus (360 Huntington Ave, Boston) on load.
 */
export const CAMERA_PRESETS = {
  boston: {
    destination: Cesium.Cartesian3.fromDegrees(-71.0589, 42.3601, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/** Northeastern University, 360 Huntington Avenue, Boston. */
export const NORTHEASTERN_CAMPUS = Object.freeze({
  latitude: 42.33985,
  longitude: -71.0892,
});

/**
 * Where to hover so a camera at `heightM`, looking `pitchDeg` down along
 * `headingDeg`, has `target` in the middle of the screen.
 */
export function cameraPositionLookingAt(
  { latitude, longitude },
  { heightM, headingDeg, pitchDeg },
) {
  const aheadM = heightM / Math.tan(Cesium.Math.toRadians(-pitchDeg));
  const heading = Cesium.Math.toRadians(headingDeg);
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.cos(Cesium.Math.toRadians(latitude));
  return {
    latitude: latitude - (aheadM * Math.cos(heading)) / metersPerDegreeLat,
    longitude: longitude - (aheadM * Math.sin(heading)) / metersPerDegreeLon,
  };
}

/** The campus view: 600 m up, looking NNE 30° down, campus centered. */
const NORTHEASTERN_VIEW = Object.freeze({
  heightM: 600,
  headingDeg: 15,
  pitchDeg: -30,
});

/**
 * Fly from wherever the camera is to the campus view (the husky button).
 * @returns {{targetPosition: Cesium.Cartesian3}} The campus point, for orbit.
 */
export function flyToNortheasternView(viewer, { duration = 3 } = {}) {
  const campus = NORTHEASTERN_CAMPUS;
  const at = cameraPositionLookingAt(campus, NORTHEASTERN_VIEW);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      at.longitude,
      at.latitude,
      NORTHEASTERN_VIEW.heightM,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(NORTHEASTERN_VIEW.headingDeg),
      pitch: Cesium.Math.toRadians(NORTHEASTERN_VIEW.pitchDeg),
      roll: 0.0,
    },
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
  return {
    targetPosition: Cesium.Cartesian3.fromDegrees(
      campus.longitude,
      campus.latitude,
      0,
    ),
  };
}

/**
 * Set camera to Northeastern's campus on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToNortheastern(viewer) {
  const campus = NORTHEASTERN_CAMPUS;
  // Start from a high altitude over campus, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      campus.longitude,
      campus.latitude,
      25000,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause, ending with campus centered
  const approach = cameraPositionLookingAt(campus, {
    heightM: 600,
    headingDeg: 15,
    pitchDeg: -30,
  });
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        approach.longitude,
        approach.latitude,
        600,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
