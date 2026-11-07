import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import { createApplication } from '../server/app.mjs';

const password = 'Publication-test-42!';
const inviteCode = process.env.INVITE_CODE || 'FRAME-FIRST-100';
const publicKeys = [
  'id',
  'albumId',
  'filename',
  'width',
  'height',
  'createdAt',
  'url',
  'previewUrl',
  'thumbnailUrl',
  'publishedAt',
  'allowDownload',
  'isFavorite',
  'isFeatured',
  'authorId',
  'authorName',
  'albumTitle',
  'albumSlug',
].sort();

async function fixture(t, existingDataDir) {
  const dataDir = existingDataDir || (await mkdtemp(path.join(tmpdir(), 'frame-publication-')));
  const application = await createApplication({ dataDir });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => {
      server.close(resolve);
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
      async request(route, { method = 'GET', json, form, headers = {} } = {}) {
        const requestHeaders = { ...headers };
        if (cookie) requestHeaders.Cookie = cookie;
        if (!['GET', 'HEAD'].includes(method)) requestHeaders['X-Album-Client'] = '1';
        if (json !== undefined) requestHeaders['Content-Type'] = 'application/json';
        const response = await fetch(origin + route, {
          method,
          headers: requestHeaders,
          body: form || (json === undefined ? undefined : JSON.stringify(json)),
        });
        for (const next of response.headers.getSetCookie()) cookie = next.split(';', 1)[0];
        return response;
      },
      async json(route, options) {
        const response = await this.request(route, options);
        return { response, body: await response.json() };
      },
    };
  }
  return { dataDir, stop, client, locals: application.app.locals };
}
const ok = ({ response, body }) =>
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
async function register(client, name) {
  const result = await client.json('/api/auth/register', {
    method: 'POST',
    json: { name, email: `${name}@example.test`, password, inviteCode },
  });
  ok(result);
  return result.body.user;
}
async function album(client, title = 'PRIVATE PROJECT TITLE') {
  const result = await client.json('/api/albums', {
    method: 'POST',
    json: {
      title,
      description: 'PRIVATE DESCRIPTION',
      location: 'PRIVATE LOCATION',
    },
  });
  ok(result);
  return result.body.album;
}
async function image() {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: '#426a71' } })
    .withMetadata({ exif: { IFD0: { ImageDescription: 'PRIVATE EXIF DESCRIPTION' } } })
    .jpeg()
    .toBuffer();
}
async function upload(client, albumId, names, bytes) {
  const photos = [];
  for (let start = 0; start < names.length; start += 3) {
    const form = new FormData();
    for (const name of names.slice(start, start + 3))
      form.append('photos', new Blob([bytes], { type: 'image/jpeg' }), name);
    const result = await client.json(`/api/albums/${albumId}/photos`, { method: 'POST', form });
    ok(result);
    photos.push(...result.body.photos);
  }
  return photos;
}
async function publish(client, albumId, ids, options = {}) {
  return client.json(`/api/albums/${albumId}/publication`, {
    method: 'PUT',
    json: {
      photoIds: ids,
      allowDownload: false,
      title: 'PUBLIC GALLERY TITLE',
      ...options,
    },
  });
}
async function detail(client, id) {
  const result = await client.json(`/api/albums/${id}`);
  ok(result);
  return result.body;
}

test('publication replaces only selected photos atomically and public DTOs never expose private fields or covers', async (t) => {
  const app = await fixture(t),
    owner = app.client(),
    other = app.client(),
    guest = app.client();
  await register(owner, 'selective-author');
  await register(other, 'different-author');
  const project = await album(owner),
    otherProject = await album(other);
  const bytes = await image();
  const photos = await upload(
    owner,
    project.id,
    ['public-a.jpg', 'public-b.jpg', 'PRIVATE-FILENAME.jpg'],
    bytes,
  );
  const foreign = (await upload(other, otherProject.id, ['foreign.jpg'], bytes))[0];
  ok(
    await owner.json(`/api/albums/${project.id}`, {
      method: 'PATCH',
      json: {
        coverPhotoId: photos[2].id,
        coverPhotoIds: photos.map((photo) => photo.id),
        coverMode: 'slideshow',
      },
    }),
  );
  assert.equal(
    (await owner.json(`/api/albums/${project.id}`, { method: 'PATCH', json: { isPublic: true } }))
      .response.status,
    400,
  );
  ok(
    await publish(owner, project.id, [photos[0].id, photos[1].id], {
      featuredPhotoIds: [photos[1].id],
    }),
  );
  const latest = await guest.json('/api/public/photos?sort=latest');
  ok(latest);
  assert.deepEqual(
    new Set(latest.body.photos.map((photo) => photo.id)),
    new Set(photos.slice(0, 2).map((photo) => photo.id)),
  );
  for (const photo of latest.body.photos) {
    assert.deepEqual(Object.keys(photo).sort(), publicKeys);
    assert.equal(photo.albumTitle, 'PUBLIC GALLERY TITLE');
    assert.equal(photo.url, `/api/photos/${photo.id}/preview`);
    assert.equal(photo.allowDownload, false);
  }
  const featured = await guest.json('/api/public/photos?sort=featured');
  ok(featured);
  assert.deepEqual(
    featured.body.photos.map((photo) => photo.id),
    [photos[1].id],
  );
  const publicAlbum = await guest.json(`/api/public/albums/${project.slug}`);
  ok(publicAlbum);
  assert.equal(publicAlbum.body.album.photoCount, 2);
  assert.ok(photos.slice(0, 2).some((photo) => photo.id === publicAlbum.body.album.coverPhotoId));
  const serialized = JSON.stringify(publicAlbum.body);
  for (const secret of [
    'PRIVATE PROJECT TITLE',
    'PRIVATE DESCRIPTION',
    'PRIVATE LOCATION',
    'PRIVATE-FILENAME.jpg',
    photos[2].id,
  ])
    assert.equal(serialized.includes(secret), false, `Public album excludes ${secret}`);
  assert.deepEqual(
    app.locals.publicAlbum(project.slug),
    publicAlbum.body,
    'SSR receives the same safe DTO',
  );
  assert.equal(app.locals.publicPhotos({ sort: 'latest' }).photos.length, 2);
  for (const viewer of [other, guest])
    for (const kind of ['file', 'preview', 'thumb'])
      assert.equal((await viewer.request(`/api/photos/${photos[2].id}/${kind}`)).status, 404);

  for (const invalid of [
    { photoIds: [photos[0].id, foreign.id] },
    { photoIds: [photos[0].id], featuredPhotoIds: [photos[1].id] },
    { photoIds: [photos[0].id, photos[0].id] },
    { photoIds: [photos[0].id], allowDownload: 'true' },
  ]) {
    const result = await publish(owner, project.id, [photos[0].id, photos[1].id], invalid);
    assert.equal(result.response.status, 400);
    const stillPublic = await guest.json(`/api/public/albums/${project.slug}`);
    ok(stillPublic);
    assert.equal(
      stillPublic.body.photos.length,
      2,
      'Invalid replacements do not partially withdraw existing photos',
    );
  }
  assert.equal((await publish(other, project.id, [photos[0].id])).response.status, 404);
  assert.equal((await publish(guest, project.id, [photos[0].id])).response.status, 401);
  ok(await publish(owner, project.id, [photos[0].id], { featuredPhotoIds: [] }));
  assert.equal(
    (await guest.json('/api/public/photos?sort=featured')).body.photos.length,
    0,
    'Featured is a real author-controlled filter',
  );
  assert.equal((await guest.json('/api/public/photos?sort=latest')).body.photos.length, 1);
  assert.equal((await guest.request(`/api/public/photos/${photos[1].id}`)).status, 404);
  const added = (await upload(owner, project.id, ['NEW-PRIVATE.jpg'], bytes))[0];
  assert.equal(added.isPublished, false);
  assert.equal((await guest.request(`/api/public/photos/${added.id}`)).status, 404);
  const own = await detail(owner, project.id);
  assert.equal(own.photos.length, 4);
  assert.equal(own.photos.find((photo) => photo.id === photos[0].id).isPublished, true);
  assert.equal(own.photos.find((photo) => photo.id === photos[1].id).isPublished, false);
});

test('download permission is enforced on every URL and favorites retain no withdrawn content', async (t) => {
  const app = await fixture(t),
    owner = app.client(),
    visitor = app.client(),
    guest = app.client();
  await register(owner, 'download-author');
  await register(visitor, 'favorite-reader');
  const project = await album(owner),
    bytes = await image();
  const [photo, privatePhoto] = await upload(
    owner,
    project.id,
    ['public.jpg', 'private.jpg'],
    bytes,
  );
  ok(await publish(owner, project.id, [photo.id]));
  const downloadRoutes = [
    `/api/photos/${photo.id}/download`,
    ...['file', 'preview', 'thumb'].map((kind) => `/api/photos/${photo.id}/${kind}?download=1`),
  ];
  for (const route of downloadRoutes) {
    assert.equal((await guest.request(route)).status, 401);
    assert.equal((await visitor.request(route)).status, 403);
    const original = await owner.request(route);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  }
  for (const kind of ['file', 'preview', 'thumb']) {
    const preview = await guest.request(`/api/photos/${photo.id}/${kind}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('Cache-Control'), /no-store/);
    const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.exif, undefined);
  }
  assert.equal((await visitor.request(`/api/photos/${privatePhoto.id}/download`)).status, 404);
  assert.equal((await owner.request(`/api/photos/${privatePhoto.id}/download`)).status, 200);
  assert.equal((await guest.request('/api/favorites')).status, 401);
  assert.equal(
    (
      await guest.json(`/api/photos/${photo.id}/favorite`, {
        method: 'PUT',
        json: { favorite: true },
      })
    ).response.status,
    401,
  );
  assert.equal(
    (
      await visitor.json(`/api/photos/${privatePhoto.id}/favorite`, {
        method: 'PUT',
        json: { favorite: true },
      })
    ).response.status,
    404,
  );
  for (let index = 0; index < 2; index++)
    ok(
      await visitor.json(`/api/photos/${photo.id}/favorite`, {
        method: 'PUT',
        json: { favorite: true },
      }),
    );
  let favorites = await visitor.json('/api/favorites');
  ok(favorites);
  assert.equal(favorites.body.photos.length, 1);
  assert.equal(favorites.body.unavailableCount, 0);
  assert.equal(favorites.body.photos[0].isFavorite, true);
  assert.deepEqual(Object.keys(favorites.body.photos[0]).sort(), publicKeys);
  assert.equal((await owner.json('/api/favorites')).body.photos.length, 0);
  assert.equal((await visitor.json(`/api/public/photos/${photo.id}`)).body.photo.isFavorite, true);
  ok(await publish(owner, project.id, [photo.id], { allowDownload: true }));
  let etag;
  for (const route of downloadRoutes) {
    const response = await visitor.request(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition'), /attachment/);
    etag = response.headers.get('ETag');
    const data = Buffer.from(await response.arrayBuffer());
    assert.notDeepEqual(data, bytes);
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.exif, undefined);
  }
  ok(await publish(owner, project.id, [photo.id], { allowDownload: false }));
  assert.equal(
    (await visitor.request(downloadRoutes[0], { headers: etag ? { 'If-None-Match': etag } : {} }))
      .status,
    403,
  );
  ok(await publish(owner, project.id, []));
  for (const kind of ['file', 'preview', 'thumb', 'download'])
    assert.equal((await visitor.request(`/api/photos/${photo.id}/${kind}`)).status, 404);
  assert.equal((await guest.request(`/api/public/photos/${photo.id}`)).status, 404);
  favorites = await visitor.json('/api/favorites');
  ok(favorites);
  assert.deepEqual(favorites.body, { photos: [], unavailableCount: 1 });
  assert.equal(JSON.stringify(favorites.body).includes(photo.id), false);
  assert.equal(
    (
      await visitor.json(`/api/photos/${photo.id}/favorite`, {
        method: 'PUT',
        json: { favorite: true },
      })
    ).response.status,
    404,
  );
  ok(
    await visitor.json(`/api/photos/${photo.id}/favorite`, {
      method: 'PUT',
      json: { favorite: false },
    }),
  );
  assert.deepEqual((await visitor.json('/api/favorites')).body, {
    photos: [],
    unavailableCount: 0,
  });
  ok(await publish(owner, project.id, [photo.id]));
  ok(
    await visitor.json(`/api/photos/${photo.id}/favorite`, {
      method: 'PUT',
      json: { favorite: true },
    }),
  );
  ok(await owner.json(`/api/photos/${photo.id}`, { method: 'PATCH', json: { deleted: true } }));
  assert.deepEqual((await visitor.json('/api/favorites')).body, {
    photos: [],
    unavailableCount: 1,
  });
  ok(await owner.json(`/api/photos/${photo.id}`, { method: 'PATCH', json: { restore: true } }));
  assert.equal(
    (await guest.request(`/api/public/photos/${photo.id}`)).status,
    404,
    'Restore never silently republishes',
  );
  const restored = (await detail(owner, project.id)).photos.find((item) => item.id === photo.id);
  assert.equal(restored.isPublished, false);
  assert.equal(restored.allowDownload, false);
  assert.equal(restored.isFeatured, false);
});

test('public search and stable cursor pagination cannot include private photos or change query scope', async (t) => {
  const app = await fixture(t),
    owner = app.client(),
    guest = app.client();
  await register(owner, 'searchable-author');
  const project = await album(owner, 'PRIVATE-SHOOT-NAME'),
    bytes = await image();
  const photos = await upload(
    owner,
    project.id,
    ['100% real.jpg', '100X real.jpg', 'alpha.jpg', 'beta.jpg', 'gamma.jpg', 'PRIVATE-ONLY.jpg'],
    bytes,
  );
  ok(
    await publish(
      owner,
      project.id,
      photos.slice(0, 5).map((item) => item.id),
      {
        title: 'Mountain Stories',
        featuredPhotoIds: [photos[0].id, photos[2].id],
      },
    ),
  );
  const seen = [],
    cursors = [];
  let cursor = '';
  do {
    const page = await guest.json(
      `/api/public/photos?sort=latest&limit=2${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    );
    ok(page);
    seen.push(...page.body.photos.map((photo) => photo.id));
    cursor = page.body.nextCursor;
    if (cursor) cursors.push(cursor);
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual(new Set(seen), new Set(photos.slice(0, 5).map((item) => item.id)));
  for (const changed of [
    'sort=featured&limit=2',
    'sort=latest&limit=2&q=Mountain',
    'sort=latest&limit=3',
  ])
    assert.equal(
      (
        await guest.request(
          `/api/public/photos?${changed}&cursor=${encodeURIComponent(cursors[0])}`,
        )
      ).status,
      400,
    );
  for (const invalid of ['limit=0', 'limit=101', 'sort=random', 'cursor=not-valid-json'])
    assert.equal((await guest.request('/api/public/photos?' + invalid)).status, 400);
  for (const query of ['Mountain Stories', 'searchable-author']) {
    const result = await guest.json(
      '/api/public/photos?sort=latest&q=' + encodeURIComponent(query),
    );
    ok(result);
    assert.equal(result.body.photos.length, 5);
  }
  for (const query of ['PRIVATE-SHOOT-NAME', 'PRIVATE-ONLY.jpg']) {
    const result = await guest.json(
      '/api/public/photos?sort=latest&q=' + encodeURIComponent(query),
    );
    ok(result);
    assert.equal(result.body.photos.length, 0);
  }
  const literal = await guest.json(
    '/api/public/photos?sort=latest&q=' + encodeURIComponent('100%'),
  );
  ok(literal);
  assert.deepEqual(
    literal.body.photos.map((photo) => photo.id),
    [photos[0].id],
    'Search treats SQL wildcards as literal text',
  );
  const deep = await guest.json(`/api/public/photos/${photos[4].id}`);
  ok(deep);
  assert.equal(deep.body.photo.id, photos[4].id);
  assert.deepEqual(Object.keys(deep.body.photo).sort(), publicKeys);
  assert.equal((await guest.request(`/api/public/photos/${photos[5].id}`)).status, 404);
});

async function seedLegacyDatabase(dataDir, bytes) {
  const db = new DatabaseSync(path.join(dataDir, 'album.sqlite'));
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE albums(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,cover_mode TEXT NOT NULL DEFAULT 'fixed',cover_photo_id TEXT,cover_photo_ids TEXT NOT NULL DEFAULT '[]',slide_interval INTEGER NOT NULL DEFAULT 8,is_public INTEGER NOT NULL DEFAULT 0,slug TEXT NOT NULL UNIQUE,analysis_status TEXT NOT NULL DEFAULT 'idle');
    CREATE TABLE photos(id TEXT PRIMARY KEY,album_id TEXT NOT NULL REFERENCES albums(id),filename TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL,mime TEXT NOT NULL,extension TEXT NOT NULL,created_at TEXT NOT NULL,sha256 TEXT NOT NULL,phash TEXT,color TEXT,sharpness REAL,blur INTEGER NOT NULL DEFAULT 0,group_id TEXT,duplicate_of TEXT,pick TEXT NOT NULL DEFAULT 'none',rating INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,analyzed INTEGER NOT NULL DEFAULT 0);
  `);
  const stamp = '2026-01-01T00:00:00.000Z',
    salt = 'legacy-salt';
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(
    'legacy-owner',
    'Legacy Author',
    'legacy@example.test',
    salt,
    scryptSync(password, salt, 64).toString('hex'),
    stamp,
  );
  const insertAlbum = db.prepare(
    'INSERT INTO albums(id,user_id,title,created_at,is_public,slug) VALUES(?,?,?,?,?,?)',
  );
  insertAlbum.run(
    'old-public',
    'legacy-owner',
    'Legacy Public Title',
    stamp,
    1,
    'retained-old-slug',
  );
  insertAlbum.run(
    'old-private',
    'legacy-owner',
    'Legacy Private Title',
    stamp,
    0,
    'old-private-slug',
  );
  const insert = db.prepare(
    'INSERT INTO photos(id,album_id,filename,width,height,bytes,mime,extension,created_at,sha256,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const [id, albumId, deleted] of [
    ['legacy-a', 'old-public', null],
    ['legacy-b', 'old-public', null],
    ['legacy-trash', 'old-public', stamp],
    ['legacy-private', 'old-private', null],
  ])
    insert.run(
      id,
      albumId,
      `${id}.jpg`,
      120,
      80,
      bytes.length,
      'image/jpeg',
      'jpg',
      stamp,
      createHash('sha256').update(bytes).digest('hex'),
      deleted,
    );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM pragma_table_info('photos') WHERE name='is_published'")
      .get().n,
    0,
  );
  db.close();
  for (const dir of ['originals', 'previews', 'thumbs'])
    await mkdir(path.join(dataDir, dir), { recursive: true });
  const preview = await sharp(bytes).webp().toBuffer();
  for (const id of ['legacy-a', 'legacy-b', 'legacy-trash', 'legacy-private']) {
    await writeFile(path.join(dataDir, 'originals', id + '.jpg'), bytes);
    await writeFile(path.join(dataDir, 'previews', id + '.webp'), preview);
    await writeFile(path.join(dataDir, 'thumbs', id + '.webp'), preview);
  }
}

test('legacy public photos migrate once with slug retained, downloads disabled and future uploads private', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-legacy-publication-'));
  const applications = [];
  t.after(async () => {
    for (const app of applications) await app.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const bytes = await image();
  await seedLegacyDatabase(dataDir, bytes);
  const first = await fixture(t, dataDir);
  applications.push(first);
  const owner = first.client(),
    guest = first.client();
  ok(
    await owner.json('/api/auth/login', {
      method: 'POST',
      json: { email: 'legacy@example.test', password },
    }),
  );
  const migrated = await guest.json('/api/public/albums/retained-old-slug');
  ok(migrated);
  assert.deepEqual(
    new Set(migrated.body.photos.map((photo) => photo.id)),
    new Set(['legacy-a', 'legacy-b']),
  );
  assert.ok(
    migrated.body.photos.every(
      (photo) => photo.allowDownload === false && photo.isFeatured === true,
    ),
  );
  assert.equal((await guest.request('/api/photos/legacy-trash/preview')).status, 404);
  assert.equal((await guest.request('/api/photos/legacy-private/file')).status, 404);
  const newPhoto = (await upload(owner, 'old-public', ['future-private.jpg'], bytes))[0];
  assert.equal(newPhoto.isPublished, false);
  ok(await publish(owner, 'old-public', ['legacy-b'], { title: 'New public title' }));
  const cookie = owner.cookie;
  await first.stop();
  const second = await fixture(t, dataDir);
  applications.push(second);
  const resumed = second.client(cookie),
    anonymous = second.client();
  const unchanged = await anonymous.json('/api/public/albums/retained-old-slug');
  ok(unchanged);
  assert.deepEqual(
    unchanged.body.photos.map((photo) => photo.id),
    ['legacy-b'],
  );
  assert.equal(unchanged.body.album.title, 'New public title');
  assert.equal((await anonymous.request(`/api/public/photos/${newPhoto.id}`)).status, 404);
  assert.equal((await anonymous.request('/api/public/photos/legacy-a')).status, 404);
  assert.equal((await detail(resumed, 'old-public')).photos.length, 3);
  await second.stop();
  const db = new DatabaseSync(path.join(dataDir, 'album.sqlite'));
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM schema_migrations WHERE name='photo-publication-v1'")
      .get().n,
    1,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM photos WHERE is_published=1').get().n, 1);
  db.close();
});

test('an interrupted publication migration rolls back its schema, data and migration marker together', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-migration-rollback-'));
  let application;
  t.after(async () => {
    if (application) await application.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await seedLegacyDatabase(dataDir, await image());
  let db = new DatabaseSync(path.join(dataDir, 'album.sqlite'));
  db.exec(
    "CREATE TRIGGER reject_migration BEFORE UPDATE ON photos BEGIN SELECT RAISE(ABORT,'controlled migration failure'); END",
  );
  db.close();
  await assert.rejects(createApplication({ dataDir }), /controlled migration failure/);
  db = new DatabaseSync(path.join(dataDir, 'album.sqlite'));
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM pragma_table_info('photos') WHERE name='is_published'")
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('schema_migrations','favorites')",
      )
      .get().n,
    0,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM photos').get().n, 4);
  db.exec('DROP TRIGGER reject_migration');
  db.close();
  application = await createApplication({ dataDir });
  assert.equal(application.app.locals.publicAlbum('retained-old-slug').photos.length, 2);
});

test('production root, explore and legacy-slug HTML render published photos without private metadata', async (t) => {
  const app = await fixture(t),
    owner = app.client();
  await register(owner, 'ssr-author');
  const project = await album(owner),
    photos = await upload(owner, project.id, ['visible.jpg', 'PRIVATE-IMAGE.jpg'], await image());
  ok(
    await owner.json(`/api/albums/${project.id}`, {
      method: 'PATCH',
      json: { coverPhotoId: photos[1].id },
    }),
  );
  ok(await publish(owner, project.id, [photos[0].id], { title: '<b>Safe public title</b>' }));
  await app.stop();

  // A minimal temporary dist makes this test independent of frontend builds.
  // The production entry is copied unchanged; its app stub re-exports the real
  // staged application rather than copying dependencies or touching real data.
  const root = await mkdtemp(path.join(tmpdir(), 'frame-ssr-entry-'));
  await mkdir(path.join(root, 'server'));
  await mkdir(path.join(root, 'dist'));
  await copyFile(
    new URL('../server/index.mjs', import.meta.url),
    path.join(root, 'server', 'index.mjs'),
  );
  await writeFile(
    path.join(root, 'server', 'app.mjs'),
    `export { createApplication } from ${JSON.stringify(new URL('../server/app.mjs', import.meta.url).href)};\n`,
  );
  await writeFile(
    path.join(root, 'dist', 'index.html'),
    '<!doctype html><html><head><title>Test</title><meta name="description" content="Test"></head><body><div id="root"></div></body></html>',
  );
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      DATA_DIR: app.dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_ORIGIN: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => {
    logs += data;
  });
  child.stderr.on('data', (data) => {
    logs += data;
  });
  try {
    const deadline = Date.now() + 7000;
    while (true) {
      assert.equal(child.exitCode, null, logs);
      try {
        if ((await fetch(origin + '/api/auth/session', { signal: AbortSignal.timeout(500) })).ok)
          break;
      } catch {
        /* The process is still opening its temporary database. */
      }
      assert.ok(Date.now() < deadline, logs || 'Production fixture did not start');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const route of ['/', '/explore', `/p/${project.slug}`]) {
      const response = await fetch(origin + route),
        html = await response.text();
      assert.equal(response.status, 200, html);
      assert.ok(html.includes(photos[0].thumbnailUrl));
      assert.ok(html.includes('&lt;b&gt;Safe public title&lt;/b&gt;'));
      for (const secret of [
        photos[1].id,
        'PRIVATE-IMAGE.jpg',
        'PRIVATE PROJECT TITLE',
        'PRIVATE DESCRIPTION',
        'PRIVATE LOCATION',
      ])
        assert.equal(html.includes(secret), false, `${route} leaked ${secret}`);
      assert.equal(html.includes('<b>Safe public title</b>'), false);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
