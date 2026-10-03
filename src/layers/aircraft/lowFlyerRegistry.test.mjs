import test from 'node:test';
import assert from 'node:assert/strict';
import { createLowFlyerRegistry } from './lowFlyerRegistry.js';

test('the registry only claims aircraft while the layer is on', () => {
  const registry = createLowFlyerRegistry();
  const events = [];
  registry.onChange((active) => events.push(active));
  registry.replaceShown(['ABC123']);
  assert.equal(
    registry.shows('abc123'),
    false,
    'inactive layer claims nothing',
  );
  assert.deepEqual(events, []);
  registry.setActive(true);
  registry.replaceShown(['ABC123', 'def456']);
  assert.equal(registry.shows('abc123'), true);
  assert.equal(registry.shows('DEF456'), true);
  assert.deepEqual(events, [true, true]);
  registry.replaceShown(['def456']);
  assert.equal(
    registry.shows('abc123'),
    false,
    'a climbed-out aircraft is released',
  );
  registry.setActive(false);
  assert.equal(registry.shows('def456'), false);
  assert.deepEqual(events, [true, true, true, false]);
});

test('a broken listener never breaks the toggle', () => {
  const registry = createLowFlyerRegistry();
  registry.onChange(() => {
    throw new Error('boom');
  });
  assert.doesNotThrow(() => registry.setActive(true));
  assert.equal(registry.isActive(), true);
  registry.dispose();
  assert.equal(registry.isActive(), false);
});
