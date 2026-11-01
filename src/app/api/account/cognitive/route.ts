import { api, getUserAgent, getRequestIp, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { cognitivePreferencesPatchSchema } from '@/lib/validation';
import { getCognitivePreferences, updateCognitivePreferences } from '@/lib/cognitive/preferences';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    return { preferences: await getCognitivePreferences(user.id) };
  });
}

export async function PATCH(req: Request) {
  return api(async () => {
    const { user } = await requireUser(req);
    const patch = cognitivePreferencesPatchSchema.parse(await readJson(req));
    const before = await getCognitivePreferences(user.id);
    const preferences = await updateCognitivePreferences(user.id, patch);
    // 隐私开关的改动必须可追溯；只写这四个布尔/枚举，不写任何对话内容。
    if (JSON.stringify(before) !== JSON.stringify(preferences)) {
      await writeAudit({
        actorId: user.id,
        actorLabel: user.username,
        action: 'user.cognitive_update',
        targetType: 'user',
        targetId: user.id,
        before,
        after: preferences,
        ip: getRequestIp(req),
        userAgent: getUserAgent(req)
      });
    }
    return { preferences };
  });
}
