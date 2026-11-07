import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadPhoto,
  normalizeReturnPath,
  publicAlbumToAlbum,
  publicPhotoToPhoto,
} from '../src/interactionFlow.ts';

const origin = 'https://album.example';

test('return paths preserve local navigation and normalize same-origin absolute URLs', () => {
  for (const path of ['/', '/explore?sort=latest#photo-1', '/p/%E4%BA%AC%E9%83%BD']) {
    assert.equal(normalizeReturnPath(path, origin), path);
  }
  assert.equal(
    normalizeReturnPath('https://album.example:443/p/one?tab=photos#two', origin),
    '/p/one?tab=photos#two',
  );
  assert.equal(normalizeReturnPath('https://ALBUM.EXAMPLE/explore', origin), '/explore');
  assert.equal(
    normalizeReturnPath('/explore?source=https%3A%2F%2Fexternal.example', origin),
    '/explore?source=https%3A%2F%2Fexternal.example',
  );
  assert.equal(normalizeReturnPath('/a/../explore', origin), '/explore');
  assert.equal(
    normalizeReturnPath('http://localhost:3001/explore', 'http://localhost:3001'),
    '/explore',
  );
});

test('return paths reject external, protocol-relative, credentialed and obfuscated redirects', () => {
  const blocked = [
    'https://external.example/p/one',
    'https://album.example.external.example/p/one',
    '//external.example',
    '///external.example',
    '\\external.example',
    '/\\external.example',
    'https://album.example\\@external.example/',
    'https://album.example@external.example/',
    'https://user:password@album.example/',
    'https://album.example//external.example',
    '/a/..//external.example',
    '/%2f%2fexternal.example',
    '/%252f%252fexternal.example',
    '/%5cexternal.example',
    '/%255cexternal.example',
    '/%252e%252e//external.example',
    '/%0d%0aLocation:external.example',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///private',
    'explore',
    ' /explore',
    '/explore\n',
    '/p/%E4',
  ];
  for (const input of blocked) assert.equal(normalizeReturnPath(input, origin), '/', input);
  assert.equal(normalizeReturnPath('/explore', 'javascript:alert(1)'), '/');
  assert.equal(normalizeReturnPath('/explore', 'not-an-origin'), '/');
});

test('public photo adaptation whitelists display fields and never invents private image metadata', () => {
  const raw = {
    id: 'photo-one',
    albumId: 'album-one',
    filename: '公开作品.jpg',
    width: 600,
    height: 900,
    createdAt: '2026-11-01T08:00:00Z',
    publishedAt: '2026-11-02T08:00:00Z',
    url: '/api/photos/photo-one/file',
    previewUrl: '/api/photos/photo-one/preview',
    thumbnailUrl: '/api/photos/photo-one/thumb',
    authorId: 'author-one',
    authorName: '摄影师',
    albumTitle: '公开影集',
    albumSlug: 'public-one',
    allowDownload: true,
    isFavorite: true,
    isFeatured: true,
    bytes: 12345678,
    mime: 'image/jpeg',
    capturedAt: 'SECRET-camera-date',
    sharpness: 123,
    blur: true,
    groupId: 'SECRET-group',
    duplicateOf: 'SECRET-original',
    pick: 'keep',
    rating: 5,
    deletedAt: 'SECRET-deletion',
    ownerEmail: 'SECRET@example.test',
    gps: 'SECRET-GPS',
    originalUrl: 'SECRET-original-url',
  };
  const photo = publicPhotoToPhoto(raw);
  assert.equal(photo.id, raw.id);
  assert.equal(photo.filename, raw.filename);
  assert.equal(photo.width, 600);
  assert.equal(photo.height, 900);
  assert.equal(photo.url, raw.previewUrl);
  assert.equal(photo.bytes, 0, 'The public response does not provide original byte size');
  assert.equal(photo.mime, '', 'Do not infer the original encoding from its filename or preview');
  assert.equal(photo.capturedAt, null);
  assert.equal(photo.sharpness, null);
  assert.equal(photo.blur, false);
  assert.equal(photo.groupId, null);
  assert.equal(photo.duplicateOf, null);
  assert.equal(photo.pick, 'none');
  assert.equal(photo.rating, 0);
  assert.equal(photo.deletedAt, null);
  assert.equal(photo.authorName, '摄影师');
  assert.equal(photo.authorId, 'author-one');
  assert.equal(photo.allowDownload, true);
  assert.equal(photo.isFavorite, true);
  assert.equal(photo.isFeatured, true);
  assert.equal(photo.isPublished, true);
  assert.equal(photo.publishedAt, raw.publishedAt);
  assert.doesNotMatch(JSON.stringify(photo), /SECRET/);
  for (const field of ['ownerEmail', 'gps', 'originalUrl'])
    assert.equal(Object.hasOwn(photo, field), false);
  const minimal = publicPhotoToPhoto({
    ...raw,
    allowDownload: undefined,
    isFavorite: undefined,
    isFeatured: undefined,
  });
  assert.equal(minimal.allowDownload, false);
  assert.equal(minimal.isFavorite, false);
  assert.equal(minimal.isFeatured, false);
});

test('public album adaptation preserves the published cover pool without private descriptions or statistics', () => {
  const raw = {
    id: 'album-one',
    title: '公开标题',
    publicTitle: '公开标题',
    createdAt: '2026-11-01T08:00:00Z',
    slug: 'public-one',
    photoCount: 2,
    isPublic: true,
    coverUrl: '/api/photos/published-one/preview',
    coverMode: 'slideshow',
    coverPhotoId: 'published-one',
    coverPhotoIds: ['published-one', 'published-two'],
    slideInterval: 12,
    description: 'SECRET-description',
    location: 'SECRET-location',
    stats: { duplicates: 123, similarGroups: 99, blurry: 5, kept: 7 },
    analysisStatus: 'complete',
    privateCoverIds: ['SECRET-private-photo'],
    ownerEmail: 'SECRET@example.test',
  };
  const album = publicAlbumToAlbum(raw);
  assert.equal(album.title, '公开标题');
  assert.equal(album.description, '');
  assert.equal(album.location, '');
  assert.equal(album.photoCount, 2);
  assert.equal(album.coverMode, 'slideshow');
  assert.equal(album.coverPhotoId, 'published-one');
  assert.deepEqual(album.coverPhotoIds, ['published-one', 'published-two']);
  assert.equal(album.slideInterval, 12);
  assert.deepEqual(album.stats, { duplicates: 0, similarGroups: 0, blurry: 0, kept: 0 });
  assert.equal(album.analysisStatus, 'idle');
  assert.doesNotMatch(JSON.stringify(album), /SECRET/);
  raw.coverPhotoIds.push('another-published-photo');
  assert.equal(
    album.coverPhotoIds.length,
    2,
    'A later source mutation must not change the display pool',
  );
  const minimal = publicAlbumToAlbum({ id: 'empty', title: '标题' });
  assert.equal(minimal.coverMode, 'fixed');
  assert.equal(minimal.coverPhotoId, null);
  assert.deepEqual(minimal.coverPhotoIds, []);
  assert.equal(minimal.slideInterval, 8);
  assert.equal(minimal.createdAt, '', 'A missing date does not become a fictional current date');
});

function downloadEnvironment(t, response, { clickError } = {}) {
  const anchor = {
    href: '',
    download: '',
    style: {},
    click: t.mock.fn(() => {
      if (clickError) throw clickError;
    }),
    remove: t.mock.fn(),
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return anchor;
      },
      body: {
        appendChild(node) {
          assert.equal(node, anchor);
        },
      },
    },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => response);
  const create = t.mock.method(URL, 'createObjectURL', () => 'blob:only-authorized-response');
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  return { anchor, fetch, create, revoke };
}

test('download fetches only the encoded authorized endpoint and saves its response Blob', async (t) => {
  const response = new Response(new Uint8Array([12, 34, 56]), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Disposition':
        "attachment; filename=photo.webp; filename*=UTF-8''..%2F%E4%BA%AC%E9%83%BD.webp",
    },
  });
  const env = downloadEnvironment(t, response);
  const id = '../photo?redirect=https://external.example/#fragment';
  await downloadPhoto(id);
  assert.equal(env.fetch.mock.callCount(), 1);
  const [url, options] = env.fetch.mock.calls[0].arguments;
  assert.equal(url, `/api/photos/${encodeURIComponent(id)}/download`);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(new Headers(options.headers).get('X-Album-Client'), '1');
  const blob = env.create.mock.calls[0].arguments[0];
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([12, 34, 56]));
  assert.equal(env.anchor.href, 'blob:only-authorized-response');
  assert.equal(env.anchor.download, '京都.webp');
  assert.equal(env.anchor.click.mock.callCount(), 1);
  assert.equal(env.anchor.remove.mock.callCount(), 1);
  assert.deepEqual(env.revoke.mock.calls[0].arguments, ['blob:only-authorized-response']);
});

test('a download denial propagates its server error and never creates a download or alternate request', async (t) => {
  const env = downloadEnvironment(t, Response.json({ error: '此作品不允许下载' }, { status: 403 }));
  await assert.rejects(downloadPhoto('photo-one'), /此作品不允许下载/);
  assert.equal(env.fetch.mock.callCount(), 1);
  assert.equal(env.create.mock.callCount(), 0);
  assert.equal(env.anchor.click.mock.callCount(), 0);
});

test('download errors support message responses and safely fall back for non-JSON failures', async (t) => {
  const env = downloadEnvironment(t, Response.json({ message: '请先登录' }, { status: 401 }));
  await assert.rejects(downloadPhoto('photo-one'), /请先登录/);
  env.fetch.mock.mockImplementation(
    async () => new Response('Service unavailable', { status: 503 }),
  );
  await assert.rejects(downloadPhoto('photo-one'), /下载失败（503）/);
  assert.equal(env.create.mock.callCount(), 0);
});

test('download filenames use a safe basename and temporary URLs are released even when clicking fails', async (t) => {
  const clickError = new Error('Browser prevented the download');
  const env = downloadEnvironment(
    t,
    new Response('image', {
      headers: { 'Content-Disposition': 'attachment; filename="C:\\private\\NUL.webp"' },
    }),
    { clickError },
  );
  await assert.rejects(downloadPhoto('photo-one'), /Browser prevented/);
  assert.equal(env.anchor.download, '_NUL.webp');
  assert.equal(env.anchor.remove.mock.callCount(), 1);
  assert.equal(env.revoke.mock.callCount(), 1);
});
