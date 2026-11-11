import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizedPostcardBlob,
  extractPalette,
  postcardLayout,
  recommendTemplate,
} from '../src/postcard.ts';

test('palette stays bounded and deterministic, excluding transparent pixels', () => {
  const pixels = [];
  for (let count = 0; count < 100; count++) pixels.push(35, 75, 120, 255);
  for (let count = 0; count < 50; count++) pixels.push(230, 180, 70, 255);
  for (let count = 0; count < 500; count++) pixels.push(255, 0, 255, 0);
  const palette = extractPalette(pixels);
  assert.deepEqual(palette, extractPalette(pixels));
  assert.ok(palette.length > 0 && palette.length <= 4);
  assert.ok(Math.abs(palette.reduce((sum, item) => sum + item.weight, 0) - 1) < 1e-9);
  assert.ok(
    palette.every(({ rgb }) =>
      rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
    ),
  );
  assert.ok(!palette.some(({ rgb }) => rgb[0] === 255 && rgb[2] === 255));
  assert.deepEqual(extractPalette([]), [{ rgb: [210, 205, 191], weight: 1 }]);
  assert.equal(extractPalette([120, 120, 120, 255, 120, 120, 120, 255]).length, 1);
});

test('Auto suggests different styles from brightness, warmth and orientation', () => {
  assert.equal(recommendTemplate([{ rgb: [30, 35, 50], weight: 1 }], 2000, 1200), 'C');
  assert.equal(recommendTemplate([{ rgb: [200, 150, 80], weight: 1 }], 2000, 1200), 'B');
  assert.equal(recommendTemplate([{ rgb: [180, 210, 230], weight: 1 }], 2000, 1200), 'A');
  assert.equal(recommendTemplate([{ rgb: [180, 210, 230], weight: 1 }], 1200, 2000), 'B');
});

test('portrait, landscape, panoramic and tall photos remain fully contained in either card orientation', () => {
  for (const [photoWidth, photoHeight] of [
    [6000, 4000],
    [4000, 6000],
    [12000, 1500],
    [1200, 10000],
    [1024, 1024],
  ]) {
    for (const orientation of ['auto', 'portrait', 'landscape']) {
      for (const longEdge of [1200, 2400, 3600]) {
        const card = postcardLayout(photoWidth, photoHeight, longEdge, orientation);
        assert.equal(Math.max(card.width, card.height), longEdge);
        assert.ok(Math.abs(card.image.width / card.image.height - photoWidth / photoHeight) < 1e-9);
        assert.ok(card.image.x >= card.mat.x && card.image.y >= card.mat.y);
        assert.ok(card.image.x + card.image.width <= card.mat.x + card.mat.width);
        assert.ok(card.image.y + card.image.height < card.captionY);
        assert.ok(card.captionY < card.height);
        assert.ok(Math.abs(card.image.x + card.image.width / 2 - card.width / 2) < 1e-9);
      }
    }
  }
  assert.throws(() => postcardLayout(0, 100, 2400, 'auto'));
  assert.throws(() => postcardLayout(Infinity, 100, 2400, 'auto'));
});

test('export fetch uses only the encoded authenticated download endpoint, with redirects rejected', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(new Blob(['image'], { type: 'image/webp' }), { status: 200 });
  };
  try {
    const result = await authorizedPostcardBlob('a/../b?secret=1');
    assert.equal(result.type, 'image/webp');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/photos/a%2F..%2Fb%3Fsecret%3D1/download');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.redirect, 'error');
  } finally {
    globalThis.fetch = original;
  }
});

test('withdrawn download permission cannot fall back to the public preview', async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return Response.json({ error: 'Author disabled download' }, { status: 403 });
  };
  try {
    await assert.rejects(authorizedPostcardBlob('private-photo'), /Author disabled download/);
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('export rejects a successful non-image response instead of generating a corrupt postcard', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
  try {
    await assert.rejects(authorizedPostcardBlob('photo'), /Unsupported image response/);
  } finally {
    globalThis.fetch = original;
  }
});
