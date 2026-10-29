/**
 * 沉浸式照片预览：缩放、拖拽、信息、选片与下载；业务更新通过回调交给 App。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Image,
  Info,
  LoaderCircle,
  Maximize,
  Minus,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { Photo } from '../../shared/types';
import './PhotoPreview.css';

type PhotoPatch = {
  pick?: 'none' | 'keep' | 'reject';
  rating?: number;
  deleted?: boolean;
  restore?: boolean;
};

export interface PhotoPreviewProps {
  photos: Photo[];
  initialId: string;
  onClose: () => void;
  onUpdate: (id: string, patch: PhotoPatch) => Promise<void>;
  onSetCover?: (id: string) => Promise<void>;
  readOnly?: boolean;
}

type Point = { x: number; y: number };
const ZERO: Point = { x: 0, y: 0 };

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function downloadUrl(value: string) {
  const url = new URL(value, window.location.href);
  url.searchParams.set('download', '1');
  return url.href;
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ),
  ).filter(
    (element) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'),
  );
}

export function PhotoPreview({
  photos,
  initialId,
  onClose,
  onUpdate,
  onSetCover,
  readOnly = false,
}: PhotoPreviewProps) {
  const available = useMemo(() => photos.filter((photo) => !photo.deletedAt), [photos]);
  const [activeId, setActiveId] = useState(initialId);
  const current = available.find((photo) => photo.id === activeId) ?? available[0];
  const activeIndex = current ? available.findIndex((photo) => photo.id === current.id) : -1;
  const [showInfo, setShowInfo] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>(ZERO);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [naturalSize, setNaturalSize] = useState({ id: '', width: 1, height: 1 });
  const [retryKey, setRetryKey] = useState(0);
  const [imageStatus, setImageStatus] = useState<{ key: string; state: 'ready' | 'error' }>({
    key: '',
    state: 'ready',
  });
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<{ pointerId: number; start: Point; pan: Point } | null>(null);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const imageKey = `${current?.id ?? ''}:${current?.url ?? ''}:${retryKey}`;
  const currentImageKeyRef = useRef(imageKey);
  currentImageKeyRef.current = imageKey;
  const loaded = imageStatus.key === imageKey && imageStatus.state === 'ready';
  const broken = imageStatus.key === imageKey && imageStatus.state === 'error';

  const imageWidth = Math.max(
    1,
    naturalSize.id === current?.id ? naturalSize.width : (current?.width ?? 1),
  );
  const imageHeight = Math.max(
    1,
    naturalSize.id === current?.id ? naturalSize.height : (current?.height ?? 1),
  );
  const fitScale = Math.min(size.width / imageWidth, size.height / imageHeight, 1);
  const scale = Math.max(0.0001, fitScale * zoom);
  const maxZoom = Math.max(8, 2 / Math.max(fitScale, 0.0001));

  // 缩放与平移以容器中心为基准，限制平移范围，避免图片完全拖出画布。
  function limitPan(point: Point, nextZoom = zoom): Point {
    const horizontal = Math.max(0, (imageWidth * fitScale * nextZoom - size.width) / 2);
    const vertical = Math.max(0, (imageHeight * fitScale * nextZoom - size.height) / 2);
    return {
      x: Math.max(-horizontal, Math.min(horizontal, point.x)),
      y: Math.max(-vertical, Math.min(vertical, point.y)),
    };
  }

  function changeZoom(next: number, anchor: Point = ZERO) {
    const value = Math.min(maxZoom, Math.max(1, next));
    const ratio = value / zoom;
    setPan(
      limitPan(
        {
          x: anchor.x - (anchor.x - pan.x) * ratio,
          y: anchor.y - (anchor.y - pan.y) * ratio,
        },
        value,
      ),
    );
    setZoom(value);
  }

  function resetView() {
    setZoom(1);
    setPan(ZERO);
  }

  function navigate(offset: number) {
    if (available.length < 2 || busy) return;
    setConfirming(false);
    setError('');
    setActiveId(available[(activeIndex + offset + available.length) % available.length].id);
  }

  // 组件只表达用户意图，实际保存与权限检查由父组件和后端完成。
  async function mutate(patch: PhotoPatch, action: string) {
    if (!current || busy || readOnly) return;
    setBusy(action);
    setError('');
    try {
      await onUpdate(current.id, patch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
    } finally {
      setBusy(null);
    }
  }

  async function setCover() {
    if (!current || !onSetCover || busy || readOnly) return;
    setBusy('cover');
    setError('');
    try {
      await onSetCover(current.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置封面失败，请重试。');
    } finally {
      setBusy(null);
    }
  }

  function cancelDelete() {
    if (busy) return;
    setConfirming(false);
    setError('');
    requestAnimationFrame(() => deleteRef.current?.focus());
  }

  async function deletePhoto() {
    if (!current || readOnly || busy) return;
    const next = available.filter((photo) => photo.id !== current.id)[
      Math.min(activeIndex, available.length - 2)
    ];
    setBusy('delete');
    setError('');
    try {
      await onUpdate(current.id, { deleted: true });
      setConfirming(false);
      if (next) setActiveId(next.id);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '移入回收站失败，请重试。');
    } finally {
      setBusy(null);
    }
  }

  // 事件处理通过 ref 获取最新状态，避免反复绑定全局键盘和滚轮事件。
  keyHandlerRef.current = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirming) cancelDelete();
      else onClose();
      return;
    }
    if (event.key === 'Tab') {
      const container = confirming ? confirmRef.current : dialogRef.current;
      if (!container) return;
      const elements = focusableElements(container);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    const target = event.target as HTMLElement;
    if (confirming || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigate(-1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigate(1);
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      changeZoom(zoom * 1.25);
    }
    if (event.key === '-') {
      event.preventDefault();
      changeZoom(zoom / 1.25);
    }
    if (event.key === '0') {
      event.preventDefault();
      resetView();
    }
  };

  wheelHandlerRef.current = (event) => {
    if (confirming || broken) return;
    event.preventDefault();
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    changeZoom(zoom * Math.exp(-event.deltaY * 0.0015), {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    });
  };

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => keyHandlerRef.current(event);
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!available.length) onClose();
    else if (!available.some((photo) => photo.id === activeId)) setActiveId(available[0].id);
  }, [available, activeId, onClose]);

  useEffect(() => {
    resetView();
    setError('');
    setDragging(false);
    dragRef.current = null;
  }, [current?.id, current?.url]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () =>
      setSize({
        width: Math.max(1, stage.clientWidth - 32),
        height: Math.max(1, stage.clientHeight - 32),
      });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    const wheel = (event: WheelEvent) => wheelHandlerRef.current(event);
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      stage.removeEventListener('wheel', wheel);
    };
  }, []);

  useEffect(() => {
    setPan((previous) => limitPan(previous));
  }, [size.width, size.height, imageWidth, imageHeight]);

  useEffect(() => {
    if (current)
      thumbnailRefs.current
        .get(current.id)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [current?.id]);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !loaded || broken || zoom <= 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      pan,
    };
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan(
      limitPan({
        x: drag.pan.x + event.clientX - drag.start.x,
        y: drag.pan.y + event.clientY - drag.start.y,
      }),
    );
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!current) return null;

  return (
    <div
      className="pp-overlay"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`照片预览：${current.filename}`}
    >
      <div className="pp-shell" inert={confirming} aria-hidden={confirming ? true : undefined}>
        <header className="pp-header">
          <div className="pp-title-area">
            <span className="pp-eyebrow">
              <span />
              {' PHOTO VIEWER'}
            </span>
            <h2 title={current.filename}>{current.filename}</h2>
            <span className="pp-position" aria-live="polite">
              {String(activeIndex + 1).padStart(2, '0')}{' '}
              <span>
                {'/ '}
                {String(available.length).padStart(2, '0')}
              </span>
            </span>
          </div>
          <div className="pp-header-actions">
            {!readOnly && onSetCover && (
              <button
                className="pp-cover-button"
                onClick={() => void setCover()}
                disabled={!!busy}
                title="设为相册大屏封面"
                aria-label="设为相册大屏封面"
              >
                {busy === 'cover' ? (
                  <LoaderCircle className="pp-spin" size={17} />
                ) : (
                  <Image size={17} />
                )}
                <span>设为封面</span>
              </button>
            )}
            <a
              className="pp-icon-button"
              href={downloadUrl(current.url)}
              download={current.filename}
              aria-label={readOnly ? '下载图片' : '下载原图'}
              title={readOnly ? '下载图片' : '下载原图'}
            >
              <Download size={19} />
            </a>
            <button
              className={`pp-icon-button ${showInfo ? 'is-active' : ''}`}
              onClick={() => setShowInfo(!showInfo)}
              aria-pressed={showInfo}
              aria-expanded={showInfo}
              aria-controls="pp-information"
              aria-label={showInfo ? '隐藏照片信息' : '查看照片信息'}
              title="照片信息"
            >
              <Info size={19} />
            </button>
            <span className="pp-divider" />
            <button
              className="pp-icon-button pp-close"
              ref={closeRef}
              onClick={onClose}
              aria-label="关闭预览"
              title="关闭预览（Esc）"
            >
              <X size={22} />
            </button>
          </div>
        </header>

        {error && !confirming && (
          <div className="pp-error" role="alert">
            {error}
            <button
              className="pp-icon-button"
              onClick={() => setError('')}
              aria-label="关闭错误提示"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="pp-body">
          <div className="pp-view-area">
            <div
              className={`pp-stage ${zoom > 1 ? 'is-zoomed' : ''} ${dragging ? 'is-dragging' : ''}`}
              ref={stageRef}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                changeZoom(zoom > 1.01 ? 1 : Math.max(2, 1 / fitScale), {
                  x: event.clientX - bounds.left - bounds.width / 2,
                  y: event.clientY - bounds.top - bounds.height / 2,
                });
              }}
            >
              {!loaded && !broken && (
                <div className="pp-image-state" role="status">
                  <LoaderCircle size={25} className="pp-spin" />
                  <span>正在呈现照片</span>
                </div>
              )}
              {broken && (
                <div className="pp-image-state" role="status">
                  <Image size={32} />
                  <span>暂时无法加载这张照片</span>
                  <button
                    className="pp-text-button"
                    onClick={() => setRetryKey((value) => value + 1)}
                  >
                    重新加载
                  </button>
                </div>
              )}
              <img
                key={`${current.id}-${retryKey}`}
                className="pp-photo"
                src={current.url}
                alt={current.filename}
                draggable={false}
                style={{
                  width: imageWidth,
                  height: imageHeight,
                  opacity: loaded && !broken ? 1 : 0,
                  transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                }}
                onLoad={(event) => {
                  if (currentImageKeyRef.current !== imageKey) return;
                  setNaturalSize({
                    id: current.id,
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                  setImageStatus({ key: imageKey, state: 'ready' });
                }}
                onError={() => {
                  if (currentImageKeyRef.current === imageKey)
                    setImageStatus({ key: imageKey, state: 'error' });
                }}
              />
            </div>
            {available.length > 1 && (
              <>
                <button
                  className="pp-navigation pp-previous"
                  onClick={() => navigate(-1)}
                  disabled={!!busy}
                  aria-label="上一张照片"
                  title="上一张（←）"
                >
                  <ChevronLeft size={26} strokeWidth={1.5} />
                </button>
                <button
                  className="pp-navigation pp-next"
                  onClick={() => navigate(1)}
                  disabled={!!busy}
                  aria-label="下一张照片"
                  title="下一张（→）"
                >
                  <ChevronRight size={26} strokeWidth={1.5} />
                </button>
              </>
            )}
            <div className="pp-image-caption">
              <span>
                {current.pick === 'keep'
                  ? '已选入作品'
                  : current.pick === 'reject'
                    ? '已标记淘汰'
                    : '让每一张照片，都值得被看见。'}
              </span>
              <span>
                {current.width}
                {' × '}
                {current.height}
              </span>
            </div>
          </div>

          {showInfo && (
            <aside className="pp-information" id="pp-information" aria-label="照片信息">
              <div className="pp-panel-heading">
                <span>照片信息</span>
                <span>DETAILS</span>
              </div>
              <div className="pp-info-preview">
                <img src={current.thumbnailUrl} alt="" />
              </div>
              <h3>{current.filename}</h3>
              <dl>
                <div>
                  <dt>分辨率</dt>
                  <dd>
                    {current.width.toLocaleString()}
                    {' × '}
                    {current.height.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>文件大小</dt>
                  <dd>{formatBytes(current.bytes)}</dd>
                </div>
                <div>
                  <dt>文件格式</dt>
                  <dd>{current.mime.split('/')[1]?.toUpperCase() ?? current.mime}</dd>
                </div>
                <div>
                  <dt>拍摄时间</dt>
                  <dd>{formatDate(current.capturedAt)}</dd>
                </div>
                <div>
                  <dt>上传时间</dt>
                  <dd>{formatDate(current.createdAt)}</dd>
                </div>
              </dl>
              {!readOnly && (
                <>
                  <div className="pp-info-rule" />
                  <div className="pp-info-section-label">选片状态</div>
                  <div className={`pp-status pp-status-${current.pick}`}>
                    {current.pick === 'keep' ? (
                      <>
                        <Check size={14} />
                        {' 已保留'}
                      </>
                    ) : current.pick === 'reject' ? (
                      <>
                        <X size={14} />
                        {' 待淘汰'}
                      </>
                    ) : (
                      '尚未标记'
                    )}
                  </div>
                  <div className="pp-info-section-label">分析提示</div>
                  <div className="pp-analysis-tags">
                    {current.duplicateOf && <span>检测到重复文件</span>}
                    {current.groupId && <span>属于相似照片组</span>}
                    {current.blur && <span>疑似模糊 · 请人工确认</span>}
                    {!current.duplicateOf && !current.groupId && !current.blur && (
                      <p>暂无需要关注的分析提示</p>
                    )}
                  </div>
                </>
              )}
            </aside>
          )}
        </div>

        <div className="pp-toolbar">
          <div className="pp-zoom-controls" aria-label="缩放控制">
            <button
              className="pp-icon-button"
              onClick={() => changeZoom(zoom / 1.25)}
              disabled={zoom <= 1 || broken}
              aria-label="缩小照片"
              title="缩小（−）"
            >
              <Minus size={17} />
            </button>
            <span className="pp-zoom-value" aria-live="polite">
              {Math.round(scale * 100)}%
            </span>
            <button
              className="pp-icon-button"
              onClick={() => changeZoom(zoom * 1.25)}
              disabled={zoom >= maxZoom || broken}
              aria-label="放大照片"
              title="放大（＋）"
            >
              <Plus size={17} />
            </button>
            <span className="pp-divider" />
            <button
              className={`pp-fit-button ${zoom === 1 ? 'is-active' : ''}`}
              onClick={resetView}
              disabled={broken}
              aria-label="适合屏幕"
              title="适合屏幕（0）"
            >
              <Maximize size={16} />
              <span>适合</span>
            </button>
            <button
              className="pp-fit-button pp-actual-size"
              onClick={() => changeZoom(1 / fitScale)}
              disabled={broken}
              aria-label="以百分之百实际大小查看"
              title="实际像素"
            >
              1:1
            </button>
          </div>

          {!readOnly && (
            <div className="pp-selection-controls">
              <div className="pp-rating" aria-label="照片星级">
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button
                    key={rating}
                    className={`pp-star ${current.rating >= rating ? 'is-rated' : ''}`}
                    aria-label={`评为 ${rating} 星${current.rating === rating ? '，再次点击取消评分' : ''}`}
                    aria-pressed={current.rating >= rating}
                    title={`${rating} 星`}
                    disabled={!!busy}
                    onClick={() =>
                      void mutate({ rating: current.rating === rating ? 0 : rating }, 'rating')
                    }
                  >
                    <Star size={17} fill={current.rating >= rating ? 'currentColor' : 'none'} />
                  </button>
                ))}
              </div>
              <span className="pp-divider pp-rating-divider" />
              <button
                className={`pp-pick-button ${current.pick === 'keep' ? 'is-kept' : ''}`}
                onClick={() =>
                  void mutate({ pick: current.pick === 'keep' ? 'none' : 'keep' }, 'pick')
                }
                disabled={!!busy}
                aria-label={current.pick === 'keep' ? '取消保留照片' : '保留这张照片'}
                aria-pressed={current.pick === 'keep'}
              >
                <Check size={17} />
                <span>{current.pick === 'keep' ? '已保留' : '保留'}</span>
              </button>
              <button
                className={`pp-pick-button ${current.pick === 'reject' ? 'is-rejected' : ''}`}
                onClick={() =>
                  void mutate({ pick: current.pick === 'reject' ? 'none' : 'reject' }, 'pick')
                }
                disabled={!!busy}
                aria-label={current.pick === 'reject' ? '取消淘汰标记' : '标记为淘汰'}
                aria-pressed={current.pick === 'reject'}
              >
                <X size={17} />
                <span>淘汰</span>
              </button>
              <button
                className="pp-icon-button pp-delete"
                ref={deleteRef}
                onClick={() => {
                  setError('');
                  setConfirming(true);
                }}
                disabled={!!busy}
                aria-label="移入回收站"
                title="移入回收站"
              >
                <Trash2 size={17} />
              </button>
            </div>
          )}
          {readOnly && <span className="pp-view-hint">滚轮缩放 · 双击查看细节</span>}
        </div>

        <footer className="pp-filmstrip-area">
          <div className="pp-filmstrip-label">
            <span>THE COLLECTION</span>
            <span>
              {available.length}
              {' 张照片'}
            </span>
          </div>
          <div className="pp-filmstrip" aria-label="浏览相册照片">
            {available.map((photo, index) => (
              <button
                key={photo.id}
                ref={(element) => {
                  if (element) thumbnailRefs.current.set(photo.id, element);
                  else thumbnailRefs.current.delete(photo.id);
                }}
                className={`pp-thumbnail ${photo.id === current.id ? 'is-current' : ''}`}
                onClick={() => {
                  if (!busy) setActiveId(photo.id);
                }}
                aria-label={`查看第 ${index + 1} 张：${photo.filename}`}
                aria-current={photo.id === current.id ? 'true' : undefined}
                disabled={!!busy}
              >
                <img src={photo.thumbnailUrl} loading="lazy" alt="" />
                <span className="pp-thumbnail-index">{String(index + 1).padStart(2, '0')}</span>
                {!readOnly && photo.pick === 'keep' && (
                  <span className="pp-thumbnail-pick">
                    <Check size={11} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </footer>
      </div>

      {confirming && (
        <div
          className="pp-confirm-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) cancelDelete();
          }}
        >
          <div
            className="pp-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pp-delete-title"
            aria-describedby="pp-delete-description"
            ref={confirmRef}
          >
            <div className="pp-confirm-icon">
              <Trash2 size={23} />
            </div>
            <span className="pp-eyebrow">KEEP WHAT MATTERS</span>
            <h3 id="pp-delete-title">将这张照片移入回收站？</h3>
            <p id="pp-delete-description">
              “{current.filename}”将从当前相册移除。你可以在回收站中恢复它。
            </p>
            {error && (
              <p className="pp-confirm-error" role="alert">
                {error}
              </p>
            )}
            <div className="pp-confirm-actions">
              <button
                className="pp-confirm-cancel"
                ref={cancelRef}
                onClick={cancelDelete}
                disabled={!!busy}
              >
                取消
              </button>
              <button
                className="pp-confirm-delete"
                onClick={() => void deletePhoto()}
                disabled={!!busy}
              >
                {busy === 'delete' && <LoaderCircle size={16} className="pp-spin" />}移入回收站
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PhotoPreview;
