/** Private, budgeted image jobs. Never expose provider keys, reference bytes or result URLs. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const fail = (status, message) => Object.assign(new Error(message), { status });
const prompts = {
  frost:
    'Create ONLY an abstract background for a premium photographic postcard. Borrow at most four dominant colors from the reference. Soft mist, natural diffused window light, subtle frosted glass grain, delicate organic tonal transitions, quiet low contrast and generous negative space. No objects, people, scenery, photo frames, borders, lettering or watermarks. The original photograph will be composited separately.',
  watercolor:
    'Repaint the entire reference photograph as a refined traditional watercolor on warm ivory cotton paper. Preserve its main composition, recognizable architecture and the identity of any person as closely as possible. Authentic translucent pigment, wet-on-wet washes, subtle paper grain and organic feathered paint edges. A finished watercolor painting, no original-photo inset, no side-by-side comparison, no borders, no text or signatures.',
};

export async function boundedImage(response, maximum = 16 * 1024 * 1024) {
  if (
    !response.ok ||
    !/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers.get('content-type') || '')
  )
    throw Error('Invalid image response');
  return boundedBytes(response, maximum);
}

async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw Error('Image too large');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw Error('Image too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export function resultAddress(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.aliyuncs.com') ||
    url.port ||
    url.username ||
    url.password
  )
    throw Error('Unexpected image storage host');
  return url.href;
}

export async function mountPostcardAI({
  app,
  db,
  dataDir,
  authorize,
  requireUser,
  asyncRoute,
  runImageTask,
  fetchImpl = fetch,
  configuration = process.env,
}) {
  const key = configuration.DASHSCOPE_API_KEY || '';
  const base = (
    configuration.QWEN_BASE_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1'
  ).replace(/\/$/, '');
  if (
    ![
      'https://maas.qianwenaiapi.com/compatible-mode/v1',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ].includes(base)
  )
    throw Error('Unsupported QWEN_BASE_URL');
  const model = configuration.QWEN_IMAGE_MODEL || 'qwen-image-2.1-turbo';
  if (
    ![
      'qwen-image-2.1-turbo',
      'qwen-image-2.1-pro',
      'qwen-image-3.0',
      'qwen-image-3.0-pro',
    ].includes(model)
  )
    throw Error('Unsupported image model');
  const budget = Number(configuration.QWEN_MONTHLY_BUDGET_CNY || 50);
  const reserve = Number(configuration.QWEN_RESERVE_PER_IMAGE_CNY || 0.6);
  if (!(budget > 0 && budget <= 50 && reserve >= 0.6 && reserve <= budget))
    throw Error('Invalid Qwen budget configuration');
  const budgetCents = Math.floor(budget * 100),
    costCents = Math.ceil(reserve * 100);
  const folder = path.join(dataDir, 'postcards');
  await mkdir(folder, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS postcard_jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), photo_id TEXT NOT NULL REFERENCES photos(id),
    style TEXT NOT NULL, model TEXT NOT NULL, month TEXT NOT NULL, reserved_cents INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    UNIQUE(user_id,photo_id,style,model)
  );`);
  // An interrupted request may already have been billed: keep its reservation, never auto-resubmit.
  db.prepare(
    "UPDATE postcard_jobs SET status='interrupted',error='服务已重启，生成结果未确认。为避免重复计费，请联系管理员核对。' WHERE status IN ('queued','running')",
  ).run();
  const pending = new Set();
  const controllers = new Set();
  let closed = false;
  const dto = (row) => ({
    id: row.id,
    photoId: row.photo_id,
    style: row.style,
    status: row.status,
    error: row.error,
    imageUrl: row.status === 'complete' ? `/api/postcards/${row.id}/image` : null,
  });
  const readJob = (req) => {
    const row = db
      .prepare('SELECT * FROM postcard_jobs WHERE id=? AND user_id=?')
      .get(req.params.id, req.user.id);
    if (!row) throw fail(404, '生成任务不存在');
    authorize(row.photo_id, req.user.id);
    return row;
  };

  async function generate(row) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 180000);
    const temporary = path.join(folder, row.id + '.tmp');
    try {
      db.prepare("UPDATE postcard_jobs SET status='running' WHERE id=?").run(row.id);
      const source = authorize(row.photo_id, row.user_id);
      const bytes = await runImageTask(() =>
        sharp(source, { limitInputPixels: 80_000_000 })
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer(),
      );
      if (controller.signal.aborted) throw Error('Cancelled');
      const dimensions = await sharp(bytes).metadata();
      const size =
        row.style === 'frost' || Math.abs(dimensions.width / dimensions.height - 1) < 0.1
          ? '1024x1024'
          : dimensions.width > dimensions.height
            ? '1536x1024'
            : '1024x1536';
      const response = await fetchImpl(base + '/images/generations', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: prompts[row.style],
          image: 'data:image/jpeg;base64,' + bytes.toString('base64'),
          n: 1,
          size,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = Error(
          response.status === 401 || response.status === 403
            ? 'API 密钥或模型权限不可用，请管理员检查配置。'
            : `图像服务响应异常（${response.status}），请稍后查询任务状态。`,
        );
        error.definitive = [400, 401, 403, 404, 422].includes(response.status);
        throw error;
      }
      // Provider responses are small JSON; refuse unexpectedly large payloads before parsing.
      const raw = (await boundedBytes(response, 65536)).toString('utf8');
      const result = JSON.parse(raw);
      const address = resultAddress(result.data?.[0]?.url);
      const output = await fetchImpl(address, { redirect: 'error', signal: controller.signal });
      const image = await boundedImage(output);
      const normalized = await runImageTask(() =>
        sharp(image, { limitInputPixels: 16_000_000 })
          .rotate()
          .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 94, effort: 1 })
          .toBuffer(),
      );
      authorize(row.photo_id, row.user_id);
      if (controller.signal.aborted || closed) throw Error('Cancelled');
      await writeFile(temporary, normalized);
      await rename(temporary, path.join(folder, row.id + '.webp'));
      db.prepare("UPDATE postcard_jobs SET status='complete',error='' WHERE id=?").run(row.id);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (!closed)
        db.prepare(
          'UPDATE postcard_jobs SET status=?,reserved_cents=CASE WHEN ? THEN 0 ELSE reserved_cents END,error=? WHERE id=?',
        ).run(
          error.definitive ? 'rejected' : 'failed',
          error.definitive ? 1 : 0,
          controller.signal.aborted
            ? '生成等待已超时，可能已产生调用费用。请联系管理员核对，系统不会自动重复提交。'
            : /^API |^图像服务/.test(error.message)
              ? error.message
              : '图像生成未完成，请联系管理员核对。系统不会自动重复提交。',
          row.id,
        );
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  app.get('/api/postcards/config', (_req, res) =>
    res.json({ enabled: !!key, model, monthlyBudgetCny: budget, reservePerImageCny: reserve }),
  );
  app.post(
    '/api/photos/:id/postcards',
    requireUser,
    asyncRoute(async (req, res) => {
      authorize(req.params.id, req.user.id);
      if (!['frost', 'watercolor'].includes(req.body.style))
        throw fail(400, '请选择有效的明信片样式');
      const existing = db
        .prepare(
          'SELECT * FROM postcard_jobs WHERE user_id=? AND photo_id=? AND style=? AND model=?',
        )
        .get(req.user.id, req.params.id, req.body.style, model);
      if (existing && existing.status !== 'rejected')
        return res.json({ job: dto(existing), reused: true });
      if (!key) throw fail(503, '尚未配置 Qwen API 密钥，请管理员配置 DASHSCOPE_API_KEY');
      if (req.body.consent !== true) throw fail(400, '请先同意将照片处理副本发送至千问图像服务');
      if (
        closed ||
        pending.size >= 2 ||
        db
          .prepare(
            "SELECT id FROM postcard_jobs WHERE user_id=? AND status IN ('queued','running')",
          )
          .get(req.user.id)
      )
        throw fail(429, '已有生成任务进行中，请等待完成后再试');
      const month = new Date().toISOString().slice(0, 7);
      const spent = db
        .prepare('SELECT COALESCE(SUM(reserved_cents),0) AS total FROM postcard_jobs WHERE month=?')
        .get(month).total;
      if (spent + costCents > budgetCents)
        throw fail(429, '本月 AI 生成额度已用完，仍可使用本地磨砂明信片');
      if (existing)
        db.prepare("DELETE FROM postcard_jobs WHERE id=? AND status='rejected'").run(existing.id);
      const row = {
        id: randomUUID(),
        user_id: req.user.id,
        photo_id: req.params.id,
        style: req.body.style,
        model,
        month,
        reserved_cents: costCents,
        status: 'queued',
        created_at: new Date().toISOString(),
      };
      db.prepare(
        'INSERT INTO postcard_jobs(id,user_id,photo_id,style,model,month,reserved_cents,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        row.id,
        row.user_id,
        row.photo_id,
        row.style,
        row.model,
        row.month,
        costCents,
        row.status,
        row.created_at,
      );
      const task = generate(row);
      pending.add(task);
      void task.finally(() => pending.delete(task));
      res.status(202).json({ job: dto(row) });
    }),
  );
  app.get('/api/postcards/:id', requireUser, (req, res) => res.json({ job: dto(readJob(req)) }));
  app.get('/api/postcards/:id/image', requireUser, (req, res) => {
    const row = readJob(req);
    if (row.status !== 'complete') throw fail(409, '图片尚未生成完成');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('webp').sendFile(path.join(folder, row.id + '.webp'));
  });
  return {
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
