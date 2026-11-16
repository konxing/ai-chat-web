import type { AiProvider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamChatCompletion } from '@/lib/ai';
import { deepSeekCitationUrls, supportsDeepSeekWeb } from '@/lib/deepseek-web';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', () => ({
  decryptProviderKey: () => 'synthetic-test-key',
  capabilitiesOf: () => ['text']
}));
vi.mock('@/lib/ssrf', () => ({
  joinApiPath: (base: string, path: string) => base + path,
  resolveProviderTarget: async (url: string) => ({ url }),
  safeFetch: fetchMock
}));

const provider = { id: 'one', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-flash' } as AiProvider;
const annotation = (url: string) => ({ type: 'url_citation', url_citation: { url } });

function upstream(wire: string, type = 'text/event-stream') {
  fetchMock.mockImplementation(async () => ({
    response: new Response(wire, { headers: { 'content-type': type } }), close: vi.fn()
  }));
}

async function send(input: Omit<Parameters<typeof streamChatCompletion>[0], 'messages'>) {
  const events = [];
  for await (const event of streamChatCompletion({ ...input, messages: [{ role: 'user', content: '今天天气怎么样' }] })) {
    events.push(event);
  }
  return events;
}

describe('DeepSeek native web tools', () => {
  beforeEach(() => fetchMock.mockReset());

  it('declares the selected server-side tool only for the supported official endpoint', async () => {
    upstream('data: [DONE]\n\n');
    await send({ provider, webTool: 'read' });
    await send({ provider, webTool: 'search' });
    await send({ provider });
    await send({ provider: { ...provider, baseUrl: 'https://gateway.example/v1' }, webTool: 'search' });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[2].body).tools)).toEqual([
      [{ type: 'deepseek_read_url' }],
      [{ type: 'deepseek_web_search' }],
      undefined,
      undefined
    ]);
    expect(supportsDeepSeekWeb({ ...provider, modelId: 'deepseek-v4-pro' })).toBe(false);
  });

  it('streams answer text and links without forwarding reasoning or server tool payloads', async () => {
    upstream([
      { choices: [{ delta: { content: '答复', reasoning_content: 'private' } }] },
      { choices: [{ finish_reason: 'stop', delta: {
        server_tool_calls: [{ signature: 'private' }],
        annotations: [annotation('https://example.com/article'), annotation('javascript:test')]
      } }] }
    ].map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n'));
    expect(await send({ provider, webTool: 'search' })).toEqual([
      { type: 'delta', text: '答复' },
      { type: 'citations', citations: ['https://example.com/article'] },
      { type: 'usage' },
      { type: 'done' }
    ]);
  });

  it('rejects in-stream provider errors and handles JSON citations', async () => {
    upstream('data: {"error":{"type":"api_error"}}\n\n');
    await expect(send({ provider, webTool: 'search' })).rejects.toMatchObject({ code: 'AI_WEB_TOOL_ERROR' });
    upstream(JSON.stringify({ choices: [{ message: {
      content: '读到了',
      annotations: [annotation('https://example.com/')]
    } }] }), 'application/json');
    expect(await send({ provider, webTool: 'read' })).toContainEqual({
      type: 'citations', citations: ['https://example.com/']
    });
    expect(deepSeekCitationUrls([annotation('https://user:secret@example.com/'), annotation('not a URL')])).toEqual([]);
  });
});
