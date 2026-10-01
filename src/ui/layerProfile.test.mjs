import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_HIDDEN_LAYERS,
  layerListedInProfile,
  readShowAllLayers,
  writeShowAllLayers,
} from './layerProfile.js';

test('the research profile hides inherited extras but never a layer that is on', () => {
  assert.equal(RESEARCH_HIDDEN_LAYERS.has('satellites'), true);
  assert.equal(RESEARCH_HIDDEN_LAYERS.has('local-life-expectancy'), false);
  assert.equal(
    layerListedInProfile({ id: 'satellites', enabled: false }, false),
    false,
  );
  assert.equal(
    layerListedInProfile({ id: 'satellites', enabled: true }, false),
    true,
    'a hidden layer switched on (e.g. from a shared link) stays listed',
  );
  assert.equal(
    layerListedInProfile({ id: 'satellites', enabled: false }, true),
    true,
  );
  assert.equal(
    layerListedInProfile({ id: 'local-air-pm25', enabled: false }, false),
    true,
  );
});

test('"Show all layers" is remembered for the page even without storage', () => {
  const body = { classList: new Set() };
  body.classList.toggle = (name, on) =>
    on ? body.classList.add(name) : body.classList.delete(name);
  assert.equal(readShowAllLayers(), false);
  writeShowAllLayers(true, { body });
  assert.equal(readShowAllLayers(), true);
  assert.equal(body.classList.has('profile-research'), false);
  writeShowAllLayers(false, { body });
  assert.equal(readShowAllLayers(), false);
  assert.equal(body.classList.has('profile-research'), true);
});
