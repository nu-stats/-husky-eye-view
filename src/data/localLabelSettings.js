// App-wide label settings for local layers. One Display-panel control
// shows/hides and resizes every local layer's map labels (pin cards and area
// names); layers subscribe and re-publish on change. Kept free of Cesium so
// the UI shell can drive it without bundling the map layers.

export const LOCAL_LABEL_SCALE_MIN = 0.4;
export const LOCAL_LABEL_SCALE_MAX = 1.5;
let _settings = Object.freeze({ visible: true, scale: 1 });
const _listeners = new Set();

/** @returns {{visible:boolean, scale:number}} Current local label settings. */
export function getLocalLabelSettings() {
  return _settings;
}

/**
 * Show/hide and resize the map labels of every local layer.
 * @param {{visible?:boolean, scale?:number}} settings Scale is clamped to
 *   [LOCAL_LABEL_SCALE_MIN, LOCAL_LABEL_SCALE_MAX].
 * @returns {{visible:boolean, scale:number}} The applied settings.
 */
export function setLocalLabelSettings({ visible, scale } = {}) {
  const current = _settings;
  const nextScale = Number.isFinite(Number(scale))
    ? Math.min(
        LOCAL_LABEL_SCALE_MAX,
        Math.max(LOCAL_LABEL_SCALE_MIN, Number(scale)),
      )
    : current.scale;
  const next = Object.freeze({
    visible: typeof visible === 'boolean' ? visible : current.visible,
    scale: nextScale,
  });
  if (next.visible === current.visible && next.scale === current.scale)
    return current;
  _settings = next;
  for (const listener of [..._listeners]) {
    try {
      listener(next);
    } catch (error) {
      console.warn('[local labels] listener failed:', error);
    }
  }
  return next;
}

/**
 * Follow label setting changes.
 * @param {function({visible:boolean, scale:number}):void} listener
 * @returns {function():void} Unsubscribe.
 */
export function onLocalLabelSettings(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}
