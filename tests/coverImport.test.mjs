import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { prepareCover } from '../scripts/prepare-cover.mjs';
import { updateCovers } from '../scripts/update-covers.mjs';

sharp.cache({ files: 0 });

test('manual pool honors natural filename order and rotation without publishing or changing originals', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'album-manual-cover-'));
  try {
    const pool = path.join(temporary, 'pool'), output = path.join(temporary, 'public');
    await fs.mkdir(pool);
    const original = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#184a65' } })
      .withExif({ IFD0: { Artist: 'Private original metadata' } }).png().toBuffer();
    await fs.writeFile(path.join(pool, '10-later.png'), original);
    await fs.writeFile(path.join(pool, '2-first.png'), original);
    await fs.writeFile(path.join(pool, 'settings.json'), JSON.stringify({ images: { '2-first.png': { rotation: 90, focalPoint: { x: 30, y: 60 } } } }));
    const result = await updateCovers({ poolDirectory: pool, outputDirectory: output });
    assert.equal(result.imported, 2);
    const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
    assert.deepEqual(manifest.slides.map(s => [s.width,s.height]), [[600,400],[400,600]]);
    assert.deepEqual(manifest.slides[0].focalPoint, { x:30,y:60 });
    for (const slide of manifest.slides) {
      assert.match(slide.url, /^\/covers\/manual-[a-f0-9]{24}\.webp$/);
      assert.equal(slide.source, '');
      const metadata = await sharp(path.join(output, path.basename(slide.url))).metadata();
      assert.equal(metadata.exif, undefined);
    }
    assert.deepEqual(await fs.readFile(path.join(pool,'2-first.png')), original);
    assert.equal((await fs.readdir(output)).some(name => name.endsWith('.png')),false);
    const ids=manifest.slides.map(s=>s.id);
    await updateCovers({ poolDirectory: pool, outputDirectory: output });
    assert.deepEqual(JSON.parse(await fs.readFile(result.manifest,'utf8')).slides.map(s=>s.id),ids);
  } finally { await fs.rm(temporary,{ recursive:true,force:true }); }
});

test('invalid replacement images, empty pools and invalid settings preserve the previous live manifest', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'album-manual-rollback-'));
  try {
    const pool=path.join(temporary,'pool'),output=path.join(temporary,'output');
    await fs.mkdir(pool);
    const input=path.join(pool,'01-valid.jpg');
    await sharp({create:{width:200,height:100,channels:3,background:'#7b8d46'}}).jpeg().toFile(input);
    const options={poolDirectory:pool,outputDirectory:output};
    const {manifest}=await updateCovers(options);
    const before=await fs.readFile(manifest);
    await fs.writeFile(path.join(pool,'99-bad.jpg'),'<html>Invalid photo</html>');
    await assert.rejects(updateCovers(options));
    assert.deepEqual(await fs.readFile(manifest),before);
    assert.equal((await fs.readdir(output)).some(name=>name.startsWith('.')),false);
    await fs.unlink(path.join(pool,'99-bad.jpg'));
    await fs.writeFile(path.join(pool,'settings.json'),JSON.stringify({images:{'01-valid.jpg':{rotation:12}}}));
    await assert.rejects(updateCovers(options),/Invalid rotation/);
    assert.deepEqual(await fs.readFile(manifest),before);
    await fs.unlink(input);
    await assert.rejects(updateCovers(options),/between 1 and 50/);
    assert.deepEqual(await fs.readFile(manifest),before);
    await assert.rejects(updateCovers({poolDirectory:pool,outputDirectory:pool}),/separate directories/);
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
});

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
