import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * Serve the chunked area-layer files (public/context/**.geojsonl and their
 * index.json) compressed. Vite's dev server sends static files as-is, and
 * these GeoJSON Lines chunks are large plain text that shrinks ~6x (a Los
 * Angeles life-expectancy chunk: 1.98 MB -> ~0.34 MB). Compressed bodies are
 * cached in memory by file, modification time and encoding.
 * @param {{cacheBytes?: number}} [options]
 * @returns {import('vite').Plugin}
 */
export function contextCompressionPlugin({
  cacheBytes = 96 * 1024 * 1024,
} = {}) {
  let publicRoot = path.resolve('public');
  const middleware = createContextCompressionMiddleware({
    publicRoot: () => publicRoot,
    cacheBytes,
  });
  return {
    name: 'hev-context-compression',
    configResolved(config) {
      if (config.publicDir) publicRoot = config.publicDir;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/** Pick the best encoding the client accepts, or null. */
export function pickEncoding(acceptEncoding) {
  const accept = String(acceptEncoding || '').toLowerCase();
  if (/(^|[\s,])br($|[\s,;])/.test(accept)) return 'br';
  if (/(^|[\s,])gzip($|[\s,;])/.test(accept)) return 'gzip';
  return null;
}

/**
 * Connect-style middleware; exported for tests.
 * @param {{publicRoot: () => string, cacheBytes?: number}} options
 */
export function createContextCompressionMiddleware({
  publicRoot,
  cacheBytes = 96 * 1024 * 1024,
}) {
  const cache = new Map();
  let cachedBytes = 0;

  const remember = (key, body) => {
    cache.set(key, body);
    cachedBytes += body.length;
    for (const [oldKey, oldBody] of cache) {
      if (cachedBytes <= cacheBytes) break;
      cache.delete(oldKey);
      cachedBytes -= oldBody.length;
    }
  };

  return async function contextCompression(req, res, next) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const pathname = decodeURIComponent(
        new URL(req.url || '/', 'http://localhost').pathname,
      );
      const at = pathname.indexOf('/context/');
      if (at < 0 || !/\.(geojsonl|json)$/.test(pathname)) return next();
      const encoding = pickEncoding(req.headers?.['accept-encoding']);
      if (!encoding) return next();
      const root = publicRoot();
      const file = path.resolve(root, pathname.slice(at + 1));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return next();
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) return next();

      const key = `${file}|${stat.mtimeMs}|${encoding}`;
      let body = cache.get(key);
      if (body) {
        // Refresh recency.
        cache.delete(key);
        cache.set(key, body);
      } else {
        const raw = await fsp.readFile(file);
        body =
          encoding === 'br'
            ? await brotli(raw, {
                params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
              })
            : await gzip(raw, { level: 6 });
        remember(key, body);
      }
      res.statusCode = 200;
      res.setHeader(
        'Content-Type',
        pathname.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'application/x-ndjson; charset=utf-8',
      );
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', String(body.length));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      next(error);
    }
  };
}
