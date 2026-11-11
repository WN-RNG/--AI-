import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { prepareCover } from '../scripts/prepare-cover.mjs';

sharp.cache({ files: 0 });

test('cover optimization keeps natural proportions, strips EXIF and never overwrites source', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'album-cover-'));
  try {
    const source = path.join(temporary, 'input.jpg');
    const target = path.join(temporary, 'optimized.webp');
    await sharp({ create: { width: 400, height: 600, channels: 3, background: '#b48a57' } })
      .withExif({ IFD0: { Artist: 'Private Artist', ImageDescription: 'private metadata' } })
      .jpeg()
      .toFile(source);
    const before = await fs.readFile(source);
    const result = await prepareCover(source, target);
    assert.equal(result.width, 400);
    assert.equal(result.height, 600);
    const metadata = await sharp(target).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.deepEqual(await fs.readFile(source), before);
    await assert.rejects(prepareCover(source, source), /different files/);
    await assert.rejects(prepareCover(source, target), /EEXIST/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('cover optimization limits display dimensions and rejects SVG/HTML disguises', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'album-cover-'));
  try {
    const source = path.join(temporary, 'panorama.png');
    const target = path.join(temporary, 'output.webp');
    await sharp({ create: { width: 3200, height: 800, channels: 3, background: '#24505b' } })
      .png()
      .toFile(source);
    assert.deepEqual(
      (({ width, height }) => ({ width, height }))(await prepareCover(source, target)),
      { width: 2560, height: 640 },
    );
    const unsupported = path.join(temporary, 'disguised.jpg');
    await fs.writeFile(
      unsupported,
      '<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"/>',
    );
    await assert.rejects(prepareCover(unsupported, path.join(temporary, 'svg.webp')), /static JPG/);
    await fs.writeFile(unsupported, '<html>Sign in</html>');
    await assert.rejects(prepareCover(unsupported, path.join(temporary, 'html.webp')));
    await assert.rejects(fs.access(path.join(temporary, 'html.webp')));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
