/**
 * Which aircraft the Helicopters & Low Flyers layer is drawing right now.
 *
 * A helicopter or low flyer is usually in the OpenSky feed too. While the
 * low-flyer layer is enabled it owns those aircraft (icon, trail, click,
 * cockpit), so the flights layer asks `shows(icao24)` and drops its duplicate.
 * Unlike the military registry this set is replaced on every poll: an
 * aircraft that climbs above 3,000 ft goes back to the flights layer.
 */
export function createLowFlyerRegistry() {
  let active = false;
  let shown = new Set();
  const listeners = new Set();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(active);
      } catch {
        // a broken listener must never break the layer toggle
      }
    }
  };

  return {
    /** Mark the low-flyer layer enabled or disabled; listeners fire on change. */
    setActive(next) {
      const value = Boolean(next);
      if (value === active) return;
      active = value;
      if (!active) shown = new Set();
      emit();
    },
    isActive: () => active,
    /** Replace the drawn set after a poll; listeners fire while active. */
    replaceShown(ids) {
      shown = new Set();
      for (const id of ids || []) {
        const hex = String(id || '')
          .trim()
          .toLowerCase();
        if (hex) shown.add(hex);
      }
      if (active) emit();
    },
    /** True when the low-flyer layer currently draws this aircraft. */
    shows(icao24) {
      return active && shown.has(String(icao24 || '').toLowerCase());
    },
    /** Subscribe to activation changes and shown-set refreshes. */
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      shown = new Set();
      active = false;
    },
  };
}
