/** Optimize one authorized cover image. Called by import-covers.py; never touches album data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export async function prepareCover(inputPath, outputPath) {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error('Input and output must be different files.');
  }
  const info = await fs.stat(inputPath);
  if (!info.isFile() || info.size > 30 * 1024 * 1024 || info.size === 0) {
    throw new Error('Cover input must be a nonempty image of at most 30 MiB.');
  }
  const image = sharp(inputPath, { limitInputPixels: 80_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) {
    throw new Error('Only static JPG, PNG and WebP covers are supported.');
  }
  const { data, info: output } = await image
    .rotate()
    .resize({ width: 2560, height: 1800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  // Sharp strips EXIF/GPS by default. Never publish the imported original file.
  await fs.writeFile(outputPath, data, { flag: 'wx' });
  return { width: output.width, height: output.height, bytes: output.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) {
    process.stderr.write('Usage: node scripts/prepare-cover.mjs <input> <new-output.webp>\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(await prepareCover(inputPath, outputPath)) + '\n');
    } catch (error) {
      process.stderr.write(`Cover optimization failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
