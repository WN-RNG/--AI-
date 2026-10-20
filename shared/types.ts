export type CoverMode = 'fixed' | 'random' | 'slideshow';
export type Pick = 'none' | 'keep' | 'reject';
export interface User { id: string; name: string; email: string }
export interface Album {
  id: string;
  title: string;
  description: string;
  location: string;
  createdAt: string;
  coverMode: CoverMode;
  coverPhotoId: string | null;
  coverPhotoIds: string[];
  slideInterval: number;
  isPublic: boolean;
  slug: string;
  photoCount: number;
  coverUrl?: string | null;
  stats?: { duplicates: number; similarGroups: number; blurry: number; kept: number };
  analysisStatus?: string;
}
export interface Photo {
  id: string;
  albumId: string;
  filename: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  createdAt: string;
  capturedAt?: string | null;
  sharpness?: number | null;
  blur: boolean;
  groupId: string | null;
  duplicateOf: string | null;
  pick: Pick;
  rating: number;
  deletedAt: string | null;
  url: string;
  previewUrl?: string;
  thumbnailUrl: string;
}
export type PhotoPatch = { pick?: Pick; rating?: number; deleted?: boolean; restore?: boolean };
