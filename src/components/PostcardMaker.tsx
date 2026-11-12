/** Local composition with optional private Qwen image jobs. Export always re-checks permission. */
import { useEffect, useRef, useState } from 'react';
import { Brush, Check, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Photo } from '../../shared/types';
import { useI18n } from '../i18n';
import {
  authorizedPostcardBlob,
  encodePostcard,
  imagePalette,
  renderPostcard,
  type PaletteColor,
  type PostcardOrientation,
  type PostcardTemplate,
} from '../postcard';
import { usePostcardAI } from '../usePostcardAI';
import { initialPostcardBlessing, nextPostcardBlessing } from '../postcardBlessings';
import { loadPostcardFont } from '../fontLoading';
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
  const [orientation, setOrientation] = useState<PostcardOrientation>('auto');
  const [caption, setCaption] = useState(() => initialPostcardBlessing(photo.id));
  const [mime, setMime] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [longEdge, setLongEdge] = useState<2400 | 3600>(2400);
  const [source, setSource] = useState<{ image: ImageBitmap; palette: PaletteColor[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const previewRef = useRef<HTMLCanvasElement>(null);
  const aliveRef = useRef(true);
  const exportControllerRef = useRef<AbortController | null>(null);
  const exportingRef = useRef(false);
  const [selected, setSelected] = useState<PostcardTemplate>('frost');
  const [consent, setConsent] = useState(false);
  const ai = usePostcardAI(photo.id, currentUserId);
  const job = ai.jobs[selected];
  const [artwork, setArtwork] = useState<{ id: string; image: ImageBitmap } | null>(null);
  const aiImage =
    job?.status === 'complete' && artwork?.id === job.id && artwork.image.width > 0
      ? artwork.image
      : undefined;
  const waiting = ai.busy || job?.status === 'queued' || job?.status === 'running';
  const canRender = selected === 'frost' || !!aiImage;

  useEffect(() => {
    if (job?.status !== 'complete' || !job.imageUrl) return;
    const controller = new AbortController();
    let bitmap: ImageBitmap | undefined;
    void (async () => {
      try {
        const response = await fetch(job.imageUrl!, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('AI 图片不可用或作者已撤回许可');
        bitmap = await createImageBitmap(await response.blob());
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        setArtwork({ id: job.id, image: bitmap });
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'AI 图片加载失败');
      }
    })();
    return () => {
      controller.abort();
      bitmap?.close();
    };
  }, [job?.id, job?.status, currentUserId]);

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
    if (!source || !previewRef.current || !canRender) return;
    let cancelled = false;
    setRendering(true);
    void (async () => {
      try {
        await loadPostcardFont(caption);
        if (cancelled || !previewRef.current) return;
        renderPostcard(previewRef.current, selected === 'watercolor' ? aiImage! : source.image, {
          template: selected,
          orientation,
          longEdge: 1200,
          palette: source.palette,
          caption,
          background: selected === 'frost' ? aiImage : undefined,
        });
      } catch (reason) {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : text('Preview failed.', '预览失败。'),
          );
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, orientation, caption, selected, aiImage, canRender]);

  function requestExport() {
    if (!source || !downloadAllowed || !canRender || exportingRef.current) return;
    // Capture the requested configuration; after sign-in the exact same operation resumes once.
    const settings = {
      template: selected,
      orientation,
      longEdge,
      palette: source.palette,
      caption,
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
        await loadPostcardFont(settings.caption);
        if (!aliveRef.current || controller.signal.aborted) return;
        const blob =
          selected === 'watercolor' && job?.imageUrl
            ? await fetch(job.imageUrl, {
                credentials: 'same-origin',
                redirect: 'error',
                signal: controller.signal,
              }).then((response) => {
                if (!response.ok) throw Error('AI 图片不可用或下载许可已撤回');
                return response.blob();
              })
            : await authorizedPostcardBlob(photo.id, controller.signal);
        if (!aliveRef.current || controller.signal.aborted) return;
        const fit = Math.min(1, longEdge / Math.max(photo.width, photo.height, 1));
        // Limit the retained decoded surface for very large originals; previews never load originals.
        image = await createImageBitmap(
          blob,
          selected !== 'watercolor' && photo.width > 0 && photo.height > 0
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
          background: selected === 'frost' ? aiImage : undefined,
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
            hidden={!source || loading || !canRender}
            role="img"
            aria-label={
              selected === 'frost'
                ? text('Frost postcard preview', '磨砂明信片预览')
                : text('Watercolor postcard preview', '水彩明信片预览')
            }
          />
          {!loading && !canRender && (
            <p className="pc-loading">
              {waiting
                ? text(
                    'Painting your moment… You can keep browsing.',
                    '正在转绘此刻，你可以继续浏览。',
                  )
                : text(
                    'Generate your watercolor below to preview it here.',
                    '点击下方生成按钮，在这里预览真实水彩转绘。',
                  )}
            </p>
          )}
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
        <div
          className="pc-template-options"
          role="group"
          aria-label={text('Choose a template', '选择明信片模板')}
        >
          <button
            type="button"
            className={`pc-template pc-template-frost ${selected === 'frost' ? 'is-selected' : ''}`}
            aria-pressed={selected === 'frost'}
            onClick={() => setSelected('frost')}
          >
            <span className="pc-template-thumb">
              <img src={photo.thumbnailUrl} alt="" />
            </span>
            <span className="pc-template-name">{text('Immersive frost', '沉浸磨砂')}</span>
            <span className="pc-template-tag">
              <Check size={13} /> {text('On your device', '本地生成')}
            </span>
          </button>
          <button
            type="button"
            className={`pc-template pc-template-watercolor ${selected === 'watercolor' ? 'is-selected' : ''}`}
            aria-pressed={selected === 'watercolor'}
            onClick={() => setSelected('watercolor')}
            aria-describedby="pc-watercolor-note"
          >
            <span className="pc-template-thumb">
              <Brush size={27} />
            </span>
            <span className="pc-template-name">{text('Watercolor art', '水彩艺术')}</span>
            <span className="pc-template-tag">Qwen AI</span>
          </button>
        </div>
        <p id="pc-watercolor-note" className="pc-style-note">
          {text(
            'Frost keeps your photo intact. Watercolor repaints a copy; your original stays safe.',
            '摄影款保留原照片，AI 只生成背景；水彩款转绘照片副本，原文件保持不变。',
          )}
        </p>
        <div className="pc-ai-panel">
          {!ai.config.enabled && (
            <p>
              {text(
                'An administrator needs to configure the Qwen API key.',
                '管理员尚需配置 Qwen API 密钥，当前可使用本地磨砂。',
              )}
            </p>
          )}
          {!currentUserId && (
            <p>{text('Sign in before using AI generation.', '登录后可使用 AI 生成。')}</p>
          )}
          <label className="pc-ai-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {text(
              'Send a smaller photo copy to Qwen for this creation.',
              '同意将照片的缩小副本发送至千问，用于本次生成。',
            )}
          </label>
          <button
            className="pc-export"
            type="button"
            onClick={() => void ai.generate(selected)}
            disabled={
              !ai.config.enabled ||
              !currentUserId ||
              !downloadAllowed ||
              !consent ||
              waiting ||
              job?.status === 'complete' ||
              job?.status === 'failed' ||
              job?.status === 'interrupted'
            }
          >
            {waiting ? <LoaderCircle className="pp-spin" size={16} /> : <Brush size={16} />}
            {waiting
              ? text('Creating…', '正在生成…')
              : job?.status === 'complete'
                ? text('Saved result · reused', '已生成 · 复用结果')
                : selected === 'frost'
                  ? text('Generate soft-light background', '生成柔雾光影背景')
                  : text('Paint in watercolor', '生成水彩明信片')}
          </button>
          <small>
            {text(
              `Up to ¥${ai.config.monthlyBudgetCny}/month across this site; each new image reserves ¥${ai.config.reservePerImageCny}. About two minutes, sometimes longer.`,
              `全站每月上限 ¥${ai.config.monthlyBudgetCny}；每次新生成预留 ¥${ai.config.reservePerImageCny}。通常需等待，可能超过两分钟。`,
            )}
          </small>
          {(ai.error || job?.error) && (
            <p className="pc-error" role="alert">
              {ai.error || job?.error}
            </p>
          )}
        </div>
        <div className="pc-blessing-heading">
          <span>{text('A wish for this moment', '为此刻写一句祝福')}</span>
          <button
            type="button"
            className="pc-another-blessing"
            onClick={() => setCaption(nextPostcardBlessing(caption))}
          >
            <RefreshCw size={15} />
            {text('Another wish', '换一句')}
          </button>
        </div>
        <label className="pc-field">
          <span className="sr-only">{text('English blessing', '英文祝福语')}</span>
          <textarea
            value={caption}
            maxLength={140}
            rows={3}
            lang="en"
            spellCheck
            onChange={(event) => setCaption(event.target.value)}
            placeholder={text('Write a wish in your own words…', '写下你自己的英文祝福…')}
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
      </aside>
      <div className="pc-save-bar">
        <button
          type="button"
          className="pc-export"
          onClick={requestExport}
          disabled={!source || !downloadAllowed || !canRender || exporting || loading || rendering}
        >
          {exporting ? <LoaderCircle size={18} className="pp-spin" /> : <Download size={18} />}
          {exporting ? text('Preparing…', '正在生成…') : text('Export postcard', '导出明信片')}
        </button>
        <p className="pc-privacy-note">
          {text(
            'Local composition. AI generation uses the site’s model budget.',
            '排版与文字在本地合成，AI 生成会消耗网站的模型额度。',
          )}
        </p>
      </div>
    </section>
  );
}
