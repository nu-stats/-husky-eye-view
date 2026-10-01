/**
 * The research profile: Husky Eye View's default view of the layer list.
 *
 * It hides features inherited from God's Eye View that the US research focus
 * does not use. Nothing is removed — "Show all layers" at the bottom of Data
 * Layers brings them back, voice can still reach them by name, and a hidden
 * layer that is switched on (say, from a shared link) always stays listed.
 */

/** Layers the research profile keeps out of the Data Layers list. */
export const RESEARCH_HIDDEN_LAYERS = Object.freeze(
  new Set([
    'satellites',
    'rocket-launches',
    'military',
    'military-installations',
    'telegeography-submarine-cables',
    // Mostly outside the US (62% of data centers, 88% of dams).
    'local-datacenters',
    'local-dams',
  ]),
);

const SHOW_ALL_KEY = 'hev.showAllLayers';
export const LAYER_PROFILE_EVENT = 'hev:layer-profile-changed';

// The choice made in this page, which wins when storage is unavailable.
let pageChoice = null;

/** Whether the user chose to see every layer (the full God's Eye View list). */
export function readShowAllLayers() {
  if (pageChoice !== null) return pageChoice;
  try {
    return globalThis.localStorage?.getItem(SHOW_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

/** Mark <body> with the active profile; CSS hides profile-only extras. */
export function applyLayerProfileClass(documentRef = globalThis.document) {
  documentRef?.body?.classList?.toggle(
    'profile-research',
    !readShowAllLayers(),
  );
}

/** Remember the choice, update <body>, and tell listeners. */
export function writeShowAllLayers(showAll, documentRef = globalThis.document) {
  pageChoice = Boolean(showAll);
  try {
    if (showAll) globalThis.localStorage?.setItem(SHOW_ALL_KEY, '1');
    else globalThis.localStorage?.removeItem(SHOW_ALL_KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  documentRef?.body?.classList?.toggle('profile-research', !showAll);
  try {
    globalThis.dispatchEvent?.(new Event(LAYER_PROFILE_EVENT));
  } catch {
    // No event support in this environment.
  }
}

/** Whether a layer's row belongs in the list under the current profile. */
export function layerListedInProfile(layer, showAll = readShowAllLayers()) {
  return (
    showAll || Boolean(layer?.enabled) || !RESEARCH_HIDDEN_LAYERS.has(layer?.id)
  );
}
