/* Rotate the AES-256-GCM master key without losing data.
 *
 * Usage:
 *   npm run rotate-keys -- --new-key-id k2027 [--new-key <base64>] [--dry-run]
 *
 * Generates a fresh 32-byte key unless --new-key is supplied, writes it to a
 * private file under ROTATE_KEY_DIR (default: BACKUP_DIR/key-rotation) BEFORE
 * re-encrypting anything, then re-encrypts every encrypted database field and
 * attachment file under the new key. The old key stays readable through
 * MASTER_KEYRING for rollback.
 *
 * The script never edits .env and never prints key material to stdout.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

interface Args {
  newKeyId: string;
  newKey?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let newKeyId = '';
  let newKey: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--new-key-id') newKeyId = argv[++i] || '';
    else if (arg === '--new-key') newKey = argv[++i] || '';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run rotate-keys -- --new-key-id <id> [--new-key <base64>] [--dry-run]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(newKeyId)) {
    throw new Error('--new-key-id must be 1-16 chars: letters, digits, _ or -');
  }
  return { newKeyId, newKey, dryRun };
}

function decodeKey(value: string, label: string): Buffer {
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error(`${label} must decode to exactly 32 bytes`);
  return buf;
}

function keyFileTarget(newKeyId: string): string {
  const dir = process.env.ROTATE_KEY_DIR ||
    path.join(process.env.BACKUP_DIR || './backups', 'key-rotation');
  return path.join(path.resolve(dir), `${newKeyId}.env`);
}

async function writeKeyFile(target: string, newKeyId: string, newKey: string, keyring: string) {
  const body = [
    `# Master key created by rotate-keys at ${new Date().toISOString()}`,
    '# 这是新主密钥的唯一副本：请离线保存，确认无误后删除本文件。',
    `MASTER_KEY_ID=${newKeyId}`,
    `MASTER_KEY=${newKey}`,
    `MASTER_KEYRING=${keyring}`,
    ''
  ].join('\n');
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    // wx：已存在就报错，绝不覆盖可能还在保护着历史数据的旧密钥文件。
    await fs.writeFile(target, body, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `密钥文件已存在：${target}。若这是上次中断留下的密钥，请用 --new-key-id ${newKeyId} --new-key <文件里的 MASTER_KEY> 续跑；` +
          '确认它已作废请先把该文件移走。'
      );
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const oldId = process.env.MASTER_KEY_ID || '';
  const oldKey = process.env.MASTER_KEY || '';
  if (!oldId || !oldKey) throw new Error('MASTER_KEY_ID and MASTER_KEY must be set');
  if (args.newKeyId === oldId) throw new Error('The new key id must differ from the current key id');

  let ring: Record<string, string> = {};
  if (process.env.MASTER_KEYRING?.trim()) {
    ring = JSON.parse(process.env.MASTER_KEYRING) as Record<string, string>;
  }
  if (!ring[oldId]) ring[oldId] = oldKey;
  if (ring[args.newKeyId] && !args.newKey) {
    throw new Error(`MASTER_KEYRING already contains ${args.newKeyId}; pass --new-key to rotate to it deliberately`);
  }

  const newKey = args.newKey || randomBytes(32).toString('base64');
  decodeKey(newKey, 'new key');

  // Install the new key as primary while keeping every old key readable.
  process.env.MASTER_KEY_ID = args.newKeyId;
  process.env.MASTER_KEY = newKey;
  process.env.MASTER_KEYRING = JSON.stringify(ring);
  const nextKeyring = JSON.stringify({ ...ring });

  const { decryptString, encryptString, cipherKeyId, decryptBuffer, encryptBuffer } = await import('../src/lib/crypto');
  const prisma = new PrismaClient();

  const rotateString = (payload: string, aad: string): string | null => {
    if (cipherKeyId(payload) === args.newKeyId) return null;
    return encryptString(decryptString(payload, aad), aad);
  };

  const stats = { chats: 0, messages: 0, providers: 0, attachments: 0, files: 0, skippedFiles: 0, missingFiles: 0, badFiles: 0 };
  let keyFile: string | null = null;

  try {
    console.log(`rotate: ${oldId} -> ${args.newKeyId}${args.dryRun ? ' (dry run)' : ''}`);

    // 先把新密钥落盘，再动任何数据。中途崩溃时，已经改成新密钥的内容必须还有
    // 一处可信副本能解开，否则就是不可恢复的批量数据损失。
    if (!args.dryRun) {
      keyFile = keyFileTarget(args.newKeyId);
      await writeKeyFile(keyFile, args.newKeyId, newKey, nextKeyring);
      console.log(`rotate: 新密钥已写入 ${keyFile}`);
    }

    const chats = await prisma.chat.findMany({ select: { id: true, titleCiphertext: true } });
    for (const chat of chats) {
      const next = rotateString(chat.titleCiphertext, `chat-title:${chat.id}`);
      if (!next) continue;
      if (!args.dryRun) await prisma.chat.update({ where: { id: chat.id }, data: { titleCiphertext: next } });
      stats.chats += 1;
    }

    const messages = await prisma.message.findMany({ select: { id: true, contentCiphertext: true } });
    for (const message of messages) {
      const next = rotateString(message.contentCiphertext, `message:${message.id}`);
      if (!next) continue;
      if (!args.dryRun) {
        await prisma.message.update({ where: { id: message.id }, data: { contentCiphertext: next } });
      }
      stats.messages += 1;
    }

    const providers = await prisma.aiProvider.findMany({ select: { id: true, apiKeyCiphertext: true } });
    for (const provider of providers) {
      const next = rotateString(provider.apiKeyCiphertext, `provider-key:${provider.id}`);
      if (!next) continue;
      if (!args.dryRun) {
        await prisma.aiProvider.update({ where: { id: provider.id }, data: { apiKeyCiphertext: next } });
      }
      stats.providers += 1;
    }

    const attachments = await prisma.attachment.findMany({
      select: {
        id: true,
        storageKey: true,
        originalNameCiphertext: true,
        extractedTextCiphertext: true,
        chunksCiphertext: true
      }
    });
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || './uploads');
    for (const attachment of attachments) {
      const name = rotateString(attachment.originalNameCiphertext, `attachment-name:${attachment.id}`);
      const text = attachment.extractedTextCiphertext
        ? rotateString(attachment.extractedTextCiphertext, `attachment-text:${attachment.id}`)
        : null;
      const chunks = attachment.chunksCiphertext
        ? rotateString(attachment.chunksCiphertext, `attachment-chunks:${attachment.id}`)
        : null;
      if (name || text || chunks) {
        if (!args.dryRun) {
          await prisma.attachment.update({
            where: { id: attachment.id },
            data: {
              ...(name ? { originalNameCiphertext: name } : {}),
              ...(text ? { extractedTextCiphertext: text } : {}),
              ...(chunks ? { chunksCiphertext: chunks } : {})
            }
          });
        }
        stats.attachments += 1;
      }

      const file = path.resolve(uploadRoot, attachment.storageKey);
      if (!file.startsWith(`${uploadRoot}${path.sep}`)) continue;
      let encrypted: Buffer;
      try {
        encrypted = await fs.readFile(file);
      } catch {
        stats.missingFiles += 1;
        console.warn(`rotate: missing attachment file ${attachment.storageKey}`);
        continue;
      }
      if (encrypted.length < 5 || encrypted.subarray(0, 4).toString('ascii') !== 'FAC1') {
        // 单个坏文件不该让整轮轮换在半途停下：它继续用旧密钥可读，旧密钥此刻还在环里。
        stats.badFiles += 1;
        console.warn(`rotate: 跳过无法识别的文件格式 ${attachment.storageKey}`);
        continue;
      }
      const keyIdLen = encrypted[4];
      const keyId = encrypted.subarray(5, 5 + keyIdLen).toString('utf8');
      if (keyId === args.newKeyId) {
        stats.skippedFiles += 1;
        continue;
      }
      const plain = decryptBuffer(encrypted, `file:${attachment.id}`);
      const rotated = encryptBuffer(plain, `file:${attachment.id}`);
      if (!args.dryRun) {
        const tmp = `${file}.rotate-${process.pid}.tmp`;
        await fs.writeFile(tmp, rotated, { mode: 0o600 });
        await fs.rename(tmp, file);
      }
      stats.files += 1;
      plain.fill(0);
    }

    console.log(
      `rotate: ${args.dryRun ? 'would rotate' : 'rotated'} ` +
        `${stats.chats} chats, ${stats.messages} messages, ${stats.providers} provider keys, ` +
        `${stats.attachments} attachment records, ${stats.files} files` +
        `${stats.skippedFiles ? `, ${stats.skippedFiles} files already on new key` : ''}` +
        `${stats.missingFiles ? `, ${stats.missingFiles} missing files` : ''}` +
        `${stats.badFiles ? `, ${stats.badFiles} files skipped (bad format)` : ''}`
    );

    if (args.dryRun) {
      console.log('rotate: dry run complete; nothing was written');
      return;
    }

    console.log('');
    console.log(`✓ 轮换完成。新密钥只写进了 ${keyFile}，不打印到终端：stdout 会进 journald 和 SSH 会话记录。`);
    console.log('  请把这个文件里的三个变量写入密钥管理服务或服务器 .env，然后重启应用。');
    console.log('  Windows 上文件权限是从目录继承的，请另用 icacls 把该目录收紧到当前用户。');
    console.log('');
    console.log('确认服务正常后，可从 MASTER_KEYRING 移除最旧的密钥；在此之前请保留全部旧密钥。');
    console.log(`备份该文件并离线保存后，可以删除 ${keyFile}。`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('rotate failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
