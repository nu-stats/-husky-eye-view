/**
 * The cockpit's LAYERS slider: how solid the map-data area fills (tract life
 * expectancy, air quality, parks…) look from the air. Shallow cockpit views
 * wash translucent colors out, so the cockpit applies its own, denser fill
 * opacity while it is active and hands each layer its own look back on exit.
 * The setting is remembered between visits.
 */

const STORAGE_KEY = 'hev.cockpitLayerOpacity';
export const COCKPIT_LAYER_OPACITY_DEFAULT = 70;
export const COCKPIT_LAYER_OPACITY_MIN = 20;
export const COCKPIT_LAYER_OPACITY_MAX = 95;
// Dragging recolors every drawn area; a short delay keeps that to a few
// passes per second.
const APPLY_DELAY_MS = 60;

/** Clamp a percent into the slider's range, defaulting when not a number. */
export function clampCockpitLayerOpacity(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return COCKPIT_LAYER_OPACITY_DEFAULT;
  return Math.min(
    COCKPIT_LAYER_OPACITY_MAX,
    Math.max(COCKPIT_LAYER_OPACITY_MIN, Math.round(value)),
  );
}

function readStored() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw === null || raw === undefined
      ? COCKPIT_LAYER_OPACITY_DEFAULT
      : clampCockpitLayerOpacity(raw);
  } catch {
    return COCKPIT_LAYER_OPACITY_DEFAULT;
  }
}

function store(percent) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(percent));
  } catch {
    // Storage blocked: the setting lasts for this page.
  }
}

function syncControls(percent) {
  if (this.layerOpacityInput) this.layerOpacityInput.value = String(percent);
  if (this.layerOpacityValue)
    this.layerOpacityValue.textContent = `${percent}%`;
}

function push(percent) {
  this.services?.setAreaFillAlpha?.(percent / 100);
}

/** On cockpit entry: apply the remembered opacity to every area layer. */
export function applyLayerOpacity() {
  const percent = this.layerOpacityPercent ?? readStored();
  this.layerOpacityPercent = percent;
  syncControls.call(this, percent);
  push.call(this, percent);
}

/** On cockpit exit: every area layer goes back to its own fill opacity. */
export function releaseLayerOpacity() {
  clearTimeout(this.layerOpacityTimer);
  this.layerOpacityTimer = null;
  this.services?.setAreaFillAlpha?.(null);
}

/** Slider moved: show the value now, recolor shortly, remember it. */
export function setLayerOpacity(percent, { immediate = false } = {}) {
  const value = clampCockpitLayerOpacity(percent);
  this.layerOpacityPercent = value;
  syncControls.call(this, value);
  store(value);
  if (!this.active) return value;
  clearTimeout(this.layerOpacityTimer);
  if (immediate) {
    this.layerOpacityTimer = null;
    push.call(this, value);
  } else {
    this.layerOpacityTimer = setTimeout(() => {
      this.layerOpacityTimer = null;
      if (this.active) push.call(this, this.layerOpacityPercent);
    }, APPLY_DELAY_MS);
  }
  return value;
}
