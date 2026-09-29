import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESEARCH_DATASETS,
  decryptResearchBuffer,
  encryptResearchText,
  researchDataProxy,
} from '../server/providers/research.js';
import { KEY_SETUP_KEYS } from './keySetupCore.mjs';

const TEXT =
  '{"type":"Feature","properties":{"name":"A"}}\n{"type":"Feature"}\n';

test('a locked dataset opens only with the key it was locked with', () => {
  const locked = encryptResearchText(TEXT, 'right-key');
  assert.ok(
    !locked.includes(Buffer.from('Feature')),
    'no plaintext in the file',
  );
  assert.equal(decryptResearchBuffer(locked, 'right-key'), TEXT);
  assert.equal(decryptResearchBuffer(locked, 'wrong-key'), null);
  assert.equal(decryptResearchBuffer(locked, ''), null);
  assert.equal(
    decryptResearchBuffer(Buffer.from('not locked'), 'right-key'),
    null,
  );
});

/** Drive the middleware with a fake request and collect the response. */
function request(plugin, url) {
  let handler = null;
  plugin.configureServer({
    middlewares: { use: (prefix, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: String(body),
        });
      },
    };
    handler({ url }, res);
  });
}

test('the research route serves data only to the right key', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hev-research-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, RESEARCH_DATASETS.mkdb),
    encryptResearchText(TEXT, 'k1'),
  );
  let key = '';
  const plugin = researchDataProxy({ dataDir: dir, readKey: () => key });

  let res = await request(plugin, '/status');
  assert.deepEqual(JSON.parse(res.body), {
    configured: false,
    datasets: { 'gva-2015': 'locked', mkdb: 'locked' },
  });
  res = await request(plugin, '/mkdb');
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).error, 'no_key');

  key = 'nope';
  res = await request(plugin, '/mkdb');
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error, 'bad_key');

  key = 'k1';
  res = await request(plugin, '/mkdb');
  assert.equal(res.status, 200);
  assert.equal(res.body, TEXT);
  assert.match(res.headers['Content-Type'], /ndjson/);
  res = await request(plugin, '/status');
  assert.deepEqual(JSON.parse(res.body).datasets, {
    'gva-2015': 'locked',
    mkdb: 'unlocked',
  });

  res = await request(plugin, '/gva-2015');
  assert.equal(res.status, 404, 'a dataset whose file is absent');
  res = await request(plugin, '/../../pinokio/ENVIRONMENT');
  assert.equal(res.status, 404, 'only the named datasets are reachable');
});

test('the shipped repository carries both datasets encrypted, never in plaintext', () => {
  for (const file of Object.values(RESEARCH_DATASETS)) {
    assert.ok(
      existsSync(new URL(`../data/research/${file}`, import.meta.url)),
      file,
    );
  }
  for (const old of [
    'gva_2015/incidents.geojsonl',
    'mkdb/incidents.geojsonl',
  ]) {
    assert.equal(
      existsSync(new URL(`./data/local_data/${old}`, import.meta.url)),
      false,
      `${old} must not be bundled in plaintext`,
    );
  }
});

test('POWER UP offers the research key, issued by the owner (no sign-up link)', () => {
  const entry = KEY_SETUP_KEYS.find((key) => key.id === 'research-data');
  assert.ok(entry);
  assert.deepEqual([...entry.envVars], ['HEV_RESEARCH_DATA_KEY']);
  assert.equal(entry.getUrl, '');
});
