/**
 * Switchable routine console logging for the Node providers.
 *
 * Routine per-refresh lines ("[CCTV] Loaded ... camera sources", token
 * refreshes) only print when the server runs with HEV_DEBUG=1. Warnings and
 * errors never go through here — keep using console.warn/error.
 */

/** True when HEV_DEBUG is set to 1/true. Read on every call so it can change at runtime. */
export function isServerDebugLogging(env = globalThis.process?.env) {
  const value = String(env?.HEV_DEBUG ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true';
}

/** console.log, but only when HEV_DEBUG=1. */
export function debugLog(...args) {
  if (isServerDebugLogging()) console.log(...args);
}

/** console.info, but only when HEV_DEBUG=1. */
export function debugInfo(...args) {
  if (isServerDebugLogging()) console.info(...args);
}
