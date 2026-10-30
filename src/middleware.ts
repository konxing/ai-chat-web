import { NextResponse, type NextRequest } from 'next/server';

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'" + (isDev ? ' ws: wss:' : ''),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests'])
  ].join('; ');
}

function applySecurityHeaders(response: NextResponse, csp: string) {
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
}

export function middleware(request: NextRequest) {
  const nonce = request.headers.get('x-nonce') || crypto.randomUUID().replaceAll('-', '');
  const csp = buildCsp(nonce);

  const { pathname } = request.nextUrl;
  const protectedPage = pathname === '/chat' || pathname.startsWith('/chat/') || pathname === '/settings';
  if (protectedPage && !request.cookies.has('fac_session')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    const response = NextResponse.redirect(url);
    applySecurityHeaders(response, csp);
    return response;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response, csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
