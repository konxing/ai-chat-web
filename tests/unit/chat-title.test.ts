import { describe, expect, it } from 'vitest';
import type { Chat } from '@prisma/client';
import { encryptString } from '@/lib/crypto';
import { deriveGeneratedTitle } from '@/lib/chats';

function chatWithTitle(title: string): Chat {
  const id = 'chat-1';
  return {
    id,
    userId: 'user-1',
    titleCiphertext: encryptString(title, `chat-title:${id}`),
    modelProviderId: null,
    modelId: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

describe('deriveGeneratedTitle', () => {
  it('derives a title from the first message of an untitled chat', () => {
    expect(deriveGeneratedTitle(chatWithTitle('新对话'), '这周去不去 海边\n钓鱼？')).toBe('这周去不去 海边 钓鱼？');
  });

  it('leaves a chat the user already renamed alone', () => {
    expect(deriveGeneratedTitle(chatWithTitle('周末计划'), '随便一句')).toBeNull();
  });

  it('collapses code blocks and whitespace, then caps at 40 characters', () => {
    const title = deriveGeneratedTitle(chatWithTitle('新对话'), '```js\nconsole.log(1)\n```\n' + '长'.repeat(80));
    expect(title).toHaveLength(40);
    expect(title).toContain('代码');
  });

  it('returns null when nothing readable survives the trim', () => {
    expect(deriveGeneratedTitle(chatWithTitle('新对话'), '   \n\t  ')).toBeNull();
    expect(deriveGeneratedTitle(chatWithTitle('新对话'), '```\nxxxx\n```')).toBe('代码');
  });
});
