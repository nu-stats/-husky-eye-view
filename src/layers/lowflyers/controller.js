import * as Cesium from 'cesium';

export function createController({ flightState }) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  /** The low-flyer feed is centered on the camera, like the civil feed. */
  function _flightQuery(viewer) {
    const cartographic = viewer?.camera?.positionCartographic;
    return cartographic
      ? {
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
        }
      : {};
  }
  return { _abortActiveUpdates, _flightQuery };
}
