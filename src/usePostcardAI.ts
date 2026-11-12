import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PostcardTemplate } from './postcard';

export type AIJob = {
  id: string;
  photoId: string;
  style: PostcardTemplate;
  status: string;
  error: string;
  imageUrl: string | null;
};
export function usePostcardAI(photoId: string, userId?: string) {
  const [config, setConfig] = useState({
    enabled: false,
    monthlyBudgetCny: 50,
    reservePerImageCny: 0.6,
  });
  const [jobs, setJobs] = useState<Partial<Record<PostcardTemplate, AIJob>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const context = `${userId || 'guest'}:${photoId}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const sending = useRef(false);
  const wake = useRef<() => void>(() => {});
  const ids = useRef<Partial<Record<PostcardTemplate, string>>>({});
  useEffect(() => {
    const controller = new AbortController();
    setJobs({});
    ids.current = {};
    setError('');
    setBusy(false);
    api<typeof config>('/postcards/config', { signal: controller.signal })
      .then(setConfig)
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!userId) return;
      clearTimeout(timer);
      let active = false;
      for (const style of ['frost', 'watercolor'] as const) {
        let id: string | null = ids.current[style] || null;
        try {
          id ||= localStorage.getItem(`postcard-job:${context}:${style}`);
        } catch {}
        if (!id) continue;
        ids.current[style] = id;
        try {
          const { job } = await api<{ job: AIJob }>(`/postcards/${encodeURIComponent(id)}`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || contextRef.current !== context) return;
          if (ids.current[style] !== job.id) continue;
          setJobs((previous) => ({ ...previous, [style]: job }));
          active ||= job.status === 'queued' || job.status === 'running';
        } catch (reason) {
          if (controller.signal.aborted) return;
          if (ids.current[style] !== id) continue;
          setError(reason instanceof Error ? reason.message : '无法查询生成任务');
          try {
            localStorage.removeItem(`postcard-job:${context}:${style}`);
          } catch {}
        }
      }
      if (!controller.signal.aborted && active) timer = setTimeout(poll, 3000);
    }
    wake.current = () => {
      void poll();
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [context]);

  async function generate(style: PostcardTemplate) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const expected = context;
    try {
      const { job } = await api<{ job: AIJob }>(
        `/photos/${encodeURIComponent(photoId)}/postcards`,
        { method: 'POST', body: JSON.stringify({ style, consent: true }) },
      );
      if (contextRef.current !== expected) return;
      setJobs((previous) => ({ ...previous, [style]: job }));
      ids.current[style] = job.id;
      try {
        localStorage.setItem(`postcard-job:${context}:${style}`, job.id);
      } catch {}
      wake.current();
    } catch (reason) {
      if (contextRef.current === expected)
        setError(reason instanceof Error ? reason.message : '提交生成失败');
    } finally {
      sending.current = false;
      if (contextRef.current === expected) setBusy(false);
    }
  }
  return { config, jobs, busy, error, generate };
}
