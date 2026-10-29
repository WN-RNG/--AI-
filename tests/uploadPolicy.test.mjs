import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyUploadFiles, createUploadBatches } from '../src/uploadPolicy.ts';
import { UPLOAD_CONFIRM_BYTES, UPLOAD_MAX_BYTES } from '../shared/uploadPolicy.ts';

const photo = (name, size = 1024) => ({ name, size });

test('20MB is ordinary, 30MB requires confirmation, larger and unsupported files are reported', () => {
  const ordinary = photo('ordinary.JPG', UPLOAD_CONFIRM_BYTES);
  const large = photo('large.png', UPLOAD_CONFIRM_BYTES + 1);
  const maximum = photo('maximum.WebP', UPLOAD_MAX_BYTES);
  const oversized = photo('too-large.jpg', UPLOAD_MAX_BYTES + 1);
  const unsupported = photo('document.pdf');
  const result = classifyUploadFiles([ordinary, large, maximum, oversized, unsupported]);
  assert.deepEqual(result.normal, [ordinary]);
  assert.deepEqual(result.large, [large, maximum]);
  assert.deepEqual(result.files, [ordinary, large, maximum]);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes(oversized.name)));
  assert.ok(result.errors.some((error) => error.includes(unsupported.name)));
});

test('without this selection consent no large photograph enters a network batch', () => {
  const files = [
    photo('first.jpg'),
    photo('unconfirmed.png', UPLOAD_CONFIRM_BYTES + 1),
    photo('second.jpg'),
    photo('third.webp'),
    photo('fourth.jpg'),
  ];
  const batches = createUploadBatches(files, false);
  assert.deepEqual(
    batches.flatMap((batch) => batch.files).map((file) => file.name),
    ['first.jpg', 'second.jpg', 'third.webp', 'fourth.jpg'],
  );
  assert.ok(batches.every((batch) => batch.allowLargeFiles === false && batch.files.length <= 3));
  assert.deepEqual(createUploadBatches([files[1]], false), []);
});

test('confirmed large photos travel alone while ordinary batches retain selection order', () => {
  const files = [
    photo('a.jpg'),
    photo('b.jpg'),
    photo('large-a.png', UPLOAD_CONFIRM_BYTES + 1),
    photo('c.jpg'),
    photo('d.jpg'),
    photo('e.jpg'),
    photo('f.jpg'),
    photo('large-b.webp', UPLOAD_MAX_BYTES),
    photo('g.jpg'),
  ];
  const before = [...files];
  const batches = createUploadBatches(files, true);
  assert.deepEqual(
    batches.flatMap((batch) => batch.files),
    files,
  );
  assert.deepEqual(files, before);
  assert.equal(batches.filter((batch) => batch.allowLargeFiles).length, 2);
  for (const batch of batches) {
    assert.ok(batch.files.length <= 3);
    if (batch.allowLargeFiles) {
      assert.equal(batch.files.length, 1);
      assert.ok(batch.files[0].size > UPLOAD_CONFIRM_BYTES);
    } else assert.ok(batch.files.every((file) => file.size <= UPLOAD_CONFIRM_BYTES));
  }
});

test('confirmation cannot override the 30MB hard cap and identically named files are retained', () => {
  const first = photo('same.jpg', UPLOAD_CONFIRM_BYTES);
  const second = photo('same.jpg', UPLOAD_CONFIRM_BYTES + 1);
  const oversized = photo('oversized.png', UPLOAD_MAX_BYTES + 1);
  const selection = classifyUploadFiles([first, second, oversized]);
  assert.deepEqual(selection.files, [first, second]);
  assert.deepEqual(
    createUploadBatches([first, second, oversized], true).flatMap((batch) => batch.files),
    [first, second],
  );
});
