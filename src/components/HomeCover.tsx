import { useEffect, useReducer, useState } from 'react';
import { Aperture, ArrowDownRight, Pause, Play } from 'lucide-react';
import { useI18n } from '../i18n';
import fallback from '../../public/covers/fallback-manifest.json';
import { coverFrame, initialCoverState, parseCoverManifest, reduceCoverState } from '../homeCover';
import type { User } from '../../shared/types';

// Bundled artwork's provenance is prose in the original asset manifest, not an outbound link.
const fallbackSlides = parseCoverManifest({
  ...fallback,
  slides: fallback.slides.map((slide) => ({ ...slide, source: '' })),
});

/** Homepage imagery is separate from user albums and never enters download/postcard flows. */
export default function HomeCover({
  user,
  onExplore,
  onLibrary,
  onFavorites,
  onLogin,
  suspended = false,
}: {
  user: User | null;
  onExplore: () => void;
  onLibrary: () => void;
  onFavorites: () => void;
  onLogin: (register: boolean) => void;
  suspended?: boolean;
}) {
  const { language, setLanguage } = useI18n();
  const zh = language === 'zh';
  const [state, dispatch] = useReducer(reduceCoverState, fallbackSlides, initialCoverState);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const { usable, active, requested } = coverFrame(state);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/covers/manifest.json', { signal: controller.signal, cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (controller.signal.aborted) return;
        const slides = parseCoverManifest(value);
        if (slides.length) dispatch({ type: 'replace', slides });
      })
      .catch(() => {
        /* Missing/invalid optional manifests retain the bundled original artwork. */
      });
    const visibility = () => setHidden(document.hidden);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => setReducedMotion(motion.matches);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', preference);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', preference);
    };
  }, []);

  useEffect(() => {
    if (paused || hidden || reducedMotion || suspended || usable.length < 2) return;
    const timer = window.setInterval(() => dispatch({ type: 'advance' }), 8000);
    return () => clearInterval(timer);
  }, [paused, hidden, reducedMotion, suspended, usable.length]);

  return (
    <section
      className="home-cover"
      aria-label={zh ? '光影摄影首页' : 'Light & Frame — photography'}
    >
      <div
        className="home-cover-images"
        aria-hidden="true"
        onContextMenu={(event) => event.preventDefault()}
      >
        {requested.map((slide) => (
          <img
            key={slide.id + ':' + slide.url}
            src={slide.url}
            alt=""
            draggable={false}
            fetchPriority={active?.id === slide.id ? 'high' : 'low'}
            className={active?.id === slide.id ? 'active' : ''}
            style={{ objectPosition: slide.focalPoint.x + '% ' + slide.focalPoint.y + '%' }}
            onLoad={() => dispatch({ type: 'ready', id: slide.id, url: slide.url })}
            onError={() => dispatch({ type: 'failed', id: slide.id, url: slide.url })}
          />
        ))}
      </div>
      <div className="home-cover-shade" />
      <header className="home-cover-header">
        <a className="home-brand" href="/" aria-label={zh ? '光影首页' : 'Light & Frame home'}>
          <Aperture size={38} />
          <span>光影</span>
        </a>
        <button
          className="home-language"
          onClick={() => setLanguage(zh ? 'en' : 'zh')}
          aria-label={zh ? 'Switch to English' : '切换中文'}
        >
          <span className={!zh ? 'active' : ''}>EN</span>
          <span aria-hidden="true">/</span>
          <span className={zh ? 'active' : ''}>中</span>
        </button>
        <div className="home-auth">
          {user ? (
            <button onClick={onLibrary}>
              {zh ? '我的空间' : 'My studio'} <ArrowDownRight size={18} />
            </button>
          ) : (
            <>
              <button onClick={() => onLogin(false)}>{zh ? '登录' : 'Log in'}</button>
              <button className="home-signup" onClick={() => onLogin(true)}>
                {zh ? '注册' : 'Sign up'}
              </button>
            </>
          )}
        </div>
        <nav className="home-navigation" aria-label={zh ? '首页导航' : 'Homepage navigation'}>
          <button onClick={onExplore}>{zh ? '公共图库' : 'Gallery'}</button>
          <span aria-hidden="true" />
          <button onClick={onLibrary}>{zh ? '我的相册' : 'My Albums'}</button>
          <span aria-hidden="true" />
          <button onClick={onFavorites}>{zh ? '我的收藏' : 'Favorites'}</button>
        </nav>
      </header>
      <div className="home-title" key={active?.id}>
        <p>
          {active?.subtitle || (zh ? '收藏每一道光，留住每一个瞬间。' : 'A place for every frame.')}
        </p>
        <h1>{active?.title || 'STILL MOMENTS'}</h1>
      </div>
      <div className="home-cover-bottom">
        <div className="home-credit">
          <span>{active?.credit || (zh ? '原创风景示意图' : 'Original illustrative artwork')}</span>
          {active?.source ? (
            <a href={active.source} target="_blank" rel="noopener noreferrer">
              {active.author || (zh ? '作品来源' : 'Photo source')} ↗
            </a>
          ) : active?.author ? (
            <span>{active.author}</span>
          ) : null}
          <span>{zh ? '仅供首页展示' : 'For homepage display'}</span>
        </div>
        <div className="home-explore-actions">
          {usable.length > 1 && !reducedMotion && (
            <button
              className="home-pause"
              aria-label={
                paused ? (zh ? '继续轮播' : 'Play slideshow') : zh ? '暂停轮播' : 'Pause slideshow'
              }
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={19} /> : <Pause size={19} />}
            </button>
          )}
          <button className="home-explore" onClick={onExplore}>
            {zh ? '探索' : 'Explore'}
            <ArrowDownRight size={29} />
          </button>
        </div>
      </div>
    </section>
  );
}
