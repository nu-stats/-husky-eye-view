/** Field-of-view zoom for the Cockpit camera (wheel, +/- keys, HUD buttons, voice). */
import {
  COCKPIT_ZOOM_LEVELS,
  clampCockpitZoom,
  cockpitZoomFov,
  formatCockpitZoom,
  stepCockpitZoom,
} from '../cockpitMath.js';

// One notch per step: trackpads fire dozens of small wheel events per swipe.
const WHEEL_STEP_MS = 140;

/** Remember the map camera's field of view so Cockpit can narrow and restore it. */
export function captureZoomBase() {
  const frustum = this.viewer.camera?.frustum;
  this.zoomBaseFov = Number.isFinite(frustum?.fov) ? frustum.fov : null;
  this.zoom = 1;
  this.lastWheelZoomMs = 0;
  syncZoomControls.call(this);
}

/** Put the map camera's field of view back as it was before Cockpit. */
export function restoreZoomBase() {
  const frustum = this.viewer.camera?.frustum;
  if (frustum && Number.isFinite(this.zoomBaseFov)) {
    frustum.fov = this.zoomBaseFov;
  }
  this.zoomBaseFov = null;
  this.zoom = 1;
  syncZoomControls.call(this);
}

/** Set the Cockpit magnification. Returns the applied value, or null outside Cockpit. */
export function setZoom(zoom) {
  if (!this.active || !Number.isFinite(this.zoomBaseFov)) return null;
  const next = clampCockpitZoom(zoom);
  this.zoom = next;
  this.viewer.camera.frustum.fov = cockpitZoomFov(this.zoomBaseFov, next);
  this.viewer.scene.requestRender?.();
  syncZoomControls.call(this);
  return next;
}

/** Move one zoom step in (+1) or out (-1). */
export function stepZoom(direction) {
  return setZoom.call(this, stepCockpitZoom(this.zoom ?? 1, direction));
}

export function onZoomWheel(event) {
  if (this.destroyed || !this.active || !event.deltaY) return;
  event.preventDefault();
  const nowMs = performance.now();
  if (nowMs - (this.lastWheelZoomMs || 0) < WHEEL_STEP_MS) return;
  this.lastWheelZoomMs = nowMs;
  stepZoom.call(this, event.deltaY < 0 ? 1 : -1);
}

function syncZoomControls() {
  const zoom = clampCockpitZoom(this.zoom ?? 1);
  const label = formatCockpitZoom(zoom);
  if (this.zoomValue) this.zoomValue.textContent = label;
  if (this.zoomReset) {
    this.zoomReset.setAttribute(
      'aria-label',
      `Cockpit zoom ${label}. Activate to reset.`,
    );
    this.zoomReset.dataset.zoomed = String(zoom > 1);
  }
  if (this.zoomIn) {
    this.zoomIn.disabled =
      zoom >= COCKPIT_ZOOM_LEVELS[COCKPIT_ZOOM_LEVELS.length - 1];
  }
  if (this.zoomOut) this.zoomOut.disabled = zoom <= COCKPIT_ZOOM_LEVELS[0];
}
