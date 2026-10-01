/** Look around from the Cockpit: pan left/right and up/down from the nose. */
import {
  clampCockpitLook,
  easeCockpitLook,
  formatCockpitLook,
} from '../cockpitMath.js';

// Degrees per arrow press / HUD button press.
export const COCKPIT_LOOK_STEP_YAW_DEG = 15;
export const COCKPIT_LOOK_STEP_PITCH_DEG = 10;
// Degrees of look per pixel of drag, scaled by the zoom so a magnified view
// does not swing wildly under the pointer.
const DRAG_DEG_PER_PX = 0.18;
// Pointer travel before a press counts as a drag rather than a click.
const DRAG_THRESHOLD_PX = 4;

/** Point the view straight ahead again (also on entry and exit). */
export function resetLook({ immediate = false } = {}) {
  this.lookTarget = { yawDeg: 0, pitchDeg: 0 };
  if (immediate || !this.lookCurrent) {
    this.lookCurrent = { yawDeg: 0, pitchDeg: 0 };
  }
  this.lookDrag = null;
  globalThis.document?.body?.classList.remove('cockpit-look-dragging');
  syncLookControls.call(this);
  return true;
}

/** Turn the view by the given degrees. Returns false outside Cockpit. */
export function look(yawDeltaDeg, pitchDeltaDeg) {
  if (!this.active) return false;
  const target = this.lookTarget || { yawDeg: 0, pitchDeg: 0 };
  this.lookTarget = clampCockpitLook(
    target.yawDeg + (yawDeltaDeg || 0),
    target.pitchDeg + (pitchDeltaDeg || 0),
  );
  this.viewer.scene.requestRender?.();
  syncLookControls.call(this);
  return true;
}

/** Advance the eased look offset for one camera update. */
export function easeLook(dtSec) {
  const target = this.lookTarget || { yawDeg: 0, pitchDeg: 0 };
  const current = this.lookCurrent || target;
  this.lookCurrent = this.lookDrag
    ? target
    : easeCockpitLook(current, target, dtSec);
  return this.lookCurrent;
}

export function onLookPointerDown(event) {
  if (this.destroyed || !this.active || event.button !== 0) return;
  this.lookDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
  };
}

export function onLookPointerMove(event) {
  const drag = this.lookDrag;
  if (!drag || !this.active || event.pointerId !== drag.pointerId) return;
  if (!drag.dragging) {
    const travel = Math.hypot(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
    );
    if (travel < DRAG_THRESHOLD_PX) return;
    drag.dragging = true;
    document.body?.classList.add('cockpit-look-dragging');
  }
  const scale = DRAG_DEG_PER_PX / Math.max(0.5, this.zoom || 1);
  // Grab-the-scene: dragging right brings what is on the left into view.
  look.call(
    this,
    -(event.clientX - drag.lastX) * scale,
    (event.clientY - drag.lastY) * scale,
  );
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
}

export function onLookPointerUp(event) {
  if (this.lookDrag && event.pointerId === this.lookDrag.pointerId) {
    this.lookDrag = null;
    document.body?.classList.remove('cockpit-look-dragging');
  }
}

function syncLookControls() {
  const target = this.lookTarget || { yawDeg: 0, pitchDeg: 0 };
  const label = formatCockpitLook(target.yawDeg, target.pitchDeg);
  if (this.lookValue) this.lookValue.textContent = label;
  if (this.lookCenter) {
    this.lookCenter.setAttribute(
      'aria-label',
      `Cockpit view ${label === 'AHEAD' ? 'straight ahead' : label}. Activate to look straight ahead.`,
    );
    this.lookCenter.dataset.looking = String(label !== 'AHEAD');
  }
}
