import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Aperture, ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronLeft, ChevronRight, Download, Expand, FolderPlus, Globe, Grid2X2, ImagePlus, Images, LoaderCircle, LockKeyhole, LogOut, Pause, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Shuffle, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import type { Album, Photo, PhotoPatch, User } from '../shared/types';
import { api, formatDate } from './api';
import AuthView from './components/AuthView';
import Modal from './components/Modal';
import CoverDialog from './components/CoverDialog';
import PhotoPreview from './components/PhotoPreview';

type Filter = 'all' | 'similar' | 'duplicates' | 'blur' | 'keep';
type Tab = 'projects' | 'smart' | 'trash';
const filters: { id: Filter; label: string }[] = [{ id: 'all', label: '全部照片' }, { id: 'similar', label: '相似分组' }, { id: 'duplicates', label: '重复候选' }, { id: 'blur', label: '疑似模糊' }, { id: 'keep', label: '已选作品' }];
const emptyStats = { duplicates: 0, similarGroups: 0, blurry: 0, kept: 0 };

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const change = () => setPath(window.location.pathname); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  const navigate = useCallback((next: string) => { window.history.pushState(null, '', next); setPath(next); window.scrollTo({ top: 0 }); }, []);
  return { path, navigate };
}

function PhotoCard({ photo, selected, selecting, readOnly, onOpen, onSelect, onPick }: { photo: Photo; selected: boolean; selecting: boolean; readOnly: boolean; onOpen: () => void; onSelect: () => void; onPick: () => void }) {
  return <article className={`photo-card ${selected ? 'is-selected' : ''}`}>
    <button className="photo-image-button" onClick={selecting ? onSelect : onOpen} aria-label={`${selecting ? '选择' : '预览'} ${photo.filename}`}><img src={photo.thumbnailUrl} alt={photo.filename} loading="lazy" draggable="false" /></button>
    {!readOnly && <button className={`photo-check ${selected ? 'is-selected' : ''} ${selecting ? 'is-visible' : ''}`} onClick={onSelect} aria-label={`${selected ? '取消选择' : '选择'} ${photo.filename}`} aria-pressed={selected}>{selected && <Check size={14} />}</button>}
    <div className="photo-badges">{photo.duplicateOf ? <span className="photo-badge"><Images size={12} />完全重复</span> : photo.groupId ? <span className="photo-badge"><Images size={12} />相似组</span> : null}{photo.blur && <span className="photo-badge badge-amber">疑似模糊</span>}</div>
    <div className="photo-meta"><div><button className="filename" onClick={onOpen} title={photo.filename}>{photo.filename}</button><time>{formatDate(photo.capturedAt || photo.createdAt)}</time></div>{!readOnly ? <button className={`pick-button ${photo.pick === 'keep' ? 'is-kept' : ''}`} onClick={onPick} aria-label={photo.pick === 'keep' ? '取消保留' : '标记为保留'} title={photo.pick === 'keep' ? '已标记保留' : '标记为保留'}><Star size={15} fill={photo.pick === 'keep' ? 'currentColor' : 'none'} /></button> : <span className="photo-resolution">{photo.width} × {photo.height}</span>}</div>
  </article>;
}

function CreateAlbum({ onClose, onCreate }: { onClose: () => void; onCreate: (album: Album) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true);
    try { const { album } = await api<{ album: Album }>('/albums', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }); onCreate(album); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title="新建拍摄项目" onClose={onClose}><p className="muted modal-intro">给这一次拍摄留一个专属空间。</p><form className="form-stack" onSubmit={submit}><label>项目名称<input name="title" placeholder="例如：京都 · 光影纪行" required maxLength={120} autoComplete="off" /></label><label>拍摄地点 <span className="optional">选填</span><input name="location" placeholder="城市或地点" maxLength={120} /></label><label>项目描述 <span className="optional">选填</span><textarea name="description" placeholder="记录这一次拍摄的故事……" maxLength={1000} rows={3} /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建项目</button></div></form></Modal>;
}

export default function App() {
  const { path, navigate } = useRoute();
  let publicSlug: string | null = null;
  if (path.startsWith('/p/')) { try { publicSlug = decodeURIComponent(path.slice(3)); } catch { publicSlug = path.slice(3); } }
  const publicView = path === '/explore' || !!publicSlug;
  const [user, setUser] = useState<User | null>(null); const [sessionLoading, setSessionLoading] = useState(true);
  const [albums, setAlbums] = useState<Album[]>([]); const [albumId, setAlbumId] = useState('');
  const [album, setAlbum] = useState<Album | null>(null); const [photos, setPhotos] = useState<Photo[]>([]);
  const [publicAlbums, setPublicAlbums] = useState<Album[]>([]); const [tab, setTab] = useState<Tab>('projects');
  const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all'); const [search, setSearch] = useState(''); const [sort, setSort] = useState('date');
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [selecting, setSelecting] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null); const [createOpen, setCreateOpen] = useState(false); const [coverOpen, setCoverOpen] = useState(false); const [publishOpen, setPublishOpen] = useState(false); const [deleteOpen, setDeleteOpen] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0); const [paused, setPaused] = useState(false);
  const [working, setWorking] = useState(false); const [analyzing, setAnalyzing] = useState(false); const [analysisProgress, setAnalysisProgress] = useState('');
  const [uploadState, setUploadState] = useState<{ percent: number; current: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false); const [toast, setToast] = useState(''); const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null); const dragDepth = useRef(0); const uploadBusy = useRef(false); const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeAlbumRef = useRef(albumId); activeAlbumRef.current = albumId;
  const routeRef = useRef(path); routeRef.current = path;
  const tell = useCallback((text: string) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6000); }, []);
  const reload = useCallback(() => setRefresh(v => v + 1), []);
  useEffect(() => { api<{ user: User | null }>('/auth/session').then(data => setUser(data.user)).catch(() => setLoadError('无法连接本地服务，请确认后端正在运行。')).finally(() => setSessionLoading(false)); return () => clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    if (!user || publicView) return;
    const controller = new AbortController();
    api<{ albums: Album[] }>('/albums', { signal: controller.signal }).then(data => { setAlbums(data.albums); setAlbumId(current => data.albums.some(a => a.id === current) ? current : data.albums[0]?.id || ''); }).catch(e => { if (e.name !== 'AbortError') setLoadError(e.message); });
    return () => controller.abort();
  }, [user, publicView, refresh]);
  useEffect(() => {
    if ((!user && !publicView) || (publicView && !publicSlug)) return;
    if (!publicView && !albumId && tab !== 'trash') { setAlbum(null); setPhotos([]); return; }
    const controller = new AbortController(); setLoading(true); setLoadError('');
    const url = publicSlug ? '/public/albums/' + encodeURIComponent(publicSlug) : tab === 'trash' ? '/trash' : '/albums/' + albumId;
    api<{ album?: Album; photos: Photo[] }>(url, { signal: controller.signal }).then(data => { setAlbum(data.album || null); setPhotos(data.photos); }).catch(e => { if (e.name !== 'AbortError') { setLoadError(e.message); setAlbum(null); setPhotos([]); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user, albumId, refresh, publicView, publicSlug, tab]);
  useEffect(() => {
    if (path !== '/explore') return;
    const controller = new AbortController(); setLoading(true); setLoadError('');
    api<{ albums: Album[] }>('/public/albums', { signal: controller.signal }).then(data => setPublicAlbums(data.albums)).catch(e => { if (e.name !== 'AbortError') setLoadError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refresh]);
  useEffect(() => { setSelected(new Set()); setSelecting(false); setPreviewId(null); setCoverOpen(false); setPublishOpen(false); setDeleteOpen(false); setSearch(''); setFilter(tab === 'smart' ? 'similar' : 'all'); setPaused(false); setAnalyzing(false); setUploadErrors([]); }, [albumId, tab, path]);
  useEffect(() => {
    if (!user) return;
    const source = new EventSource('/api/events'); let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.albumId === albumId) {
          if (data.type === 'analyzing' || data.type === 'progress') { setAnalyzing(true); setAnalysisProgress(data.total ? `${data.current || 0} / ${data.total}` : '正在分析'); }
          if (data.type === 'analyzed' || data.type === 'analysis-error') { setAnalyzing(false); setAnalysisProgress(''); if (data.type === 'analyzed') tell('分析已完成，可以开始对比选片了'); }
        }
        clearTimeout(timer); timer = setTimeout(reload, 350);
      } catch { /* ignore keepalive */ }
    };
    return () => { source.close(); clearTimeout(timer); };
  }, [user, albumId, reload, tell]);
  const activePhotos = useMemo(() => photos.filter(p => !p.deletedAt), [photos]);
  const coverPool = useMemo(() => {
    if (!album || !activePhotos.length) return [];
    const chosen = (album.coverPhotoIds || []).map(id => activePhotos.find(p => p.id === id)).filter((p): p is Photo => !!p);
    if (album.coverMode === 'fixed') return [activePhotos.find(p => p.id === album.coverPhotoId) || activePhotos[0]];
    return chosen.length ? chosen : activePhotos;
  }, [album?.coverMode, album?.coverPhotoId, album?.coverPhotoIds?.join(','), activePhotos]);
  const coverKey = `${album?.id}:${album?.coverMode}:${coverPool.map(p => p.id).join(',')}`;
  useEffect(() => { setHeroIndex(album?.coverMode === 'random' ? Math.floor(Math.random() * Math.max(coverPool.length, 1)) : 0); }, [coverKey]);
  useEffect(() => {
    if (!album || album.coverMode === 'fixed' || coverPool.length < 2 || paused || previewId || coverOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => { if (!document.hidden) setHeroIndex(v => album.coverMode === 'random' ? (v + 1 + Math.floor(Math.random() * (coverPool.length - 1))) % coverPool.length : (v + 1) % coverPool.length); }, (album.slideInterval || 8) * 1000);
    return () => clearInterval(timer);
  }, [coverKey, album?.slideInterval, paused, previewId, coverOpen]);
  const hero = coverPool[heroIndex % Math.max(coverPool.length, 1)];
  const stats = album?.stats || emptyStats;
  const duplicateOriginals = useMemo(() => new Set(photos.map(p => p.duplicateOf).filter(Boolean)), [photos]);
  const changeFilter = (next: Filter) => { setFilter(next); setSelected(new Set()); };
  const visiblePhotos = useMemo(() => {
    const result = photos.filter(p => {
      if (tab !== 'trash' && p.deletedAt) return false;
      if (search && !p.filename.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return false;
      if (publicView || tab === 'trash') return true;
      return filter === 'all' || (filter === 'similar' && !!p.groupId) || (filter === 'duplicates' && (!!p.duplicateOf || duplicateOriginals.has(p.id))) || (filter === 'blur' && p.blur) || (filter === 'keep' && p.pick === 'keep');
    });
    return result.sort((a, b) => filter === 'similar' && a.groupId !== b.groupId ? (a.groupId || '').localeCompare(b.groupId || '') : sort === 'name' ? a.filename.localeCompare(b.filename) : sort === 'rating' ? b.rating - a.rating : (b.capturedAt || b.createdAt).localeCompare(a.capturedAt || a.createdAt));
  }, [photos, filter, search, sort, tab, publicView, duplicateOriginals]);
  const resetTab = (next: Tab) => { navigate('/'); setTab(next); setFilter(next === 'smart' ? 'similar' : 'all'); };
  async function patchPhoto(id: string, patch: PhotoPatch) {
    const data = await api<{ photo: Photo }>('/photos/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    setPhotos(current => current.map(p => p.id === id ? data.photo : p));
    if (patch.restore) setPhotos(current => current.filter(p => p.id !== id));
    reload();
  }
  async function patchAlbum(patch: Partial<Album>) {
    if (!album) return;
    const target = album.id; const requestedPath = path;
    const data = await api<{ album: Album }>('/albums/' + target, { method: 'PATCH', body: JSON.stringify(patch) });
    if (activeAlbumRef.current === target && routeRef.current === requestedPath) setAlbum(data.album);
    setAlbums(current => current.map(a => a.id === data.album.id ? data.album : a)); reload();
  }
  async function setCover(id: string) { await patchAlbum({ coverMode: 'fixed', coverPhotoId: id }); tell('已设置为相册封面'); }
  async function analyze(id = albumId) {
    if (activeAlbumRef.current === id) { setAnalyzing(true); setAnalysisProgress('准备分析'); }
    try { await api('/albums/' + id + '/analyze', { method: 'POST' }); reload(); }
    catch (e) { if (activeAlbumRef.current === id) setAnalyzing(false); tell((e as Error).message); }
  }
  async function upload(files: FileList | File[]) {
    if (!albumId || uploadBusy.current) return;
    const all = Array.from(files); const failures: string[] = [];
    const valid = all.filter(f => { if (!/\.(jpe?g|png|webp)$/i.test(f.name) || f.size > 20 * 1024 * 1024) { failures.push(`${f.name}：请使用不超过 20MB 的 JPG、PNG 或 WebP 图片`); return false; } return true; });
    if (!valid.length) { setUploadErrors(failures); return; }
    uploadBusy.current = true; const targetAlbum = albumId; setUploadErrors([]); let uploaded = 0;
    for (let start = 0; start < valid.length; start += 15) {
      const batch = valid.slice(start, start + 15); const data = new FormData(); batch.forEach(file => data.append('photos', file));
      try {
        const result = await new Promise<{ photos: Photo[]; errors?: { filename?: string; error?: string }[] }>((resolve, reject) => {
          const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/albums/${targetAlbum}/photos`); xhr.setRequestHeader('X-Album-Client', '1');
          xhr.upload.onprogress = event => setUploadState({ percent: Math.round(((start + (event.lengthComputable ? event.loaded / event.total : 0) * batch.length) / valid.length) * 100), current: start, total: valid.length });
          xhr.onload = () => { let response; try { response = JSON.parse(xhr.responseText); } catch { reject(new Error('服务响应异常，请稍后重试')); return; } if (xhr.status >= 200 && xhr.status < 300) resolve(response); else reject(new Error(response.error || '上传失败')); };
          xhr.onerror = () => reject(new Error('网络连接中断，请重新选择失败的文件上传')); xhr.timeout = 180000; xhr.ontimeout = () => reject(new Error('上传超时，请重试')); xhr.send(data);
        });
        uploaded += result.photos.length; result.errors?.forEach(e => failures.push(`${e.filename || '照片'}：${e.error || '上传失败'}`));
      } catch (e) { batch.forEach(f => failures.push(`${f.name}：${(e as Error).message}`)); }
      reload();
    }
    setUploadState(null); uploadBusy.current = false; setUploadErrors(failures); if (uploaded) { tell(`已上传 ${uploaded} 张照片，正在后台分析`); await analyze(targetAlbum); }
  }
  async function importDemo() {
    setWorking(true);
    try { const { album: result } = await api<{ album: Album }>('/demo', { method: 'POST' }); setAlbumId(result.id); setTab('projects'); reload(); tell('示例项目已加入你的空间，可自由体验选片'); await analyze(result.id); }
    catch (e) { tell((e as Error).message); } finally { setWorking(false); }
  }
  async function bulk(patch: PhotoPatch) {
    setWorking(true);
    try { for (const id of selected) await api('/photos/' + id, { method: 'PATCH', body: JSON.stringify(patch) }); setSelected(new Set()); setSelecting(false); setDeleteOpen(false); reload(); tell(patch.deleted ? '已移入回收站，可随时恢复' : '已更新选片标记'); }
    catch (e) { reload(); tell((e as Error).message); } finally { setWorking(false); }
  }
  async function publish(value: boolean) { setWorking(true); try { await patchAlbum({ isPublic: value }); setPublishOpen(false); tell(value ? '作品集已发布，可复制链接分享' : '已撤回公开作品集'); } catch (e) { tell((e as Error).message); } finally { setWorking(false); } }
  async function copyLink() { if (!album) return; const link = `${window.location.origin}/p/${album.slug}`; try { await navigator.clipboard.writeText(link); tell('作品链接已复制'); } catch { tell(`作品地址：${link}`); } }
  const selectPhoto = (id: string) => { setSelecting(true); setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); };

  if (sessionLoading) return <div className="startup"><Aperture className="spin-slow" size={45} /><span>正在打开你的创作空间</span></div>;
  if (!user && !publicView) return <><AuthView onLogin={value => { setUser(value); setLoadError(''); }} onExplore={() => navigate('/explore')} />{loadError && <div className="connection-error">{loadError}</div>}</>;
  return <div className="app-shell" onDragEnter={e => { if (!publicView && album && tab !== 'trash' && e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth.current++; setDragging(true); } }} onDragOver={e => { if (dragging) e.preventDefault(); }} onDragLeave={e => { if (dragging) { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); } }} onDrop={e => { if (dragging) { e.preventDefault(); dragDepth.current = 0; setDragging(false); void upload(e.dataTransfer.files); } }}>
    <header className="topbar"><button className="brand" onClick={() => { navigate('/'); setTab('projects'); }} aria-label="光影相册首页"><Aperture size={29} /><span>光影<span className="brand-separator">/</span><small>AI 相册</small></span></button><nav className="main-nav" aria-label="主导航"><button className={!publicView && tab === 'projects' ? 'active' : ''} onClick={() => resetTab('projects')}>拍摄项目</button><button className={!publicView && tab === 'smart' ? 'active' : ''} onClick={() => resetTab('smart')}>智能选片</button><button className={publicView ? 'active' : ''} onClick={() => navigate('/explore')}>公开作品</button>{user && <button className={!publicView && tab === 'trash' ? 'active' : ''} onClick={() => resetTab('trash')}>回收站</button>}</nav><div className="header-actions">{user ? <><button className="button button-primary upload-header" onClick={() => albumId && !publicView && tab !== 'trash' ? fileInput.current?.click() : setCreateOpen(true)} disabled={!!uploadState}><Upload size={16} /><span>上传照片</span></button><div className="user-avatar" title={user.name}>{user.name.slice(0, 1).toUpperCase()}</div><button className="icon-button logout" title="退出登录" aria-label="退出登录" onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); setAlbums([]); setAlbumId(''); setPhotos([]); setAlbum(null); navigate('/'); } catch (e) { tell((e as Error).message); } }}><LogOut size={17} /></button></> : <button className="button button-primary" onClick={() => navigate('/')}>登录创作空间<ArrowUpRight size={16} /></button>}</div></header>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple hidden onChange={e => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
    {path === '/explore' ? <main className="explore-page"><div className="section-intro"><p className="eyebrow">THROUGH DIFFERENT EYES</p><h1>在光影里，看见世界。</h1><p className="muted">每一次按下快门，都是一个值得分享的视角。</p></div>{loading ? <Loading /> : publicAlbums.length ? <div className="portfolio-grid">{publicAlbums.map(a => <a key={a.id} href={`/p/${a.slug}`} onClick={e => { e.preventDefault(); navigate(`/p/${a.slug}`); }} className="portfolio-card">{a.coverUrl ? <img src={a.coverUrl} alt={a.title} /> : <div className="portfolio-placeholder"><Aperture size={45} /></div>}<div><span className="eyebrow">PHOTOGRAPHIC JOURNAL</span><h2>{a.title}</h2><p>{a.location || '光影作品集'}<span>{a.photoCount} 张作品<ArrowUpRight size={17} /></span></p></div></a>)}</div> : <Empty icon={Globe} title="好作品，值得被看见" text="这里会展示创作者主动发布的作品集。私密项目始终由作者自己掌握。" />}</main> : <>
      {!publicView && tab !== 'trash' && <div className="album-rail"><span className="rail-label">我的拍摄项目<span>{albums.length.toString().padStart(2, '0')}</span></span><div className="album-tabs">{albums.map(a => <button key={a.id} className={albumId === a.id ? 'active' : ''} onClick={() => setAlbumId(a.id)}>{a.coverUrl && <img src={a.coverUrl} alt="" />}<span>{a.title}</span>{a.isPublic ? <Globe size={12} /> : <LockKeyhole size={12} />}</button>)}</div><button className="rail-create" onClick={() => setCreateOpen(true)}><Plus size={15} /><span>新建项目</span></button></div>}
      {loadError ? <div className="load-error" role="alert"><p>{loadError}</p><button className="button button-secondary" onClick={reload}><RefreshCw size={16} />重新加载</button></div> : null}
      {loading && !album && (publicView || tab !== 'trash') ? <Loading /> : (publicView || tab !== 'trash') && album ? <>
        <section className={`project-hero ${hero ? '' : 'hero-empty'}`} aria-label="相册大图">
          {hero && <img key={hero.id} src={hero.previewUrl || hero.url} className="hero-photo" alt={hero.filename} fetchPriority="high" />}
          <div className="hero-shade" />
          <div className="hero-content"><p className="eyebrow">{publicView ? 'A PHOTOGRAPHIC JOURNAL' : `YOUR PROJECT / ${String(Math.max(1, albums.findIndex(a => a.id === album.id) + 1)).padStart(2, '0')}`}</p><h1>{album.title}</h1><p className="hero-description">{album.description || '用镜头收藏瞬间，让光影讲述故事。'}</p><div className="hero-details"><span>{formatDate(album.createdAt)}</span><span className="tiny-dot" /><span>{album.photoCount} 张照片</span>{album.location && <><span className="tiny-dot" /><span>{album.location}</span></>}</div><span className="privacy-label">{album.isPublic ? <Globe size={14} /> : <LockKeyhole size={14} />}{album.isPublic ? '公开作品集' : '私密项目'}</span>{!publicView && <div className="hero-actions"><button className="button button-primary" disabled={analyzing || !activePhotos.length} onClick={() => void analyze()}>{analyzing ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{analyzing ? `正在分析 ${analysisProgress}` : '开始智能选片'}{!analyzing && <ArrowUpRight size={17} />}</button><button className="button button-glass" onClick={() => activePhotos.length ? setCoverOpen(true) : fileInput.current?.click()}><Settings2 size={16} />封面与轮播</button></div>}</div>
          {!publicView && <div className="hero-top-actions"><button className="glass-icon" title="公开作品集设置" onClick={() => setPublishOpen(true)}><Globe size={16} /><span>{album.isPublic ? '分享作品集' : '发布作品集'}</span></button></div>}
          {activePhotos.length > 0 && <div className="hero-controls"><span className="cover-mode-label">{album.coverMode === 'slideshow' ? '照片轮播' : album.coverMode === 'random' ? '随机轮播' : '精选封面'}</span>{coverPool.length > 1 && <><button className="glass-icon" aria-label="上一张封面" onClick={() => setHeroIndex(v => (v - 1 + coverPool.length) % coverPool.length)}><ChevronLeft size={17} /></button><span className="hero-counter">{String(heroIndex % coverPool.length + 1).padStart(2, '0')} / {String(coverPool.length).padStart(2, '0')}</span><button className="glass-icon" aria-label="下一张封面" onClick={() => setHeroIndex(v => (v + 1) % coverPool.length)}><ChevronRight size={17} /></button>{album.coverMode !== 'fixed' && <button className="glass-icon" aria-label={paused ? '播放轮播' : '暂停轮播'} onClick={() => setPaused(!paused)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>}</>}<button className="glass-icon" aria-label="预览封面大图" onClick={() => hero && setPreviewId(hero.id)}><Expand size={17} /></button></div>}
          {!publicView && activePhotos.length > 0 && <div className="analysis-summary"><div className="analysis-title"><ShieldCheck size={17} /><span>{analyzing ? '正在整理你的照片' : album.analysisStatus === 'complete' || activePhotos.some(p => p.sharpness != null) ? '分析已完成' : '等待智能分析'}</span></div><div className="analysis-stats"><button onClick={() => changeFilter('duplicates')}><strong>{stats.duplicates}</strong><span>重复候选</span></button><button onClick={() => changeFilter('similar')}><strong>{stats.similarGroups}</strong><span>相似分组</span></button><button onClick={() => changeFilter('blur')}><strong>{stats.blurry}</strong><span>疑似模糊</span></button></div></div>}
        </section>
        <main className="photo-workspace"><div className="workspace-heading"><div className="section-title"><h2>{publicView ? '作品影集' : '项目照片'}</h2><span>{activePhotos.length}</span>{loading && <LoaderCircle className="spin" size={16} />}</div><div className="workspace-controls"><div className="search-field"><Search size={16} /><input placeholder="查找照片" aria-label="按文件名查找照片" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={13} /></button>}</div><select className="sort-select" aria-label="照片排序" value={sort} onChange={e => setSort(e.target.value)}><option value="date">导入时间</option><option value="name">文件名称</option><option value="rating">星级优先</option></select><Grid2X2 size={18} className="grid-indicator" />{!publicView && <button className={`button button-small button-secondary ${selecting ? 'is-active' : ''}`} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}><CheckCheck size={15} />{selecting ? '结束选择' : '批量选择'}</button>}</div></div>
          {!publicView ? <div className="filter-row">{filters.map(f => <button key={f.id} className={filter === f.id ? 'active' : ''} aria-pressed={filter === f.id} onClick={() => changeFilter(f.id)}>{f.label}{f.id === 'keep' && stats.kept > 0 && <span>{stats.kept}</span>}</button>)}<span className="workspace-hint">点击照片进入沉浸预览</span></div> : <div className="public-description">{album.description || '每张作品，都有一个属于它的故事。'}</div>}
          {uploadErrors.length > 0 && <div className="upload-errors" role="alert"><button className="icon-button" aria-label="关闭上传提示" onClick={() => setUploadErrors([])}><X size={16} /></button><strong>部分照片未能上传，可重新选择后重试</strong>{uploadErrors.slice(0, 8).map((e, i) => <p key={i}>{e}</p>)}{uploadErrors.length > 8 && <p>还有 {uploadErrors.length - 8} 条提示</p>}</div>}
          {visiblePhotos.length ? <div className="photo-grid">{visiblePhotos.map(p => <PhotoCard key={p.id} photo={p} selected={selected.has(p.id)} selecting={selecting} readOnly={publicView} onOpen={() => setPreviewId(p.id)} onSelect={() => selectPhoto(p.id)} onPick={() => void patchPhoto(p.id, { pick: p.pick === 'keep' ? 'none' : 'keep' }).catch(e => tell(e.message))} />)}{!publicView && filter === 'all' && !search && <button className="upload-tile" onClick={() => fileInput.current?.click()} disabled={!!uploadState}><ImagePlus size={25} /><strong>添加更多照片</strong><span>拖入照片，或点击上传</span></button>}</div> : <Empty icon={activePhotos.length ? Search : ImagePlus} title={activePhotos.length ? '这个视角下，还没有照片' : '让第一张照片，开启故事'} text={activePhotos.length ? '试试其他筛选条件，或先运行一次智能分析。' : '拖入照片，或点击上传。支持 JPG、PNG、WebP，单张不超过 20MB。'}>{!publicView && !activePhotos.length && <button className="button button-primary" onClick={() => fileInput.current?.click()}><Upload size={16} />上传照片</button>}</Empty>}
          {!publicView && <div className="workspace-footer"><span><LockKeyhole size={12} />{album.isPublic ? '你已主动发布此作品集' : '当前项目仅你可见'}</span><span>本地智能筛选仅提供建议，照片由你决定取舍。</span></div>}
        </main>
      </> : tab === 'trash' && !publicView ? <main className="trash-page"><div className="section-intro"><p className="eyebrow">NOT EVERY GOODBYE IS FOREVER</p><h1>回收站</h1><p className="muted">被移除的照片暂存在这里，恢复后会回到原来的项目。</p></div>{loading ? <Loading /> : photos.length ? <div className="photo-grid">{photos.map(p => <article key={p.id} className="photo-card trash-card"><img src={p.thumbnailUrl} alt={p.filename} loading="lazy" /><div className="photo-meta"><span className="filename">{p.filename}</span><button className="text-button" onClick={() => void patchPhoto(p.id, { restore: true }).then(() => tell('已恢复到原项目')).catch(e => tell(e.message))}><RefreshCw size={13} />恢复</button></div></article>)}</div> : <Empty icon={Trash2} title="回收站是空的" text="你的每一次选择，都保留着重新考虑的余地。" />}</main> : !loading && !loadError && !publicView ? <main className="welcome-page"><div className="welcome-decoration"><Aperture size={65} strokeWidth={1} /></div><p className="eyebrow">YOUR NEXT STORY STARTS HERE</p><h1>为你的作品，<br />留一个更好的空间。</h1><p className="muted">创建第一个拍摄项目，上传照片，<br />从相似的瞬间里，找到最动人的一帧。</p><div className="welcome-actions"><button className="button button-primary" onClick={() => setCreateOpen(true)}><FolderPlus size={18} />新建拍摄项目</button><button className="button button-secondary" disabled={working} onClick={() => void importDemo()}>{working ? <LoaderCircle className="spin" size={17} /> : <Images size={17} />}体验示例项目</button></div><span className="small-text muted">示例项目使用生成的摄影素材，可在自己的空间内自由体验。</span></main> : null}
    </>}
    <footer className="app-footer"><span>光影 / AI 相册</span><span>MADE FOR THE WAY YOU SEE.</span>{publicView && <button className="text-button" onClick={() => navigate('/explore')}><ArrowLeft size={13} />所有公开作品</button>}</footer>
    {uploadState && <div className="upload-progress" role="status"><div><LoaderCircle className="spin" size={18} /><strong>正在上传照片</strong><span>{uploadState.percent}%</span></div><div className="progress-track"><span style={{ width: `${uploadState.percent}%` }} /></div><p>请保持页面打开 · 共 {uploadState.total} 张</p></div>}
    {selected.size > 0 && !publicView && <div className="selection-bar"><span>已选择 <strong>{selected.size}</strong> 张</span><button className="text-button" onClick={() => setSelected(new Set(visiblePhotos.map(p => p.id)))}>全选当前结果</button><span className="selection-divider" /><button className="button button-small button-secondary" disabled={working} onClick={() => void bulk({ pick: 'keep' })}><Star size={15} />标记保留</button><button className="button button-small button-danger" onClick={() => setDeleteOpen(true)} disabled={working}><Trash2 size={15} />移入回收站</button><button className="icon-button" aria-label="清空选择" onClick={() => setSelected(new Set())}><X size={18} /></button></div>}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {dragging && <div className="drop-overlay"><Upload size={45} /><h2>把这一刻，交给光影</h2><p>松开鼠标，上传到「{album?.title}」</p></div>}
    {createOpen && <CreateAlbum onClose={() => setCreateOpen(false)} onCreate={a => { setAlbums(current => [a, ...current]); setAlbumId(a.id); setTab('projects'); navigate('/'); setCreateOpen(false); reload(); tell('项目已创建，可以上传照片了'); }} />}
    {coverOpen && album && <CoverDialog album={album} photos={activePhotos} onClose={() => setCoverOpen(false)} onSave={patchAlbum} />}
    {previewId && <PhotoPreview photos={visiblePhotos.length && visiblePhotos.some(p => p.id === previewId) ? visiblePhotos.filter(p => !p.deletedAt) : activePhotos} initialId={previewId} onClose={() => setPreviewId(null)} onUpdate={patchPhoto} onSetCover={publicView ? undefined : setCover} readOnly={publicView} />}
    {publishOpen && album && <Modal title={album.isPublic ? '分享你的作品集' : '发布公开作品集'} onClose={() => setPublishOpen(false)}><div className="publish-icon"><Globe size={30} /></div><h3 className="publish-title">{album.title}</h3><p className="muted publish-copy">{album.isPublic ? '这个相册已经公开，拥有链接的任何人都可以浏览。你可以随时撤回。' : `发布后，这个相册中当前的 ${activePhotos.length} 张照片都将公开，允许搜索引擎收录。请先移除不希望公开的照片。`}</p><p className="small-text muted">公开页面提供去除位置信息的展示图；私密原图仍由你保管。</p>{album.isPublic && <div className="share-link"><input readOnly value={`${window.location.origin}/p/${album.slug}`} aria-label="公开作品链接" /><button className="text-button" onClick={() => void copyLink()}>复制链接</button></div>}<div className="modal-actions">{album.isPublic ? <><button className="button button-danger" onClick={() => void publish(false)} disabled={working}>撤回公开</button><button className="button button-primary" onClick={() => { setPublishOpen(false); navigate(`/p/${album.slug}`); }}>查看作品集<ArrowUpRight size={16} /></button></> : <><button className="button button-secondary" onClick={() => setPublishOpen(false)}>再检查一下</button><button className="button button-primary" disabled={working || !activePhotos.length} onClick={() => void publish(true)}>{working && <LoaderCircle className="spin" size={16} />}确认发布</button></>}</div></Modal>}
    {deleteOpen && <Modal title="将选中的照片移入回收站？" onClose={() => setDeleteOpen(false)}><p className="muted modal-intro">选中的 {selected.size} 张照片会从相册和公开作品集中移除，可以在回收站恢复。</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setDeleteOpen(false)}>取消</button><button className="button button-danger" disabled={working} onClick={() => void bulk({ deleted: true })}>{working && <LoaderCircle className="spin" size={16} />}移入回收站</button></div></Modal>}
  </div>;
}

function Loading() { return <div className="loading-state" role="status"><LoaderCircle size={25} className="spin" /><span>正在整理光影……</span></div>; }
function Empty({ icon: Icon, title, text, children }: { icon: typeof Search; title: string; text: string; children?: React.ReactNode }) { return <div className="empty-state"><Icon size={32} strokeWidth={1.3} /><h3>{title}</h3><p>{text}</p>{children}</div>; }
