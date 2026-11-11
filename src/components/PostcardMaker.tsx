/** Postcard controls stay local. Export re-checks permission through the authenticated download API. */
import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, Sparkles } from 'lucide-react';
import type { Photo } from '../../shared/types';
import { useI18n } from '../i18n';
import {
  authorizedPostcardBlob,
  encodePostcard,
  imagePalette,
  recommendTemplate,
  renderPostcard,
  type PaletteColor,
  type PostcardOrientation,
  type PostcardTemplate,
} from '../postcard';
import './PostcardMaker.css';

export type PostcardExportHandler = (photo: Photo, performExport: () => Promise<void>) => void;

export default function PostcardMaker({
  photo,
  downloadAllowed,
  currentUserId,
  onRequestExport,
}: {
  photo: Photo;
  downloadAllowed: boolean;
  currentUserId?: string;
  onRequestExport?: PostcardExportHandler;
}) {
  const { language } = useI18n();
  const text = (en: string, zh: string) => (language === 'en' ? en : zh);
  const [template, setTemplate] = useState<'auto' | PostcardTemplate>('auto');
  const [orientation, setOrientation] = useState<PostcardOrientation>('auto');
  const [caption, setCaption] = useState(photo.filename.replace(/\.[^.]+$/, '').slice(0, 140));
  const [mime, setMime] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [longEdge, setLongEdge] = useState<2400 | 3600>(2400);
  const [source, setSource] = useState<{ image: ImageBitmap; palette: PaletteColor[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const previewRef = useRef<HTMLCanvasElement>(null);
  const aliveRef = useRef(true);
  const exportControllerRef = useRef<AbortController | null>(null);
  const exportingRef = useRef(false);
  const recommended = source
    ? recommendTemplate(source.palette, source.image.width, source.image.height)
    : 'B';
  const selected = template === 'auto' ? recommended : template;
  const names = {
    A: text('Airy', '清透'),
    B: text('Editorial', '画册'),
    C: text('Cinema', '电影'),
  };
  const author = photo.authorName || '';

  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    let image: ImageBitmap | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/photos/${encodeURIComponent(photo.id)}/preview`, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(text('Unable to load this photo.', '暂时无法加载照片。'));
        const blob = await response.blob();
        image = await createImageBitmap(blob);
        if (cancelled) {
          image.close();
          return;
        }
        setSource({ image, palette: imagePalette(image) });
      } catch (reason) {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : text('Preview failed.', '预览失败。'),
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      controller.abort();
      exportControllerRef.current?.abort();
      image?.close();
    };
  }, [photo.id]);

  useEffect(() => {
    if (!source || !previewRef.current) return;
    try {
      renderPostcard(previewRef.current, source.image, {
        template: selected,
        orientation,
        longEdge: 1200,
        palette: source.palette,
        caption,
        author,
        metadata: `DISPLAY ${source.image.width} × ${source.image.height}`,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text('Preview failed.', '预览失败。'));
    }
  }, [source, selected, orientation, caption, author]);

  function requestExport() {
    if (!source || !downloadAllowed || exportingRef.current) return;
    // Capture the requested configuration; after sign-in the exact same operation resumes once.
    const settings = {
      template: selected,
      orientation,
      longEdge,
      palette: source.palette,
      caption,
      author,
    };
    const perform = async () => {
      if (!aliveRef.current || exportingRef.current) return;
      exportingRef.current = true;
      setExporting(true);
      setError('');
      setNotice('');
      const controller = new AbortController();
      exportControllerRef.current = controller;
      let image: ImageBitmap | undefined;
      let canvas: HTMLCanvasElement | undefined;
      let objectUrl = '';
      try {
        const blob = await authorizedPostcardBlob(photo.id, controller.signal);
        if (!aliveRef.current || controller.signal.aborted) return;
        const fit = Math.min(1, longEdge / Math.max(photo.width, photo.height, 1));
        // Limit the retained decoded surface for very large originals; previews never load originals.
        image = await createImageBitmap(
          blob,
          photo.width > 0 && photo.height > 0
            ? {
                resizeWidth: Math.max(1, Math.round(photo.width * fit)),
                resizeHeight: Math.max(1, Math.round(photo.height * fit)),
                resizeQuality: 'high',
              }
            : undefined,
        );
        if (!aliveRef.current || controller.signal.aborted) return;
        canvas = document.createElement('canvas');
        renderPostcard(canvas, image, {
          ...settings,
          metadata: `${longEdge} px · ${mime === 'image/png' ? 'PNG' : 'JPEG'}`,
        });
        const result = await encodePostcard(canvas, mime);
        if (!aliveRef.current || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(result);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `postcard-${photo.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'photo'}-${selected}.${mime === 'image/png' ? 'png' : 'jpg'}`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (aliveRef.current)
          setNotice(text('Your postcard is ready to save.', '明信片已生成，请在浏览器中保存。'));
      } catch (reason) {
        if (aliveRef.current && !controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : text('Export failed. Please try again.', '导出失败，请重试。'),
          );
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        image?.close();
        if (canvas) canvas.width = canvas.height = 1;
        if (exportControllerRef.current === controller) exportControllerRef.current = null;
        exportingRef.current = false;
        if (aliveRef.current) setExporting(false);
      }
    };
    if (onRequestExport) onRequestExport(photo, perform);
    else if (currentUserId) void perform();
    else setError(text('Please sign in to export.', '请先登录再导出。'));
  }

  return (
    <section className="pc-maker" aria-label={text('Postcard studio', '明信片工作室')}>
      <div className="pc-preview-area">
        <div className="pc-preview-heading">
          <span>POSTCARD STUDIO</span>
          <span>{text('A little piece of this moment.', '把这一刻，留在一张明信片里。')}</span>
        </div>
        <div className="pc-canvas-wrap">
          {loading && (
            <div className="pc-loading" role="status">
              <LoaderCircle className="pp-spin" size={24} />
              {text('Finding your colours…', '正在提取照片色彩…')}
            </div>
          )}
          <canvas
            ref={previewRef}
            hidden={!source}
            role="img"
            aria-label={text(
              `Postcard preview · ${names[selected]}`,
              `明信片预览 · ${names[selected]}`,
            )}
          />
        </div>
        <p className="pc-preview-note">
          {text(
            'Original photo stays unchanged. Preview uses a smaller display image.',
            '原照片保持不变，当前预览使用展示图。',
          )}
        </p>
      </div>
      <aside className="pc-controls" aria-label={text('Postcard settings', '明信片设置')}>
        <div className="pc-controls-title">
          <span>MAKE IT YOURS</span>
          <h3>{text('A moment, framed.', '为此刻装裱。')}</h3>
        </div>
        <div className="pc-field-label">{text('Style', '选择样式')}</div>
        <button
          type="button"
          className={`pc-auto ${template === 'auto' ? 'is-selected' : ''}`}
          aria-pressed={template === 'auto'}
          onClick={() => setTemplate('auto')}
        >
          <Sparkles size={17} />
          <span>
            Auto{' '}
            <small>
              · {recommended} {names[recommended]}
            </small>
          </span>
          {template === 'auto' && <Check size={16} />}
        </button>
        <p className="pc-auto-note">
          {text(
            'Suggested from colour, brightness and photo shape.',
            '根据色彩、明暗和照片比例推荐。',
          )}
        </p>
        <div
          className="pc-template-options"
          role="group"
          aria-label={text('Choose a template', '选择明信片模板')}
        >
          {(['A', 'B', 'C'] as const).map((id) => (
            <button
              type="button"
              key={id}
              className={`pc-template pc-template-${id} ${template === id ? 'is-selected' : ''}`}
              onClick={() => setTemplate(id)}
              aria-pressed={template === id}
            >
              <span className="pc-template-thumb">
                <img src={photo.thumbnailUrl} alt="" />
              </span>
              <span className="pc-template-name">
                {id} · {names[id]}
              </span>
              <span className="pc-template-tag">
                {id === recommended ? text('Recommended', '推荐') : '\u00a0'}
              </span>
            </button>
          ))}
        </div>
        <label className="pc-field">
          <span>{text('Caption', '明信片寄语')}</span>
          <textarea
            value={caption}
            maxLength={140}
            rows={3}
            onChange={(event) => setCaption(event.target.value)}
            placeholder={text('Write something to keep…', '写下你想留住的话…')}
          />
          <small>{caption.length} / 140</small>
        </label>
        <label className="pc-field">
          <span>{text('Orientation', '明信片方向')}</span>
          <select
            value={orientation}
            onChange={(event) => setOrientation(event.target.value as PostcardOrientation)}
          >
            <option value="auto">{text('Auto · follow photo', '自动 · 跟随照片')}</option>
            <option value="landscape">{text('Landscape', '横向')}</option>
            <option value="portrait">{text('Portrait', '竖向')}</option>
          </select>
        </label>
        <div className="pc-output-options">
          <label className="pc-field">
            <span>{text('Format', '保存格式')}</span>
            <select value={mime} onChange={(event) => setMime(event.target.value as typeof mime)}>
              <option value="image/png">PNG</option>
              <option value="image/jpeg">JPEG</option>
            </select>
          </label>
          <label className="pc-field">
            <span>{text('Long edge', '最长边')}</span>
            <select
              value={longEdge}
              onChange={(event) => setLongEdge(Number(event.target.value) as typeof longEdge)}
            >
              <option value="2400">2400 px</option>
              <option value="3600">3600 px</option>
            </select>
          </label>
        </div>
        {!downloadAllowed && (
          <p className="pc-permission-note">
            {text(
              'The author has not enabled downloads. You can preview styles here; exporting is unavailable.',
              '作者尚未开放下载，你可以预览模板，暂时无法导出。',
            )}
          </p>
        )}
        {downloadAllowed && !currentUserId && (
          <p className="pc-permission-note">
            {text(
              'Sign in to export. Your current style will be kept.',
              '登录后可导出，当前样式会为你保留。',
            )}
          </p>
        )}
        {error && (
          <p className="pc-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="pc-notice" role="status">
            {notice}
          </p>
        )}
        <button
          type="button"
          className="pc-export"
          onClick={requestExport}
          disabled={!source || !downloadAllowed || exporting}
        >
          {exporting ? <LoaderCircle size={18} className="pp-spin" /> : <Download size={18} />}
          {exporting ? text('Preparing…', '正在生成…') : text('Export postcard', '导出明信片')}
        </button>
        <p className="pc-privacy-note">
          {text(
            'Rendered on your device. No AI service or extra fee.',
            '在你的设备中生成，不调用 AI 服务，不产生额外费用。',
          )}
        </p>
      </aside>
    </section>
  );
}
