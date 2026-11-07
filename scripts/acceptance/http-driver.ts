/**
 * 验收驱动器：虚拟用户走真实 HTTP 链路的最小客户端。
 *
 * 只封装网站本来就有的接口——登录、建会话、发消息（SSE）、认知读接口、
 * 偏好开关。验收要验的是「正常用户操作路径」，所以这里没有一条后门：
 * 驱动器做不到的事，就是普通用户做不到的事。
 *
 * 注意两个真实约束，场景编排要绕着排：
 * - 登录限流：同一 IP 15 分钟 20 次。多用户跑批要复用会话或拉开时间。
 * - 消息落记忆是后台欠账（CognitiveTask）：done 帧回来之后，
 *   记忆行要等 worker 跑完才出现，判定前要轮询，不能立刻断言。
 */

export interface DriverContext {
  baseUrl: string;
  cookie: string;
  csrf: string;
  username: string;
}

export interface ChatHandle {
  id: string;
  title: string;
  modelId: string | null;
}

export interface SendResult {
  assistantText: string;
  /** done 帧里的引用清单：这一轮真进了提示词的记忆 id。 */
  memoryIds: string[];
  userMessageId: string;
  assistantMessageId: string;
  modelId: string | null;
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

async function request(
  ctx: DriverContext,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { cookie: ctx.cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = ctx.csrf;
  }
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res;
}

async function expectOk(res: Response, action: string): Promise<Response> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${action} 失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res;
}

export async function login(
  baseUrl: string,
  username: string,
  password: string
): Promise<DriverContext> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password })
  });
  await expectOk(res, `登录 ${username}`);
  const setCookies = res.headers.getSetCookie();
  const session = cookieValue(setCookies, 'fac_session');
  const csrf = cookieValue(setCookies, 'fac_csrf');
  if (!session || !csrf) throw new Error(`登录 ${username} 后没有拿到会话 cookie`);
  return { baseUrl, cookie: `fac_session=${session}; fac_csrf=${csrf}`, csrf, username };
}

/** api() 帮助器的统一信封是 { ok:true, data }——所有 JSON 接口都从 data 里取。 */
async function readData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok?: boolean; data?: T };
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

export async function apiGet<T>(ctx: DriverContext, path: string): Promise<T> {
  return readData<T>(await expectOk(await request(ctx, 'GET', path), `GET ${path}`));
}

export async function apiPatch<T>(ctx: DriverContext, path: string, body: unknown): Promise<T> {
  return readData<T>(await expectOk(await request(ctx, 'PATCH', path, body), `PATCH ${path}`));
}

export async function apiPost<T>(ctx: DriverContext, path: string, body: unknown): Promise<T> {
  return readData<T>(await expectOk(await request(ctx, 'POST', path, body), `POST ${path}`));
}

export async function apiDelete<T>(ctx: DriverContext, path: string, body?: unknown): Promise<T> {
  return readData<T>(await expectOk(await request(ctx, 'DELETE', path, body ?? {}), `DELETE ${path}`));
}

export async function createChat(ctx: DriverContext, title?: string): Promise<ChatHandle> {
  const payload = await apiPost<{ chat: ChatHandle }>(ctx, '/api/chats', { title });
  return payload.chat;
}

/** 发一条消息并读完整个 SSE 流；模型那一句的完整正文在返回值里。 */
export async function sendMessage(
  ctx: DriverContext,
  chatId: string,
  content: string
): Promise<SendResult> {
  const res = await expectOk(
    await request(ctx, 'POST', `/api/chats/${chatId}/messages`, { content, attachmentIds: [] }),
    '发送消息'
  );
  const raw = await res.text();
  let assistantText = '';
  let done: Record<string, unknown> | null = null;
  for (const frame of raw.split('\n\n')) {
    const line = frame.trim();
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    if (event.type === 'delta') assistantText += String(event.text ?? '');
    if (event.type === 'done') done = event;
    if (event.type === 'error') {
      throw new Error(`模型轮次失败：${JSON.stringify(event).slice(0, 300)}`);
    }
  }
  if (!done) throw new Error('SSE 流里没有 done 帧');
  const assistant = done.message as { id: string } | undefined;
  const userMessage = done.userMessage as { id: string } | undefined;
  return {
    assistantText,
    memoryIds: (done.memoryIds as string[]) ?? [],
    userMessageId: userMessage?.id ?? '',
    assistantMessageId: assistant?.id ?? '',
    modelId: (done.modelId as string) ?? null
  };
}

/** 八个认知开关全开：虚拟用户的默认姿态是「智能层全部生效」。 */
export async function enableAllCognitiveSwitches(ctx: DriverContext): Promise<void> {
  await apiPatch(ctx, '/api/account/cognitive', {
    memoryEnabled: true,
    userModelEnabled: true,
    emotionEnabled: true,
    associationEnabled: true,
    timelineEnabled: true,
    reflectionEnabled: true,
    decisionMemoryEnabled: true,
    adaptiveMemoryEnabled: true
  });
}
