import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const entries = Object.entries(JSON.parse(await readFile(new URL('../src/lib/noto-stickers.json', import.meta.url), 'utf8')));
const destination = new URL('../public/stickers/noto/', import.meta.url);
const sourceLimit = 1_200_000;
const outputLimit = 4 * 1024 * 1024;
const side = 112;
const sharp = (await import('sharp').catch(() => {
  throw new Error('Install the project dependencies, including optional dependencies, before refreshing the stickers.');
})).default;

async function download(codepoint, expectedHash) {
  const url = `https://fonts.gstatic.com/s/e/notoemoji/latest/${codepoint}/512.webp`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.body || !response.ok || response.headers.get('content-type') !== 'image/webp') {
    await response.body?.cancel();
    throw new Error(`Expected an official WebP for ${codepoint}, HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > sourceLimit) throw new Error(`Official image exceeds the size limit: ${codepoint}`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes);
  if (body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WEBP' ||
      createHash('sha256').update(body).digest('hex') !== expectedHash) {
    throw new Error(`Pinned source changed for ${codepoint}. Review the upstream image before updating its SHA-256.`);
  }
  return body;
}

async function convert([id, { codepoint, sha256 }]) {
  if (!/^noto[A-Za-z]+$/.test(id) || !/^[0-9a-f]{4,6}$/.test(codepoint) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Invalid sticker manifest entry: ${id}`);
  }
  const bytes = await download(codepoint, sha256);
  const animation = sharp(bytes, { animated: true });
  const metadata = await animation.metadata();
  if (metadata.format !== 'webp' || metadata.width > 512 || metadata.pageHeight > 512 ||
      metadata.pages < 2 || metadata.pages > 120) {
    throw new Error(`Unexpected WebP dimensions or animation frames: ${id}`);
  }
  const resize = { fit: 'inside', withoutEnlargement: true };
  const first = sharp(bytes);
  const { channels } = await first.stats();
  // Some animations open with a blank frame. Use a visible frame for reduced-motion mode.
  const poster = (channels[3]?.mean ?? 255) < 10 ? sharp(bytes, { page: Math.floor(metadata.pages / 3) }) : first;
  return Promise.all([
    animation.resize(side, side, resize).webp({ quality: 57, effort: 5, minSize: true }).toBuffer()
      .then((data) => [`${id}.webp`, data]),
    poster.resize(side, side, resize).webp({ quality: 76 }).toBuffer()
      .then((data) => [`${id}-still.webp`, data])
  ]);
}

const files = [];
for (let i = 0; i < entries.length; i += 4) {
  files.push(...(await Promise.all(entries.slice(i, i + 4).map(convert))).flat());
}
const total = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
if (total > outputLimit) throw new Error('Web sticker pack exceeds 4 MiB.');
await mkdir(destination, { recursive: true });
await Promise.all(files.map(([name, bytes]) => writeFile(new URL(name, destination), bytes)));
console.log(`Synced ${entries.length} Noto animations and stills (${Math.round(total / 1024)} KiB).`);
