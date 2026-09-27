/**
 * Display-panel "Labels" row: an on/off toggle plus a Size slider for the map
 * labels of the added local layers (pin cards and area names). The choice is
 * remembered in localStorage and applied through the `apply` callback.
 */

export const MAP_LABELS_STORAGE_KEY = 'hev.mapLabels';

function readSaved(storage) {
  try {
    const saved = JSON.parse(
      storage?.getItem(MAP_LABELS_STORAGE_KEY) || 'null',
    );
    return {
      visible: typeof saved?.visible === 'boolean' ? saved.visible : true,
      percent: Number.isFinite(saved?.percent) ? saved.percent : 100,
    };
  } catch {
    return { visible: true, percent: 100 };
  }
}

export class MapLabelControls {
  /**
   * @param {object} options
   * @param {import('./uiLifetime.js').UiLifetime} options.lifetime
   * @param {function({visible:boolean, scale:number}):void} options.apply
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
    this._toggle = root?.getElementById('map-labels-toggle');
    this._row = root?.getElementById('map-labels-slider-row');
    this._slider = root?.getElementById('map-labels-size-slider');
    this._value = root?.getElementById('map-labels-size-value');
    if (!this._toggle || !this._slider) return;

    const saved = readSaved(storage);
    this._visible = saved.visible;
    this._percent = this._clampPercent(saved.percent);
    this._render();
    this._commit({ persist: false });

    lifetime.listen(this._toggle, 'click', () => {
      this._visible = !this._visible;
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
    const min = Number(this._slider.min) || 40;
    const max = Number(this._slider.max) || 150;
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : 100));
  }

  _render() {
    this._toggle.classList.toggle('active', this._visible);
    this._toggle.setAttribute('aria-pressed', String(this._visible));
    this._row?.classList.toggle('visible', this._visible);
    this._slider.value = String(this._percent);
    if (this._value) this._value.textContent = `${this._percent}%`;
  }

  _commit({ persist = true } = {}) {
    this._apply({ visible: this._visible, scale: this._percent / 100 });
    if (!persist) return;
    try {
      this._storage?.setItem(
        MAP_LABELS_STORAGE_KEY,
        JSON.stringify({ visible: this._visible, percent: this._percent }),
      );
    } catch {
      /* storage may be unavailable (private mode); the setting still applies */
    }
  }
}
