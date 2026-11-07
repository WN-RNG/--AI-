import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireBodyScrollLock } from '../src/components/dialogScrollLock.ts';

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`nested dialogs retain the lock until both close, release order ${order.join('→')}`, () => {
    const body = { style: { overflow: 'auto' } };
    const release = [acquireBodyScrollLock(body), acquireBodyScrollLock(body)];
    assert.equal(body.style.overflow, 'hidden');
    release[order[0]]();
    assert.equal(body.style.overflow, 'hidden', 'remaining dialog must still block page scrolling');
    release[order[1]]();
    assert.equal(
      body.style.overflow,
      'auto',
      'last release must restore the original inline value',
    );
  });
}

test('a repeated release never unlocks another dialog or a later acquisition', () => {
  const body = { style: { overflow: '' } };
  const releaseViewer = acquireBodyScrollLock(body);
  const releaseAuth = acquireBodyScrollLock(body);
  releaseViewer();
  releaseViewer();
  assert.equal(body.style.overflow, 'hidden');
  releaseAuth();
  assert.equal(body.style.overflow, '');
  const releaseNewDialog = acquireBodyScrollLock(body);
  releaseAuth();
  releaseViewer();
  assert.equal(body.style.overflow, 'hidden');
  releaseNewDialog();
  releaseNewDialog();
  assert.equal(body.style.overflow, '');
});

test('StrictMode acquire-release-acquire restores the value from before mounting', () => {
  const body = { style: { overflow: 'scroll' } };
  const releaseProbe = acquireBodyScrollLock(body);
  releaseProbe();
  assert.equal(body.style.overflow, 'scroll');
  const releaseMounted = acquireBodyScrollLock(body);
  assert.equal(body.style.overflow, 'hidden');
  releaseProbe();
  assert.equal(body.style.overflow, 'hidden');
  releaseMounted();
  assert.equal(body.style.overflow, 'scroll');
});

test('independent bodies retain their own original overflow, including pre-existing hidden', () => {
  const first = { style: { overflow: 'hidden' } };
  const second = { style: { overflow: 'clip' } };
  const releaseFirst = acquireBodyScrollLock(first);
  const releaseSecond = acquireBodyScrollLock(second);
  releaseFirst();
  assert.equal(first.style.overflow, 'hidden');
  assert.equal(second.style.overflow, 'hidden');
  releaseSecond();
  assert.equal(second.style.overflow, 'clip');
});
