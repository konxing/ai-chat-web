import { mkdir, readFile, writeFile } from 'node:fs/promises';

const upstream = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/99701e07d3d1fe1bdbcdb14964547f0fd592966f/2D/svg/';
const manifest = new URL('../src/lib/noto-reactions.json', import.meta.url);
const destination = new URL('../public/stickers/reactions/', import.meta.url);
const sourceLimit = 96 * 1024;
const outputLimit = 1024 * 1024;
const side = 112;
const entries = Object.entries(JSON.parse(await readFile(manifest, 'utf8')));
const sharp = (await import('sharp').catch(() => {
  throw new Error('Install project dependencies including optional dependencies before refreshing the stickers.');
})).default;

async function convert([id, { codepoint }]) {
  if (!/^noto[A-Za-z]+$/.test(id) || !/^[0-9a-f]{4,6}(?:_[0-9a-f]{4,6}){0,3}$/.test(codepoint)) {
    throw new Error(`Invalid Noto reaction entry: ${id}`);
  }
  const response = await fetch(new URL(`emoji_u${codepoint}.svg`, upstream), {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Expected official Noto artwork for ${id}, HTTP ${response.status}.`);
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > sourceLimit) throw new Error(`Noto SVG exceeds its size limit: ${id}`);
    chunks.push(chunk);
  }
  const image = sharp(Buffer.concat(chunks, size), { limitInputPixels: 262_144 });
  const { format } = await image.metadata();
  if (format !== 'svg') throw new Error(`Unexpected Noto image format: ${id}`);
  const bytes = await image.resize(side, side, { fit: 'inside' }).webp({ quality: 82, effort: 5 }).toBuffer();
  return [`${id}.webp`, bytes];
}

const files = [];
for (let index = 0; index < entries.length; index += 12) {
  files.push(...await Promise.all(entries.slice(index, index + 12).map(convert)));
}
const total = files.reduce((sum, [, bytes]) => sum + bytes.length, 0);
if (total > outputLimit) throw new Error('Noto reaction pack exceeds 1 MiB.');
await mkdir(destination, { recursive: true });
await Promise.all(files.map(([name, bytes]) => writeFile(new URL(name, destination), bytes)));
console.log(`Synced ${files.length} Noto reactions (${Math.round(total / 1024)} KiB).`);
