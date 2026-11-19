import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberAuthentication, shouldStartWithRegistration } from '../src/authPreference.ts';

test('fresh browsers register first, returning browsers log in, and blocked storage never breaks authentication', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  try {
    assert.equal(shouldStartWithRegistration(), true);
    values.set('light-frame.authenticated', 'invalid');
    assert.equal(shouldStartWithRegistration(), true);
    values.set('light-frame.authenticated', '1');
    assert.equal(shouldStartWithRegistration(), false);
    values.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    });
    assert.equal(shouldStartWithRegistration(), true);
    assert.doesNotThrow(rememberAuthentication);
    assert.equal(shouldStartWithRegistration(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
