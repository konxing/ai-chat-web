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

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function selfOrigins(): Set<string> {
  const out = new Set<string>();
  const entries = [process.env.APP_URL || '', ...(process.env.ALLOWED_ORIGINS || '').split(',')];
  for (const raw of entries) {
    const value = raw.trim();
    if (!value) continue;
    const origin = originOf(value);
    if (origin) out.add(origin);
  }
  return out;
}

export function assertSameOrigin(req: Request): void {
  const header = req.headers.get('origin');
  if (!header) return; // SameSite=Lax cookies + CSRF token protect session mutations.
  const allowed = selfOrigins();
  if (allowed.size === 0) {
    throw new ApiError(500, 'CONFIG_ERROR', 'APP_URL 配置无效');
  }
  // 不能拿请求自带的 Host/URL 当「本站」：重绑定攻击里两者都会跟着攻击者的域名变，
  // 同源就等于被绕过。入口必须由 APP_URL / ALLOWED_ORIGINS 显式声明。
  const origin = originOf(header);
  if (!origin || !allowed.has(origin)) {
    throw new ApiError(403, 'ORIGIN_MISMATCH', '请求来源校验失败');
  }
}

export function assertJsonContentType(req: Request): void {
  const ct = req.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
}

interface BodyError {
  code: string;
  message: string;
}

/**
 * 按实际字节数读取请求体。content-length 由客户端声明、不可信，
 * 因此逐块累计，超限立即取消，避免整段大请求体先进内存再判断。
 */
async function readCappedBody(
  req: Request,
  maxBytes: number,
  tooLarge: BodyError,
  unreadable: BodyError
): Promise<Buffer> {
  const fail = (status: number, error: BodyError) => new ApiError(status, error.code, error.message);
  if (!req.body) return Buffer.alloc(0);
  if (Number(req.headers.get('content-length') || '0') > maxBytes) throw fail(413, tooLarge);
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
        throw fail(413, tooLarge);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw fail(400, unreadable);
  }
  return Buffer.concat(chunks, received);
}

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  assertJsonContentType(req);
  const body = await readCappedBody(
    req,
    maxBytes,
    { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
    { code: 'INVALID_JSON', message: 'JSON 格式无效' }
  );
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效');
  }
}

/**
 * 读取 multipart 表单并限制体积。maxBytes 需为「文件大小上限 + multipart 边界余量」。
 */
export async function readMultipartLimited(req: Request, maxBytes: number): Promise<FormData> {
  const contentType = req.headers.get('content-type') || '';
  const body = await readCappedBody(
    req,
    maxBytes,
    { code: 'FILE_TOO_LARGE', message: '上传内容过大' },
    { code: 'INVALID_FORM', message: '上传表单无效' }
  );
  const formReq = new Request(req.url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body
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
