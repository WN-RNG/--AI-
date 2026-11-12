import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApplication } from '../server/app.mjs';
import { boundedImage, resultAddress } from '../server/postcardAI.mjs';

test('provider download rejects redirects, arbitrary hosts, non-images and oversized streamed bodies', async () => {
  for (const value of [
    'http://bucket.oss.aliyuncs.com/x',
    'https://127.0.0.1/x',
    'https://evil.test/x',
    'https://user:pass@bucket.oss.aliyuncs.com/x',
  ])
    assert.throws(() => resultAddress(value));
  assert.equal(
    resultAddress('https://bucket.oss-cn-beijing.aliyuncs.com/a.png'),
    'https://bucket.oss-cn-beijing.aliyuncs.com/a.png',
  );
  await assert.rejects(
    boundedImage(new Response('<html>', { headers: { 'Content-Type': 'text/html' } })),
  );
  await assert.rejects(
    boundedImage(
      new Response(new Uint8Array(33), { headers: { 'Content-Type': 'image/png' } }),
      32,
    ),
  );
});

test('real HTTP jobs enforce consent, ownership, budget, deduplication, revocation and restart reuse', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-ai-'));
  const bytes = await sharp({
    create: { width: 64, height: 96, channels: 3, background: '#778969' },
  })
    .jpeg()
    .toBuffer();
  const output = await sharp(bytes).webp().toBuffer();
  const calls = [];
  let rejectNext = true;
  const configuration = {
    DASHSCOPE_API_KEY: 'test-secret-never-returned',
    QWEN_MONTHLY_BUDGET_CNY: '1.2',
    QWEN_RESERVE_PER_IMAGE_CNY: '0.6',
  };
  const options = {
    dataDir,
    postcardAIOptions: {
      configuration,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (String(url).endsWith('/images/generations') && rejectNext) {
          rejectNext = false;
          return Response.json({ error: 'test-secret-never-returned' }, { status: 401 });
        }
        if (String(url).endsWith('/images/generations'))
          return Response.json({
            data: [{ url: 'https://bucket.oss-cn-beijing.aliyuncs.com/generated.webp' }],
          });
        return new Response(output, { headers: { 'Content-Type': 'image/webp' } });
      },
    },
  };
  let application, server, origin;
  async function start() {
    application = await createApplication(options);
    server = application.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await application.close();
  }
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await start();
  function client() {
    let cookie = '';
    return async (route, method = 'GET', body) => {
      const response = await fetch(origin + route, {
        method,
        headers: {
          Cookie: cookie,
          'X-Album-Client': '1',
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      for (const c of response.headers.getSetCookie()) cookie = c.split(';')[0];
      return response;
    };
  }
  const owner = client(),
    visitor = client(),
    guest = client();
  for (const [fn, name] of [
    [owner, 'owner'],
    [visitor, 'visitor'],
  ])
    assert.equal(
      (
        await fn('/api/auth/register', 'POST', {
          email: `ai-${name}@example.test`,
          name,
          password: 'Test-Password-42!',
          inviteCode: process.env.INVITE_CODE || 'FRAME-FIRST-100',
        })
      ).status,
      201,
    );
  const album = (await (await owner('/api/albums', 'POST', { title: 'Private AI source' })).json())
    .album;
  const form = new FormData();
  form.append('photos', new Blob([bytes], { type: 'image/jpeg' }), 'original.jpg');
  const photo = (await (await owner(`/api/albums/${album.id}/photos`, 'POST', form)).json())
    .photos[0];
  const route = `/api/photos/${photo.id}/postcards`;
  assert.equal((await guest(route, 'POST', { style: 'watercolor', consent: true })).status, 401);
  assert.equal((await visitor(route, 'POST', { style: 'watercolor', consent: true })).status, 403);
  assert.equal((await owner(route, 'POST', { style: 'watercolor' })).status, 400);
  assert.equal(calls.length, 0);
  async function wait(id) {
    for (let n = 0; n < 100; n++) {
      const response = await owner(`/api/postcards/${id}`);
      const { job } = await response.json();
      if (job.status === 'complete') return job;
      if (job.status === 'failed') throw Error(job.error);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error('job timeout');
  }
  const rejectedId = (
    await (await owner(route, 'POST', { style: 'watercolor', consent: true })).json()
  ).job.id;
  let rejected;
  for (let n = 0; n < 100; n++) {
    rejected = (await (await owner(`/api/postcards/${rejectedId}`)).json()).job;
    if (rejected.status === 'rejected') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(rejected.status, 'rejected');
  assert.ok(!JSON.stringify(rejected).includes('test-secret'));
  const created = await owner(route, 'POST', { style: 'watercolor', consent: true });
  assert.equal(created.status, 202);
  const first = (await created.json()).job;
  const ready = await wait(first.id);
  const repeated = await (
    await owner(route, 'POST', { style: 'watercolor', consent: true })
  ).json();
  assert.equal(repeated.job.id, first.id);
  assert.equal(calls.filter((c) => c.url.includes('/images/generations')).length, 2);
  const request = calls[1];
  const payload = JSON.parse(request.init.body);
  assert.equal(request.init.headers.Authorization, 'Bearer test-secret-never-returned');
  assert.equal(request.init.redirect, 'error');
  assert.equal(payload.n, 1);
  assert.match(payload.image, /^data:image\/jpeg;base64,/);
  assert.match(payload.prompt, /watercolor/);
  assert.equal(payload.size, '1024x1536');
  assert.equal(calls[2].init.headers, undefined, 'key must never be forwarded to storage');
  assert.equal((await visitor(ready.imageUrl)).status, 404);
  assert.equal((await owner(ready.imageUrl)).status, 200);
  assert.ok(!JSON.stringify(ready).includes('aliyuncs.com'));
  assert.ok(!JSON.stringify(ready).includes('test-secret'));
  const frost = (await (await owner(route, 'POST', { style: 'frost', consent: true })).json()).job;
  await wait(frost.id);
  const secondForm = new FormData();
  secondForm.append('photos', new Blob([bytes], { type: 'image/jpeg' }), 'another.jpg');
  const another = (await (await owner(`/api/albums/${album.id}/photos`, 'POST', secondForm)).json())
    .photos[0];
  assert.equal(
    (await owner(`/api/photos/${another.id}/postcards`, 'POST', { style: 'frost', consent: true }))
      .status,
    429,
  );
  const originalName = (await readdir(path.join(dataDir, 'originals'))).find((name) =>
    name.startsWith(photo.id),
  );
  assert.deepEqual(await readFile(path.join(dataDir, 'originals', originalName)), bytes);
  await stop();
  await start();
  assert.equal(
    (await (await owner(route, 'POST', { style: 'watercolor', consent: true })).json()).job.id,
    first.id,
  );
  assert.equal(calls.filter((c) => c.url.includes('/images/generations')).length, 3);
  await owner(`/api/photos/${photo.id}`, 'PATCH', { deleted: true });
  assert.equal((await owner(ready.imageUrl)).status, 404);
  assert.equal((await owner(route, 'POST', { style: 'frost', consent: true })).status, 404);
});

test('missing server key disables AI without charging or sending reference images', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-ai-disabled-'));
  const instance = await createApplication({
    dataDir,
    postcardAIOptions: {
      configuration: {},
      fetchImpl: () => {
        throw Error('must not call provider');
      },
    },
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await instance.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const result = await (
    await fetch(`http://127.0.0.1:${server.address().port}/api/postcards/config`)
  ).json();
  assert.equal(result.enabled, false);
  assert.equal(result.monthlyBudgetCny, 50);
});
