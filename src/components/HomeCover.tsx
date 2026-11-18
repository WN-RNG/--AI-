import { useEffect, useReducer, useState } from 'react';
import { Aperture, ArrowDownRight, Pause, Play } from 'lucide-react';
import { useI18n } from '../i18n';
import initialManifest from '../../public/covers/manifest.json';
import { coverFrame, initialCoverState, parseCoverManifest, reduceCoverState } from '../homeCover';
import type { User } from '../../shared/types';

// The manually selected pool is also bundled for an unavailable runtime manifest.
const fallbackSlides = parseCoverManifest(initialManifest);

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
  const { language } = useI18n();
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
        /* Keep the bundled manual selection if the optional runtime manifest is unavailable. */
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
          <span>Light &amp; Frame</span>
        </a>
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
      <div className="home-cover-bottom">
        {(active?.credit || active?.author) && (
          <div className="home-credit">
            {active.credit && <span>{active.credit}</span>}
            {active.author && <span>{active.author}</span>}
          </div>
        )}
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
