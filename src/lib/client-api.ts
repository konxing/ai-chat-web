'use client';

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
  }
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return '';
}

export function csrfHeader(): Record<string, string> {
  const token = readCookie('fac_csrf');
  return token ? { 'x-csrf-token': token } : {};
}

export async function apiFetch<T>(
  input: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method || (init.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = csrfHeader();
    for (const [key, value] of Object.entries(csrf)) headers.set(key, value);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const response = await fetch(input, { ...init, method, headers, body, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (response.ok) return undefined as T;
    throw new ApiClientError(response.status, {
      code: 'UNEXPECTED_RESPONSE',
      message: `请求失败（HTTP ${response.status}）`
    });
  }
  const payload = (await response.json()) as
    | { ok: true; data: T }
    | { ok: false; error: ApiErrorPayload };
  if (!response.ok || !payload.ok) {
    const error = payload.ok
      ? { code: 'HTTP_ERROR', message: `请求失败（HTTP ${response.status}）` }
      : payload.error;
    throw new ApiClientError(response.status, error);
  }
  return payload.data;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return '操作失败，请稍后重试';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '—';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDateTime(value);
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

export { cn } from './cn';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function imageUrl(id: string): string {
  return `/api/files/${id}?inline=1`;
}
