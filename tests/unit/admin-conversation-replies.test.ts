import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/http';
import { GET, PATCH } from '@/app/api/admin/conversation/route';
import { aiReplyPlanningEnabled, splitDialogueRepliesEnabled } from '@/lib/cognitive/cognitive-flags';

const settings = vi.hoisted(() => new Map<string, { key: string; value: unknown; updatedById: string | null }>());
const auth = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireOwnerPassword: vi.fn()
}));
const findUnique = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => auth);
vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemConfig: {
      findMany: async () => Array.from(settings.values()),
      findUnique,
      upsert: async ({ create }: { create: { key: string; value: unknown; updatedById: string | null } }) => {
        settings.set(create.key, create);
      }
    },
    $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes)
  }
}));
vi.mock('@/lib/cognitive/conversation/prompts/prompt-version', () => ({
  listPromptVersions: async () => [],
  getActivePromptVersion: async () => null
}));

const URL = 'http://127.0.0.1:3000/api/admin/conversation';

function changeSwitch(value: unknown, key = 'splitDialogueReplies') {
  return PATCH(new Request(URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value, confirmPassword: 'owner-password' })
  }));
}

describe('conversation reply presentation switch', () => {
  beforeEach(() => {
    settings.clear();
    auth.requireOwner.mockReset().mockResolvedValue({ user: { id: 'owner' } });
    auth.requireOwnerPassword.mockReset().mockResolvedValue(undefined);
    findUnique.mockReset().mockImplementation(async ({ where }: { where: { key: string } }) => settings.get(where.key) ?? null);
  });

  it('defaults off, then persists changes independently of the main conversation intelligence switch', async () => {
    expect(await splitDialogueRepliesEnabled()).toBe(false);
    expect(await (await GET(new Request(URL))).json()).toMatchObject({ data: { enabled: false, splitDialogueReplies: false } });

    const enabled = await changeSwitch(true);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ data: { enabled: false, splitDialogueReplies: true } });
    expect(auth.requireOwnerPassword).toHaveBeenCalledWith('owner', 'owner-password');
    expect(settings.get('splitDialogueReplies')).toMatchObject({ value: true, updatedById: 'owner' });
    expect(await splitDialogueRepliesEnabled()).toBe(true);
    expect(await (await GET(new Request(URL))).json()).toMatchObject({ data: { splitDialogueReplies: true } });

    expect((await changeSwitch(false)).status).toBe(200);
    expect(await splitDialogueRepliesEnabled()).toBe(false);
  });

  it('rejects a non-owner, failed password confirmation, and non-boolean input', async () => {
    auth.requireOwner.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', '仅超级管理员可执行此操作'));
    expect((await changeSwitch(true)).status).toBe(403);
    expect(auth.requireOwnerPassword).not.toHaveBeenCalled();
    auth.requireOwnerPassword.mockRejectedValueOnce(new ApiError(403, 'PASSWORD_INVALID', '密码错误'));
    expect((await changeSwitch(true)).status).toBe(403);
    expect((await changeSwitch('true')).status).toBe(400);
    expect(settings.has('splitDialogueReplies')).toBe(false);
  });

  it('falls back to off when the setting is unreadable', async () => {
    findUnique.mockRejectedValueOnce(new Error('configuration unavailable'));
    expect(await splitDialogueRepliesEnabled()).toBe(false);
  });

  it('defaults AI planning off and allows only an authenticated owner to toggle it independently', async () => {
    expect(await aiReplyPlanningEnabled()).toBe(false);
    auth.requireOwner.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', '仅超级管理员可执行此操作'));
    expect((await changeSwitch(true, 'aiReplyPlanning')).status).toBe(403);
    auth.requireOwnerPassword.mockRejectedValueOnce(new ApiError(403, 'PASSWORD_INVALID', '密码错误'));
    expect((await changeSwitch(true, 'aiReplyPlanning')).status).toBe(403);
    expect((await changeSwitch('true', 'aiReplyPlanning')).status).toBe(400);
    expect(await aiReplyPlanningEnabled()).toBe(false);
    expect((await changeSwitch(true, 'aiReplyPlanning')).status).toBe(200);
    expect(await aiReplyPlanningEnabled()).toBe(true);
    expect(await (await GET(new Request(URL))).json()).toMatchObject({ data: { enabled: false, aiReplyPlanning: true } });
    expect((await changeSwitch(false, 'aiReplyPlanning')).status).toBe(200);
    expect(await aiReplyPlanningEnabled()).toBe(false);
  });
});
