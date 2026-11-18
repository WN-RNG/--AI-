/** Local homepage material pool -> optimized display images and an atomic public manifest. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareCover } from './prepare-cover.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageExtension = /\.(?:jpe?g|png|webp)$/i;

function optionsFor(settings, filename) {
  const value = settings.images?.[filename] ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid settings for ${filename}.`);
  }
  const rotation = value.rotation ?? 0;
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error(`Invalid rotation for ${filename}; use 0, 90, 180 or 270.`);
  }
  const focalPoint = value.focalPoint ?? { x: 50, y: 50 };
  if (
    !focalPoint ||
    ![focalPoint.x, focalPoint.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)
  ) {
    throw new Error(`Invalid focal point for ${filename}; x/y must be between 0 and 100.`);
  }
  return { rotation, focalPoint };
}

export async function updateCovers({
  poolDirectory = path.join(root, 'cover-materials'),
  outputDirectory = path.join(root, 'public', 'covers'),
} = {}) {
  const pool = path.resolve(poolDirectory);
  const output = path.resolve(outputDirectory);
  if (pool === output || pool.startsWith(output + path.sep) || output.startsWith(pool + path.sep)) {
    throw new Error('The original pool and public output must be separate directories.');
  }
  const entries = await fs.readdir(pool, { withFileTypes: true });
  // Ignore directories and symlinks: no recursive traversal outside the chosen material pool.
  const files = entries
    .filter((entry) => entry.isFile() && imageExtension.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!files.length || files.length > 50)
    throw new Error('The pool must contain between 1 and 50 JPG, PNG or WebP images.');
  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(path.join(pool, 'settings.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    (settings.images !== undefined &&
      (!settings.images || typeof settings.images !== 'object' || Array.isArray(settings.images)))
  ) {
    throw new Error('settings.json must contain an object with optional image settings.');
  }
  await fs.mkdir(output, { recursive: true });
  const staging = await fs.mkdtemp(path.join(output, '.manual-cover-'));
  const manifestTemporary = path.join(output, `.manifest-${randomUUID()}.tmp`);
  try {
    const slides = [];
    for (const [index, filename] of files.entries()) {
      const { rotation, focalPoint } = optionsFor(settings, filename);
      const temporary = path.join(staging, `${index}.webp`);
      const info = await prepareCover(path.join(pool, filename), temporary, { rotation });
      const bytes = await fs.readFile(temporary);
      const id = 'manual-' + createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      // Identical images are represented once, even if copied under another filename.
      if (slides.some((slide) => slide.id === id)) continue;
      slides.push({
        id,
        url: `/covers/${id}.webp`,
        title: `Selected photograph ${index + 1}`,
        author: '',
        source: '',
        credit: '',
        displayOnly: true,
        focalPoint,
        width: info.width,
        height: info.height,
      });
      const destination = path.join(output, `${id}.webp`);
      // Content-derived names keep cached images correct when a filename is reused in the pool.
      try {
        await fs.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await fs.readFile(destination)).equals(bytes))
          throw new Error('Conflicting generated asset: ' + id);
      }
    }
    const manifest = { version: 1, updatedAt: new Date().toISOString(), slides };
    await fs.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    // The live manifest changes only after every image has decoded and been written successfully.
    await fs.rename(manifestTemporary, path.join(output, 'manifest.json'));
    return { imported: slides.length, manifest: path.join(output, 'manifest.json') };
  } finally {
    await fs.rm(manifestTemporary, { force: true });
    // Only remove the exact temporary directory created above, never the originals or output pool.
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/update-covers.mjs');
    console.log(JSON.stringify(await updateCovers()));
  } catch (error) {
    console.error('Cover update failed; the previous manifest was retained: ' + error.message);
    process.exitCode = 1;
  }
}
