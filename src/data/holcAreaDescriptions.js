/**
 * Links from a HOLC redlining area to its 1930s area description on Mapping
 * Inequality (University of Richmond): the transcription plus the scanned
 * original form, which is in the public domain.
 *
 * The lookup (area id → "<ST>/<CitySlug>/<label>") is built by
 * scripts/build-holc-area-descriptions.mjs into
 * public/context/holc/area-descriptions.json and fetched once, on the first
 * HOLC card. Map features carry the area id in their feature id
 * (holc-mi-<area_id>).
 */

export const HOLC_LAYER_ID = 'local-holc-redlining';
export const MAPPING_INEQUALITY_MAP_URL =
  'https://dsl.richmond.edu/panorama/redlining/map/';

/** Mapping Inequality city slugs drop spaces and punctuation ("St. Paul" → "StPaul"). */
export function holcCitySlug(city) {
  return String(city || '').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * The HOLC area id inside a map feature or context id, or null. Accepts the
 * area ids of the full Mapping Inequality build (holc-mi-<area_id>) and of the
 * older tract-split build (holc-<city_id>-<area_id>-<geoid>).
 */
export function holcAreaIdFrom(id) {
  const match = /holc-(?:mi|\d+)-(\d+)(?:[-_]|$)/.exec(String(id || ''));
  return match ? match[1] : null;
}

/** Page URL for an index entry "<ST>/<CitySlug>/<label>", or null if malformed. */
export function holcAreaDescriptionUrl(path) {
  if (!/^[A-Z]{2}\/[A-Za-z0-9]+\/[A-Za-z0-9-]+$/.test(String(path || '')))
    return null;
  const [state, slug, label] = path.split('/');
  return `${MAPPING_INEQUALITY_MAP_URL}${state}/${slug}/area_descriptions/${label}`;
}

/**
 * Lazily loaded lookup. A failed fetch is not cached, so a later card retries.
 * @returns {{urlFor: (id: string) => Promise<string|null>}}
 */
export function createHolcAreaDescriptionIndex({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = `${import.meta.env?.BASE_URL || '/'}context/holc/area-descriptions.json`,
} = {}) {
  let loading = null;
  const load = () => {
    loading ||= Promise.resolve()
      .then(() => fetchImpl(url))
      .then((response) => {
        if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
        return response.json();
      })
      .catch(() => {
        loading = null;
        return {};
      });
    return loading;
  };
  return {
    async urlFor(id) {
      const areaId = holcAreaIdFrom(id);
      if (!areaId) return null;
      const index = await load();
      return holcAreaDescriptionUrl(index?.[areaId]);
    },
  };
}
