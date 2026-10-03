import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHolcAreaDescriptionIndex,
  holcAreaDescriptionUrl,
  holcAreaIdFrom,
  holcCitySlug,
} from './holcAreaDescriptions.js';

test('city slugs match Mapping Inequality page addresses', () => {
  assert.equal(holcCitySlug('Boston'), 'Boston');
  assert.equal(holcCitySlug('Little Rock'), 'LittleRock');
  assert.equal(holcCitySlug('St. Petersburg'), 'StPetersburg');
  assert.equal(holcCitySlug('Winston-Salem'), 'WinstonSalem');
  assert.equal(
    holcCitySlug('Stamford, Darien, and New Canaan'),
    'StamfordDarienandNewCanaan',
  );
});

test('area ids come from map feature and context ids', () => {
  assert.equal(holcAreaIdFrom('holc-10-230-01073003900'), '230');
  assert.equal(
    holcAreaIdFrom('local-holc-redlining:holc-10-230-01073003900_2'),
    '230',
  );
  assert.equal(holcAreaIdFrom('holc-mi-7897'), '7897');
  assert.equal(holcAreaIdFrom('local-holc-redlining:holc-mi-7897_2'), '7897');
  assert.equal(holcAreaIdFrom('local-life-expectancy:25025070700'), null);
});

test('only well-formed index entries become links', () => {
  assert.equal(
    holcAreaDescriptionUrl('MA/Boston/D7'),
    'https://dsl.richmond.edu/panorama/redlining/map/MA/Boston/area_descriptions/D7',
  );
  assert.equal(holcAreaDescriptionUrl('MA/Boston/../evil'), null);
  assert.equal(holcAreaDescriptionUrl('javascript:alert(1)'), null);
  assert.equal(holcAreaDescriptionUrl(undefined), null);
});

test('the index loads once and retries after a failure', async () => {
  let calls = 0;
  let fail = true;
  const index = createHolcAreaDescriptionIndex({
    url: '/context/holc/area-descriptions.json',
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, '/context/holc/area-descriptions.json');
      if (fail) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ 230: 'AL/Birmingham/C2' }) };
    },
  });
  assert.equal(await index.urlFor('holc-10-230-01073003900'), null);
  fail = false;
  assert.equal(
    await index.urlFor('holc-10-230-01073003900'),
    'https://dsl.richmond.edu/panorama/redlining/map/AL/Birmingham/area_descriptions/C2',
  );
  assert.equal(await index.urlFor('holc-10-999-01073003900'), null);
  assert.equal(calls, 2);
  assert.equal(await index.urlFor('not-holc'), null);
  assert.equal(calls, 2);
});
