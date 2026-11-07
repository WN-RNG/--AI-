/**
 * 前端业务主控制器：协调会话、项目、上传、智能选片、封面轮播及公开作品。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Aperture,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  Expand,
  FolderPlus,
  Globe,
  Grid2X2,
  Heart,
  ImagePlus,
  Images,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Album, Photo, PhotoPatch, PublicPhoto, User } from '../shared/types';
import { api, formatDate } from './api';
import AuthDialog from './components/AuthDialog';
import PublishDialog from './components/PublishDialog';
import {
  downloadPhoto,
  normalizeReturnPath,
  publicAlbumToAlbum,
  publicPhotoToPhoto,
  type PendingIntent,
} from './interactionFlow';
import Modal from './components/Modal';
import CoverDialog from './components/CoverDialog';
import PhotoPreview from './components/PhotoPreview';
import LargeUploadDialog from './components/LargeUploadDialog';
import { classifyUploadFiles, createUploadBatches, type UploadSelection } from './uploadPolicy';

type Filter = 'all' | 'similar' | 'duplicates' | 'blur' | 'keep';
type Tab = 'projects' | 'smart' | 'trash';
type UploadJob = {
  id: number;
  albumId: string;
  userId: string;
  path: string;
  tab: Tab;
  selection: UploadSelection<File>;
  failures: string[];
  uploaded: number;
  cancelled: boolean;
  started: boolean;
  phase: 'confirming' | 'uploading';
  xhr: XMLHttpRequest | null;
};
type UploadResult = {
  photos: Photo[];
  errors?: { filename?: string; error?: string }[];
};
const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部照片' },
  { id: 'similar', label: '相似分组' },
  { id: 'duplicates', label: '重复候选' },
  { id: 'blur', label: '疑似模糊' },
  { id: 'keep', label: '已选作品' },
];
const emptyStats = { duplicates: 0, similarGroups: 0, blurry: 0, kept: 0 };
const emptyPhotos: Photo[] = [];

// 轻量路由：只管理路径；相册选择与筛选仍由 App 的临时状态保存。
function useRoute() {
  const [route, setRoute] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const change = () => setRoute(window.location.pathname + window.location.search);
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  const navigate = useCallback((next: string, replace = false) => {
    const target = normalizeReturnPath(next, window.location.origin);
    const changed = new URL(target, window.location.origin).pathname !== window.location.pathname;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
    setRoute(target);
    if (changed) window.scrollTo({ top: 0 });
  }, []);
  return { path: new URL(route, window.location.origin).pathname, route, navigate };
}

// 照片网格卡片：只负责展示与事件回调，不直接访问后端。
function PhotoCard({
  photo,
  selected,
  selecting,
  readOnly,
  onOpen,
  onSelect,
  onPick,
  onFavorite,
}: {
  photo: Photo;
  selected: boolean;
  selecting: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onPick: () => void;
  onFavorite?: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [photo.thumbnailUrl]);
  const imageWidth = photo.width > 0 ? photo.width : 3;
  const imageHeight = photo.height > 0 ? photo.height : 2;
  return (
    <article className={`photo-card ${selected ? 'is-selected' : ''}`}>
      <button
        className={`photo-image-button ${imageFailed ? 'is-image-error' : ''}`}
        style={imageFailed ? { aspectRatio: `${imageWidth} / ${imageHeight}` } : undefined}
        onClick={selecting ? onSelect : onOpen}
        aria-label={`${selecting ? '选择' : '预览'} ${photo.filename}`}
      >
        {imageFailed ? (
          <span
            className="photo-image-fallback"
            role="img"
            aria-label={`${photo.filename} 暂时无法加载`}
          >
            <Images size={24} />
            <span>暂时无法加载</span>
          </span>
        ) : (
          <img
            src={photo.thumbnailUrl}
            alt={photo.filename}
            width={imageWidth}
            height={imageHeight}
            loading="lazy"
            draggable="false"
            onError={() => setImageFailed(true)}
          />
        )}
      </button>
      {!readOnly && (
        <button
          className={`photo-check ${selected ? 'is-selected' : ''} ${selecting ? 'is-visible' : ''}`}
          onClick={onSelect}
          aria-label={`${selected ? '取消选择' : '选择'} ${photo.filename}`}
          aria-pressed={selected}
        >
          {selected && <Check size={14} />}
        </button>
      )}
      <div className="photo-badges">
        {photo.duplicateOf ? (
          <span className="photo-badge">
            <Images size={12} />
            完全重复
          </span>
        ) : photo.groupId ? (
          <span className="photo-badge">
            <Images size={12} />
            相似组
          </span>
        ) : null}
        {photo.blur && <span className="photo-badge badge-amber">疑似模糊</span>}
      </div>
      <div className="photo-meta">
        <div>
          <button className="filename" onClick={onOpen} title={photo.filename}>
            {photo.filename}
          </button>
          <time>
            {readOnly
              ? photo.authorName || '摄影创作者'
              : formatDate(photo.capturedAt || photo.createdAt)}
          </time>
        </div>
        {!readOnly ? (
          <button
            className={`pick-button ${photo.pick === 'keep' ? 'is-kept' : ''}`}
            onClick={onPick}
            aria-label={photo.pick === 'keep' ? '取消保留' : '标记为保留'}
            title={photo.pick === 'keep' ? '已标记保留' : '标记为保留'}
          >
            <Star size={15} fill={photo.pick === 'keep' ? 'currentColor' : 'none'} />
          </button>
        ) : (
          <button
            className={`pick-button ${photo.isFavorite ? 'is-kept' : ''}`}
            onClick={onFavorite}
            aria-label={photo.isFavorite ? '取消收藏' : '收藏作品'}
            aria-pressed={!!photo.isFavorite}
            title={photo.isFavorite ? '已收藏' : '收藏作品'}
          >
            <Heart size={18} fill={photo.isFavorite ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
    </article>
  );
}

// 新建项目表单：成功创建后，将服务端返回的相册交给父组件。
function CreateAlbum({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (album: Album) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const { album } = await api<{ album: Album }>('/albums', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
      });
      if (alive.current) onCreate(album);
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal title="新建拍摄项目" onClose={onClose}>
      <p className="muted modal-intro">给这一次拍摄留一个专属空间。</p>
      <form className="form-stack" onSubmit={submit}>
        <label>
          项目名称
          <input
            name="title"
            placeholder="例如：京都 · 光影纪行"
            required
            maxLength={120}
            autoComplete="off"
          />
        </label>
        <label>
          {'拍摄地点 '}
          <span className="optional">选填</span>
          <input name="location" placeholder="城市或地点" maxLength={120} />
        </label>
        <label>
          {'项目描述 '}
          <span className="optional">选填</span>
          <textarea
            name="description"
            placeholder="记录这一次拍摄的故事……"
            maxLength={1000}
            rows={3}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            取消
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建项目
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function App() {
  const { path, route, navigate } = useRoute();
  let publicSlug: string | null = null;
  if (path.startsWith('/p/')) {
    try {
      publicSlug = decodeURIComponent(path.slice(3));
    } catch {
      publicSlug = path.slice(3);
    }
  }
  // 状态区：用户与数据、视图选择、弹窗、轮播及异步反馈。
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumId, setAlbumId] = useState('');
  const [albumData, setAlbum] = useState<Album | null>(null);
  const [loadedPath, setLoadedPath] = useState('');
  const [loadedScope, setLoadedScope] = useState('');
  const [photoData, setPhotos] = useState<Photo[]>([]);
  const favoritesView = path === '/favorites' && !!user;
  const galleryView = path === '/' || path === '/explore' || (!user && !publicSlug);
  const feedView = galleryView || favoritesView;
  const publicView = feedView || !!publicSlug;
  const [galleryPhotos, setGalleryPhotos] = useState<Photo[]>([]);
  const [gallerySort, setGallerySort] = useState<'featured' | 'latest'>('featured');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailableFavorites, setUnavailableFavorites] = useState(0);
  const [authIntent, setAuthIntent] = useState<PendingIntent | null>(null);
  const [resumeIntent, setResumeIntent] = useState<PendingIntent | null>(null);
  const [uploadGuide, setUploadGuide] = useState(false);
  const [tab, setTab] = useState<Tab>('projects');
  const contextKey = `${publicSlug ? 'public' : user?.id || 'guest'}:${path}:${publicSlug || (tab === 'trash' ? 'trash' : albumId)}`;
  const album = loadedScope === contextKey ? albumData : null;
  const photos = loadedScope === contextKey ? photoData : emptyPhotos;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('date');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [working, setWorking] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState('');
  const [uploadState, setUploadState] = useState<{
    percent: number;
    current: number;
    total: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState('');
  const [uploadErrorsByAlbum, setUploadErrorsByAlbum] = useState<Record<string, string[]>>({});
  const [pendingUpload, setPendingUpload] = useState<UploadJob | null>(null);
  const [uploadLocked, setUploadLocked] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const uploadJobRef = useRef<UploadJob | null>(null);
  const uploadSequence = useRef(0);
  const favoriteRequests = useRef(new Set<string>());
  const authEpoch = useRef(0);
  const feedRequestVersion = useRef(0);
  const feedContext = useRef('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeAlbumRef = useRef(albumId);
  activeAlbumRef.current = albumId;
  const routeRef = useRef(path);
  routeRef.current = path;
  const currentScopeRef = useRef(contextKey);
  currentScopeRef.current = contextKey;
  const uploadUserRef = useRef(user?.id);
  uploadUserRef.current = user?.id;
  const uploadTabRef = useRef(tab);
  uploadTabRef.current = tab;
  const uploadErrorKey = user && !publicView ? `${user.id}:${albumId}` : '';
  const uploadErrors = uploadErrorsByAlbum[uploadErrorKey] || [];
  const tell = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 6000);
  }, []);
  const reload = useCallback(() => setRefresh((v) => v + 1), []);
  const recordUploadErrors = useCallback((job: UploadJob, errors: string[]) => {
    if (uploadUserRef.current !== job.userId) return;
    setUploadErrorsByAlbum((current) =>
      uploadUserRef.current === job.userId
        ? {
            ...current,
            [`${job.userId}:${job.albumId}`]: [...errors],
          }
        : current,
    );
  }, []);
  const cancelUpload = useCallback(
    (reason = '已取消本次上传') => {
      const job = uploadJobRef.current;
      if (!job) return;
      job.cancelled = true;
      uploadJobRef.current = null;
      job.xhr?.abort();
      setPendingUpload(null);
      setUploadLocked(false);
      setUploadState(null);
      dragDepth.current = 0;
      setDragging(false);
      reload();
      tell(reason);
    },
    [reload, tell],
  );
  useEffect(() => {
    const job = uploadJobRef.current;
    if (
      job &&
      (job.albumId !== albumId || job.userId !== user?.id || job.path !== path || job.tab !== tab)
    ) {
      cancelUpload(
        job.phase === 'confirming'
          ? '已取消原项目的本次上传确认'
          : '已停止原项目的后续上传，已完成的照片会保留',
      );
    }
    dragDepth.current = 0;
    setDragging(false);
  }, [albumId, user?.id, path, tab, cancelUpload]);
  useEffect(() => setUploadErrorsByAlbum({}), [user?.id]);
  useEffect(
    () => () => {
      const job = uploadJobRef.current;
      if (job) {
        job.cancelled = true;
        uploadJobRef.current = null;
        job.xhr?.abort();
      }
    },
    [],
  );
  // 数据同步：恢复会话，再根据用户、相册与公开路由读取对应数据。
  useEffect(() => {
    const controller = new AbortController();
    const epoch = authEpoch.current;
    api<{ user: User | null }>('/auth/session', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && authEpoch.current === epoch) setUser(data.user);
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          authEpoch.current === epoch &&
          error.name !== 'AbortError'
        )
          setLoadError('暂时无法连接相册服务，请稍后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted && authEpoch.current === epoch) setSessionLoading(false);
      });
    return () => {
      controller.abort();
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!user || publicView) return;
    const controller = new AbortController();
    api<{ albums: Album[] }>('/albums', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.albums)) throw new Error('相册列表响应异常，请稍后重试');
        setAlbums(data.albums);
        setAlbumId((current) =>
          data.albums.some((a) => a.id === current) ? current : data.albums[0]?.id || '',
        );
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setLoadError(e.message);
      });
    return () => controller.abort();
  }, [user, publicView, refresh]);
  useEffect(() => {
    if ((!user && !publicView) || (publicView && !publicSlug)) return;
    if (!publicView && !albumId && tab !== 'trash') {
      setAlbum(null);
      setPhotos([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    const url = publicSlug
      ? '/public/albums/' + encodeURIComponent(publicSlug)
      : tab === 'trash'
        ? '/trash'
        : '/albums/' + albumId;
    api<{ album?: Album; photos: Photo[] }>(url, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoadedPath(path);
        setLoadedScope(contextKey);
        setAlbum(data.album ? (publicSlug ? publicAlbumToAlbum(data.album) : data.album) : null);
        setPhotos(
          publicSlug
            ? data.photos.map((photo) => publicPhotoToPhoto(photo as unknown as PublicPhoto))
            : data.photos,
        );
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setLoadError(e.message);
          setAlbum(null);
          setPhotos([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user, albumId, refresh, publicView, publicSlug, tab]);
  useEffect(() => {
    if (!feedView || (favoritesView && !user)) return;
    const controller = new AbortController();
    const version = ++feedRequestVersion.current;
    setLoading(true);
    setLoadingMore(false);
    setLoadError('');
    const context = `${path}:${gallerySort}:${search}`;
    if (feedContext.current !== context) setGalleryPhotos([]);
    feedContext.current = context;
    setNextCursor(null);
    const timer = setTimeout(
      () => {
        const query = new URLSearchParams({ sort: gallerySort, q: search, limit: '48' });
        const url = favoritesView ? '/favorites' : '/public/photos?' + query;
        api<{ photos: PublicPhoto[]; nextCursor?: string | null; unavailableCount?: number }>(url, {
          signal: controller.signal,
        })
          .then((data) => {
            if (controller.signal.aborted || feedRequestVersion.current !== version) return;
            setGalleryPhotos(data.photos.map(publicPhotoToPhoto));
            setNextCursor(data.nextCursor || null);
            setUnavailableFavorites(data.unavailableCount || 0);
          })
          .catch((e) => {
            if (e.name !== 'AbortError') setLoadError(e.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [feedView, favoritesView, path, user?.id, refresh, gallerySort, search]);
  // A photo deep link opens only after its authorized public data is available.
  useEffect(() => {
    if (!publicView || loading) return;
    const id = new URLSearchParams(route.split('?')[1] || '').get('photo');
    const source = feedView ? galleryPhotos : loadedPath === path ? photos : [];
    if (id && source.some((photo) => photo.id === id)) setPreviewId(id);
    else if (id && galleryView) {
      const controller = new AbortController();
      api<{ photo: PublicPhoto }>('/public/photos/' + encodeURIComponent(id), {
        signal: controller.signal,
      })
        .then(({ photo }) => {
          if (controller.signal.aborted) return;
          setGalleryPhotos((current) =>
            current.some((item) => item.id === photo.id)
              ? current
              : [publicPhotoToPhoto(photo), ...current],
          );
          setPreviewId(photo.id);
        })
        .catch((error) => {
          if (!controller.signal.aborted && error.name !== 'AbortError')
            tell('这张作品已撤回或暂不可用，可继续浏览其他作品');
        });
      return () => controller.abort();
    }
  }, [
    route,
    galleryPhotos,
    photos,
    feedView,
    galleryView,
    publicView,
    loading,
    loadedPath,
    path,
    tell,
  ]);
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
    setPreviewId(null);
    setCoverOpen(false);
    setPublishOpen(false);
    setDeleteOpen(false);
    setSearch('');
    setFilter(tab === 'smart' ? 'similar' : 'all');
    setPaused(false);
    setAnalyzing(false);
    setCreateOpen(false);
    setWorking(false);
  }, [albumId, tab, path]);
  useEffect(() => {
    if (!user) return;
    const source = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.albumId === albumId) {
          if (data.type === 'analyzing' || data.type === 'progress') {
            setAnalyzing(true);
            setAnalysisProgress(data.total ? `${data.current || 0} / ${data.total}` : '正在分析');
          }
          if (data.type === 'analyzed' || data.type === 'analysis-error') {
            setAnalyzing(false);
            setAnalysisProgress('');
            if (data.type === 'analyzed') tell('分析已完成，可以开始对比选片了');
          }
        }
        clearTimeout(timer);
        timer = setTimeout(reload, 350);
      } catch {
        /* ignore keepalive */
      }
    };
    return () => {
      source.close();
      clearTimeout(timer);
    };
  }, [user, albumId, reload, tell]);
  // 大屏展示池：过滤回收站照片，并按指定照片、随机或顺序模式生成封面。
  const activePhotos = useMemo(() => photos.filter((p) => !p.deletedAt), [photos]);
  const coverPool = useMemo(() => {
    if (!album || !activePhotos.length) return [];
    const chosen = (album.coverPhotoIds || [])
      .map((id) => activePhotos.find((p) => p.id === id))
      .filter((p): p is Photo => !!p);
    if (album.coverMode === 'fixed')
      return [activePhotos.find((p) => p.id === album.coverPhotoId) || activePhotos[0]];
    return chosen.length ? chosen : activePhotos;
  }, [album?.coverMode, album?.coverPhotoId, album?.coverPhotoIds?.join(','), activePhotos]);
  const coverKey = `${album?.id}:${album?.coverMode}:${coverPool.map((p) => p.id).join(',')}`;
  useEffect(() => {
    setHeroIndex(
      album?.coverMode === 'random' ? Math.floor(Math.random() * Math.max(coverPool.length, 1)) : 0,
    );
  }, [coverKey]);
  useEffect(() => {
    if (
      !album ||
      album.coverMode === 'fixed' ||
      coverPool.length < 2 ||
      paused ||
      previewId ||
      coverOpen ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const timer = setInterval(
      () => {
        if (!document.hidden)
          setHeroIndex((v) =>
            album.coverMode === 'random'
              ? (v + 1 + Math.floor(Math.random() * (coverPool.length - 1))) % coverPool.length
              : (v + 1) % coverPool.length,
          );
      },
      (album.slideInterval || 8) * 1000,
    );
    return () => clearInterval(timer);
  }, [coverKey, album?.slideInterval, paused, previewId, coverOpen]);
  const hero = coverPool[heroIndex % Math.max(coverPool.length, 1)];
  const stats = album?.stats || emptyStats;
  const duplicateOriginals = useMemo(
    () => new Set(photos.map((p) => p.duplicateOf).filter(Boolean)),
    [photos],
  );
  const changeFilter = (next: Filter) => {
    setFilter(next);
    setSelected(new Set());
  };
  // 网格视图：本地筛选、文件名搜索与排序；不会修改数据库中的原始照片。
  const visiblePhotos = useMemo(() => {
    const result = (feedView ? galleryPhotos : photos).filter((p) => {
      if (tab !== 'trash' && p.deletedAt) return false;
      if (
        search &&
        (!galleryView || favoritesView) &&
        ![p.filename, p.authorName || '', p.albumTitle || '']
          .join(' ')
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())
      )
        return false;
      if (publicView || tab === 'trash') return true;
      return (
        filter === 'all' ||
        (filter === 'similar' && !!p.groupId) ||
        (filter === 'duplicates' && (!!p.duplicateOf || duplicateOriginals.has(p.id))) ||
        (filter === 'blur' && p.blur) ||
        (filter === 'keep' && p.pick === 'keep')
      );
    });
    if (feedView) return result;
    return result.sort((a, b) =>
      filter === 'similar' && a.groupId !== b.groupId
        ? (a.groupId || '').localeCompare(b.groupId || '')
        : sort === 'name'
          ? a.filename.localeCompare(b.filename)
          : sort === 'rating'
            ? b.rating - a.rating
            : (b.capturedAt || b.createdAt).localeCompare(a.capturedAt || a.createdAt),
    );
  }, [
    photos,
    galleryPhotos,
    feedView,
    galleryView,
    favoritesView,
    filter,
    search,
    sort,
    tab,
    publicView,
    duplicateOriginals,
  ]);
  const resetTab = (next: Tab) => {
    if (!user) {
      requestLogin('workspace', undefined, next);
      return;
    }
    navigate('/library');
    setTab(next);
    setFilter(next === 'smart' ? 'similar' : 'all');
  };
  // 业务操作：先由服务端校验和保存，再刷新前端数据。
  async function patchPhoto(id: string, patch: PhotoPatch) {
    const scope = contextKey;
    const data = await api<{ photo: Photo }>('/photos/' + id, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (currentScopeRef.current !== scope) return;
    setPhotos((current) => current.map((p) => (p.id === id ? data.photo : p)));
    if (patch.restore) setPhotos((current) => current.filter((p) => p.id !== id));
    reload();
  }
  async function patchAlbum(patch: Partial<Album>) {
    if (!album) return;
    const target = album.id;
    const requestedPath = path;
    const data = await api<{ album: Album }>('/albums/' + target, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (activeAlbumRef.current === target && routeRef.current === requestedPath)
      setAlbum(data.album);
    setAlbums((current) => current.map((a) => (a.id === data.album.id ? data.album : a)));
    reload();
  }
  async function setCover(id: string) {
    await patchAlbum({ coverMode: 'fixed', coverPhotoId: id });
    tell('已设置为相册封面');
  }
  async function analyze(id = albumId) {
    if (activeAlbumRef.current === id) {
      setAnalyzing(true);
      setAnalysisProgress('准备分析');
    }
    try {
      await api('/albums/' + id + '/analyze', { method: 'POST' });
      reload();
    } catch (e) {
      if (activeAlbumRef.current === id) setAnalyzing(false);
      tell((e as Error).message);
    }
  }
  function uploadContextIsCurrent(job: UploadJob) {
    return (
      !job.cancelled &&
      uploadJobRef.current === job &&
      activeAlbumRef.current === job.albumId &&
      uploadUserRef.current === job.userId &&
      routeRef.current === job.path &&
      uploadTabRef.current === job.tab
    );
  }

  // 一次选择只确认一次。保留原选择顺序，普通照片小批顺序上传，大照片逐张上传。
  async function runUpload(job: UploadJob, allowLargeFiles: boolean) {
    if (job.started) return;
    if (!uploadContextIsCurrent(job)) {
      if (uploadJobRef.current === job) cancelUpload('页面已切换，请在当前项目重新选择照片');
      return;
    }
    job.started = true;
    job.phase = 'uploading';
    setPendingUpload(null);
    const batches = createUploadBatches(job.selection.files, allowLargeFiles);
    const total = batches.reduce((count, batch) => count + batch.files.length, 0);
    let processed = 0;
    setUploadState({ percent: 0, current: 0, total });
    try {
      for (const batch of batches) {
        if (!uploadContextIsCurrent(job)) break;
        const form = new FormData();
        // Multer consumes fields in multipart order: consent must precede the photo parts.
        if (batch.allowLargeFiles) form.append('allowLargeFiles', 'true');
        batch.files.forEach((file) => form.append('photos', file));
        try {
          const result = await new Promise<UploadResult>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            job.xhr = xhr;
            const cleanup = () => {
              if (job.xhr === xhr) job.xhr = null;
              xhr.upload.onprogress = null;
              xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
            };
            const fail = (error: Error) => {
              cleanup();
              reject(error);
            };
            xhr.open('POST', `/api/albums/${job.albumId}/photos`);
            xhr.setRequestHeader('X-Album-Client', '1');
            xhr.upload.onprogress = (event) => {
              if (!uploadContextIsCurrent(job)) return;
              const fraction =
                event.lengthComputable && event.total > 0
                  ? Math.min(1, event.loaded / event.total)
                  : 0;
              setUploadState({
                percent: Math.round(((processed + fraction * batch.files.length) / total) * 100),
                current: processed,
                total,
              });
            };
            xhr.onload = () => {
              let response;
              try {
                response = JSON.parse(xhr.responseText);
              } catch {
                fail(new Error('服务响应异常，请稍后重试'));
                return;
              }
              if (
                Array.isArray(response?.photos) &&
                ((xhr.status >= 200 && xhr.status < 300) ||
                  (xhr.status === 400 && Array.isArray(response?.errors)))
              ) {
                cleanup();
                resolve(response);
              } else fail(new Error(response?.error || '上传失败，请重试'));
            };
            xhr.onerror = () => fail(new Error('连接中断，请先检查上传结果，再重试未完成的照片'));
            xhr.onabort = () => fail(new DOMException('本次上传已取消', 'AbortError'));
            xhr.timeout = batch.allowLargeFiles ? 300000 : 180000;
            xhr.ontimeout = () => fail(new Error('上传超时，请先检查上传结果，再重试未完成的照片'));
            xhr.send(form);
          });
          job.uploaded += result.photos.length;
          if (Array.isArray(result.errors))
            result.errors.forEach((error) =>
              job.failures.push(`${error.filename || '照片'}：${error.error || '上传失败'}`),
            );
        } catch (error) {
          if (job.cancelled) break;
          const message = error instanceof Error ? error.message : '上传失败，请重试';
          batch.files.forEach((file) => job.failures.push(`${file.name}：${message}`));
        }
        processed += batch.files.length;
        if (!uploadContextIsCurrent(job)) break;
        recordUploadErrors(job, job.failures);
        setUploadState({
          percent: Math.round((processed / total) * 100),
          current: processed,
          total,
        });
        reload();
      }
    } catch (error) {
      if (!job.cancelled) {
        const message = error instanceof Error ? error.message : '请重新选择未完成的照片';
        job.failures.push(`本次上传未完成：${message}`);
      }
    } finally {
      // A cancelled old request must never release a later selection's lock or erase its errors.
      if (uploadJobRef.current === job) {
        recordUploadErrors(job, job.failures);
        uploadJobRef.current = null;
        setPendingUpload(null);
        setUploadLocked(false);
        setUploadState(null);
        reload();
      }
    }
    if (
      !job.cancelled &&
      job.uploaded &&
      activeAlbumRef.current === job.albumId &&
      uploadUserRef.current === job.userId &&
      routeRef.current === job.path &&
      uploadTabRef.current === job.tab
    ) {
      tell(`已上传 ${job.uploaded} 张照片，正在后台分析`);
      await analyze(job.albumId);
    }
  }

  function upload(files: FileList | File[]) {
    if (!user || !albumId || publicView || tab === 'trash') return;
    if (uploadJobRef.current) {
      tell('请先完成或取消本次上传，再选择其他照片');
      return;
    }
    const selection = classifyUploadFiles(Array.from(files));
    if (!selection.files.length && !selection.errors.length) return;
    clearTimeout(toastTimer.current);
    setToast('');
    const job: UploadJob = {
      id: ++uploadSequence.current,
      albumId,
      userId: user.id,
      path,
      tab,
      selection,
      failures: [...selection.errors],
      uploaded: 0,
      cancelled: false,
      started: false,
      phase: selection.large.length ? 'confirming' : 'uploading',
      xhr: null,
    };
    recordUploadErrors(job, job.failures);
    if (!selection.files.length) {
      tell('所选文件均未能上传，请查看文件提示');
      return;
    }
    uploadJobRef.current = job;
    setUploadGuide(false);
    setUploadLocked(true);
    if (selection.large.length) setPendingUpload(job);
    else void runUpload(job, false);
  }
  async function importDemo() {
    const epoch = authEpoch.current;
    const requestedPath = path;
    setWorking(true);
    try {
      const { album: result } = await api<{ album: Album }>('/demo', { method: 'POST' });
      if (authEpoch.current !== epoch || routeRef.current !== requestedPath) return;
      setAlbumId(result.id);
      setTab('projects');
      reload();
      tell('示例项目已加入你的空间，可自由体验选片');
      await analyze(result.id);
    } catch (e) {
      if (authEpoch.current === epoch && routeRef.current === requestedPath)
        tell((e as Error).message);
    } finally {
      if (authEpoch.current === epoch && routeRef.current === requestedPath) setWorking(false);
    }
  }
  async function bulk(patch: PhotoPatch) {
    const scope = contextKey;
    setWorking(true);
    try {
      for (const id of selected) {
        if (currentScopeRef.current !== scope) return;
        await api('/photos/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
      }
      if (currentScopeRef.current !== scope) return;
      setSelected(new Set());
      setSelecting(false);
      setDeleteOpen(false);
      reload();
      tell(patch.deleted ? '已移入回收站，可随时恢复' : '已更新选片标记');
    } catch (e) {
      if (currentScopeRef.current === scope) {
        reload();
        tell((e as Error).message);
      }
    } finally {
      if (currentScopeRef.current === scope) setWorking(false);
    }
  }
  async function savePublication(settings: {
    photoIds: string[];
    allowDownload: boolean;
    title: string;
    featuredPhotoIds: string[];
  }) {
    if (!album) return;
    const target = album.id;
    const scope = contextKey;
    const ownerId = user?.id;
    const data = await api<{ album: Album }>(
      '/albums/' + encodeURIComponent(target) + '/publication',
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
    );
    if (uploadUserRef.current !== ownerId) return;
    setAlbums((current) => current.map((item) => (item.id === target ? data.album : item)));
    if (currentScopeRef.current !== scope) {
      reload();
      return;
    }
    setAlbum(data.album);
    setPublishOpen(false);
    setSelected(new Set());
    setSelecting(false);
    reload();
    tell(
      settings.photoIds.length
        ? `已发布 ${settings.photoIds.length} 张精选照片，其余照片继续私密`
        : '已撤回公开，照片仍保留在你的相册中',
    );
  }
  function requestLogin(
    kind: PendingIntent['kind'],
    photo?: Photo,
    workspaceTab?: PendingIntent['workspaceTab'],
  ) {
    setAuthIntent({
      kind,
      path: route,
      photoId: photo?.id || previewId || undefined,
      scrollY: window.scrollY,
      workspaceTab,
    });
  }
  function openPhoto(photo: Photo) {
    setPreviewId(photo.id);
    if (publicView) navigate(path + '?photo=' + encodeURIComponent(photo.id), true);
  }
  function closePreview() {
    setPreviewId(null);
    if (publicView) navigate(path, true);
  }
  function requestUpload() {
    if (!user) {
      requestLogin('upload');
      return;
    }
    if (!publicView && albumId && tab !== 'trash') fileInput.current?.click();
    else {
      setUploadGuide(true);
      setTab('projects');
      navigate('/library');
    }
  }
  async function favoritePhoto(photo: Photo) {
    if (!user) {
      requestLogin('favorite', photo);
      return;
    }
    const ownerId = user.id;
    const scope = contextKey;
    const feed = feedContext.current;
    if (favoriteRequests.current.has(photo.id)) return;
    favoriteRequests.current.add(photo.id);
    try {
      const next = !photo.isFavorite;
      await api('/photos/' + encodeURIComponent(photo.id) + '/favorite', {
        method: 'PUT',
        body: JSON.stringify({ favorite: next }),
      });
      if (uploadUserRef.current !== ownerId) return;
      if (currentScopeRef.current !== scope || feedContext.current !== feed) {
        reload();
        return;
      }
      const update = (items: Photo[]) =>
        items.map((item) => (item.id === photo.id ? { ...item, isFavorite: next } : item));
      setGalleryPhotos((current) =>
        favoritesView && !next ? current.filter((item) => item.id !== photo.id) : update(current),
      );
      setPhotos(update);
      if (favoritesView && !next && visiblePhotos.length <= 1) closePreview();
      tell(next ? '已加入我的收藏' : '已取消收藏');
      reload();
    } catch (error) {
      if (currentScopeRef.current === scope) tell((error as Error).message);
    } finally {
      favoriteRequests.current.delete(photo.id);
    }
  }
  async function requestDownload(photo: Photo) {
    if (publicView && !photo.allowDownload && photo.authorId !== user?.id) {
      tell('作者暂未开放展示图下载');
      return;
    }
    if (!user) {
      requestLogin('download', photo);
      return;
    }
    try {
      await downloadPhoto(photo.id);
      tell('下载已准备好');
    } catch (error) {
      tell((error as Error).message);
    }
  }
  async function loadMorePhotos() {
    if (!nextCursor || loadingMore || !galleryView) return;
    const version = feedRequestVersion.current;
    setLoadingMore(true);
    try {
      const query = new URLSearchParams({
        sort: gallerySort,
        q: search,
        limit: '48',
        cursor: nextCursor,
      });
      const data = await api<{ photos: PublicPhoto[]; nextCursor: string | null }>(
        '/public/photos?' + query,
      );
      if (feedRequestVersion.current !== version) return;
      setGalleryPhotos((current) => {
        const ids = new Set(current.map((photo) => photo.id));
        return [
          ...current,
          ...data.photos.filter((photo) => !ids.has(photo.id)).map(publicPhotoToPhoto),
        ];
      });
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (feedRequestVersion.current === version) setLoadError((error as Error).message);
    } finally {
      if (feedRequestVersion.current === version) setLoadingMore(false);
    }
  }
  // The intent stays in memory, contains no files or credentials, and is consumed once.
  useEffect(() => {
    if (!resumeIntent || !user) return;
    const intent = resumeIntent;
    setResumeIntent(null);
    if (intent.kind === 'upload') {
      setUploadGuide(true);
      setTab('projects');
      navigate('/library');
    } else if (intent.kind === 'workspace') {
      if (intent.workspaceTab === 'favorites') navigate('/favorites');
      else {
        setTab(intent.workspaceTab || 'projects');
        navigate('/library');
      }
    } else {
      const target = normalizeReturnPath(intent.path, window.location.origin);
      if (target !== route) navigate(target, true);
      if (intent.photoId && new URL(target, window.location.origin).searchParams.has('photo'))
        setPreviewId(intent.photoId);
      requestAnimationFrame(() => window.scrollTo({ top: intent.scrollY }));
      if (intent.kind === 'download' && intent.photoId) {
        void downloadPhoto(intent.photoId)
          .then(() => tell('下载已准备好'))
          .catch((e) => tell(e.message));
      } else if (intent.kind === 'favorite' && intent.photoId) {
        const id = intent.photoId;
        const ownerId = user.id;
        void api('/photos/' + encodeURIComponent(id) + '/favorite', {
          method: 'PUT',
          body: JSON.stringify({ favorite: true }),
        })
          .then(() => {
            if (uploadUserRef.current !== ownerId) return;
            setGalleryPhotos((items) =>
              items.map((photo) => (photo.id === id ? { ...photo, isFavorite: true } : photo)),
            );
            setPhotos((items) =>
              items.map((photo) => (photo.id === id ? { ...photo, isFavorite: true } : photo)),
            );
            tell('已加入我的收藏');
            reload();
          })
          .catch((e) => tell(e.message));
      }
    }
  }, [resumeIntent, user, navigate, route, tell]);
  useEffect(() => {
    if (sessionLoading || user || (path !== '/library' && path !== '/favorites')) return;
    setAuthIntent(
      (current) =>
        current || {
          kind: 'workspace',
          path: '/',
          scrollY: 0,
          workspaceTab: path === '/favorites' ? 'favorites' : 'projects',
        },
    );
    navigate('/', true);
  }, [sessionLoading, user, path, navigate]);
  useEffect(() => {
    if (authIntent && new URL(authIntent.path, window.location.origin).pathname !== path)
      setAuthIntent(null);
  }, [path, authIntent]);
  const selectPhoto = (id: string) => {
    setSelecting(true);
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // 页面组合：认证页、公开作品、私密工作台，以及各类独立弹窗。
  if (sessionLoading && !publicView)
    return (
      <div className="startup">
        <Aperture className="spin-slow" size={45} />
        <span>正在打开你的创作空间</span>
      </div>
    );
  return (
    <div
      className="app-shell"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (!publicView && album && tab !== 'trash' && !uploadJobRef.current) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (dragging) {
          e.preventDefault();
          dragDepth.current--;
          if (dragDepth.current <= 0) setDragging(false);
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!user || publicView) {
            requestUpload();
            tell('进入自己的相册后，请重新选择要上传的照片');
          } else upload(e.dataTransfer.files);
        }
      }}
    >
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            navigate('/');
            setTab('projects');
          }}
          aria-label="光影相册首页"
        >
          <Aperture size={29} />
          <span>
            光影<span className="brand-separator">/</span>
            <small>AI 相册</small>
          </span>
        </button>
        <nav className="main-nav" aria-label="主导航">
          <button
            className={publicView && !favoritesView ? 'active public-nav' : 'public-nav'}
            onClick={() => navigate('/')}
          >
            公共图库
          </button>
          <button
            className={!publicView && tab === 'projects' ? 'active' : ''}
            onClick={() => resetTab('projects')}
          >
            我的相册
          </button>
          <button
            className={!publicView && tab === 'smart' ? 'active' : ''}
            onClick={() => resetTab('smart')}
          >
            智能选片
          </button>
          <button
            className={favoritesView ? 'active' : ''}
            onClick={() =>
              user ? navigate('/favorites') : requestLogin('workspace', undefined, 'favorites')
            }
          >
            我的收藏
          </button>
          {user && (
            <button
              className={!publicView && tab === 'trash' ? 'active' : ''}
              onClick={() => resetTab('trash')}
            >
              回收站
            </button>
          )}
        </nav>
        <div className="header-actions">
          {user ? (
            <>
              <button
                className="button button-primary upload-header"
                onClick={requestUpload}
                disabled={uploadLocked}
              >
                <Upload size={16} />
                <span>上传照片</span>
              </button>
              <div className="user-avatar" title={user.name}>
                {user.name.slice(0, 1).toUpperCase()}
              </div>
              <button
                className="icon-button logout"
                title="退出登录"
                aria-label="退出登录"
                onClick={async () => {
                  cancelUpload('已取消本次上传');
                  try {
                    await api('/auth/logout', { method: 'POST' });
                    authEpoch.current++;
                    setSessionLoading(false);
                    setUploadErrorsByAlbum({});
                    setUser(null);
                    setAlbums([]);
                    setAlbumId('');
                    setPhotos([]);
                    setAlbum(null);
                    setGalleryPhotos([]);
                    setAuthIntent(null);
                    setResumeIntent(null);
                    setPreviewId(null);
                    setCreateOpen(false);
                    setWorking(false);
                    navigate('/');
                  } catch (e) {
                    tell((e as Error).message);
                  }
                }}
              >
                <LogOut size={17} />
              </button>
            </>
          ) : (
            <>
              <button className="button button-secondary upload-header" onClick={requestUpload}>
                <Upload size={18} />
                <span>上传照片</span>
              </button>
              <button className="button button-primary" onClick={() => requestLogin('login')}>
                登录 / 注册
              </button>
            </>
          )}
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) upload(e.target.files);
          e.target.value = '';
        }}
      />
      {feedView ? (
        <main className="explore-page public-gallery">
          <section
            className="project-hero gallery-hero"
            aria-label={favoritesView ? '我的收藏' : '公共图库'}
          >
            {galleryPhotos[0] && (
              <img src={galleryPhotos[0].previewUrl} className="hero-photo" alt="" />
            )}
            <div className="hero-shade" />
            <div className="hero-content">
              <h1>{favoritesView ? '我的收藏' : '公共图库'}</h1>
              <p className="hero-description">
                {favoritesView
                  ? '把喜欢的作品留在这里，随时回来寻找灵感。'
                  : '先看见喜欢的作品，再开始自己的创作。'}
              </p>
            </div>
            <span className="gallery-visitor">
              <Globe size={17} />
              {user ? '发现摄影作品' : '游客浏览'}
            </span>
          </section>
          <div className="gallery-toolbar">
            <div className="gallery-tabs" role="group" aria-label="图库内容">
              {favoritesView ? (
                <span className="gallery-tab-label">
                  <Heart size={18} />
                  已收藏作品
                </span>
              ) : (
                <>
                  <button
                    className={gallerySort === 'featured' ? 'active' : ''}
                    aria-pressed={gallerySort === 'featured'}
                    onClick={() => setGallerySort('featured')}
                  >
                    精选作品
                  </button>
                  <button
                    className={gallerySort === 'latest' ? 'active' : ''}
                    aria-pressed={gallerySort === 'latest'}
                    onClick={() => setGallerySort('latest')}
                  >
                    最新发布
                  </button>
                </>
              )}
            </div>
            <div className="search-field gallery-search">
              <Search size={19} />
              <input
                aria-label="搜索作品、相册或作者"
                placeholder="搜索作品、相册或作者"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}>
                  <X size={17} />
                </button>
              )}
            </div>
          </div>
          {unavailableFavorites > 0 && favoritesView && (
            <p className="gallery-notice" role="status">
              {unavailableFavorites} 张收藏作品已被作者撤回或暂不可用，其他收藏仍可浏览。
            </p>
          )}
          {loadError && (
            <div className="load-error" role="alert">
              <p>{loadError}</p>
              <button className="button button-secondary" onClick={reload}>
                <RefreshCw size={18} />
                重试加载
              </button>
            </div>
          )}
          {loading && !galleryPhotos.length ? (
            <Loading />
          ) : visiblePhotos.length ? (
            <div className="photo-grid public-photo-grid">
              {visiblePhotos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  selected={false}
                  selecting={false}
                  readOnly
                  onOpen={() => openPhoto(photo)}
                  onSelect={() => {}}
                  onPick={() => {}}
                  onFavorite={() => void favoritePhoto(photo)}
                />
              ))}
            </div>
          ) : !loadError && !loading ? (
            <Empty
              icon={favoritesView ? Heart : Globe}
              title={
                search
                  ? '没有找到相关作品'
                  : favoritesView
                    ? '把喜欢的作品收藏在这里'
                    : '好作品，值得被看见'
              }
              text={
                search
                  ? '试试其他作品名、相册名或作者名称。'
                  : favoritesView
                    ? '在公共图库点击收藏，下次就能在这里找到。'
                    : '作者主动发布后，作品会出现在这里；私人相册不会公开。'
              }
            >
              {favoritesView ? (
                <button className="button button-secondary" onClick={() => navigate('/')}>
                  去公共图库看看
                </button>
              ) : !search ? (
                <button className="button button-secondary" onClick={requestUpload}>
                  上传自己的作品
                </button>
              ) : null}
            </Empty>
          ) : null}
          {galleryView && nextCursor && (
            <div className="gallery-more">
              <button
                className="button button-secondary"
                disabled={loadingMore || loading}
                onClick={() => void loadMorePhotos()}
              >
                {loadingMore && <LoaderCircle size={18} className="spin" />}
                {loadingMore ? '正在加载' : '加载更多作品'}
              </button>
            </div>
          )}
        </main>
      ) : (
        <>
          {uploadGuide && !publicView && (
            <div className="upload-guide" role="status">
              <div>
                <strong>准备上传你的照片</strong>
                <p>
                  {albumId
                    ? '请选择本地照片，上传后默认仅你可见。'
                    : '先创建一个拍摄项目，再选择本地照片。'}
                </p>
              </div>
              <button
                className="button button-primary"
                onClick={() => (albumId ? fileInput.current?.click() : setCreateOpen(true))}
              >
                {albumId ? '选择照片' : '新建项目并上传'}
              </button>
              <button
                className="icon-button"
                aria-label="关闭上传引导"
                onClick={() => setUploadGuide(false)}
              >
                <X size={20} />
              </button>
            </div>
          )}
          {!publicView && tab !== 'trash' && (
            <div className="album-rail">
              <span className="rail-label">
                我的拍摄项目<span>{albums.length.toString().padStart(2, '0')}</span>
              </span>
              <div className="album-tabs">
                {albums.map((a) => (
                  <button
                    key={a.id}
                    className={albumId === a.id ? 'active' : ''}
                    onClick={() => setAlbumId(a.id)}
                  >
                    {a.coverUrl && <img src={a.coverUrl} alt="" />}
                    <span>{a.title}</span>
                    {a.isPublic ? <Globe size={12} /> : <LockKeyhole size={12} />}
                  </button>
                ))}
              </div>
              <button className="rail-create" onClick={() => setCreateOpen(true)}>
                <Plus size={15} />
                <span>新建项目</span>
              </button>
            </div>
          )}
          {loadError ? (
            <div className="load-error" role="alert">
              <p>{loadError}</p>
              <button className="button button-secondary" onClick={reload}>
                <RefreshCw size={16} />
                重新加载
              </button>
            </div>
          ) : null}
          {loading && !album && (publicView || tab !== 'trash') ? (
            <Loading />
          ) : (publicView || tab !== 'trash') && album ? (
            <>
              <section className={`project-hero ${hero ? '' : 'hero-empty'}`} aria-label="相册大图">
                {hero && (
                  <img
                    key={hero.id}
                    src={hero.previewUrl || hero.url}
                    className="hero-photo"
                    alt={hero.filename}
                    fetchPriority="high"
                  />
                )}
                <div className="hero-shade" />
                <div className="hero-content">
                  <p className="eyebrow">
                    {publicView
                      ? 'A PHOTOGRAPHIC JOURNAL'
                      : `YOUR PROJECT / ${String(Math.max(1, albums.findIndex((a) => a.id === album.id) + 1)).padStart(2, '0')}`}
                  </p>
                  <h1>{album.title}</h1>
                  <p className="hero-description">
                    {album.description || '用镜头收藏瞬间，让光影讲述故事。'}
                  </p>
                  <div className="hero-details">
                    <span>{formatDate(album.createdAt)}</span>
                    <span className="tiny-dot" />
                    <span>
                      {album.photoCount}
                      {' 张照片'}
                    </span>
                    {album.location && (
                      <>
                        <span className="tiny-dot" />
                        <span>{album.location}</span>
                      </>
                    )}
                  </div>
                  <span className="privacy-label">
                    {album.isPublic ? <Globe size={14} /> : <LockKeyhole size={14} />}
                    {album.isPublic ? '公开作品集' : '私密项目'}
                  </span>
                  {!publicView && (
                    <div className="hero-actions">
                      <button
                        className="button button-primary"
                        disabled={analyzing || !activePhotos.length}
                        onClick={() => void analyze()}
                      >
                        {analyzing ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Sparkles size={17} />
                        )}
                        {analyzing ? `正在分析 ${analysisProgress}` : '开始智能选片'}
                        {!analyzing && <ArrowUpRight size={17} />}
                      </button>
                      <button
                        className="button button-glass"
                        onClick={() =>
                          activePhotos.length ? setCoverOpen(true) : fileInput.current?.click()
                        }
                      >
                        <Settings2 size={16} />
                        封面与轮播
                      </button>
                    </div>
                  )}
                </div>
                {!publicView && (
                  <div className="hero-top-actions">
                    <button
                      className="glass-icon"
                      title="公开作品集设置"
                      onClick={() => setPublishOpen(true)}
                    >
                      <Globe size={16} />
                      <span>{album.isPublic ? '管理公开作品' : '发布精选作品'}</span>
                    </button>
                  </div>
                )}
                {activePhotos.length > 0 && (
                  <div className="hero-controls">
                    <span className="cover-mode-label">
                      {album.coverMode === 'slideshow'
                        ? '照片轮播'
                        : album.coverMode === 'random'
                          ? '随机轮播'
                          : '精选封面'}
                    </span>
                    {coverPool.length > 1 && (
                      <>
                        <button
                          className="glass-icon"
                          aria-label="上一张封面"
                          onClick={() =>
                            setHeroIndex((v) => (v - 1 + coverPool.length) % coverPool.length)
                          }
                        >
                          <ChevronLeft size={17} />
                        </button>
                        <span className="hero-counter">
                          {String((heroIndex % coverPool.length) + 1).padStart(2, '0')}
                          {' / '}
                          {String(coverPool.length).padStart(2, '0')}
                        </span>
                        <button
                          className="glass-icon"
                          aria-label="下一张封面"
                          onClick={() => setHeroIndex((v) => (v + 1) % coverPool.length)}
                        >
                          <ChevronRight size={17} />
                        </button>
                        {album.coverMode !== 'fixed' && (
                          <button
                            className="glass-icon"
                            aria-label={paused ? '播放轮播' : '暂停轮播'}
                            onClick={() => setPaused(!paused)}
                          >
                            {paused ? <Play size={15} /> : <Pause size={15} />}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      className="glass-icon"
                      aria-label="预览封面大图"
                      onClick={() => hero && openPhoto(hero)}
                    >
                      <Expand size={17} />
                    </button>
                  </div>
                )}
                {!publicView && activePhotos.length > 0 && (
                  <div className="analysis-summary">
                    <div className="analysis-title">
                      <ShieldCheck size={17} />
                      <span>
                        {analyzing
                          ? '正在整理你的照片'
                          : album.analysisStatus === 'complete' ||
                              activePhotos.some((p) => p.sharpness != null)
                            ? '分析已完成'
                            : '等待智能分析'}
                      </span>
                    </div>
                    <div className="analysis-stats">
                      <button onClick={() => changeFilter('duplicates')}>
                        <strong>{stats.duplicates}</strong>
                        <span>重复候选</span>
                      </button>
                      <button onClick={() => changeFilter('similar')}>
                        <strong>{stats.similarGroups}</strong>
                        <span>相似分组</span>
                      </button>
                      <button onClick={() => changeFilter('blur')}>
                        <strong>{stats.blurry}</strong>
                        <span>疑似模糊</span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <main className="photo-workspace">
                <div className="workspace-heading">
                  <div className="section-title">
                    <h2>{publicView ? '作品影集' : '项目照片'}</h2>
                    <span>{activePhotos.length}</span>
                    {loading && <LoaderCircle className="spin" size={16} />}
                  </div>
                  <div className="workspace-controls">
                    <div className="search-field">
                      <Search size={16} />
                      <input
                        placeholder="查找照片"
                        aria-label="按文件名查找照片"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button
                          className="icon-button"
                          aria-label="清空搜索"
                          onClick={() => setSearch('')}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                    <select
                      className="sort-select"
                      aria-label="照片排序"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="date">{publicView ? '作品时间' : '导入时间'}</option>
                      <option value="name">文件名称</option>
                      {!publicView && <option value="rating">星级优先</option>}
                    </select>
                    <Grid2X2 size={18} className="grid-indicator" />
                    {!publicView && (
                      <button
                        className={`button button-small button-secondary ${selecting ? 'is-active' : ''}`}
                        onClick={() => {
                          setSelecting(!selecting);
                          setSelected(new Set());
                        }}
                      >
                        <CheckCheck size={15} />
                        {selecting ? '结束选择' : '批量选择'}
                      </button>
                    )}
                  </div>
                </div>
                {!publicView ? (
                  <div className="filter-row">
                    {filters.map((f) => (
                      <button
                        key={f.id}
                        className={filter === f.id ? 'active' : ''}
                        aria-pressed={filter === f.id}
                        onClick={() => changeFilter(f.id)}
                      >
                        {f.label}
                        {f.id === 'keep' && stats.kept > 0 && <span>{stats.kept}</span>}
                      </button>
                    ))}
                    <span className="workspace-hint">点击照片进入沉浸预览</span>
                  </div>
                ) : (
                  <div className="public-description">
                    {album.description || '每张作品，都有一个属于它的故事。'}
                  </div>
                )}
                {uploadErrors.length > 0 && (
                  <div className="upload-errors" role="alert">
                    <button
                      className="icon-button"
                      aria-label="关闭上传提示"
                      onClick={() =>
                        setUploadErrorsByAlbum((current) => ({ ...current, [uploadErrorKey]: [] }))
                      }
                    >
                      <X size={16} />
                    </button>
                    <strong>部分照片未能上传，可重新选择后重试</strong>
                    {uploadErrors.slice(0, 8).map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                    {uploadErrors.length > 8 && (
                      <p>
                        {'还有 '}
                        {uploadErrors.length - 8}
                        {' 条提示'}
                      </p>
                    )}
                  </div>
                )}
                {visiblePhotos.length ? (
                  <div className="photo-grid">
                    {visiblePhotos.map((p) => (
                      <PhotoCard
                        key={p.id}
                        photo={p}
                        selected={selected.has(p.id)}
                        selecting={selecting}
                        readOnly={publicView}
                        onOpen={() => openPhoto(p)}
                        onFavorite={() => void favoritePhoto(p)}
                        onSelect={() => selectPhoto(p.id)}
                        onPick={() =>
                          void patchPhoto(p.id, {
                            pick: p.pick === 'keep' ? 'none' : 'keep',
                          }).catch((e) => tell(e.message))
                        }
                      />
                    ))}
                    {!publicView && filter === 'all' && !search && (
                      <button
                        className="upload-tile"
                        onClick={() => fileInput.current?.click()}
                        disabled={uploadLocked}
                      >
                        <ImagePlus size={25} />
                        <strong>添加更多照片</strong>
                        <span>拖入照片，或点击上传</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <Empty
                    icon={activePhotos.length ? Search : ImagePlus}
                    title={
                      activePhotos.length ? '这个视角下，还没有照片' : '让第一张照片，开启故事'
                    }
                    text={
                      activePhotos.length
                        ? '试试其他筛选条件，或先运行一次智能分析。'
                        : '支持 JPG、PNG、WebP。20MB 以内直接上传，超过 20MB 至 30MB 需本次确认。'
                    }
                  >
                    {!publicView && !activePhotos.length && (
                      <button
                        className="button button-primary"
                        onClick={() => fileInput.current?.click()}
                        disabled={uploadLocked}
                      >
                        <Upload size={16} />
                        上传照片
                      </button>
                    )}
                  </Empty>
                )}
                {!publicView && (
                  <div className="workspace-footer">
                    <span>
                      <LockKeyhole size={12} />
                      {album.isPublic
                        ? '仅主动选中的照片已公开，其余照片继续私密'
                        : '当前项目仅你可见'}
                    </span>
                    <span>本地智能筛选仅提供建议，照片由你决定取舍。</span>
                  </div>
                )}
              </main>
            </>
          ) : tab === 'trash' && !publicView ? (
            <main className="trash-page">
              <div className="section-intro">
                <p className="eyebrow">NOT EVERY GOODBYE IS FOREVER</p>
                <h1>回收站</h1>
                <p className="muted">被移除的照片暂存在这里，恢复后会回到原来的项目。</p>
              </div>
              {loading ? (
                <Loading />
              ) : photos.length ? (
                <div className="photo-grid">
                  {photos.map((p) => (
                    <article key={p.id} className="photo-card trash-card">
                      <img
                        src={p.thumbnailUrl}
                        alt={p.filename}
                        width={p.width}
                        height={p.height}
                        loading="lazy"
                      />
                      <div className="photo-meta">
                        <span className="filename">{p.filename}</span>
                        <button
                          className="text-button"
                          onClick={() =>
                            void patchPhoto(p.id, { restore: true })
                              .then(() => tell('已恢复到原项目'))
                              .catch((e) => tell(e.message))
                          }
                        >
                          <RefreshCw size={13} />
                          恢复
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={Trash2}
                  title="回收站是空的"
                  text="你的每一次选择，都保留着重新考虑的余地。"
                />
              )}
            </main>
          ) : publicView ? (
            <Empty
              icon={Globe}
              title="作品集暂不可用"
              text="作品可能尚未发布或已经撤回，你仍然可以浏览公共图库。"
            >
              <button className="button button-secondary" onClick={() => navigate('/')}>
                返回公共图库
              </button>
            </Empty>
          ) : !loading && !loadError && !publicView ? (
            <main className="welcome-page">
              <div className="welcome-decoration">
                <Aperture size={65} strokeWidth={1} />
              </div>
              <p className="eyebrow">YOUR NEXT STORY STARTS HERE</p>
              <h1>
                为你的作品，
                <br />
                留一个更好的空间。
              </h1>
              <p className="muted">
                创建第一个拍摄项目，上传照片，
                <br />
                从相似的瞬间里，找到最动人的一帧。
              </p>
              <div className="welcome-actions">
                <button className="button button-primary" onClick={() => setCreateOpen(true)}>
                  <FolderPlus size={18} />
                  新建拍摄项目
                </button>
                <button
                  className="button button-secondary"
                  disabled={working}
                  onClick={() => void importDemo()}
                >
                  {working ? <LoaderCircle className="spin" size={17} /> : <Images size={17} />}
                  体验示例项目
                </button>
              </div>
              <span className="small-text muted">
                示例项目使用生成的摄影素材，可在自己的空间内自由体验。
              </span>
            </main>
          ) : null}
        </>
      )}
      <footer className="app-footer">
        <span>光影 / AI 相册</span>
        <span>MADE FOR THE WAY YOU SEE.</span>
        {publicView && (
          <button className="text-button" onClick={() => navigate('/explore')}>
            <ArrowLeft size={13} />
            所有公开作品
          </button>
        )}
      </footer>
      {uploadState && (
        <div className="upload-progress" role="status">
          <div>
            <LoaderCircle className="spin" size={18} />
            <strong>正在上传照片</strong>
            <span>{uploadState.percent}%</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${uploadState.percent}%` }} />
          </div>
          <p>
            {'请保持页面打开 · 共 '}
            {uploadState.total}
            {' 张'}
          </p>
        </div>
      )}
      {selected.size > 0 && !publicView && (
        <div className="selection-bar">
          <span>
            {'已选择 '}
            <strong>{selected.size}</strong>
            {' 张'}
          </span>
          <button
            className="text-button"
            onClick={() => setSelected(new Set(visiblePhotos.map((p) => p.id)))}
          >
            全选当前结果
          </button>
          <span className="selection-divider" />
          <button
            className="button button-small button-primary"
            onClick={() => setPublishOpen(true)}
            disabled={working}
          >
            <Globe size={17} />
            发布所选照片
          </button>
          <button
            className="button button-small button-secondary"
            disabled={working}
            onClick={() => void bulk({ pick: 'keep' })}
          >
            <Star size={15} />
            标记保留
          </button>
          <button
            className="button button-small button-danger"
            onClick={() => setDeleteOpen(true)}
            disabled={working}
          >
            <Trash2 size={15} />
            移入回收站
          </button>
          <button
            className="icon-button"
            aria-label="清空选择"
            onClick={() => setSelected(new Set())}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={45} />
          <h2>把这一刻，交给光影</h2>
          <p>松开鼠标，上传到「{album?.title}」</p>
        </div>
      )}
      {pendingUpload && (
        <LargeUploadDialog
          key={pendingUpload.id}
          files={pendingUpload.selection.large}
          normalCount={pendingUpload.selection.normal.length}
          skippedErrors={pendingUpload.selection.errors}
          onConfirm={() => {
            void runUpload(pendingUpload, true);
          }}
          onSkip={() => {
            void runUpload(pendingUpload, false);
          }}
          onCancel={() => cancelUpload()}
        />
      )}
      {createOpen && (
        <CreateAlbum
          onClose={() => setCreateOpen(false)}
          onCreate={(a) => {
            if (!user || uploadUserRef.current !== user.id || routeRef.current !== path) return;
            setAlbums((current) => [a, ...current]);
            setAlbumId(a.id);
            setTab('projects');
            navigate('/library');
            setCreateOpen(false);
            reload();
            tell('项目已创建，可以上传照片了');
          }}
        />
      )}
      {coverOpen && album && (
        <CoverDialog
          album={album}
          photos={activePhotos}
          onClose={() => setCoverOpen(false)}
          onSave={patchAlbum}
        />
      )}
      {previewId && (
        <PhotoPreview
          photos={
            visiblePhotos.length && visiblePhotos.some((p) => p.id === previewId)
              ? visiblePhotos.filter((p) => !p.deletedAt)
              : feedView
                ? galleryPhotos
                : activePhotos
          }
          initialId={previewId}
          onClose={closePreview}
          onUpdate={patchPhoto}
          onSetCover={publicView ? undefined : setCover}
          readOnly={publicView}
          currentUserId={user?.id}
          onDownload={(photo) => void requestDownload(photo)}
          onFavorite={publicView ? (photo) => void favoritePhoto(photo) : undefined}
          onNavigateAlbum={(photo) => {
            closePreview();
            if (photo.albumSlug) navigate('/p/' + encodeURIComponent(photo.albumSlug));
          }}
          onActiveChange={(id) => {
            setPreviewId(id);
            if (publicView) navigate(path + '?photo=' + encodeURIComponent(id), true);
          }}
          isInteractionBlocked={!!authIntent}
        />
      )}
      {publishOpen && album && (
        <PublishDialog
          album={album}
          photos={activePhotos}
          initialSelectedIds={[...selected]}
          onClose={() => setPublishOpen(false)}
          onSave={savePublication}
        />
      )}
      {authIntent && (
        <AuthDialog
          intent={authIntent.kind}
          photo={(feedView ? galleryPhotos : photos).find(
            (photo) => photo.id === authIntent.photoId,
          )}
          onClose={() => {
            setAuthIntent(null);
            requestAnimationFrame(() => window.scrollTo({ top: authIntent.scrollY }));
          }}
          onLogin={(value) => {
            const intent = authIntent;
            if (
              normalizeReturnPath(intent.path, window.location.origin) !==
              window.location.pathname + window.location.search
            )
              return;
            authEpoch.current++;
            setSessionLoading(false);
            setUser(value);
            setAuthIntent(null);
            setResumeIntent(intent);
            setLoadError('');
          }}
        />
      )}
      {deleteOpen && (
        <Modal title="将选中的照片移入回收站？" onClose={() => setDeleteOpen(false)}>
          <p className="muted modal-intro">
            {'选中的 '}
            {selected.size}
            {' 张照片会从相册和公开作品集中移除，可以在回收站恢复。'}
          </p>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button
              className="button button-danger"
              disabled={working}
              onClick={() => void bulk({ deleted: true })}
            >
              {working && <LoaderCircle className="spin" size={16} />}移入回收站
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={25} className="spin" />
      <span>正在加载照片，首次连接可能需要稍候……</span>
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  children,
}: {
  icon: typeof Search;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon size={32} strokeWidth={1.3} />
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
