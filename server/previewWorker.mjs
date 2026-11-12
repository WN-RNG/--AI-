import path from 'node:path';
import { rename, rm } from 'node:fs/promises';
import sharp from 'sharp';

/** Durable queue in DATA_DIR: thumbnails are usable while high-resolution previews are prepared. */
export function createPreviewWorker({ db, dirs, runImageTask }) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS preview_jobs(photo_id TEXT PRIMARY KEY REFERENCES photos(id), status TEXT NOT NULL DEFAULT 'queued')",
  );
  db.prepare("UPDATE preview_jobs SET status='queued' WHERE status='running'").run();
  let stopped = false;
  let active;
  async function processOne() {
    if (active || stopped) return;
    const row = db
      .prepare(
        "SELECT p.id,p.extension FROM preview_jobs j JOIN photos p ON p.id=j.photo_id WHERE j.status='queued' AND p.deleted_at IS NULL LIMIT 1",
      )
      .get();
    if (!row) return;
    const temporary = path.join(dirs.previews, row.id + '.pending.webp');
    active = (async () => {
      try {
        db.prepare("UPDATE preview_jobs SET status='running' WHERE photo_id=?").run(row.id);
        await runImageTask(() =>
          sharp(path.join(dirs.originals, `${row.id}.${row.extension}`), {
            limitInputPixels: 80_000_000,
            failOn: 'error',
          })
            .rotate()
            .resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 88, effort: 1 })
            .toFile(temporary),
        );
        await rename(temporary, path.join(dirs.previews, row.id + '.webp'));
        db.prepare("UPDATE preview_jobs SET status='complete' WHERE photo_id=?").run(row.id);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        db.prepare('UPDATE preview_jobs SET status=? WHERE photo_id=?').run(
          error.status === 503 ? 'queued' : 'failed',
          row.id,
        );
      }
    })();
    try {
      await active;
    } finally {
      active = null;
    }
  }
  const timer = setInterval(() => {
    void processOne();
  }, 500);
  timer.unref();
  return {
    enqueue(id) {
      db.prepare("INSERT OR REPLACE INTO preview_jobs(photo_id,status) VALUES(?,'queued')").run(id);
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
