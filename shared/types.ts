/**
 * 前端数据契约：描述接口使用的数据结构，不替代后端运行时参数和权限校验。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

// fixed：指定封面；random：随机轮播；slideshow：按选定顺序轮播。
export type CoverMode = 'fixed' | 'random' | 'slideshow';
export type Pick = 'none' | 'keep' | 'reject';
/** 登录用户的公开身份字段，不包含密码或会话令牌。 */
export interface User {
  id: string;
  name: string;
  email: string;
}
/** 拍摄项目及顶部大屏展示设置；轮播间隔的单位为秒。 */
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
  publicTitle?: string | null;
}
/** 照片信息、分析候选与人工选片结果；url 的实际响应受访问权限控制。 */
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
  isPublished?: boolean;
  allowDownload?: boolean;
  isFeatured?: boolean;
  publishedAt?: string | null;
  isFavorite?: boolean;
  authorId?: string;
  authorName?: string;
  albumTitle?: string;
  albumSlug?: string;
}
/** 公共图库的字段白名单，不包含原图信息或作者的私人选片结果。 */
export interface PublicPhoto {
  id: string;
  albumId: string;
  filename: string;
  width: number;
  height: number;
  createdAt: string;
  url: string;
  previewUrl: string;
  thumbnailUrl: string;
  publishedAt: string;
  allowDownload: boolean;
  isFavorite: boolean;
  isFeatured: boolean;
  authorId: string;
  authorName: string;
  albumTitle: string;
  albumSlug: string;
}
/** 公开相册的独立结构：仅引用已发布照片，不返回私人描述或地点。 */
export interface PublicAlbum {
  id: string;
  title: string;
  publicTitle: string;
  createdAt: string;
  slug: string;
  photoCount: number;
  isPublic: true;
  coverUrl: string | null;
  coverPhotoId: string | null;
  coverPhotoIds: string[];
  coverMode: CoverMode;
  slideInterval: number;
}
/** 照片可修改字段；deleted/restore 对应软删除和恢复。 */
export type PhotoPatch = { pick?: Pick; rating?: number; deleted?: boolean; restore?: boolean };
