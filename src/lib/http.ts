import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { log } from './logger';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonError(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, {
    ...init,
    headers: { 'Cache-Control': 'no-store', ...(init?.headers || {}) }
  });
}

export async function api<T>(fn: () => Promise<T | Response>): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return NextResponse.json(
      { ok: true, data: result ?? null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return jsonError(err.status, err.code, err.message, err.details);
    }
    if (err instanceof ZodError) {
      return jsonError(400, 'VALIDATION_ERROR', '请求参数无效', err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message
      })));
    }
    const maybe = err as Error & { code?: string };
    if (maybe.code === 'WEAK_PASSWORD') {
      return jsonError(400, 'WEAK_PASSWORD', maybe.message);
    }
    log.error('api.unhandled_error', {
      message: maybe.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : maybe.stack
    });
    return jsonError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试');
  }
}

export function getRequestIp(req: Request): string {
  const value = req.headers.get('x-client-ip');
  return value && value.length <= 64 ? value : 'unknown';
}

export function getUserAgent(req: Request): string {
  return (req.headers.get('user-agent') || '').slice(0, 512);
}

export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (!origin) return; // SameSite=Lax cookies + CSRF token protect session mutations.
  let expected: string;
  try {
    expected = new URL(process.env.APP_URL || '').origin;
  } catch {
    throw new ApiError(500, 'CONFIG_ERROR', 'APP_URL 配置无效');
  }
  if (origin !== expected) {
    throw new ApiError(403, 'ORIGIN_MISMATCH', '请求来源校验失败');
  }
}

export function assertJsonContentType(req: Request): void {
  const ct = req.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
}

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  assertJsonContentType(req);
  const length = Number(req.headers.get('content-length') || '0');
  if (length > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效');
  }
}

/**
 * 带体积上限地读取 multipart 表单。content-length 由客户端声明、不可信，
 * 因此按实际字节数逐块累计，超限立即取消请求，避免整段大文件先进内存再判断。
 * maxBytes 需为「文件大小上限 + multipart 边界余量」。
 */
export async function readMultipartLimited(req: Request, maxBytes: number): Promise<FormData> {
  const contentType = req.headers.get('content-type') || '';
  if (!req.body) throw new ApiError(400, 'INVALID_FORM', '上传表单无效');
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'FILE_TOO_LARGE', '上传内容过大');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'INVALID_FORM', '上传表单无效');
  }
  const formReq = new Request(req.url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Buffer.concat(chunks)
  });
  try {
    return await formReq.formData();
  } catch {
    throw new ApiError(400, 'INVALID_FORM', '上传表单无效');
  }
}

export function clientErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return '请求失败';
}
