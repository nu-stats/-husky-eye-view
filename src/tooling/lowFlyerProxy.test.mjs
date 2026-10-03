import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adsbLolLowFlyerProxy,
  filterLowFlyers,
  lowFlyerReason,
  LOW_FLYER_MAX_ALT_FT,
} from '../../server/providers/aircraft/adsb-lol-low.js';

test('helicopters are kept at any height; others only below 3,000 ft', () => {
  assert.equal(LOW_FLYER_MAX_ALT_FT, 3000);
  assert.equal(lowFlyerReason({ t: 'EC35', alt_baro: 9000 }), 'helicopter');
  assert.equal(
    lowFlyerReason({ category: 'A7', alt_baro: 1200 }),
    'helicopter',
  );
  assert.equal(lowFlyerReason({ t: 'C172', alt_baro: 2500 }), 'low');
  assert.equal(lowFlyerReason({ t: 'B738', alt_baro: 3000 }), 'low');
  assert.equal(lowFlyerReason({ t: 'B738', alt_baro: 3001 }), null);
  assert.equal(lowFlyerReason({ t: 'EC35', alt_baro: 'ground' }), null);
  assert.equal(lowFlyerReason({ alt_baro: 'ground' }), null);
  // A known fixed-wing type wins over a mislabeled A7 category.
  assert.equal(
    lowFlyerReason({ t: 'B738', category: 'A7', alt_baro: 9000 }),
    null,
  );
});

test('the filtered payload keeps readsb shape and tags each row', () => {
  const out = filterLowFlyers({
    now: 1000,
    ac: [
      { hex: 'aaa111', t: 'B407', alt_baro: 800 },
      { hex: 'bbb222', t: 'A320', alt_baro: 35000 },
      { hex: 'ccc333', t: 'PA28', alt_baro: 1800 },
    ],
  });
  assert.equal(out.now, 1000);
  assert.deepEqual(
    out.ac.map((row) => [row.hex, row.hevLowReason]),
    [
      ['aaa111', 'helicopter'],
      ['ccc333', 'low'],
    ],
  );
});

function install(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/adsblol/low');
        handler = fn;
      },
    },
  });
  return (url) =>
    new Promise((resolve) => {
      const res = {
        status: 0,
        headers: {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ url }, res);
    });
}

test('the proxy requires a position, caches per anchor and serves stale on failure', async () => {
  const calls = [];
  let fail = false;
  const plugin = adsbLolLowFlyerProxy({
    fetchImpl: async (url) => {
      calls.push(url);
      if (fail) return { ok: false, status: 503, headers: new Map() };
      const body = JSON.stringify({
        now: 5,
        ac: [{ hex: 'abc123', t: 'EC45', alt_baro: 600 }],
      });
      return new Response(body, { status: 200 });
    },
  });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  const request = install(plugin);

  assert.equal((await request('/?lat=x')).status, 400);

  const first = await request('/?lat=42.36&lon=-71.06');
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-ADS-B-Cache'], 'MISS');
  assert.match(calls[0], /\/v2\/lat\/42\.25\/lon\/-71\/dist\/120$/);
  assert.equal(JSON.parse(first.body).ac[0].hevLowReason, 'helicopter');

  const second = await request('/?lat=42.37&lon=-71.05');
  assert.equal(second.headers['X-ADS-B-Cache'], 'HIT');
  assert.equal(calls.length, 1);

  // Past the cache window, an upstream failure serves the last good body.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    fail = true;
    const stale = await request('/?lat=42.36&lon=-71.06');
    assert.equal(stale.status, 200);
    assert.equal(stale.headers['X-ADS-B-Cache'], 'STALE');
    assert.equal(JSON.parse(stale.body).ac[0].hex, 'abc123');
    assert.equal(calls.length, 2);
    // A 5xx starts a cooldown: the next poll is served stale without
    // contacting upstream at all.
    const cooled = await request('/?lat=42.36&lon=-71.06');
    assert.equal(cooled.headers['X-ADS-B-Cache'], 'STALE');
    assert.equal(calls.length, 2);
  } finally {
    Date.now = realNow;
  }
});
