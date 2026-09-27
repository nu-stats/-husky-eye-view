/**
 * Display-panel "Speed" row: trades sharpness for frame rate on large screens
 * or modest graphics cards. On, it turns off the 4x anti-aliasing and renders
 * the map at the Resolution slider's share of the screen's pixels (the image
 * is scaled up to fill the window). The choice is remembered in localStorage
 * and applied through the `apply` callback.
 */

export const RENDER_SPEED_STORAGE_KEY = 'hev.renderSpeed';
const DEFAULT_PERCENT = 75;

function readSaved(storage) {
  try {
    const saved = JSON.parse(
      storage?.getItem(RENDER_SPEED_STORAGE_KEY) || 'null',
    );
    return {
      fast: saved?.fast === true,
      percent: Number.isFinite(saved?.percent)
        ? saved.percent
        : DEFAULT_PERCENT,
    };
  } catch {
    return { fast: false, percent: DEFAULT_PERCENT };
  }
}

/**
 * Apply a speed setting to a Cesium viewer.
 * @param {object} viewer
 * @param {{fast:boolean, scale:number}} setting
 */
export function applyRenderSpeed(viewer, { fast, scale }) {
  if (!viewer?.scene) return;
  viewer.resolutionScale = fast ? scale : 1;
  viewer.scene.msaaSamples = fast ? 1 : 4;
  viewer.scene.requestRender?.();
}

export class RenderSpeedControls {
  /**
   * @param {object} options
   * @param {import('./uiLifetime.js').UiLifetime} options.lifetime
   * @param {function({fast:boolean, scale:number}):void} options.apply
   * @param {Document} [options.root]
   * @param {Storage} [options.storage]
   */
  constructor({
    lifetime,
    apply,
    root = globalThis.document,
    storage = globalThis.localStorage,
  }) {
    this._apply = apply;
    this._storage = storage;
    this._toggle = root?.getElementById('render-speed-toggle');
    this._row = root?.getElementById('render-speed-row');
    this._slider = root?.getElementById('render-speed-slider');
    this._value = root?.getElementById('render-speed-value');
    if (!this._toggle || !this._slider) return;

    const saved = readSaved(storage);
    this._fast = saved.fast;
    this._percent = this._clampPercent(saved.percent);
    this._render();
    this._commit({ persist: false });

    lifetime.listen(this._toggle, 'click', () => {
      this._fast = !this._fast;
      this._render();
      this._commit();
    });
    lifetime.listen(this._slider, 'input', () => {
      this._percent = this._clampPercent(this._slider.value);
      this._render();
      this._commit();
    });
  }

  _clampPercent(value) {
    const min = Number(this._slider.min) || 50;
    const max = Number(this._slider.max) || 100;
    const number = Number(value);
    return Math.min(
      max,
      Math.max(min, Number.isFinite(number) ? number : DEFAULT_PERCENT),
    );
  }

  _render() {
    this._toggle.classList.toggle('active', this._fast);
    this._toggle.setAttribute('aria-pressed', String(this._fast));
    this._row?.classList.toggle('visible', this._fast);
    this._slider.value = String(this._percent);
    if (this._value) this._value.textContent = `${this._percent}%`;
  }

  _commit({ persist = true } = {}) {
    this._apply({ fast: this._fast, scale: this._percent / 100 });
    if (!persist) return;
    try {
      this._storage?.setItem(
        RENDER_SPEED_STORAGE_KEY,
        JSON.stringify({ fast: this._fast, percent: this._percent }),
      );
    } catch {
      /* storage may be unavailable (private mode); the setting still applies */
    }
  }
}
