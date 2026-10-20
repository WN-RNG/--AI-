import { useState } from 'react';
import { Check, Image, Shuffle, Play, LoaderCircle } from 'lucide-react';
import Modal from './Modal';
import type { Album, CoverMode, Photo } from '../../shared/types';

export default function CoverDialog({ album, photos, onClose, onSave }: { album: Album; photos: Photo[]; onClose: () => void; onSave: (patch: Partial<Album>) => Promise<void> }) {
  const [mode, setMode] = useState<CoverMode>(album.coverMode);
  const [fixed, setFixed] = useState(album.coverPhotoId || photos[0]?.id || '');
  const [chosen, setChosen] = useState<string[]>(album.coverPhotoIds || []);
  const [interval, setInterval] = useState(album.slideInterval || 8);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { await onSave({ coverMode: mode, coverPhotoId: fixed || null, coverPhotoIds: chosen, slideInterval: interval }); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const options = [{ id: 'fixed', title: '指定照片', text: '让最出色的一张成为主角', icon: Image }, { id: 'random', title: '随机轮播', text: '以随机顺序，展现不同视角', icon: Shuffle }, { id: 'slideshow', title: '顺序轮播', text: '按选定顺序，徐徐展开项目', icon: Play }] as const;
  return <Modal title="相册封面与轮播" wide onClose={onClose}>
    <p className="muted modal-intro">为顶部大屏选择一种展示方式。原图会完整保留。</p>
    <div className="cover-modes">{options.map(o => <button key={o.id} className={`cover-mode ${mode === o.id ? 'is-active' : ''}`} onClick={() => setMode(o.id)} aria-pressed={mode === o.id}><o.icon size={22} /><strong>{o.title}</strong><small>{o.text}</small></button>)}</div>
    <div className="cover-selection-heading"><span>{mode === 'fixed' ? '选择封面照片' : '选择参与展示的照片'}</span>{mode !== 'fixed' && <button className="text-button" onClick={() => setChosen([])}>使用全部照片</button>}</div>
    {mode !== 'fixed' && <p className="muted small-text">{chosen.length ? `已选择 ${chosen.length} 张` : '当前使用相册中的全部照片'}，点击缩略图可指定展示范围。</p>}
    <div className="cover-grid">{photos.map(p => {
      const selected = mode === 'fixed' ? fixed === p.id : chosen.includes(p.id);
      return <button key={p.id} className={`cover-choice ${selected ? 'is-selected' : ''}`} onClick={() => mode === 'fixed' ? setFixed(p.id) : setChosen(chosen.includes(p.id) ? chosen.filter(id => id !== p.id) : [...chosen, p.id])} aria-label={`选择 ${p.filename}`} aria-pressed={selected}><img src={p.thumbnailUrl} alt={p.filename} loading="lazy" />{selected && <span className="cover-check"><Check size={14} /></span>}</button>;
    })}</div>
    {mode !== 'fixed' && <label className="interval-label">每张展示<select value={interval} onChange={e => setInterval(Number(e.target.value))}><option value={5}>5 秒</option><option value={8}>8 秒</option><option value={12}>12 秒</option><option value={20}>20 秒</option></select></label>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="modal-actions"><button className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy || !photos.length} onClick={save}>{busy && <LoaderCircle className="spin" size={16} />}保存展示方式</button></div>
  </Modal>;
}
