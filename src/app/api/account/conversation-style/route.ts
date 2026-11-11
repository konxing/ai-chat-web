import { z } from 'zod';
import { CHAT_PERSONA_IDS } from '@/lib/chat-personas';
import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getConversationStyle, setConversationStyle, getConversationStyleMeta, resetConversationStyle } from '@/lib/cognitive/conversation/style/style-profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const styleSchema = z.object({
  persona: z.enum(CHAT_PERSONA_IDS).optional(),
  knowledgeDepth: z.enum(['low', 'medium', 'high']).optional(),
  naturalness: z.enum(['low', 'medium', 'high']).optional(),
  structure: z.enum(['minimal', 'dynamic', 'rich']).optional(),
  proactivity: z.enum(['low', 'medium', 'high']).optional(),
  restraint: z.enum(['low', 'medium', 'high']).optional(),
  length: z.enum(['short', 'dynamic', 'long']).optional(),
  factuality: z.enum(['standard', 'high']).optional()
});

/** 普通用户查看/修改自己的表达偏好（严格隔离，只动本人）。 */
export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const [style, meta] = await Promise.all([getConversationStyle(user.id), getConversationStyleMeta(user.id)]);
    return { style, meta };
  });
}

export async function PUT(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const patch = styleSchema.parse(await readJson(req));
    return { style: await setConversationStyle(user.id, patch, 'user') };
  });
}

/** P3：恢复默认表达偏好（撤销长期偏好）。 */
export async function DELETE(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { style: await resetConversationStyle(user.id) };
  });
}
