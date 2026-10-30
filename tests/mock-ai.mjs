/* Local OpenAI-compatible mock used by automated tests.
 * It never contacts the network. API keys are only checked for presence. */
import http from 'node:http';

const PORT = Number(process.env.MOCK_AI_PORT || 4010);
const EXPECTED_KEY = process.env.MOCK_AI_KEY || '';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function authOk(req) {
  const header = req.headers.authorization || '';
  if (!EXPECTED_KEY) return header.startsWith('Bearer ');
  return header === `Bearer ${EXPECTED_KEY}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.endsWith('/models') && req.method === 'GET') {
    if (!authOk(req)) return json(res, 401, { error: { message: 'bad key' } });
    return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
  }

  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    if (!authOk(req)) return json(res, 401, { error: { message: 'bad key' } });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return json(res, 400, { error: { message: 'invalid json' } });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((p) => p.text || '').join(' ')
          : '';
    const reply = `MOCK_REPLY: ${text || '(empty)'}`;

    if (!body.stream) {
      return json(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const parts = reply.match(/.{1,12}/g) || [''];
    for (const part of parts) {
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          model: body.model || 'mock-model',
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }]
        })}\n\n`
      );
      await new Promise((r) => setTimeout(r, 15));
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        model: body.model || 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: parts.length, total_tokens: 7 + parts.length }
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (url.pathname.endsWith('/audio/transcriptions') && req.method === 'POST') {
    if (!authOk(req)) return json(res, 401, { error: { message: 'bad key' } });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return json(res, 400, { error: { message: 'empty body' } });
    return json(res, 200, { text: 'MOCK_TRANSCRIPT' });
  }

  return json(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-ai listening on ${PORT}`);
});
