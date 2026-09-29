import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken }).catch(
    (error) => {
      throw ionAccessError(error);
    },
  );
}

/**
 * Name the fix when Cesium ion refuses the token (revoked, deleted or
 * mistyped), instead of surfacing a bare "Request has failed" status.
 * @param {unknown} error Failure from an ion request.
 * @returns {unknown} A readable Error for 401/403, otherwise the original.
 */
export function ionAccessError(error) {
  const status = Number(error?.statusCode);
  if (status !== 401 && status !== 403) return error;
  return new Error(
    `Cesium ion rejected the token (HTTP ${status}). ${ION_TOKEN_FIX}`,
  );
}

/** What to do when ion refuses the token. */
export const ION_TOKEN_FIX =
  'Fix: make a new token at ion.cesium.com/tokens and paste it into POWER UP → CESIUM ION.';
