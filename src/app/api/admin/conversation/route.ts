import { z } from 'zod';
import { api, readJson, ApiError } from '@/lib/http';
import { requireOwner, requireOwnerPassword } from '@/lib/auth';
import { getSystemSettings, updateSystemSettings } from '@/lib/config';
import {
  listPromptVersions,
  getActivePromptVersion,
  addCandidatePromptVersion,
  activatePromptVersion
} from '@/lib/cognitive/conversation/prompts/prompt-version';
import { DEFAULT_CONVERSATION_STYLE } from '@/lib/cognitive/conversation/core/conversation-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** OWNER 对话智能设置 + Prompt Inspector 数据。 */
export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    const settings = await getSystemSettings();
    const [versions, active] = await Promise.all([listPromptVersions(), getActivePromptVersion()]);
    return {
      enabled: settings.conversationLayerEnabled,
      defaultStyle: DEFAULT_CONVERSATION_STYLE,
      versions,
      activeVersion: active?.version ?? null
    };
  });
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  confirmPassword: z.string().min(1)
});

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = patchSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    const settings = await updateSystemSettings(
      body.enabled === undefined ? {} : { conversationLayerEnabled: body.enabled },
      user.id
    );
    return { enabled: settings.conversationLayerEnabled };
  });
}

const postSchema = z.object({
  action: z.enum(['candidate', 'activate']),
  content: z.string().min(1).optional(),
  id: z.string().optional(),
  confirmPassword: z.string().min(1)
});

/** 新增候选版本（不生效）或激活/回滚某版本。候选须经评测才能激活。 */
export async function POST(req: Request) {
  return api(async () => {
    const { user } = await requireOwner(req);
    const body = postSchema.parse(await readJson(req));
    await requireOwnerPassword(user.id, body.confirmPassword);
    if (body.action === 'candidate') {
      if (!body.content) throw new ApiError(400, 'CONTENT_REQUIRED', '候选版本内容不能为空');
      const v = await addCandidatePromptVersion({ content: body.content });
      return { version: v };
    }
    if (!body.id) throw new ApiError(400, 'ID_REQUIRED', '激活版本需要 id');
    const v = await activatePromptVersion(body.id);
    return { version: v };
  });
}
