import { useLayoutEffect, useState } from 'react';
import { Heart, Images, LayoutGrid } from 'lucide-react';
import { useI18n } from '../i18n';

/** Three primary destinations stay within thumb reach, outside modal/photo workflows. */
export default function MobileNavigation({
  home,
  active,
  blocked,
  onExplore,
  onLibrary,
  onFavorites,
}: {
  home: boolean;
  active: 'explore' | 'library' | 'favorites';
  blocked: boolean;
  onExplore: () => void;
  onLibrary: () => void;
  onFavorites: () => void;
}) {
  const { language } = useI18n();
  const [collectionVisible, setCollectionVisible] = useState(false);

  useLayoutEffect(() => {
    if (!home) return;
    const collection = document.getElementById('collection');
    if (!collection) return;
    const bounds = collection.getBoundingClientRect();
    setCollectionVisible(bounds.top < window.innerHeight * 0.65 && bounds.bottom > 0);
    // Keep the first screen entirely photographic. Reveal navigation on entering the gallery.
    const observer = new IntersectionObserver(
      ([entry]) => setCollectionVisible(entry.isIntersecting),
      { rootMargin: '0px 0px -35% 0px' },
    );
    observer.observe(collection);
    return () => observer.disconnect();
  }, [home]);

  const zh = language === 'zh';
  const destinations = [
    { id: 'explore', label: zh ? '公共图库' : 'Explore', icon: LayoutGrid, action: onExplore },
    { id: 'library', label: zh ? '我的相册' : 'Albums', icon: Images, action: onLibrary },
    { id: 'favorites', label: zh ? '我的收藏' : 'Saved', icon: Heart, action: onFavorites },
  ];

  return (
    <nav
      className="mobile-navigation"
      aria-label={zh ? '手机主导航' : 'Mobile navigation'}
      hidden={blocked || (home && !collectionVisible)}
    >
      {destinations.map(({ id, label, icon: Icon, action }) => (
        <button
          key={id}
          className={active === id ? 'active' : ''}
          aria-current={active === id ? 'page' : undefined}
          onClick={action}
        >
          <Icon size={23} strokeWidth={1.7} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
