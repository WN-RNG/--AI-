import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readdir, rename, rm, stat, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
// libvips' open-file cache can retain upload/thumbnail handles on Windows,
// preventing an original from being moved or a closed application's data removed.
sharp.cache({ files: 0 });
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const SESSION_DAYS = 30;
const COOKIE = 'frame_session';
const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const problem = (status, message) => Object.assign(new Error(message), { status });
const timestamp = () => new Date().toISOString();
const hashToken = value => createHash('sha256').update(value).digest('hex');
const textValue = (value, max, label, fallback = '') => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length > max) throw problem(400, `${label}格式不正确`);
  return value.trim();
};

/** All files are private on disk. Public image routes explicitly check publication. */
export async function createApplication({ dataDir, demoDir, allowedOrigins = [] } = {}) {
  if (!dataDir) throw new Error('createApplication requires dataDir');
  dataDir = path.resolve(dataDir);
  const dirs = Object.fromEntries(['originals', 'previews', 'thumbs', 'tmp'].map(key => [key, path.join(dataDir, key)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));
  const db = new DatabaseSync(path.join(dataDir, 'album.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      cover_mode TEXT NOT NULL DEFAULT 'fixed', cover_photo_id TEXT,
      cover_photo_ids TEXT NOT NULL DEFAULT '[]', slide_interval INTEGER NOT NULL DEFAULT 8,
      is_public INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL UNIQUE,
      analysis_status TEXT NOT NULL DEFAULT 'idle'
    );
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL REFERENCES albums(id), filename TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
      extension TEXT NOT NULL, created_at TEXT NOT NULL, sha256 TEXT NOT NULL,
      phash TEXT, color TEXT, sharpness REAL, blur INTEGER NOT NULL DEFAULT 0,
      group_id TEXT, duplicate_of TEXT, pick TEXT NOT NULL DEFAULT 'none',
      rating INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, analyzed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS photos_album ON photos(album_id, deleted_at);
    CREATE INDEX IF NOT EXISTS albums_user ON albums(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  // A restarted worker can safely retry cached analysis; it never leaves a permanent spinner.
  db.prepare("UPDATE albums SET analysis_status = 'idle' WHERE analysis_status IN ('queued','analyzing')").run();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Album-Client') !== '1') return next(problem(403, '请求校验失败，请刷新页面后重试'));
      const origin = req.get('origin');
      if (origin) {
        const allowed = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
        try {
          const requestOrigin = new URL(origin).origin;
          if (requestOrigin !== new URL(allowed).origin && !allowedOrigins.includes(requestOrigin)) throw new Error();
        }
        catch { return next(problem(403, '不允许跨站操作')); }
      }
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, _res, next) => {
    if (req.body !== undefined && (req.body === null || Array.isArray(req.body) || typeof req.body !== 'object')) return next(problem(400, '请求内容需要为对象'));
    req.body ||= {};
    next();
  });
  app.use('/api', (req, _res, next) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (raw && /^[a-f0-9]{64}$/.test(raw)) {
      req.sessionHash = hashToken(raw);
      req.user = db.prepare(`SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>?`).get(req.sessionHash, Date.now());
    }
    next();
  });
  const requireUser = (req, _res, next) => req.user ? next() : next(problem(401, '请先登录'));
  const ownAlbum = (id, uid) => {
    const album = db.prepare('SELECT * FROM albums WHERE id=? AND user_id=?').get(id, uid);
    if (!album) throw problem(404, '相册不存在');
    return album;
  };
  const ownPhoto = (id, uid) => {
    const photo = db.prepare('SELECT p.* FROM photos p JOIN albums a ON a.id=p.album_id WHERE p.id=? AND a.user_id=?').get(id, uid);
    if (!photo) throw problem(404, '照片不存在');
    return photo;
  };
  const photoJSON = row => ({
    id: row.id, albumId: row.album_id, filename: row.filename, width: row.width, height: row.height,
    bytes: row.bytes, mime: row.mime, createdAt: row.created_at, capturedAt: null,
    sharpness: row.sharpness, blur: !!row.blur, groupId: row.group_id, duplicateOf: row.duplicate_of,
    pick: row.pick, rating: row.rating, deletedAt: row.deleted_at,
    url: `/api/photos/${row.id}/file`, previewUrl: `/api/photos/${row.id}/preview`, thumbnailUrl: `/api/photos/${row.id}/thumb`,
  });
  const albumJSON = row => {
    const active = db.prepare('SELECT * FROM photos WHERE album_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(row.id);
    const covers = JSON.parse(row.cover_photo_ids).filter(id => active.some(photo => photo.id === id));
    const cover = active.find(photo => photo.id === row.cover_photo_id) || active.find(photo => covers.includes(photo.id)) || active[0];
    return {
      id: row.id, title: row.title, description: row.description, location: row.location, createdAt: row.created_at,
      coverMode: row.cover_mode, coverPhotoId: active.some(photo => photo.id === row.cover_photo_id) ? row.cover_photo_id : null,
      coverPhotoIds: covers, slideInterval: row.slide_interval,
      isPublic: !!row.is_public, slug: row.slug, photoCount: active.length,
      coverUrl: cover ? `/api/photos/${cover.id}/preview` : null, analysisStatus: row.analysis_status,
      stats: { duplicates: active.filter(p => p.duplicate_of).length, similarGroups: new Set(active.map(p => p.group_id).filter(Boolean)).size,
        blurry: active.filter(p => p.blur).length, kept: active.filter(p => p.pick === 'keep').length },
    };
  };
  const clients = new Map();
  let closed = false;
  const notify = (uid, event) => {
    if (closed) return;
    for (const response of clients.get(uid) || []) {
      if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const setSession = (req, res, userId) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_DAYS * 86400000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
  };
  const loginAttempts = new Map();
  const authRateLimit = (req, _res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.until < now) loginAttempts.set(key, { count: 1, until: now + 15 * 60000 });
    else if (++entry.count > 30) return next(problem(429, '尝试次数较多，请稍后再试'));
    if (loginAttempts.size > 5000) for (const [ip, value] of loginAttempts) if (value.until < now) loginAttempts.delete(ip);
    next();
  };
  app.get('/api/auth/session', (req, res) => res.json({ user: req.user || null }));
  app.post('/api/auth/register', authRateLimit, asyncRoute(async (req, res) => {
    const name = textValue(req.body.name, 60, '昵称');
    const email = textValue(req.body.email, 254, '邮箱').toLowerCase();
    const password = req.body.password;
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem(400, '请填写有效的昵称和邮箱');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw problem(400, '密码需要 8 至 128 个字符');
    if (req.body.inviteCode !== (process.env.INVITE_CODE || 'FRAME-FIRST-100')) throw problem(403, '邀请码不正确');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw problem(409, '该邮箱已注册');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    const user = { id: randomUUID(), name, email };
    try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id, name, email, salt, passwordHash, timestamp()); }
    catch (error) { if (error.code?.includes('CONSTRAINT') || /UNIQUE constraint failed: users.email/.test(error.message)) throw problem(409, '该邮箱已注册'); throw error; }
    setSession(req, res, user.id);
    res.status(201).json({ user });
  }));
  app.post('/api/auth/login', authRateLimit, asyncRoute(async (req, res) => {
    const email = textValue(req.body.email, 254, '邮箱').toLowerCase();
    const password = req.body.password;
    if (typeof password !== 'string' || password.length > 128) throw problem(400, '邮箱或密码不正确');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const actual = await scrypt(password, user?.salt || 'not-an-existing-account', 64);
    if (!user || !timingSafeEqual(actual, Buffer.from(user.password_hash, 'hex'))) throw problem(401, '邮箱或密码不正确');
    setSession(req, res, user.id);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  }));
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    for (const response of clients.get(req.user?.id) || []) response.end();
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/albums', requireUser, (req, res) => res.json({ albums: db.prepare('SELECT * FROM albums WHERE user_id=? ORDER BY created_at DESC,id DESC').all(req.user.id).map(albumJSON) }));
  const createAlbum = (uid, input) => {
    const title = textValue(input.title, 120, '相册名称');
    if (!title) throw problem(400, '请填写相册名称');
    const id = randomUUID();
    db.prepare('INSERT INTO albums(id,user_id,title,description,location,created_at,slug) VALUES(?,?,?,?,?,?,?)').run(
      id, uid, title, textValue(input.description, 2000, '相册描述'), textValue(input.location, 120, '拍摄地点'), timestamp(), randomBytes(9).toString('hex'));
    return db.prepare('SELECT * FROM albums WHERE id=?').get(id);
  };
  app.post('/api/albums', requireUser, (req, res) => {
    const album = createAlbum(req.user.id, req.body);
    notify(req.user.id, { type: 'change', albumId: album.id });
    res.status(201).json({ album: albumJSON(album) });
  });
  app.get('/api/albums/:id', requireUser, (req, res) => {
    const album = ownAlbum(req.params.id, req.user.id);
    res.json({ album: albumJSON(album), photos: db.prepare('SELECT * FROM photos WHERE album_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(album.id).map(photoJSON) });
  });
  app.patch('/api/albums/:id', requireUser, (req, res) => {
    const album = ownAlbum(req.params.id, req.user.id);
    const input = req.body;
    if (input.title !== undefined) { album.title = textValue(input.title, 120, '相册名称'); if (!album.title) throw problem(400, '请填写相册名称'); }
    if (input.description !== undefined) album.description = textValue(input.description, 2000, '相册描述');
    if (input.location !== undefined) album.location = textValue(input.location, 120, '拍摄地点');
    if (input.coverMode !== undefined) {
      if (!['fixed', 'random', 'slideshow'].includes(input.coverMode)) throw problem(400, '封面模式不正确');
      album.cover_mode = input.coverMode;
    }
    const assertCover = id => {
      if (typeof id !== 'string' || !db.prepare('SELECT id FROM photos WHERE id=? AND album_id=? AND deleted_at IS NULL').get(id, album.id)) throw problem(400, '封面必须是当前相册中的照片');
      return id;
    };
    if (input.coverPhotoId !== undefined) album.cover_photo_id = input.coverPhotoId === null ? null : assertCover(input.coverPhotoId);
    if (input.coverPhotoIds !== undefined) {
      if (!Array.isArray(input.coverPhotoIds) || input.coverPhotoIds.length > 100) throw problem(400, '轮播照片数量不正确');
      album.cover_photo_ids = JSON.stringify([...new Set(input.coverPhotoIds.map(assertCover))]);
    }
    if (input.slideInterval !== undefined) {
      if (!Number.isInteger(input.slideInterval) || input.slideInterval < 3 || input.slideInterval > 30) throw problem(400, '轮播间隔需要为 3 至 30 秒');
      album.slide_interval = input.slideInterval;
    }
    if (input.isPublic !== undefined) {
      if (typeof input.isPublic !== 'boolean') throw problem(400, '公开设置格式不正确');
      album.is_public = Number(input.isPublic);
    }
    db.prepare('UPDATE albums SET title=?,description=?,location=?,cover_mode=?,cover_photo_id=?,cover_photo_ids=?,slide_interval=?,is_public=? WHERE id=?').run(
      album.title, album.description, album.location, album.cover_mode, album.cover_photo_id, album.cover_photo_ids, album.slide_interval, album.is_public, album.id);
    notify(req.user.id, { type: 'change', albumId: album.id });
    res.json({ album: albumJSON(album) });
  });

  const upload = multer({
    storage: multer.diskStorage({ destination: dirs.tmp, filename: (_req, _file, done) => done(null, randomUUID()) }),
    limits: { fileSize: MAX_BYTES, files: 30, fields: 5, parts: 35 },
  }).array('photos', 30);
  const fileDigest = async filename => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  };
  const insertImage = async (albumId, tempPath, rawName) => {
    const metadata = await sharp(tempPath, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false }).metadata();
    if (!formats[metadata.format] || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw problem(400, '仅支持静态 JPG、PNG、WebP 图片');
    if (metadata.width * metadata.height > MAX_PIXELS || Math.max(metadata.width, metadata.height) > 25000) throw problem(400, '图片尺寸过大，请控制在 8000 万像素以内');
    const size = (await stat(tempPath)).size;
    if (size > MAX_BYTES) throw problem(400, '单张照片不能超过 20MB');
    const id = randomUUID();
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    const paths = [path.join(dirs.originals, `${id}.${extension}`), path.join(dirs.previews, `${id}.webp`), path.join(dirs.thumbs, `${id}.webp`)];
    try {
      const digest = await fileDigest(tempPath);
      await sharp(tempPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toFile(paths[1]);
      await sharp(tempPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(paths[2]);
      await rename(tempPath, paths[0]);
      const swapped = [5, 6, 7, 8].includes(metadata.orientation);
      const filename = path.basename(rawName.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || `photo.${extension}`;
      db.prepare('INSERT INTO photos(id,album_id,filename,width,height,bytes,mime,extension,created_at,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        id, albumId, filename, swapped ? metadata.height : metadata.width, swapped ? metadata.width : metadata.height,
        size, formats[metadata.format], extension, timestamp(), digest);
      return db.prepare('SELECT * FROM photos WHERE id=?').get(id);
    } catch (error) {
      await Promise.all(paths.map(file => rm(file, { force: true }).catch(() => {})));
      throw error;
    }
  };
  app.post('/api/albums/:id/photos', requireUser, (req, res, next) => {
    try { ownAlbum(req.params.id, req.user.id); } catch (error) { return next(error); }
    upload(req, res, error => {
      if (error) {
        // Multer removes partial disk files on failure; repeat defensively after malformed bodies.
        Promise.all((req.files || []).map(file => rm(file.path, { force: true }).catch(() => {}))).then(() => next(error));
        return;
      }
      (async () => {
        const photos = [], errors = [];
        if (!req.files?.length) throw problem(400, '请选择需要上传的照片');
        try {
          for (const file of req.files) {
            try { photos.push(photoJSON(await insertImage(req.params.id, file.path, Buffer.from(file.originalname, 'latin1').toString('utf8')))); }
            catch (error) { errors.push({ filename: file.originalname, error: error.status ? error.message : '图片无法读取，请确认格式正确且文件完整' }); }
            finally { await rm(file.path, { force: true }).catch(() => {}); }
          }
        } finally { await Promise.all(req.files.map(file => rm(file.path, { force: true }).catch(() => {}))); }
        if (photos.length) db.prepare("UPDATE albums SET analysis_status='idle' WHERE id=? AND analysis_status NOT IN ('queued','analyzing')").run(req.params.id);
        notify(req.user.id, { type: 'change', albumId: req.params.id });
        res.status(photos.length ? 201 : 400).json({ photos, errors, ...(photos.length ? {} : { error: '没有可上传的有效照片' }) });
      })().catch(next);
    });
  });
  app.patch('/api/photos/:id', requireUser, (req, res) => {
    const photo = ownPhoto(req.params.id, req.user.id);
    const input = req.body;
    if (input.pick !== undefined) {
      if (!['none', 'keep', 'reject'].includes(input.pick)) throw problem(400, '选片标记不正确');
      photo.pick = input.pick;
    }
    if (input.rating !== undefined) {
      if (!Number.isInteger(input.rating) || input.rating < 0 || input.rating > 5) throw problem(400, '评分需要为 0 至 5 星');
      photo.rating = input.rating;
    }
    if (input.deleted === true) photo.deleted_at = timestamp();
    if (input.restore === true || input.deleted === false) photo.deleted_at = null;
    db.prepare('UPDATE photos SET pick=?,rating=?,deleted_at=? WHERE id=?').run(photo.pick, photo.rating, photo.deleted_at, photo.id);
    notify(req.user.id, { type: 'change', albumId: photo.album_id });
    res.json({ photo: photoJSON(photo) });
  });
  app.get('/api/trash', requireUser, (req, res) => res.json({ photos: db.prepare(`SELECT p.* FROM photos p JOIN albums a ON a.id=p.album_id
    WHERE a.user_id=? AND p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`).all(req.user.id).map(photoJSON) }));
  for (const kind of ['file', 'preview', 'thumb']) app.get(`/api/photos/:id/${kind}`, asyncRoute(async (req, res) => {
    const photo = db.prepare('SELECT p.*, a.user_id, a.is_public FROM photos p JOIN albums a ON a.id=p.album_id WHERE p.id=?').get(req.params.id);
    const isOwner = photo && req.user?.id === photo.user_id;
    if (!photo || (!isOwner && (!photo.is_public || photo.deleted_at))) throw problem(404, '照片不存在或尚未公开');
    const filename = kind === 'thumb' ? path.join(dirs.thumbs, `${photo.id}.webp`) : kind === 'file' && isOwner
      ? path.join(dirs.originals, `${photo.id}.${photo.extension}`) : path.join(dirs.previews, `${photo.id}.webp`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', kind === 'file' && isOwner ? photo.mime : 'image/webp');
    if (req.query.download === '1') {
      const original = isOwner && kind === 'file' ? photo.filename : `${path.parse(photo.filename).name}.webp`;
      res.setHeader('Content-Disposition', `attachment; filename="photo.${isOwner && kind === 'file' ? photo.extension : 'webp'}"; filename*=UTF-8''${encodeURIComponent(original).replace(/'/g, '%27')}`);
    }
    res.sendFile(filename, error => { if (error && !res.headersSent) res.status(404).json({ error: '照片文件不存在' }); });
  }));
  app.get('/api/public/albums', (_req, res) => res.json({ albums: db.prepare('SELECT * FROM albums WHERE is_public=1 ORDER BY created_at DESC').all().map(albumJSON) }));
  app.get('/api/public/albums/:slug', (req, res) => {
    const album = db.prepare('SELECT * FROM albums WHERE slug=? AND is_public=1').get(req.params.slug);
    if (!album) throw problem(404, '作品集不存在或已撤回');
    res.json({ album: albumJSON(album), photos: db.prepare('SELECT * FROM photos WHERE album_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(album.id).map(photoJSON) });
  });

  // The UI only receives analysis hints; it never automatically deletes a photo.
  const hamming = (a, b) => {
    let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), distance = 0;
    while (bits) { bits &= bits - 1n; distance++; }
    return distance;
  };
  const computeFeatures = async photo => {
    if (photo.analyzed && photo.phash && photo.color && photo.sharpness !== null) return photo;
    const source = path.join(dirs.thumbs, `${photo.id}.webp`);
    const gray = await sharp(source).resize(9, 8, { fit: 'fill' }).removeAlpha().greyscale().raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | BigInt(gray[y * 9 + x] > gray[y * 9 + x + 1]);
    const { data, info } = await sharp(source).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, squares = 0, count = 0;
    for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const value = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - info.width] - data[i + info.width];
      sum += value; squares += value * value; count++;
    }
    const sharpness = count ? Math.max(0, squares / count - (sum / count) ** 2) : 0;
    const stats = await sharp(source).removeAlpha().stats();
    const color = JSON.stringify(stats.channels.slice(0, 3).map(channel => channel.mean));
    photo.phash = bits.toString(16).padStart(16, '0');
    photo.color = color; photo.sharpness = sharpness; photo.analyzed = 1;
    if (!closed) db.prepare('UPDATE photos SET phash=?,color=?,sharpness=?,analyzed=1 WHERE id=?').run(photo.phash, color, sharpness, photo.id);
    return photo;
  };
  let running = false;
  const queue = [];
  let activeAnalysis = Promise.resolve();
  const analyzeAlbum = async ({ albumId, userId }) => {
    db.prepare("UPDATE albums SET analysis_status='analyzing' WHERE id=?").run(albumId);
    const rows = db.prepare('SELECT * FROM photos WHERE album_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(albumId);
    notify(userId, { type: 'analyzing', albumId, current: 0, total: rows.length });
    for (let i = 0; i < rows.length && !closed; i++) {
      await computeFeatures(rows[i]);
      notify(userId, { type: 'analyzing', albumId, current: i + 1, total: rows.length });
      await new Promise(resolve => setImmediate(resolve));
    }
    if (closed) return;
    // Work only with photos still active after potentially lengthy image decoding.
    const alive = new Set(db.prepare('SELECT id FROM photos WHERE album_id=? AND deleted_at IS NULL').all(albumId).map(p => p.id));
    const photos = rows.filter(row => alive.has(row.id));
    const parents = photos.map((_, index) => index);
    const rootOf = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
    const digestMap = new Map();
    const colors = photos.map(p => JSON.parse(p.color));
    for (let i = 0; i < photos.length; i++) {
      photos[i].duplicate_of = digestMap.get(photos[i].sha256) || null;
      if (!photos[i].duplicate_of) digestMap.set(photos[i].sha256, photos[i].id);
      for (let j = 0; j < i; j++) {
        const colorDistance = colors[i].reduce((n, value, k) => n + Math.abs(value - colors[j][k]), 0);
        if (photos[i].sha256 === photos[j].sha256 || (colorDistance < 70 && hamming(photos[i].phash, photos[j].phash) <= 7)) parents[rootOf(i)] = rootOf(j);
      }
      if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve));
      if (closed) return;
    }
    const stillAlive = new Set(db.prepare('SELECT id FROM photos WHERE album_id=? AND deleted_at IS NULL').all(albumId).map(p => p.id));
    const counts = new Map(), representatives = new Map(), survivingDigests = new Map();
    for (let i = 0; i < photos.length; i++) if (stillAlive.has(photos[i].id)) {
      const group = rootOf(i);
      counts.set(group, (counts.get(group) || 0) + 1);
      if (!representatives.has(group)) representatives.set(group, photos[i].id);
      photos[i].duplicate_of = survivingDigests.get(photos[i].sha256) || null;
      if (!photos[i].duplicate_of) survivingDigests.set(photos[i].sha256, photos[i].id);
    }
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE photos SET group_id=NULL,duplicate_of=NULL,blur=0 WHERE album_id=? AND deleted_at IS NULL').run(albumId);
      const update = db.prepare('UPDATE photos SET group_id=?,duplicate_of=?,blur=? WHERE id=? AND deleted_at IS NULL');
      for (let i = 0; i < photos.length; i++) update.run(counts.get(rootOf(i)) > 1 ? `similar-${representatives.get(rootOf(i))}` : null,
        photos[i].duplicate_of, Number(photos[i].sharpness < 65), photos[i].id);
      db.prepare("UPDATE albums SET analysis_status='complete' WHERE id=?").run(albumId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notify(userId, { type: 'analyzed', albumId, current: photos.length, total: photos.length });
    // Photos uploaded during this job join a following pass rather than being left unanalyzed.
    if (db.prepare('SELECT id FROM photos WHERE album_id=? AND deleted_at IS NULL AND analyzed=0 LIMIT 1').get(albumId)) {
      db.prepare("UPDATE albums SET analysis_status='queued' WHERE id=?").run(albumId);
      queue.push({ albumId, userId });
    }
  };
  const drainQueue = async () => {
    if (running || closed) return;
    running = true;
    while (queue.length && !closed) {
      const job = queue.shift();
      try { await analyzeAlbum(job); }
      catch (error) {
        console.error('Photo analysis failed:', error.message);
        if (!closed) { db.prepare("UPDATE albums SET analysis_status='error' WHERE id=?").run(job.albumId); notify(job.userId, { type: 'analysis-error', albumId: job.albumId }); }
      }
    }
    running = false;
  };
  app.post('/api/albums/:id/analyze', requireUser, (req, res) => {
    const album = ownAlbum(req.params.id, req.user.id);
    if (!['queued', 'analyzing'].includes(album.analysis_status)) {
      db.prepare("UPDATE albums SET analysis_status='queued' WHERE id=?").run(album.id);
      queue.push({ albumId: album.id, userId: req.user.id });
      notify(req.user.id, { type: 'queued', albumId: album.id });
      setImmediate(() => { if (!running) activeAnalysis = drainQueue(); });
    }
    res.json({ ok: true });
  });
  app.get('/api/events', requireUser, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\ndata: {"type":"connected"}\n\n');
    const set = clients.get(req.user.id) || new Set();
    set.add(res); clients.set(req.user.id, set);
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    timer.unref();
    req.on('close', () => { clearInterval(timer); set.delete(res); if (!set.size) clients.delete(req.user.id); });
  });
  app.post('/api/demo', requireUser, asyncRoute(async (req, res) => {
    if (!demoDir) throw problem(404, '尚未配置示例照片');
    const existing = db.prepare("SELECT * FROM albums WHERE user_id=? AND title IN ('京都 · 光影纪行','光影漫游 · 示例项目')").get(req.user.id);
    if (existing) return res.json({ album: albumJSON(existing) });
    const names = (await readdir(demoDir)).filter(name => /\.(jpe?g|png|webp)$/i.test(name)).slice(0, 30);
    if (!names.length) throw problem(404, '尚未配置示例照片');
    const album = createAlbum(req.user.id, { title: '京都 · 光影纪行', description: '一组用于体验上传、选片、封面和作品发布流程的示例照片。', location: '日本 · 京都' });
    for (const name of names) {
      const source = path.join(demoDir, name);
      const temp = path.join(dirs.tmp, randomUUID());
      try {
        await copyFile(source, temp);
        const photo = await insertImage(album.id, temp, name);
        if (/^kyoto-temple\./i.test(name)) db.prepare('UPDATE albums SET cover_photo_id=? WHERE id=?').run(photo.id, album.id);
      }
      finally { await rm(temp, { force: true }).catch(() => {}); }
    }
    const street = names.find(name => /rain/i.test(name)) || names[0];
    const variants = [
      { name: '雨中街角 · 完全重复示例.png', mode: 'duplicate' },
      { name: '雨中街角 · 相似构图示例.jpg', mode: 'similar' },
      { name: '雨中街角 · 疑似模糊示例.jpg', mode: 'blur' },
    ];
    for (const variant of variants) {
      const temp = path.join(dirs.tmp, randomUUID());
      try {
        const source = path.join(demoDir, street);
        if (variant.mode === 'duplicate') await copyFile(source, temp);
        else if (variant.mode === 'similar') await sharp(source).resize({ width: 1500, withoutEnlargement: true }).modulate({ brightness: 1.035 }).jpeg({ quality: 88 }).toFile(temp);
        else await sharp(source).blur(14).jpeg({ quality: 90 }).toFile(temp);
        await insertImage(album.id, temp, variant.name);
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    }
    notify(req.user.id, { type: 'change', albumId: album.id });
    res.status(201).json({ album: albumJSON(db.prepare('SELECT * FROM albums WHERE id=?').get(album.id)) });
  }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    let status = error.status || 500, message = error.message;
    if (error instanceof multer.MulterError) {
      status = 400;
      message = error.code === 'LIMIT_FILE_SIZE' ? '单张照片不能超过 20MB，请分批上传' : '每批最多上传 30 张照片，请检查上传字段';
    }
    if (error.type === 'entity.parse.failed') { status = 400; message = '请求内容格式不正确'; }
    if (status >= 500) { console.error('API error:', error.message); message = '服务暂时无法完成操作，请稍后重试'; }
    res.status(status).json({ error: message });
  });
  app.locals.publicAlbum = slug => {
    const album = db.prepare('SELECT * FROM albums WHERE slug=? AND is_public=1').get(slug);
    return album ? { album: albumJSON(album), photos: db.prepare('SELECT * FROM photos WHERE album_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(album.id).map(photoJSON) } : null;
  };
  app.locals.publicAlbums = () => db.prepare('SELECT * FROM albums WHERE is_public=1 ORDER BY created_at DESC').all().map(albumJSON);
  return {
    app,
    async close() {
      closed = true; queue.length = 0;
      for (const set of clients.values()) for (const response of set) response.end();
      clients.clear();
      await activeAnalysis;
      db.close();
    },
  };
}
