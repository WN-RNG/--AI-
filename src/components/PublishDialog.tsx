import { useI18n } from '../i18n';
import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Eye, Globe, LoaderCircle } from 'lucide-react';
import type { Album, Photo } from '../../shared/types';
import Modal from './Modal';
type PublishingPhoto = Photo & {
  isPublished?: boolean;
  isFeatured?: boolean;
  allowDownload?: boolean;
};
export interface PublishSettings {
  photoIds: string[];
  allowDownload: boolean;
  title: string;
  featuredPhotoIds: string[];
}
export interface PublishDialogProps {
  album: Album;
  photos: Photo[];
  initialSelectedIds: string[];
  onClose: () => void;
  onSave: (settings: PublishSettings) => Promise<void>;
}
export default function PublishDialog({
  album,
  photos,
  initialSelectedIds,
  onClose,
  onSave,
}: PublishDialogProps) {
  const { t } = useI18n();
  const available = useMemo(
    () => photos.filter((photo) => !photo.deletedAt) as PublishingPhoto[],
    [photos],
  );
  const initialIds = initialSelectedIds.length
    ? initialSelectedIds
    : available.filter((photo) => photo.isPublished).map((photo) => photo.id);
  const [selectedIds, setSelectedIds] = useState(
    () => new Set(initialIds.filter((id) => available.some((photo) => photo.id === id))),
  );
  const [title, setTitle] = useState(album.publicTitle || album.title);
  const [allowDownload, setAllowDownload] = useState(() => {
    const initial = available.filter((photo) => initialIds.includes(photo.id));
    return initial.length > 0 && initial.every((photo) => photo.allowDownload === true);
  });
  const [includeFeatured, setIncludeFeatured] = useState(
    () =>
      available.some((photo) => initialIds.includes(photo.id) && photo.isFeatured) ||
      !available.some((photo) => photo.isPublished),
  );
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const selectedPhotos = available.filter((photo) => selectedIds.has(photo.id));
  const hasPublished = available.some((photo) => photo.isPublished) || album.isPublic;
  function togglePhoto(id: string) {
    if (savingRef.current) return;
    const adding = !selectedIds.has(id);
    const next = new Set(selectedIds);
    if (adding) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
    // 扩大公开范围时，旧许可不能自动沿用到新加入的照片。
    if (adding || !next.size) setAllowDownload(false);
    setError('');
  }
  function selectAll() {
    if (savingRef.current) return;
    if (available.some((photo) => !selectedIds.has(photo.id))) setAllowDownload(false);
    setSelectedIds(new Set(available.map((photo) => photo.id)));
    setError('');
  }
  function close() {
    if (!savingRef.current) onClose();
  }
  async function save(withdraw = false) {
    if (savingRef.current) return;
    const name = title.trim();
    if (!withdraw && (!name || name.length > 120)) {
      setError('请填写 1–120 个字符的作品集名称。');
      return;
    }
    if (!withdraw && !selectedPhotos.length) {
      setError('请至少选择一张照片。若要停止公开，请使用“撤回全部公开”。');
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError('');
    const ids = withdraw ? [] : selectedPhotos.map((photo) => photo.id);
    try {
      await onSave({
        photoIds: ids,
        allowDownload: !withdraw && allowDownload,
        title: name || album.publicTitle || album.title,
        featuredPhotoIds: !withdraw && includeFeatured ? ids : [],
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('公开设置未保存，请重试。'));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={preview ? t('预览公开效果') : t('发布精选作品')} wide onClose={close}>
      <div className="publish-dialog" aria-busy={busy}>
        {preview ? (
          <section className="publish-preview" aria-label={t('所选照片的公开预览')}>
            <div className="publish-preview-header">
              <button
                type="button"
                className="text-button"
                onClick={() => setPreview(false)}
                disabled={busy}
              >
                <ArrowLeft size={15} />
                {t('返回修改')}
              </button>
              <span>{t('仅预览，尚未保存公开设置')}</span>
            </div>
            <h3>{title.trim() || album.publicTitle || album.title}</h3>
            <p className="publish-selection-summary">
              {selectedPhotos.length} {t('张公开作品 ·')}{' '}
              {allowDownload ? t('允许登录后下载展示图') : t('未开放下载')}
            </p>
            {selectedPhotos.length ? (
              <div className="publish-preview-grid">
                {selectedPhotos.map((photo) => (
                  <figure key={photo.id} className="publish-preview-card">
                    <img
                      src={photo.previewUrl || photo.thumbnailUrl}
                      width={photo.width || undefined}
                      height={photo.height || undefined}
                      alt={photo.filename}
                      loading="lazy"
                    />
                    <figcaption>{photo.filename}</figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="publish-preview-empty">{t('没有选择公开照片，请返回修改。')}</p>
            )}
          </section>
        ) : (
          <>
            <p className="publish-dialog-intro">
              {t(
                '只公开你在这里选中的照片。保存后，未选中的照片会保持或恢复私密，其他人无法从公开作品集中浏览它们。',
              )}
            </p>
            <label className="publish-title-field">
              {t('作品集名称')}
              <input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError('');
                }}
                maxLength={120}
                required
                disabled={busy}
                placeholder={t('为这组作品起一个名字')}
              />
            </label>
            <div className="publish-selection-toolbar">
              <span className="publish-selection-summary" role="status">
                {t('已选择 {selected} / {total} 张', {
                  selected: selectedPhotos.length,
                  total: available.length,
                })}
              </span>
              <div>
                <button
                  type="button"
                  className="text-button"
                  onClick={selectAll}
                  disabled={busy || !available.length}
                >
                  {t('选择全部')}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setSelectedIds(new Set());
                    setAllowDownload(false);
                    setError('');
                  }}
                  disabled={busy || !selectedPhotos.length}
                >
                  {t('清空选择')}
                </button>
              </div>
            </div>
            <div className="publish-photo-grid" aria-label={t('选择公开照片')}>
              {available.map((photo) => (
                <button
                  type="button"
                  key={photo.id}
                  className={`publish-photo-choice ${selectedIds.has(photo.id) ? 'is-selected' : ''}`}
                  onClick={() => togglePhoto(photo.id)}
                  disabled={busy}
                  aria-pressed={selectedIds.has(photo.id)}
                  aria-label={`${selectedIds.has(photo.id) ? t('取消公开') : t('选择公开')} ${photo.filename}`}
                >
                  <img
                    src={photo.thumbnailUrl}
                    width={photo.width || undefined}
                    height={photo.height || undefined}
                    alt=""
                    loading="lazy"
                  />
                  <span className="publish-photo-caption">{photo.filename}</span>
                  {selectedIds.has(photo.id) && (
                    <span className="publish-photo-check" aria-hidden="true">
                      <Check size={15} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            {!available.length && (
              <p className="publish-dialog-note">{t('当前没有可发布的照片。请先上传照片。')}</p>
            )}
            <label className="publish-download-consent">
              <input
                type="checkbox"
                checked={allowDownload}
                onChange={(event) => setAllowDownload(event.target.checked)}
                disabled={busy || !selectedPhotos.length}
              />
              <span>
                {t('允许登录用户下载这些照片的展示图')}
                <small>{t('不提供私密原图。新增公开照片后，需要重新勾选此许可。')}</small>
              </span>
            </label>
            <label className="publish-feature-consent">
              <input
                type="checkbox"
                checked={includeFeatured}
                onChange={(event) => setIncludeFeatured(event.target.checked)}
                disabled={busy || !selectedPhotos.length}
              />
              <span>
                {t('同时加入精选作品')}
                <small>{t('勾选后，所选照片也会展示在公开的精选作品中。')}</small>
              </span>
            </label>
            <p className="publish-dialog-note">
              {t('公开内容可被任何人浏览，也可能被搜索引擎收录。请确认你拥有发布这些照片的权利。')}
            </p>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {t(error)}
          </p>
        )}
        <div className="publish-dialog-actions">
          {hasPublished && (
            <button
              type="button"
              className="button button-danger"
              onClick={() => void save(true)}
              disabled={busy}
            >
              {t('撤回全部公开')}
            </button>
          )}
          <button
            type="button"
            className="button button-secondary"
            onClick={preview ? () => setPreview(false) : close}
            disabled={busy}
          >
            {preview ? t('返回修改') : t('取消')}
          </button>
          {!preview && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                if (!title.trim()) {
                  setError('请先填写作品集名称。');
                  return;
                }
                setError('');
                setPreview(true);
              }}
              disabled={busy || !selectedPhotos.length}
            >
              <Eye size={16} />
              {t('预览公开效果')}
            </button>
          )}
          <button
            type="button"
            className="button button-primary"
            onClick={() => void save()}
            disabled={busy || !selectedPhotos.length}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Globe size={16} />}
            {hasPublished
              ? t('保存公开设置')
              : t('确认发布 {count} 张照片', { count: selectedPhotos.length })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
