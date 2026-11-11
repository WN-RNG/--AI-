import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSearchUrl,
  displayImageUrl,
  photoPageUrl,
  chooseCandidates,
  coverConfiguration,
  collect500px,
  validateDisplayResponse,
  sameDisplayedPhoto,
} from '../scripts/collect-500px.mjs';

test('collector accepts only the explicit public 500px search and photo routes', () => {
  assert.equal(
    new URL(validateSearchUrl('https://500px.com/search?q=nature&type=Photo')).hostname,
    '500px.com',
  );
  for (const value of [
    'http://500px.com/search?q=x&type=Photo',
    'https://evil.example/search?q=x&type=Photo',
    'https://500px.com@127.0.0.1/search?q=x&type=Photo',
    'https://500px.com/search?q=x&type=Photo&redirect=http://127.0.0.1',
  ])
    assert.throws(() => validateSearchUrl(value));
  assert.equal(photoPageUrl('https://500px.com/photo/Abc123'), 'https://500px.com/photo/Abc123');
  assert.equal(photoPageUrl('https://500px.com/login'), null);
  assert.equal(photoPageUrl('https://500px.com/photo/Abc123?redirect=bad'), null);
});

test('only published display CDN addresses pass and exact signed query is preserved', () => {
  const url =
    'https://cdn-resize-prod-com.500px.cloud/photo/123/0.jpg?s=2&w=1&expiry=42&sig=OriginalCase';
  assert.equal(displayImageUrl(url), url);
  assert.equal(
    displayImageUrl(
      url.replace(
        'cdn-resize-prod-com.500px.cloud',
        'cdn-resize-prod-com.500px.cloud.evil.example',
      ),
    ),
    null,
  );
  assert.equal(displayImageUrl('https://127.0.0.1/photo/123/a.jpg'), null);
  assert.equal(displayImageUrl('https://cdn-resize-prod-com.500px.cloud/user-avatar/a.jpg'), null);
});

test('display-size variants match by their real DOM-provided photo path rather than changing alt text', () => {
  const candidate = {
    url: 'https://cdn-resize-prod-com.500px.cloud/photo/123/0.jpg?s=1&sig=thumb',
    title: 'Lake',
  };
  assert.equal(
    sameDisplayedPhoto(candidate, {
      url: 'https://cdn-resize-prod-com.500px.cloud/photo/123/0.jpg?s=2&sig=display',
      title: 'Lake by Artist',
    }),
    true,
  );
  assert.equal(
    sameDisplayedPhoto(candidate, {
      url: 'https://cdn-resize-prod-com.500px.cloud/photo/999/0.jpg?s=2&sig=other',
      title: 'Lake',
    }),
    false,
  );
  assert.equal(
    sameDisplayedPhoto(candidate, { url: 'https://untrusted.example/photo/123/0.jpg' }),
    false,
  );
});

test('landscape selection and config retain real title, author, source and no invented originals', () => {
  const base = {
    source: 'https://500px.com/photo/Abc123',
    url: 'https://cdn-resize-prod-com.500px.cloud/photo/1/0.jpg?s=2&sig=existing',
    title: 'Sunset at the Lake',
    author: 'Real Photographer',
    width: 1024,
    height: 640,
  };
  const portrait = {
    ...base,
    source: 'https://500px.com/photo/Portrait',
    width: 640,
    height: 1024,
  };
  const wildlife = { ...base, source: 'https://500px.com/photo/Fox', title: 'Focused Fox' };
  assert.deepEqual(chooseCandidates([portrait, wildlife, base, base], 6), [base]);
  const config = coverConfiguration([base, base]);
  assert.equal(config.slides.length, 1);
  assert.equal(config.slides[0].url, base.url);
  assert.equal(config.slides[0].author, base.author);
  assert.equal(config.slides[0].source, base.source);
  assert.equal(config.slides[0].title, base.title);
  assert.equal(config.slides[0].displayOnly, true);
  assert.throws(() => coverConfiguration([{ ...base, width: 600 }]), /No suitable/);
});

test('invalid collection bounds and control-character queries fail before starting a browser', async () => {
  await assert.rejects(collect500px({ output: 'unused.json', limit: 7 }), /between 1 and 6/);
  await assert.rejects(
    collect500px({ output: 'unused.json', query: 'landscape\nlogin' }),
    /short search phrase/,
  );
  await assert.rejects(
    collect500px({ output: 'unused.json', downloadDir: 'relative-cache' }),
    /absolute private/,
  );
});

test('browser response capture accepts only exact public image bytes and rejects denied or disguised content', () => {
  const url = 'https://cdn-resize-prod-com.500px.cloud/photo/123/0.jpg?s=2&sig=untouched';
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
  const response = {
    url,
    status: 200,
    mime: 'image/jpeg',
    body: bytes.toString('base64'),
    base64Encoded: true,
  };
  assert.deepEqual(validateDisplayResponse(response), { bytes, extension: '.jpg' });
  assert.throws(() => validateDisplayResponse({ ...response, status: 403 }), /unavailable/);
  assert.throws(
    () => validateDisplayResponse({ ...response, url: 'https://127.0.0.1/photo/image.jpg' }),
    /unavailable/,
  );
  assert.throws(
    () => validateDisplayResponse({ ...response, mime: 'text/html' }),
    /supported binary/,
  );
  assert.throws(
    () =>
      validateDisplayResponse({
        ...response,
        body: Buffer.from('<html>login</html>').toString('base64'),
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      validateDisplayResponse({
        ...response,
        body: 'A'.repeat(Math.ceil((30 * 1024 * 1024) / 3) * 4 + 4),
      }),
    /exceeds 30/,
  );
});

test('captured local sources remove signed download URLs and remote hosts from the import configuration', () => {
  const photo = {
    source: 'https://500px.com/photo/LocalCapture',
    url: 'https://cdn-resize-prod-com.500px.cloud/photo/123/0.jpg?s=2&sig=private',
    title: 'Real lake',
    author: 'Real author',
    width: 1024,
    height: 640,
    file: 'C:\\private-cache\\sha256.jpg',
  };
  const config = coverConfiguration([photo]);
  assert.deepEqual(config.allowedHosts, []);
  assert.equal(config.slides[0].file, photo.file);
  assert.equal('url' in config.slides[0], false);
  assert.equal(JSON.stringify(config).includes('sig='), false);
  assert.equal(config.slides[0].source, photo.source);
});
