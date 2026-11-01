'use strict';

/**
 * Dependency-free gzip for the custom server, so the runtime image needs
 * nothing beyond Node. Decision is made once, before Node serializes the
 * header block, and covers both callers that use setHeader() and callers that
 * pass headers straight into writeHead().
 */

const zlib = require('node:zlib');

const MIN_BYTES = 1024;
const LEVEL = 6;

// woff/woff2 and image/video bodies already carry their own compression, so
// gzipping them only costs CPU. text/event-stream is absent on purpose: an SSE
// body must reach the browser token by token.
const COMPRESSIBLE = new Set([
  'text/html',
  'text/plain',
  'text/css',
  'text/xml',
  'text/javascript',
  'text/calendar',
  'text/vtt',
  'application/javascript',
  'application/ecmascript',
  'application/json',
  'application/manifest+json',
  'application/ld+json',
  'application/schema+json',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'image/svg+xml',
  'font/ttf',
  'font/otf',
  'application/vnd.ms-fontobject'
]);

function first(values) {
  return Array.isArray(values) ? values[0] : values;
}

function pick(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function typeOf(value) {
  const raw = first(value);
  if (!raw) return '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

function acceptsGzip(raw) {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || !value) return false;
  for (const part of value.split(',')) {
    const bits = part.trim().toLowerCase().split(';');
    if (bits[0].trim() !== 'gzip') continue;
    const q = bits.find((bit) => bit.trim().startsWith('q='));
    if (!q) return true;
    const weight = Number(q.trim().slice(2));
    return Number.isFinite(weight) ? weight > 0 : true;
  }
  return false;
}

function varyWith(existing) {
  const raw = Array.isArray(existing) ? existing.join(',') : existing;
  const parts = String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === 'accept-encoding')) {
    parts.push('Accept-Encoding');
  }
  return parts.join(', ');
}

function attachGzip(req, res) {
  const clientWantsGzip = acceptsGzip(req.headers['accept-encoding']);

  const rawWrite = res.write.bind(res);
  const rawEnd = res.end.bind(res);
  const rawWriteHead = res.writeHead.bind(res);

  let mode = null;
  let stream = null;
  let closed = false;
  let headFrozen = false;
  const finishers = [];

  function compressible(explicit, status) {
    if (!clientWantsGzip) return false;
    if (req.method === 'HEAD' || req.headers.range) return false;
    if (res.headersSent) return false;
    if (status < 200 || status >= 300 || status === 204 || status === 206) return false;
    if (first(pick(explicit, 'content-encoding')) || res.getHeader('Content-Encoding')) return false;
    if (first(pick(explicit, 'upgrade')) || res.getHeader('Upgrade')) return false;
    const type = typeOf(pick(explicit, 'content-type') || res.getHeader('Content-Type'));
    if (!COMPRESSIBLE.has(type)) return false;
    const declared = pick(explicit, 'content-length');
    const length = Number(declared !== undefined ? declared : res.getHeader('Content-Length'));
    if (Number.isFinite(length) && length >= 0 && length < MIN_BYTES) return false;
    return true;
  }

  function decide(explicit, status) {
    if (!mode) mode = compressible(explicit || {}, status) ? 'gzip' : 'off';
    return mode;
  }

  function ensureStream() {
    if (stream) return;
    // After writeHead() Node has already serialized the header block, so the
    // gzip headers went in through the rebuilt writeHead arguments instead.
    if (!headFrozen) {
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      res.setHeader('Vary', varyWith(res.getHeader('Vary')));
    }

    stream = zlib.createGzip({ level: LEVEL });
    stream.on('data', (chunk) => {
      if (!rawWrite(chunk)) stream.pause();
    });
    stream.on('error', () => {
      stream = null;
      res.destroy();
    });
    stream.on('end', () => {
      res.on('finish', runFinishers);
      rawEnd();
    });
    res.on('drain', () => {
      if (stream) stream.resume();
    });
  }

  function runFinishers() {
    if (closed) return;
    closed = true;
    while (finishers.length) finishers.shift()();
  }

  res.writeHead = function patchedWriteHead() {
    const args = Array.prototype.slice.call(arguments);
    const headersIndex = args.findIndex((arg) => arg && typeof arg === 'object');
    const source = headersIndex === -1 ? {} : args[headersIndex];
    const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
    headFrozen = true;

    if (decide(source, status) !== 'gzip') {
      return rawWriteHead.apply(res, args);
    }

    const merged = Object.assign({}, source);
    for (const key of Object.keys(merged)) {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'content-encoding' || lower === 'vary') {
        delete merged[key];
      }
    }
    merged['Content-Encoding'] = 'gzip';
    merged['Vary'] = varyWith(pick(source, 'vary') || res.getHeader('Vary'));

    if (headersIndex === -1) args.push(merged);
    else args[headersIndex] = merged;
    return rawWriteHead.apply(res, args);
  };

  res.write = function patchedWrite() {
    const args = Array.prototype.slice.call(arguments);
    const chunk = args[0];
    const encoding = typeof args[1] === 'string' ? args[1] : undefined;
    const callback = typeof args[1] === 'function' ? args[1] : typeof args[2] === 'function' ? args[2] : undefined;

    if (decide({}, res.statusCode) !== 'gzip') return rawWrite.apply(res, args);
    ensureStream();
    return stream.write(chunk, encoding, callback);
  };

  res.end = function patchedEnd() {
    const args = Array.prototype.slice.call(arguments);
    let chunk = args[0];
    let encoding;
    let callback;
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof args[1] === 'function') {
      callback = args[1];
    } else {
      encoding = typeof args[1] === 'string' ? args[1] : undefined;
      callback = typeof args[2] === 'function' ? args[2] : undefined;
    }

    if (decide({}, res.statusCode) !== 'gzip') return rawEnd.apply(res, args);
    ensureStream();
    if (callback) finishers.push(callback);
    if (chunk === undefined || chunk === null || chunk === '') stream.end();
    else stream.end(chunk, encoding);
    return res;
  };

  // Anything still in flight when the socket dies must not leak callbacks.
  res.on('close', runFinishers);
}

module.exports = { acceptsGzip, attachGzip, COMPRESSIBLE };
