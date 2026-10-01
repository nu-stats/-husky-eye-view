/**
 * Switchable routine console logging for the browser build.
 *
 * Routine per-poll / per-update info lines ("Updated: N aircraft", "Fast
 * fetch major roads", layer "Initialized") are noise in normal use, so they go
 * through `debugLog` and only print when debugging is on:
 *
 *   localStorage.setItem('hev.debug', '1')   // persistent, per browser
 *   ?debug                                   // one page load (?debug=0 is off)
 *
 * Warnings and errors never go through here — keep using console.warn/error.
 * Dependency-free and DOM-optional: under node:test there is no localStorage
 * or location, and every access is guarded.
 */

let _enabled;

function readDebugFlag() {
  try {
    if (globalThis.localStorage?.getItem?.('hev.debug') === '1') return true;
  } catch {
    // Storage blocked (private mode, sandboxed frame, Node without a file).
  }
  try {
    const search = globalThis.location?.search;
    if (typeof search === 'string' && search) {
      const params = new URLSearchParams(search);
      if (params.has('debug')) {
        const value = params.get('debug').toLowerCase();
        return value !== '0' && value !== 'false' && value !== 'off';
      }
    }
  } catch {
    // Malformed or inaccessible location.
  }
  return false;
}

/** True when routine debug logging is on. The decision is cached. */
export function isDebugLogging() {
  if (_enabled === undefined) _enabled = readDebugFlag();
  return _enabled;
}

/** Re-read localStorage / the URL (after toggling `hev.debug`) and return the result. */
export function refreshDebugLogging() {
  _enabled = readDebugFlag();
  return _enabled;
}

/** console.log, but only when debug logging is on. */
export function debugLog(...args) {
  if (isDebugLogging()) console.log(...args);
}

/** console.info, but only when debug logging is on. */
export function debugInfo(...args) {
  if (isDebugLogging()) console.info(...args);
}
