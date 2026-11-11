import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { mountCoverAssets } from '../server/coverAssets.mjs';

test('cover imports become visible without rebuilding; missing assets never return SPA HTML', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'guangying-cover-assets-'));
  const directory = path.join(root, 'covers');
  await mkdir(directory);
  await writeFile(path.join(root, 'private.txt'), 'PRIVATE');
  const app = express();
  mountCoverAssets(app, directory);
  app.get('/{*path}', (_request, response) => response.type('html').send('<h1>SPA</h1>'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/covers/manifest.json')).status, 404);
    await writeFile(path.join(directory, 'manifest.json'), '{"version":1,"slides":[]}');
    let response = await fetch(base + '/covers/manifest.json');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await response.json()).version, 1);
    await writeFile(path.join(directory, 'manifest.json'), '{"version":2,"slides":[]}');
    assert.equal((await (await fetch(base + '/covers/manifest.json')).json()).version, 2);
    response = await fetch(base + '/covers/%2e%2e%2fprivate.txt');
    assert.ok([400, 403, 404].includes(response.status));
    assert.equal((await response.text()).includes('PRIVATE'), false);
    response = await fetch(base + '/covers/missing.webp');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type').includes('application/json'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
