import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugLog, isDebugLogging, refreshDebugLogging } from './debugLog.js';

function withGlobals(t, { storage, search }) {
  const saved = {};
  for (const key of ['localStorage', 'location']) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  const define = (key, value) =>
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  define(
    'localStorage',
    storage === undefined
      ? undefined
      : { getItem: (key) => (key in storage ? storage[key] : null) },
  );
  define('location', search === undefined ? undefined : { search });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    refreshDebugLogging();
  });
}

test('debug logging is off by default with no localStorage or location', (t) => {
  withGlobals(t, {});
  assert.equal(refreshDebugLogging(), false);
  assert.equal(isDebugLogging(), false);
  const log = t.mock.method(console, 'log', () => {});
  debugLog('[Data:Flights] Updated: 3 aircraft');
  assert.equal(log.mock.callCount(), 0);
});

test('hev.debug=1 in localStorage turns debug logging on', (t) => {
  withGlobals(t, { storage: { 'hev.debug': '1' }, search: '' });
  assert.equal(refreshDebugLogging(), true);
  const log = t.mock.method(console, 'log', () => {});
  debugLog('[Data:Flights] Updated:', 3);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ['[Data:Flights] Updated:', 3]);
});

test('?debug in the URL turns debug logging on (and ?debug=0 does not)', (t) => {
  withGlobals(t, { storage: {}, search: '?welcome=0&debug' });
  assert.equal(refreshDebugLogging(), true);
  globalThis.location = { search: '?debug=0' };
  assert.equal(refreshDebugLogging(), false);
});

test('a throwing localStorage is treated as off', (t) => {
  withGlobals(t, { search: '' });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  assert.equal(refreshDebugLogging(), false);
});
