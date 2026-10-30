import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/http';
import { resetEnvCacheForTests } from '@/lib/env';
import { joinApiPath, resolveProviderTarget, safeFetch } from '@/lib/ssrf';

function expectCode(fn: () => Promise<unknown>, code: string) {
  return fn().then(
    () => {
      throw new Error(`expected ${code}, request succeeded`);
    },
    (err) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(code);
    }
  );
}

function usePrivateUrls(allowed: boolean) {
  process.env.ALLOW_PRIVATE_AI_URLS = allowed ? 'true' : 'false';
  resetEnvCacheForTests();
}

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://example.com/' });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }, 2000);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => usePrivateUrls(false));

describe('provider URL validation', () => {
  it('requires http(s) and rejects embedded credentials', async () => {
    await expectCode(() => resolveProviderTarget('ftp://example.com/v1'), 'UNSAFE_URL');
    await expectCode(() => resolveProviderTarget('https://user:pass@example.com/v1'), 'UNSAFE_URL');
    await expectCode(() => resolveProviderTarget('not a url'), 'UNSAFE_URL');
  });

  it('requires HTTPS in production mode', async () => {
    await expectCode(() => resolveProviderTarget('http://127.0.0.1:4010/v1'), 'UNSAFE_URL');
  });

  it('rejects fragments and overlong URLs', async () => {
    await expectCode(() => resolveProviderTarget('https://example.com/v1#secret'), 'UNSAFE_URL');
    await expectCode(() => resolveProviderTarget(`https://example.com/${'a'.repeat(600)}`), 'UNSAFE_URL');
  });

  it('blocks loopback, private, link-local and IPv6 loopback literals', async () => {
    for (const url of [
      'https://127.0.0.1/v1',
      'https://10.0.0.8/v1',
      'https://192.168.1.1/v1',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/v1',
      'https://[fe80::1]/v1',
      'https://localhost/v1',
      'https://api.localhost/v1'
    ]) {
      await expectCode(() => resolveProviderTarget(url), 'UNSAFE_URL');
    }
  });

  it('accepts a private target only when explicitly enabled, for isolated deployments', async () => {
    usePrivateUrls(true);
    const target = await resolveProviderTarget(`${baseUrl}/v1`);
    expect(target.allowPrivate).toBe(true);
    expect(target.addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
    const v6 = await resolveProviderTarget('http://[::1]:4010/v1');
    expect(v6.addresses[0].family).toBe(6);
  });
});

describe('safeFetch', () => {
  it('performs a request with a pinned dispatcher', async () => {
    usePrivateUrls(true);
    const target = await resolveProviderTarget(`${baseUrl}/v1`);
    const { response, close } = await safeFetch(target, joinApiPath(baseUrl, '/models'), {
      method: 'GET',
      timeoutMs: 5000
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string };
    expect(body.object).toBe('list');
    await close();
  });

  it('blocks redirects instead of following them', async () => {
    usePrivateUrls(true);
    const target = await resolveProviderTarget(`${baseUrl}/v1`);
    await expectCode(
      async () => {
        const result = await safeFetch(target, '/redirect', { method: 'GET', timeoutMs: 5000 });
        await result.close();
      },
      'REDIRECT_BLOCKED'
    );
  });

  it('maps timeouts to AI_TIMEOUT', async () => {
    usePrivateUrls(true);
    const target = await resolveProviderTarget(`${baseUrl}/v1`);
    await expectCode(
      async () => {
        const result = await safeFetch(target, '/slow', { method: 'GET', timeoutMs: 200 });
        await result.close();
      },
      'AI_TIMEOUT'
    );
  });
});

describe('joinApiPath', () => {
  it('joins base URLs without duplicating slashes', () => {
    expect(joinApiPath('https://api.example.com/v1', '/models')).toBe('https://api.example.com/v1/models');
    expect(joinApiPath('https://api.example.com/v1/', '/models')).toBe('https://api.example.com/v1/models');
    expect(joinApiPath('https://api.example.com/v1/models', '/models')).toBe(
      'https://api.example.com/v1/models'
    );
    expect(joinApiPath('https://api.example.com', 'models')).toBe('https://api.example.com/models');
  });
});
