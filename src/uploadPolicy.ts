import {
  UPLOAD_BATCH_SIZE,
  UPLOAD_CONFIRM_BYTES,
  UPLOAD_MAX_BYTES,
} from '../shared/uploadPolicy.ts';

export interface UploadFileInfo {
  name: string;
  size: number;
}

export interface UploadSelection<T extends UploadFileInfo> {
  files: T[];
  normal: T[];
  large: T[];
  errors: string[];
}

/** Preliminary browser checks; the server still verifies actual image content and permissions. */
export function classifyUploadFiles<T extends UploadFileInfo>(
  files: readonly T[],
): UploadSelection<T> {
  const selection: UploadSelection<T> = { files: [], normal: [], large: [], errors: [] };
  for (const file of files) {
    if (!/\.(jpe?g|png|webp)$/i.test(file.name)) {
      selection.errors.push(`${file.name}：仅支持 JPG、PNG 或 WebP 图片，已跳过`);
    } else if (file.size > UPLOAD_MAX_BYTES) {
      selection.errors.push(`${file.name}：超过 30MB，已跳过`);
    } else {
      selection.files.push(file);
      (file.size > UPLOAD_CONFIRM_BYTES ? selection.large : selection.normal).push(file);
    }
  }
  return selection;
}

/** Keep selection order: ordinary files use small batches, confirmed large files travel alone. */
export function createUploadBatches<T extends UploadFileInfo>(
  files: readonly T[],
  allowLargeFiles: boolean,
): { files: T[]; allowLargeFiles: boolean }[] {
  const batches: { files: T[]; allowLargeFiles: boolean }[] = [];
  let normal: T[] = [];
  const flush = () => {
    if (normal.length) batches.push({ files: normal, allowLargeFiles: false });
    normal = [];
  };
  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) continue;
    if (file.size > UPLOAD_CONFIRM_BYTES) {
      if (allowLargeFiles) {
        flush();
        batches.push({ files: [file], allowLargeFiles: true });
      }
    } else {
      normal.push(file);
      if (normal.length === UPLOAD_BATCH_SIZE) flush();
    }
  }
  flush();
  return batches;
}
