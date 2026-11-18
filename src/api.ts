/**
 * 前端请求与显示工具：统一 JSON 请求、同源凭据、修改请求头及错误处理。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import { englishServiceError } from './uiTranslations.ts';
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== 'GET') headers.set('X-Album-Client', '1');
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers, credentials: 'same-origin' });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    // A cancelled response body must remain cancelled, never become successful empty data.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`Unexpected response format (${response.status}). Please try again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Unexpected response data. Please try again.');
  if (!response.ok)
    throw new Error(
      englishServiceError(
        typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`,
      ),
    );
  return data as T;
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(date)
        .replaceAll('/', '.');
}
