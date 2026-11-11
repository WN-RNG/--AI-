import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coverFrame,
  initialCoverState,
  parseCoverManifest,
  reduceCoverState,
} from '../src/homeCover.ts';

function manifest(slides) {
  return { version: 1, slides };
}
function slide(id, changes = {}) {
  return {
    id,
    title: id,
    subtitle: '',
    url: `/covers/${id}.webp`,
    author: 'Author',
    source: '',
    credit: 'Authorized cover',
    displayOnly: true,
    ...changes,
  };
}
function ready(state, id) {
  const image = state.slides.find((candidate) => candidate.id === id);
  return reduceCoverState(state, { type: 'ready', id, url: image.url });
}
function fail(state, id) {
  const image = state.slides.find((candidate) => candidate.id === id);
  return reduceCoverState(state, { type: 'failed', id, url: image.url });
}

test('a downloaded manifest keeps loaded bundled covers ready so autoplay can reach new photographs', () => {
  const fallback = parseCoverManifest(manifest([slide('B'), slide('A'), slide('C')]));
  const loaded = ready(ready(initialCoverState(fallback), 'B'), 'A');
  const imported = parseCoverManifest(manifest([...fallback, slide('500px-new')]));
  const merged = reduceCoverState(loaded, { type: 'replace', slides: imported });
  assert.equal(reduceCoverState(merged, { type: 'advance' }).activeId, 'A');
  const changed = reduceCoverState(loaded, {
    type: 'replace',
    slides: parseCoverManifest(manifest([slide('B'), slide('A', { url: '/covers/new-A.webp' })])),
  });
  assert.equal(reduceCoverState(changed, { type: 'advance' }), changed);
});

test('manifest accepts only display-only local covers and safe attribution, with bounded focal points', () => {
  const valid = slide('valid', {
    source: 'https://photographer.example/work',
    focalPoint: { x: -40, y: 700 },
  });
  const result = parseCoverManifest(
    manifest([
      valid,
      valid,
      slide('private', { url: '/api/photos/private/file' }),
      slide('traversal', { url: '/covers/../secret.jpg' }),
      slide('external', { url: 'https://images.example/a.jpg' }),
      slide('script', { source: 'javascript:alert(1)' }),
      slide('secret', { source: 'https://user:password@example.com/image' }),
      slide('missing-author', { author: undefined }),
      slide('missing-source', { source: undefined }),
      slide('subtitle-object', { subtitle: {} }),
      slide('bad-title', { title: [] }),
      slide('not-display-only', { displayOnly: false }),
      slide('nonfinite', { focalPoint: { x: Infinity, y: NaN } }),
    ]),
  );
  assert.deepEqual(
    result.map((image) => image.id),
    ['valid', 'nonfinite'],
  );
  assert.deepEqual(result[0].focalPoint, { x: 0, y: 100 });
  assert.deepEqual(result[1].focalPoint, { x: 50, y: 50 });
  assert.equal(
    parseCoverManifest(manifest(Array.from({ length: 70 }, (_, index) => slide(`n-${index}`))))
      .length,
    50,
  );
  for (const malformed of [null, [], {}, { slides: [valid] }, { version: 1, slides: {} }]) {
    assert.deepEqual(parseCoverManifest(malformed), []);
  }
});

test('carousel requests only active/next initially, retains loaded photos and waits for next load', () => {
  const slides = parseCoverManifest(manifest(['B', 'A', 'C', 'D'].map((id) => slide(id))));
  let state = initialCoverState(slides);
  assert.deepEqual(
    coverFrame(state).requested.map((image) => image.id),
    ['B', 'A'],
  );
  assert.equal(reduceCoverState(state, { type: 'advance' }), state);
  state = ready(ready(state, 'B'), 'A');
  state = reduceCoverState(state, { type: 'advance' });
  assert.equal(state.activeId, 'A');
  assert.equal(state.previousId, 'B');
  assert.deepEqual(
    coverFrame(state).requested.map((image) => image.id),
    ['B', 'A', 'C'],
  );
  state = ready(state, 'C');
  state = reduceCoverState(state, { type: 'advance' });
  assert.equal(state.activeId, 'C');
  assert.ok(
    coverFrame(state).requested.every((image) => typeof image.url === 'string' && image.url.length),
  );
  assert.ok(coverFrame(state).requested.some((image) => image.id === 'B'));
});

test('invalid optional manifests retain fallback; all failed imported photos fall back exactly once', () => {
  const fallback = parseCoverManifest(manifest([slide('fallback-B'), slide('fallback-A')]));
  let state = initialCoverState(fallback);
  assert.equal(reduceCoverState(state, { type: 'replace', slides: [] }), state);
  state = reduceCoverState(state, {
    type: 'replace',
    slides: parseCoverManifest(manifest([slide('imported')])),
  });
  state = fail(state, 'imported');
  assert.equal(state.usingFallback, true);
  assert.equal(state.activeId, 'fallback-B');
  state = fail(state, 'fallback-B');
  state = fail(state, 'fallback-A');
  assert.equal(state.activeId, null);
  assert.equal(coverFrame(state).requested.length, 0);
  assert.equal(reduceCoverState(state, { type: 'advance' }), state);
  assert.equal(fail(state, 'fallback-A'), state);
  assert.equal(
    reduceCoverState(state, { type: 'failed', id: 'fallback-B', url: '/covers/stale.webp' }),
    state,
  );
});
