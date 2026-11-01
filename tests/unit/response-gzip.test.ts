import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const nodeRequire = createRequire(import.meta.url);
const gzipModule = nodeRequire('../../server-gzip.cjs') as {
  acceptsGzip: (raw: unknown) => boolean;
  attachGzip: (req: http.IncomingMessage, res: http.ServerResponse) => void;
};

const BIG = '<html><body>' + 'A'.repeat(4096) + '</body></html>';
const SMALL = '<p>tiny</p>';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestRaw(
  port: number,
  urlPath: string,
  options: { acceptEncoding?: string; method?: string; range?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers: {
          ...(options.acceptEncoding ? { 'Accept-Encoding': options.acceptEncoding } : {}),
          ...(options.range ? { Range: options.range } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function decoded(res: RawResponse): string {
  return res.headers['content-encoding'] === 'gzip'
    ? zlib.gunzipSync(res.body).toString('utf8')
    : res.body.toString('utf8');
}

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    gzipModule.attachGzip(req, res);
    const path = (req.url || '').split('?')[0];

    if (path === '/set-header') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(BIG);
      return;
    }
    if (path === '/write-head') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(BIG),
        'X-Custom': 'kept'
      });
      res.end(BIG);
      return;
    }
    if (path === '/asset') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(BIG),
        'Accept-Ranges': 'bytes'
      });
      res.end(BIG);
      return;
    }
    if (path === '/small') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(SMALL));
      res.end(SMALL);
      return;
    }
    if (path === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 20);
      return;
    }
    if (path === '/flight') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.write(BIG.slice(0, 2000));
      setTimeout(() => res.end(BIG.slice(2000)), 10);
      return;
    }
    if (path === '/vary') {
      res.setHeader('Vary', 'RSC, Next-Router-State-Tree');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(BIG);
      return;
    }
    if (path === '/prefixed') {
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(BIG);
      return;
    }
    if (path === '/not-found') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(BIG);
      return;
    }
    res.statusCode = 404;
    res.end('no route');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('acceptsGzip', () => {
  it.each([
    ['gzip', true],
    ['br, gzip', true],
    ['gzip;q=0.8', true],
    ['identity, gzip;q=0', false],
    ['gzip;q=0', false],
    ['identity', false],
    ['', false],
    [undefined, false],
    [null, false]
  ])('%s -> %s', (value, expected) => {
    expect(gzipModule.acceptsGzip(value)).toBe(expected);
  });
});

describe('attachGzip', () => {
  it('gzips setHeader-style HTML and keeps the payload intact', async () => {
    const res = await requestRaw(port, '/set-header', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(decoded(res)).toBe(BIG);
    expect(res.body.length).toBeLessThan(Buffer.byteLength(BIG));
  });

  it('rewrites writeHead-supplied headers, dropping Content-Length and adding Vary', async () => {
    const res = await requestRaw(port, '/write-head', { acceptEncoding: 'gzip, deflate'});
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['x-custom']).toBe('kept');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['vary']).toContain('Accept-Encoding');
    expect(decoded(res)).toBe(BIG);
  });

  it('compresses static JS assets', async () => {
    const res = await requestRaw(port, '/asset', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(decoded(res)).toBe(BIG);
  });

  it('skips clients that do not accept gzip', async () => {
    const res = await requestRaw(port, '/set-header', { acceptEncoding: 'identity' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe(BIG);
  });

  it('skips bodies below the size threshold', async () => {
    const res = await requestRaw(port, '/small', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe(SMALL);
  });

  it('never buffers or compresses text/event-stream', async () => {
    const started = Date.now();
    const res = await requestRaw(port, '/stream', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.body.toString('utf8')).toBe('data: one\n\ndata: two\n\n');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps streamed HTML correct across multiple writes', async () => {
    const res = await requestRaw(port, '/flight', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(decoded(res)).toBe(BIG);
  });

  it('appends to an existing Vary instead of replacing it', async () => {
    const res = await requestRaw(port, '/vary', { acceptEncoding: 'gzip' });
    const vary = String(res.headers['vary']);
    expect(vary).toContain('RSC');
    expect(vary).toContain('Next-Router-State-Tree');
    expect(vary.toLowerCase()).toContain('accept-encoding');
    expect(decoded(res)).toBe(BIG);
  });

  it('leaves already encoded responses alone', async () => {
    const res = await requestRaw(port, '/prefixed', { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.body.toString('utf8')).toBe(BIG);
  });

  it('does not compress non-2xx responses', async () => {
    const res = await requestRaw(port, '/not-found', { acceptEncoding: 'gzip' });
    expect(res.status).toBe(404);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe(BIG);
  });

  it('skips HEAD requests and requests carrying Range', async () => {
    const head = await requestRaw(port, '/write-head', { acceptEncoding: 'gzip', method: 'HEAD' });
    expect(head.headers['content-encoding']).toBeUndefined();
    const ranged = await requestRaw(port, '/asset', { acceptEncoding: 'gzip', range: 'bytes=0-99' });
    expect(ranged.headers['content-encoding']).toBeUndefined();
  });
});
