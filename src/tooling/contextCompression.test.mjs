import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  createContextCompressionMiddleware,
  pickEncoding,
} from '../../build/context-compression.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hev-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'context', 'tracts'), { recursive: true });
  const body = `${'{"type":"Feature","properties":{"pm25":7.1}}\n'.repeat(400)}`;
  writeFileSync(path.join(root, 'context', 'tracts', '25025.geojsonl'), body);
  writeFileSync(path.join(root, 'secret.txt'), 'nope');
  return { root, body };
}

async function call(middleware, url, headers = {}) {
  const res = {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  let nexted = false;
  await middleware({ method: 'GET', url, headers }, res, () => {
    nexted = true;
  });
  return { res, nexted };
}

test('area-layer chunks are served compressed when the browser accepts it', async (t) => {
  const { root, body } = fixture(t);
  const middleware = createContextCompressionMiddleware({ publicRoot: () => root });
  const br = await call(middleware, '/context/tracts/25025.geojsonl', {
    'accept-encoding': 'gzip, deflate, br',
  });
  assert.equal(br.nexted, false);
  assert.equal(br.res.headers['content-encoding'], 'br');
  assert.equal(br.res.headers.vary, 'Accept-Encoding');
  assert.equal(zlib.brotliDecompressSync(br.res.body).toString(), body);
  assert.ok(br.res.body.length < body.length / 5, 'repetitive text shrinks a lot');

  const gz = await call(middleware, '/context/tracts/25025.geojsonl', {
    'accept-encoding': 'gzip',
  });
  assert.equal(gz.res.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.res.body).toString(), body);
});

test('everything else falls through to Vite untouched', async (t) => {
  const { root } = fixture(t);
  const middleware = createContextCompressionMiddleware({ publicRoot: () => root });
  for (const [url, headers] of [
    ['/context/tracts/25025.geojsonl', {}],
    ['/src/main.js', { 'accept-encoding': 'br' }],
    ['/context/tracts/missing.geojsonl', { 'accept-encoding': 'br' }],
    ['/context/../secret.txt', { 'accept-encoding': 'br' }],
  ]) {
    assert.equal((await call(middleware, url, headers)).nexted, true, url);
  }
  assert.equal(pickEncoding('gzip;q=1.0, br;q=0.9'), 'br');
  assert.equal(pickEncoding('identity'), null);
});
