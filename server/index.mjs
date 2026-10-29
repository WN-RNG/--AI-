/**
 * 后端启动入口：读取环境配置，托管构建页面，提供公开 HTML 并监听 HTTP。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createApplication } from './app.mjs';

// 根据此文件的位置定位项目，移动目录后无需写死新的盘符。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const allowedOrigins = process.argv.includes('--dev')
  ? ['http://127.0.0.1:5173', 'http://localhost:5173']
  : [];
const { app, close } = await createApplication({
  dataDir,
  demoDir: path.join(root, 'public', 'demo'),
  allowedOrigins,
});
const dist = path.join(root, 'dist');
// 构建存在时，提供公开页面 HTML 和静态资源；公开内容经过转义。
if (existsSync(path.join(dist, 'index.html'))) {
  const shell = await readFile(path.join(dist, 'index.html'), 'utf8');
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const render = (req, { title, description, content, image, noindex = false }) => {
    const configured = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const origin = new URL(configured).origin;
    const canonical = origin + req.path;
    const meta = `<link rel="canonical" href="${escape(canonical)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}"><meta property="og:type" content="website">${image ? `<meta property="og:image" content="${escape(origin + image)}">` : ''}${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}`;
    return shell
      .replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`)
      .replace(
        /<meta name="description"[^>]*>/,
        `<meta name="description" content="${escape(description)}">`,
      )
      .replace('</head>', `${meta}</head>`)
      .replace('<div id="root"></div>', `<div id="root">${content}</div>`);
  };
  app.get('/p/:slug', (req, res) => {
    const result = app.locals.publicAlbum(req.params.slug);
    if (!result)
      return res
        .status(404)
        .type('html')
        .send(
          render(req, {
            title: '作品集暂不可用 · 光影',
            description: '该作品集尚未发布或已经撤回。',
            content: '<main><h1>作品集暂不可用</h1><a href="/explore">浏览公开作品</a></main>',
            noindex: true,
          }),
        );
    const { album, photos } = result;
    const content = `<main><nav><a href="/explore">光影 · 公开作品</a></nav><h1>${escape(album.title)}</h1><p>${escape(album.description)}</p><p>${escape(album.location)} · ${photos.length} 张作品</p><div>${photos.map((photo) => `<figure><a href="${photo.url}"><img src="${photo.thumbnailUrl}" alt="${escape(photo.filename)}" width="${photo.width}" height="${photo.height}" loading="lazy"></a><figcaption>${escape(photo.filename)}</figcaption></figure>`).join('')}</div></main>`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      render(req, {
        title: `${album.title} · 光影作品集`,
        description: album.description || `${album.title}，共 ${photos.length} 张摄影作品。`,
        content,
        image: album.coverUrl,
      }),
    );
  });
  app.get('/explore', (req, res) => {
    const albums = app.locals.publicAlbums();
    const content = `<main><a href="/">光影</a><h1>发现公开作品</h1>${albums.map((album) => `<article><a href="/p/${escape(album.slug)}">${album.coverUrl ? `<img src="${album.coverUrl}" alt="${escape(album.title)}" width="800" loading="lazy">` : ''}<h2>${escape(album.title)}</h2></a><p>${escape(album.description)}</p></article>`).join('')}</main>`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      render(req, {
        title: '发现公开作品 · 光影',
        description: '发现创作者主动发布的摄影作品集。',
        content,
      }),
    );
  });
  app.get('/robots.txt', (_req, res) =>
    res
      .type('text')
      .send(
        'User-agent: *\nAllow: /\nDisallow: /api/auth/\nDisallow: /api/albums/\nDisallow: /api/events\nDisallow: /api/trash\nDisallow: /api/demo\nDisallow: /album/\nDisallow: /trash\n',
      ),
  );
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
// HTTP 生命周期：正常启动监听，退出前结束通知连接并关闭数据库。
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () =>
  console.log(`FRAME is ready at http://${host}:${port}`),
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await close();
    process.exit(0);
  });
