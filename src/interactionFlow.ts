import type { Album, Photo, PublicAlbum, PublicPhoto } from '../shared/types.ts';

/** A one-time action to resume after authentication; it contains no account credentials. */
export interface PendingIntent {
  kind: 'login' | 'download' | 'favorite' | 'upload' | 'workspace' | 'postcard';
  path: string;
  photoId?: string;
  scrollY: number;
  workspaceTab?: 'projects' | 'smart' | 'trash' | 'favorites';
}

/** Return a local navigation target, including query/hash, without accepting external redirects. */
export function normalizeReturnPath(input: string, origin: string): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input.trim() !== input ||
    /[\\\u0000-\u001f\u007f]/.test(input)
  )
    return '/';
  if (!(input.startsWith('/') && !input.startsWith('//')) && !/^https?:\/\/[^/]/i.test(input))
    return '/';
  try {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return '/';
    const target = new URL(input, base.origin);
    if (target.origin !== base.origin || target.username || target.password) return '/';
    // A same-origin URL can still become a protocol-relative URL after removing its origin.
    // Check encoded separators and dot-segment normalization before returning the local path.
    let pathname = target.pathname;
    for (let depth = 0; depth < 8; depth++) {
      if (/[\\\u0000-\u001f\u007f]/.test(pathname) || pathname.startsWith('//')) return '/';
      const normalized = new URL(pathname, base.origin);
      if (normalized.origin !== base.origin || normalized.pathname.startsWith('//')) return '/';
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) return target.pathname + target.search + target.hash;
      pathname = decoded;
    }
  } catch {
    // Invalid origins, malformed escapes and unsupported URL schemes have no return destination.
  }
  return '/';
}

/** Adapt a public response for shared rendering; unknown/private metadata stays unknown. */
export function publicPhotoToPhoto(raw: PublicPhoto): Photo {
  const previewUrl = raw.previewUrl || raw.url;
  return {
    id: raw.id,
    albumId: raw.albumId,
    filename: raw.filename,
    width: raw.width,
    height: raw.height,
    bytes: 0,
    mime: '',
    createdAt: raw.createdAt,
    capturedAt: null,
    sharpness: null,
    blur: false,
    groupId: null,
    duplicateOf: null,
    pick: 'none',
    rating: 0,
    deletedAt: null,
    url: previewUrl,
    previewUrl,
    thumbnailUrl: raw.thumbnailUrl,
    authorId: raw.authorId,
    authorName: raw.authorName,
    albumTitle: raw.albumTitle,
    albumSlug: raw.albumSlug,
    allowDownload: raw.allowDownload ?? false,
    isFavorite: raw.isFavorite ?? false,
    isFeatured: raw.isFeatured ?? false,
    publishedAt: raw.publishedAt,
    isPublished: true,
  };
}

/** Preserve only the server-provided public cover pool; never infer it from private photos. */
export function publicAlbumToAlbum(raw: PublicAlbum | Partial<Album>): Album {
  const publicTitle =
    'publicTitle' in raw && typeof raw.publicTitle === 'string' ? raw.publicTitle : raw.title;
  return {
    id: raw.id || '',
    title: publicTitle || '',
    description: '',
    location: '',
    createdAt: raw.createdAt || '',
    coverMode:
      raw.coverMode === 'random' || raw.coverMode === 'slideshow' ? raw.coverMode : 'fixed',
    coverPhotoId: raw.coverPhotoId ?? null,
    coverPhotoIds: Array.isArray(raw.coverPhotoIds) ? [...raw.coverPhotoIds] : [],
    slideInterval:
      Number.isInteger(raw.slideInterval) && raw.slideInterval! >= 3 && raw.slideInterval! <= 30
        ? raw.slideInterval!
        : 8,
    isPublic: true,
    slug: raw.slug || '',
    photoCount: raw.photoCount ?? 0,
    coverUrl: raw.coverUrl ?? null,
    stats: { duplicates: 0, similarGroups: 0, blurry: 0, kept: 0 },
    analysisStatus: 'idle',
  };
}

function downloadFilename(disposition: string | null): string {
  let filename = '';
  if (disposition) {
    const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
    const extended = encoded?.[1] ?? encoded?.[2];
    if (extended) {
      const utf8 = /^UTF-8'[^']*'(.*)$/i.exec(extended.trim());
      if (utf8) {
        try {
          filename = decodeURIComponent(utf8[1]);
        } catch {
          /* use the ordinary filename */
        }
      }
    }
    if (!filename) {
      const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(
        disposition,
      );
      filename = (ordinary?.[1]?.replace(/\\(["\\])/g, '$1') ?? ordinary?.[2] ?? '').trim();
    }
  }
  filename = filename.replaceAll('\\', '/').split('/').at(-1) || '';
  filename = filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  if (!filename) return 'photo';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
    ? `_${filename}`
    : filename;
}

/** Download only the authorized endpoint's response; no original URL or external fallback is used. */
export async function downloadPhoto(id: string): Promise<void> {
  const response = await fetch(`/api/photos/${encodeURIComponent(id)}/download`, {
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'X-Album-Client': '1' },
  });
  if (!response.ok) {
    let message = `下载失败（${response.status}），请稍后重试`;
    try {
      const data = await response.json();
      if (typeof data?.error === 'string' && data.error.trim()) message = data.error;
      else if (typeof data?.message === 'string' && data.message.trim()) message = data.message;
    } catch {
      /* the HTTP status still gives a useful fallback for non-JSON errors */
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = downloadFilename(response.headers.get('Content-Disposition'));
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    // Let the browser begin consuming the Blob before releasing its temporary URL.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    try {
      anchor?.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}
