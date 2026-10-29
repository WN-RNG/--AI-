/**
 * 后端集成测试：使用独立临时目录和真实编码图片，不操作项目的日常 data 目录。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createApplication } from '../server/app.mjs';
import {
  UPLOAD_CONFIRM_BYTES,
  UPLOAD_MAX_BYTES,
  UPLOAD_BATCH_SIZE,
} from '../shared/uploadPolicy.ts';

const inviteCode = process.env.INVITE_CODE || 'FRAME-FIRST-100';
const password = 'Album-Test-42!';

async function fixture(t, existingDataDir, applicationOptions = {}) {
  const dataDir = existingDataDir || (await mkdtemp(path.join(tmpdir(), 'frame-api-test-')));
  const application = await createApplication({ dataDir, ...applicationOptions });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await application.close();
  };
  t.after(stop);
  if (!existingDataDir)
    t.after(async () => {
      await stop();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

  function client(initialCookie = '') {
    let cookie = initialCookie;
    return {
      get cookie() {
        return cookie;
      },
      async request(route, options = {}) {
        const { method = 'GET', json, form, mutationHeader = true, headers = {}, signal } = options;
        const requestHeaders = { ...headers };
        if (cookie) requestHeaders.Cookie = cookie;
        if (mutationHeader && !['GET', 'HEAD'].includes(method))
          requestHeaders['X-Album-Client'] = '1';
        if (json !== undefined) requestHeaders['Content-Type'] = 'application/json';
        const response = await fetch(`${baseUrl}${route}`, {
          method,
          headers: requestHeaders,
          body: form || (json === undefined ? undefined : JSON.stringify(json)),
          signal,
        });
        for (const setCookie of response.headers.getSetCookie()) {
          const nextCookie = setCookie.split(';', 1)[0];
          if (/Max-Age=0/i.test(setCookie)) cookie = '';
          else cookie = nextCookie;
        }
        return response;
      },
      async json(route, options) {
        const response = await this.request(route, options);
        const body = await response.json();
        return { response, body };
      },
    };
  }

  return { dataDir, stop, client };
}

function expectSuccess(response, body) {
  assert.ok(response.ok, `Expected success, received ${response.status}: ${JSON.stringify(body)}`);
}

function expectDenied(response) {
  assert.ok(
    [401, 403, 404].includes(response.status),
    `Expected denied access, received ${response.status}`,
  );
}

async function register(client, username) {
  const result = await client.json('/api/auth/register', {
    method: 'POST',
    json: { email: `${username}@example.test`, password, name: username, inviteCode },
  });
  expectSuccess(result.response, result.body);
  assert.ok(result.body.user?.id, 'Registration returns the authenticated account');
  return result.body.user;
}

async function album(client, title = 'A real photography project') {
  const result = await client.json('/api/albums', { method: 'POST', json: { title } });
  expectSuccess(result.response, result.body);
  assert.ok(result.body.album?.id, 'Creation returns the new album');
  return result.body.album;
}

async function sample(format = 'jpeg', withMetadata = false) {
  const width = 180;
  const height = 120;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const checker = ((Math.floor(x / 12) + Math.floor(y / 12)) % 2) * 90;
      pixels[offset] = (x + checker) % 256;
      pixels[offset + 1] = (y * 2 + checker) % 256;
      pixels[offset + 2] = (x + y + checker) % 256;
    }
  }
  let image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (withMetadata)
    image = image.withMetadata({ exif: { IFD0: { ImageDescription: 'Private test metadata' } } });
  return image.toFormat(format).toBuffer();
}

async function upload(client, albumId, files, { fields = [], fieldsAfterFiles = false } = {}) {
  const form = new FormData();
  const appendFields = () => {
    for (const [name, value] of fields) form.append(name, value);
  };
  if (!fieldsAfterFiles) appendFields();
  for (const file of files) {
    form.append('photos', new Blob([file.bytes], { type: file.type || 'image/jpeg' }), file.name);
  }
  if (fieldsAfterFiles) appendFields();
  const result = await client.json(`/api/albums/${albumId}/photos`, { method: 'POST', form });
  return result;
}

async function detail(client, albumId) {
  const result = await client.json(`/api/albums/${albumId}`);
  expectSuccess(result.response, result.body);
  return result.body;
}

test('invite registration, login, session revocation and albums/files survive a restart', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-restart-test-'));
  const applications = [];
  t.after(async () => {
    for (const application of applications) await application.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const first = await fixture(t, dataDir);
  applications.push(first);
  const client = first.client();
  assert.equal((await client.json('/api/auth/session')).body.user, null);

  const denied = await client.json('/api/auth/register', {
    method: 'POST',
    json: { email: 'owner@example.test', name: 'Owner', password, inviteCode: 'wrong-invite' },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(client.cookie, '');

  const user = await register(client, 'owner');
  assert.equal(user.email, 'owner@example.test');
  assert.equal(user.password, undefined);
  const created = await album(client, 'Persistent private album');
  assert.equal(created.isPublic, false);
  const original = await sample('jpeg', true);
  const uploaded = await upload(client, created.id, [{ name: 'original.jpg', bytes: original }]);
  expectSuccess(uploaded.response, uploaded.body);
  const photoId = uploaded.body.photos[0].id;
  const sessionCookie = client.cookie;
  await first.stop();

  const second = await fixture(t, dataDir);
  applications.push(second);
  const resumed = second.client(sessionCookie);
  assert.equal((await resumed.json('/api/auth/session')).body.user.id, user.id);
  const retained = await detail(resumed, created.id);
  assert.equal(retained.photos.length, 1);
  const download = await resumed.request(`/api/photos/${photoId}/file?download=1`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);

  const loggingIn = second.client();
  const wrong = await loggingIn.json('/api/auth/login', {
    method: 'POST',
    json: { email: user.email, password: 'incorrect-password' },
  });
  assert.equal(wrong.response.status, 401);
  assert.equal(loggingIn.cookie, '');
  const login = await loggingIn.json('/api/auth/login', {
    method: 'POST',
    json: { email: user.email, password },
  });
  expectSuccess(login.response, login.body);
  assert.equal(login.body.user.id, user.id);
  const tokenBeforeLogout = loggingIn.cookie;
  const logout = await loggingIn.json('/api/auth/logout', { method: 'POST' });
  expectSuccess(logout.response, logout.body);
  assert.equal((await second.client(tokenBeforeLogout).json('/api/auth/session')).body.user, null);
});

test('account isolation protects album APIs, originals, thumbnails, upload and photo mutation', async (t) => {
  const app = await fixture(t);
  const alice = app.client();
  const bob = app.client();
  const anonymous = app.client();
  await register(alice, 'alice');
  await register(bob, 'bob');
  const aliceAlbum = await album(alice, 'Alice private');
  const bobAlbum = await album(bob, 'Bob private');
  const image = await sample();
  const aliceUpload = await upload(alice, aliceAlbum.id, [{ name: 'alice.jpg', bytes: image }]);
  const bobUpload = await upload(bob, bobAlbum.id, [{ name: 'bob.jpg', bytes: image }]);
  expectSuccess(aliceUpload.response, aliceUpload.body);
  expectSuccess(bobUpload.response, bobUpload.body);
  const alicePhoto = aliceUpload.body.photos[0];
  const bobPhoto = bobUpload.body.photos[0];
  assert.deepEqual(
    (await bob.json('/api/albums')).body.albums.map((item) => item.id),
    [bobAlbum.id],
  );

  for (const stranger of [bob, anonymous]) {
    expectDenied(await stranger.request(`/api/albums/${aliceAlbum.id}`));
    expectDenied(await stranger.request(`/api/photos/${alicePhoto.id}/file`));
    expectDenied(await stranger.request(`/api/photos/${alicePhoto.id}/file?download=1`));
    expectDenied(await stranger.request(`/api/photos/${alicePhoto.id}/thumb`));
    expectDenied(
      await stranger.request(`/api/photos/${alicePhoto.id}`, {
        method: 'PATCH',
        json: { pick: 'reject', deleted: true },
      }),
    );
    expectDenied(
      await stranger.request(`/api/albums/${aliceAlbum.id}`, {
        method: 'PATCH',
        json: { isPublic: true },
      }),
    );
    expectDenied(
      await stranger.request(`/api/albums/${aliceAlbum.id}/analyze`, { method: 'POST' }),
    );
    expectDenied(
      (await upload(stranger, aliceAlbum.id, [{ name: 'intrusion.jpg', bytes: image }])).response,
    );
  }
  const unchanged = await detail(alice, aliceAlbum.id);
  assert.equal(unchanged.photos.length, 1);
  assert.equal(unchanged.photos[0].pick, 'none');
  assert.equal(unchanged.album.isPublic, false);

  const crossUserCover = await alice.json(`/api/albums/${aliceAlbum.id}`, {
    method: 'PATCH',
    json: { coverPhotoId: bobPhoto.id, coverPhotoIds: [bobPhoto.id] },
  });
  assert.equal(crossUserCover.response.status, 400);
  assert.equal((await detail(alice, aliceAlbum.id)).album.coverPhotoId, null);

  const noClientHeader = await alice.request('/api/albums', {
    method: 'POST',
    mutationHeader: false,
    json: { title: 'Forbidden' },
  });
  assert.equal(noClientHeader.status, 403);
  const crossOrigin = await alice.request('/api/albums', {
    method: 'POST',
    json: { title: 'Forbidden' },
    headers: { Origin: 'https://different-origin.example' },
  });
  assert.equal(crossOrigin.status, 403);
});

test('upload decodes actual JPG, PNG and WebP and reports invalid files without losing valid ones', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await register(client, 'formats');
  const created = await album(client);
  const files = await Promise.all(
    [
      ['jpeg', 'portrait.jpg', 'image/jpeg'],
      ['png', 'landscape.png', 'image/png'],
      ['webp', 'street.webp', 'image/webp'],
    ].map(async ([format, name, type]) => ({ name, type, bytes: await sample(format) })),
  );
  const uploaded = await upload(client, created.id, [
    ...files.slice(0, 2),
    {
      name: 'pretends-to-be-a-photo.jpg',
      type: 'image/jpeg',
      bytes: Buffer.from('<html>not a photo</html>'),
    },
  ]);
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.photos.length, 2, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.errors.length, 1);
  const webp = await upload(client, created.id, [files[2]]);
  expectSuccess(webp.response, webp.body);
  const accepted = [...uploaded.body.photos, ...webp.body.photos];
  assert.deepEqual(
    new Set(accepted.map((photo) => photo.mime)),
    new Set(['image/jpeg', 'image/png', 'image/webp']),
  );
  for (const photo of accepted) {
    assert.equal(photo.width, 180);
    assert.equal(photo.height, 120);
    const thumbnail = await client.request(photo.thumbnailUrl);
    assert.equal(thumbnail.status, 200);
    assert.equal(
      (await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).format,
      'webp',
    );
  }
  const rejected = await upload(client, created.id, [
    { name: 'fake.png', type: 'image/png', bytes: Buffer.from('not PNG') },
  ]);
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.errors.length, 1);
  assert.equal((await detail(client, created.id)).photos.length, 3);
});

// Trailing JPEG padding exercises real multipart byte limits without requiring
// a huge decoded image or allocating an 80 MP fixture just to test file size.
function sizedJpeg(image, length) {
  assert.ok(length >= image.length);
  const bytes = Buffer.alloc(length);
  image.copy(bytes);
  return bytes;
}

test('20 MiB is normal; larger uploads need explicit consent regardless of multipart field order', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await register(client, 'large-files');
  const created = await album(client);
  const image = await sample();
  const boundary = await upload(client, created.id, [
    {
      name: 'exactly-20.jpg',
      bytes: sizedJpeg(image, UPLOAD_CONFIRM_BYTES),
    },
  ]);
  expectSuccess(boundary.response, boundary.body);
  assert.equal(boundary.body.photos[0].bytes, UPLOAD_CONFIRM_BYTES);

  const mixed = await upload(client, created.id, [
    { name: 'normal.jpg', bytes: image },
    { name: 'needs-consent.jpg', bytes: sizedJpeg(image, UPLOAD_CONFIRM_BYTES + 1) },
  ]);
  assert.equal(mixed.response.status, 201);
  assert.equal(
    mixed.body.photos.length,
    1,
    'A missing large-file confirmation preserves ordinary files',
  );
  assert.equal(mixed.body.photos[0].filename, 'normal.jpg');
  assert.match(mixed.body.errors[0].error, /确认/);

  const falseConsent = await upload(
    client,
    created.id,
    [
      {
        name: 'not-confirmed.jpg',
        bytes: sizedJpeg(image, UPLOAD_CONFIRM_BYTES + 1),
      },
    ],
    { fields: [['allowLargeFiles', 'false']] },
  );
  assert.equal(falseConsent.response.status, 400);
  assert.match(falseConsent.body.errors[0].error, /确认/);

  for (const fieldsAfterFiles of [false, true]) {
    const accepted = await upload(
      client,
      created.id,
      [
        {
          name: `confirmed-${fieldsAfterFiles}.jpg`,
          bytes: sizedJpeg(image, UPLOAD_CONFIRM_BYTES + 1),
        },
      ],
      { fields: [['allowLargeFiles', 'true']], fieldsAfterFiles },
    );
    expectSuccess(accepted.response, accepted.body);
    assert.equal(accepted.body.photos[0].bytes, UPLOAD_CONFIRM_BYTES + 1);
  }
  assert.equal((await detail(client, created.id)).photos.length, 4);
  assert.deepEqual(await readdir(path.join(app.dataDir, 'tmp')), []);
});

test('exactly 30 MiB is accepted after confirmation; hard size/count failures reject and clean the batch', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await register(client, 'hard-limits');
  const created = await album(client);
  const image = await sample();
  const maximum = await upload(
    client,
    created.id,
    [
      {
        name: 'exactly-30.jpg',
        bytes: sizedJpeg(image, UPLOAD_MAX_BYTES),
      },
    ],
    { fields: [['allowLargeFiles', 'true']] },
  );
  expectSuccess(maximum.response, maximum.body);
  assert.equal(maximum.body.photos[0].bytes, UPLOAD_MAX_BYTES);

  // Standard Multer hard-limit failures roll back the entire hostile batch.
  // The normal frontend excludes >30 MiB files before forming any batch.
  const oversized = await upload(
    client,
    created.id,
    [
      { name: 'ordinary-in-rejected-batch.jpg', bytes: image },
      { name: 'over-30.jpg', bytes: sizedJpeg(image, UPLOAD_MAX_BYTES + 1) },
    ],
    { fields: [['allowLargeFiles', 'true']] },
  );
  assert.equal(oversized.response.status, 400);
  assert.match(oversized.body.error, /30MB/);
  assert.deepEqual(await readdir(path.join(app.dataDir, 'tmp')), []);

  const tooMany = await upload(
    client,
    created.id,
    Array.from({ length: UPLOAD_BATCH_SIZE + 1 }, (_, index) => ({
      name: `too-many-${index}.jpg`,
      bytes: image,
    })),
  );
  assert.equal(tooMany.response.status, 400);
  assert.match(tooMany.body.error, /3 张/);
  assert.equal((await detail(client, created.id)).photos.length, 1);
  assert.deepEqual(await readdir(path.join(app.dataDir, 'tmp')), []);
});

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for the controlled concurrent operation');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('concurrent accounts, analysis and demo share one image processor; overload is bounded and retryable', async (t) => {
  const demoDir = await mkdtemp(path.join(tmpdir(), 'frame-demo-source-'));
  t.after(() => rm(demoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const image = await sample();
  await writeFile(path.join(demoDir, 'kyoto-temple.jpg'), image);
  const app = await fixture(t, undefined, { demoDir });
  const clients = Array.from({ length: 5 }, () => app.client());
  const albums = [];
  for (let index = 0; index < clients.length; index++) {
    await register(clients[index], `concurrent-${index}`);
    albums.push(await album(clients[index]));
  }
  const beforeAnalysis = await upload(clients[0], albums[0].id, [
    { name: 'analyze-me.jpg', bytes: image },
  ]);
  expectSuccess(beforeAnalysis.response, beforeAnalysis.body);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false,
    active = 0,
    peak = 0;
  const observed = new Set();
  for (const method of ['metadata', 'toFile', 'toBuffer', 'stats']) {
    const original = sharp.prototype[method];
    t.mock.method(sharp.prototype, method, async function (...args) {
      active++;
      peak = Math.max(peak, active);
      observed.add(method);
      try {
        if (method === 'toFile' && !held) {
          held = true;
          await gate;
        }
        return await original.apply(this, args);
      } finally {
        active--;
      }
    });
  }

  const pending = [];
  try {
    pending.push(upload(clients[0], albums[0].id, [{ name: 'held.jpg', bytes: image }]));
    await until(() => held);
    const analyzing = await clients[0].json(`/api/albums/${albums[0].id}/analyze`, {
      method: 'POST',
    });
    expectSuccess(analyzing.response, analyzing.body);
    pending.push(clients[1].json('/api/demo', { method: 'POST' }));
    pending.push(upload(clients[2], albums[2].id, [{ name: 'queued-a.jpg', bytes: image }]));
    pending.push(
      upload(clients[3], albums[3].id, [
        { name: 'broken-while-queued.jpg', bytes: Buffer.from('not a decodable image') },
        { name: 'queued-b.jpg', bytes: image },
      ]),
    );
    // Allow the admitted requests to receive their multipart bodies and wait.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const overloaded = await upload(clients[4], albums[4].id, [
      { name: 'retry-later.jpg', bytes: image },
    ]);
    assert.equal(overloaded.response.status, 503);
    assert.equal(overloaded.response.headers.get('Retry-After'), '3');
    assert.match(overloaded.body.error, /繁忙/);
    release();
    const completed = await Promise.all(pending);
    for (const result of completed) expectSuccess(result.response, result.body);
    assert.equal(
      completed[3].body.photos.length,
      1,
      'A failed queued image does not discard its valid peer',
    );
    assert.equal(completed[3].body.errors[0].filename, 'broken-while-queued.jpg');
    let status;
    const deadline = Date.now() + 5000;
    do {
      status = await detail(clients[0], albums[0].id);
      if (status.album.analysisStatus === 'complete') break;
      assert.notEqual(status.album.analysisStatus, 'error');
      assert.ok(Date.now() < deadline, 'Queued analysis completes after uploads');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
    assert.equal(
      peak,
      1,
      'Actual Sharp operations never overlap across accounts, analysis or demo',
    );
    assert.deepEqual(observed, new Set(['metadata', 'toFile', 'toBuffer', 'stats']));
    assert.deepEqual(await readdir(path.join(app.dataDir, 'tmp')), []);
    assert.equal((await detail(clients[4], albums[4].id)).photos.length, 0);
    const retry = await upload(clients[4], albums[4].id, [{ name: 'retried.jpg', bytes: image }]);
    expectSuccess(retry.response, retry.body);
  } finally {
    release();
    await Promise.allSettled(pending);
  }
});

test('fixed, random and slideshow covers persist and reject photos outside the project', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await register(client, 'covers');
  const first = await album(client, 'Cover project');
  const another = await album(client, 'Another owned project');
  const image = await sample();
  const uploaded = await upload(client, first.id, [
    { name: 'first.jpg', bytes: image },
    { name: 'second.jpg', bytes: image },
  ]);
  const outsider = await upload(client, another.id, [{ name: 'other-project.jpg', bytes: image }]);
  expectSuccess(uploaded.response, uploaded.body);
  expectSuccess(outsider.response, outsider.body);
  const ids = uploaded.body.photos.map((photo) => photo.id);
  for (const coverMode of ['fixed', 'random', 'slideshow']) {
    const changed = await client.json(`/api/albums/${first.id}`, {
      method: 'PATCH',
      json: { coverMode, coverPhotoId: ids[1], coverPhotoIds: ids, slideInterval: 7 },
    });
    expectSuccess(changed.response, changed.body);
    const saved = (await detail(client, first.id)).album;
    assert.equal(saved.coverMode, coverMode);
    assert.equal(saved.coverPhotoId, ids[1]);
    assert.deepEqual(saved.coverPhotoIds, ids);
    assert.equal(saved.slideInterval, 7);
  }
  for (const invalid of [
    { coverPhotoId: outsider.body.photos[0].id },
    { coverPhotoIds: [ids[0], outsider.body.photos[0].id] },
    { coverMode: 'unrecognized' },
    { slideInterval: 1 },
  ]) {
    const response = await client.request(`/api/albums/${first.id}`, {
      method: 'PATCH',
      json: invalid,
    });
    assert.equal(response.status, 400);
  }
  const retained = (await detail(client, first.id)).album;
  assert.equal(retained.coverMode, 'slideshow');
  assert.deepEqual(retained.coverPhotoIds, ids);
});

test('publication exposes metadata-free previews, deletion hides media and revocation closes public access', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const anonymous = app.client();
  const secondUser = app.client();
  await register(owner, 'publisher');
  await register(secondUser, 'visitor');
  const created = await album(owner, 'Public on purpose');
  const original = await sample('jpeg', true);
  assert.ok((await sharp(original).metadata()).exif);
  const uploaded = await upload(owner, created.id, [
    { name: 'private-metadata.jpg', bytes: original },
  ]);
  expectSuccess(uploaded.response, uploaded.body);
  const photo = uploaded.body.photos[0];
  assert.equal((await anonymous.json('/api/public/albums')).body.albums.length, 0);
  const publish = await owner.json(`/api/albums/${created.id}`, {
    method: 'PATCH',
    json: { isPublic: true },
  });
  expectSuccess(publish.response, publish.body);
  const publicRoute = `/api/public/albums/${created.slug}`;
  assert.equal((await anonymous.json(publicRoute)).body.photos.length, 1);
  assert.equal((await anonymous.json('/api/public/albums')).body.albums[0].id, created.id);
  for (const viewer of [anonymous, secondUser]) {
    for (const route of [photo.url, `${photo.url}?download=1`, photo.thumbnailUrl]) {
      const response = await viewer.request(route);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.exif, undefined);
      assert.notDeepEqual(bytes, original);
    }
  }
  const download = await owner.request(`${photo.url}?download=1`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);

  const removed = await owner.json(`/api/photos/${photo.id}`, {
    method: 'PATCH',
    json: { deleted: true },
  });
  expectSuccess(removed.response, removed.body);
  assert.equal((await detail(owner, created.id)).photos.length, 0);
  assert.equal((await anonymous.json(publicRoute)).body.photos.length, 0);
  expectDenied(await anonymous.request(photo.url));
  expectDenied(await anonymous.request(photo.thumbnailUrl));
  assert.equal((await owner.json('/api/trash')).body.photos[0].id, photo.id);
  assert.equal((await secondUser.json('/api/trash')).body.photos.length, 0);
  expectDenied(
    await secondUser.request(`/api/photos/${photo.id}`, {
      method: 'PATCH',
      json: { restore: true },
    }),
  );

  const restored = await owner.json(`/api/photos/${photo.id}`, {
    method: 'PATCH',
    json: { restore: true, pick: 'keep', rating: 5 },
  });
  expectSuccess(restored.response, restored.body);
  assert.equal(restored.body.photo.deletedAt, null);
  assert.equal((await owner.json('/api/trash')).body.photos.length, 0);
  assert.equal((await anonymous.json(publicRoute)).body.photos.length, 1);
  const revoke = await owner.json(`/api/albums/${created.id}`, {
    method: 'PATCH',
    json: { isPublic: false },
  });
  expectSuccess(revoke.response, revoke.body);
  assert.equal((await anonymous.json('/api/public/albums')).body.albums.length, 0);
  expectDenied(await anonymous.request(publicRoute));
  expectDenied(await anonymous.request(photo.url));
  expectDenied(await anonymous.request(photo.thumbnailUrl));
  assert.equal((await owner.request(photo.url)).status, 200);
});

test('background analysis identifies duplicate candidates without deleting or changing human picks', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await register(client, 'analysis');
  const created = await album(client, 'Selection project');
  const image = await sample('jpeg');
  const flat = await sharp({
    create: { width: 180, height: 120, channels: 3, background: '#777777' },
  })
    .png()
    .toBuffer();
  const uploaded = await upload(client, created.id, [
    { name: 'capture.jpg', bytes: image },
    { name: 'renamed-copy.jpg', bytes: image },
    { name: 'flat-test.png', bytes: flat, type: 'image/png' },
  ]);
  expectSuccess(uploaded.response, uploaded.body);
  const [first, second, flatPhoto] = uploaded.body.photos;
  const picked = await client.json(`/api/photos/${second.id}`, {
    method: 'PATCH',
    json: { pick: 'keep', rating: 4 },
  });
  expectSuccess(picked.response, picked.body);
  const started = await client.json(`/api/albums/${created.id}/analyze`, { method: 'POST' });
  expectSuccess(started.response, started.body);
  let analyzed;
  const deadline = Date.now() + 10000;
  do {
    analyzed = await detail(client, created.id);
    assert.notEqual(analyzed.album.analysisStatus, 'error');
    if (analyzed.album.analysisStatus === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.equal(
    analyzed.album.analysisStatus,
    'complete',
    'Analysis completes within the bounded test window',
  );
  assert.equal(analyzed.photos.length, 3, 'Candidate detection never deletes a photo');
  assert.equal(analyzed.album.stats.duplicates, 1);
  const firstResult = analyzed.photos.find((photo) => photo.id === first.id);
  const secondResult = analyzed.photos.find((photo) => photo.id === second.id);
  const duplicate = [firstResult, secondResult].find((photo) => photo.duplicateOf);
  const primary = [firstResult, secondResult].find((photo) => !photo.duplicateOf);
  assert.equal(duplicate.duplicateOf, primary.id);
  assert.ok(firstResult.groupId);
  assert.equal(firstResult.groupId, secondResult.groupId);
  assert.equal(secondResult.pick, 'keep');
  assert.equal(secondResult.rating, 4);
  assert.equal(analyzed.photos.find((photo) => photo.id === flatPhoto.id).blur, true);
  assert.equal((await client.json('/api/trash')).body.photos.length, 0);
});

test('authenticated event streams deliver project changes for real-time refresh', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.client().request('/api/events')).status, 401);
  const client = app.client();
  await register(client, 'realtime');
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('Timed out waiting for a real-time change')),
    4000,
  );
  deadline.unref();
  t.after(() => {
    clearTimeout(deadline);
    controller.abort();
  });
  const stream = await client.request('/api/events', { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('Content-Type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent(predicate) {
    while (true) {
      let separator;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) {
          const event = JSON.parse(data.slice(6));
          if (predicate(event)) return event;
        }
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'Event connection remains open until the change arrives');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  try {
    await nextEvent((event) => event.type === 'connected');
    const created = await album(client, 'Live project');
    const event = await nextEvent(
      (event) => event.type === 'change' && event.albumId === created.id,
    );
    assert.equal(event.albumId, created.id);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});
