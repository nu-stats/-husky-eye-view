/**
 * Vite plugin: helicopters and low flyers around the view, from adsb.lol.
 *
 * GET /api/adsblol/low?lat=&lon= asks adsb.lol for every aircraft within
 * LOW_FLYER_RADIUS_NM of the (coarsened) view anchor and keeps:
 *   - helicopters at any height (helicopter ICAO type code, or emitter
 *     category A7 when the type is unknown), and
 *   - any other airborne aircraft below LOW_FLYER_MAX_ALT_FT.
 * Rows on the ground are dropped. The response keeps adsb.lol's readsb shape
 * ({ now, ac: [...] }) so the browser reuses readsbSnapshot unchanged; each
 * kept row gains `hevLowReason: 'helicopter' | 'low'`.
 *
 * Cache and failure behavior match the military proxy: a short per-anchor
 * cache, concurrent requests coalesced, and the last good body served STALE
 * when upstream fails.
 */
import { classifyAircraft } from '../../../src/data/aircraftClass.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
} from '../common/http.js';
import { adsbLolFallbackAnchor } from './opensky.js';

export const LOW_FLYER_RADIUS_NM = 120;
export const LOW_FLYER_MAX_ALT_FT = 3000;
const CACHE_MS = 12_000;
const CACHE_MAX = 60;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Why a readsb row belongs in the layer, or null when it does not. */
export function lowFlyerReason(row) {
  if (!row || row.alt_baro === 'ground') return null;
  const typeCode = String(row.t || '').trim();
  const helicopter = typeCode
    ? classifyAircraft({ typeCode }) === 'helicopter'
    : String(row.category || '').toUpperCase() === 'A7';
  if (helicopter) return 'helicopter';
  const altFt = Number(row.alt_baro);
  if (Number.isFinite(altFt) && altFt <= LOW_FLYER_MAX_ALT_FT) return 'low';
  return null;
}

/** Keep only helicopters and low flyers from an adsb.lol point response. */
export function filterLowFlyers(payload) {
  const rows = Array.isArray(payload?.ac) ? payload.ac : [];
  const ac = [];
  for (const row of rows) {
    const reason = lowFlyerReason(row);
    if (reason) ac.push({ ...row, hevLowReason: reason });
  }
  return { now: payload?.now ?? Date.now(), ac };
}

/** Cooldown after a 429/5xx when upstream sends no usable Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const SERVER_ERROR_COOLDOWN_MS = 15_000;
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 120_000;

/** Cooldown an upstream failure earns, honoring a sane Retry-After. */
function cooldownFor(upstream, now) {
  const clamp = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
  const raw = upstream.headers?.get?.('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return clamp(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at) && at > now) return clamp(at - now);
  }
  return upstream.status === 429
    ? RATE_LIMIT_COOLDOWN_MS
    : SERVER_ERROR_COOLDOWN_MS;
}

export function adsbLolLowFlyerProxy({ fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  // adsb.lol rate-limits per address, not per anchor: one cooldown for all.
  let cooldownUntil = 0;

  function serve(res, status, body, cacheStatus, cachedAt = 0) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-ADS-B-Cache': cacheStatus,
      ...(cachedAt
        ? { 'X-ADS-B-Cache-Age-Ms': String(Math.max(0, Date.now() - cachedAt)) }
        : {}),
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsblol/low', async (req, res) => {
      const anchor = adsbLolFallbackAnchor(req);
      if (!anchor) {
        serve(
          res,
          400,
          JSON.stringify({ error: 'lat and lon are required' }),
          'NONE',
        );
        return;
      }
      const lat = Math.round(anchor.latitude * 4) / 4;
      const lon = Math.round(anchor.longitude * 4) / 4;
      const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      const cached = cache.get(key);
      if (cached && Date.now() - cached.cachedAt < CACHE_MS) {
        serve(res, 200, cached.body, 'HIT', cached.cachedAt);
        return;
      }
      if (Date.now() < cooldownUntil) {
        if (cached) serve(res, 200, cached.body, 'STALE', cached.cachedAt);
        else
          serve(
            res,
            503,
            JSON.stringify({ error: 'adsb.lol upstream cooling down' }),
            'NONE',
          );
        return;
      }
      const request = coalesceProxyRequest(inFlight, key, async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const upstream = await fetchImpl(
            `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${LOW_FLYER_RADIUS_NM}`,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': 'gods-eye-view-adsblol-low-flyers/1.0',
              },
              signal: controller.signal,
            },
          );
          if (!upstream.ok) {
            if (upstream.status === 429 || upstream.status >= 500) {
              const failedAt = Date.now();
              cooldownUntil = failedAt + cooldownFor(upstream, failedAt);
            }
            upstream.body?.cancel?.().catch(() => {});
            throw new Error(`upstream HTTP ${upstream.status}`);
          }
          const payload = await readResponseJsonCapped(
            upstream,
            MAX_RESPONSE_BYTES,
          );
          const record = {
            body: JSON.stringify(filterLowFlyers(payload)),
            cachedAt: Date.now(),
          };
          cache.delete(key);
          cache.set(key, record);
          while (cache.size > CACHE_MAX)
            cache.delete(cache.keys().next().value);
          return record;
        } finally {
          clearTimeout(timeoutId);
        }
      });
      try {
        const record = await request.promise;
        serve(res, 200, record.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        if (!request.shared && error?.name !== 'AbortError')
          console.warn('[adsb.lol Low Flyers]', error?.message || error);
        if (cached) serve(res, 200, cached.body, 'STALE', cached.cachedAt);
        else
          serve(
            res,
            502,
            JSON.stringify({ error: 'adsb.lol low-flyer proxy error' }),
            'NONE',
          );
      }
    });
  };
  return {
    name: 'adsblol-low-flyers-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
