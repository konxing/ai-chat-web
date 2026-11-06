import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(32, '用户名最多 32 个字符')
  .regex(/^[A-Za-z0-9_\u4e00-\u9fa5-]+$/, '用户名只能包含字母、数字、下划线、中文或连字符');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, '邮箱过长')
  .email('邮箱格式无效');

export const passwordSchema = z.string().min(10, '密码至少 10 个字符').max(128, '密码过长');

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, '请输入用户名或邮箱').max(254),
  password: z.string().min(1, '请输入密码').max(200)
});

export const registerRequestSchema = z.object({
  username: usernameSchema,
  email: emailSchema
});

export const registerVerifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, '验证码为 6 位数字'),
  password: passwordSchema
});

export const forgotPasswordSchema = z.object({
  email: emailSchema
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, '验证码为 6 位数字'),
  password: passwordSchema
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().max(64).optional().nullable()
});

export const emailChangeRequestSchema = z.object({
  newEmail: emailSchema,
  password: z.string().min(1).max(200)
});

export const emailChangeVerifySchema = z.object({
  newEmail: emailSchema,
  code: z.string().regex(/^\d{6}$/, '验证码为 6 位数字')
});

export const chatCreateSchema = z.object({
  providerId: z.string().uuid().optional(),
  title: z.string().trim().max(60).optional()
});

export const chatRenameSchema = z.object({
  title: z.string().trim().min(1).max(60)
});

export const chatModelSchema = z.object({
  providerId: z.string().uuid()
});

export const sendMessageSchema = z.object({
  content: z.string().max(50_000).default(''),
  attachmentIds: z.array(z.string().uuid()).max(15, '一条消息最多 15 个附件').default([])
});

export const ipRuleInputSchema = z.object({
  cidr: z.string().trim().min(1).max(64),
  label: z.string().trim().max(128).optional().nullable(),
  enabled: z.boolean().default(true),
  expiresAt: z.string().datetime().optional().nullable()
});

export const ipRuleUpdateSchema = z.object({
  label: z.string().trim().max(128).optional().nullable(),
  enabled: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  confirmPassword: z.string().min(1).max(200).optional()
});

export const adminUserUpdateSchema = z.object({
  displayName: z.string().trim().max(64).optional().nullable(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  confirmPassword: z.string().min(1).max(200).optional()
});

export const adminConfigSchema = z.object({
  siteName: z.string().trim().min(1).max(80).optional(),
  registrationOpen: z.boolean().optional(),
  defaultProviderId: z.string().uuid().nullable().optional(),
  maxUploadMB: z.number().int().min(1).max(320).optional(),
  maintenanceNotice: z.string().max(500).optional()
});

/**
 * 十一个字段全部可选：只提交改动的那一项，其余保持原值。
 *
 * memoryWritePaused 和那八个开关走同一个口子，但它不是第九个模块开关：
 * 模块开关管「这个模块要不要工作」，关掉后读侧也不注入；这一列只管「还记不记新东西」，
 * 已存的记忆照常带入对话。之所以不拆成第二个接口，是因为它和开关改的是同一行 CognitivePreference，
 * 拆两个入口只是多一条能改同一行的路——边界靠 preferences.ts 里那条「不进 COGNITIVE_FLAGS」的断言守，
 * 不靠多一个路由。
 *
 * reflectionCooldown（6.6 的可配置冷却）同理走这个口子，但它挡的是另一类值：这里用三档白名单而不是
 * 一个放宽的整数，因为 `0` 或 `'hourly'` 一旦过库，后台那趟 O(n²) 聚类就等于被人手动调成「每分钟重算
 * 整个记忆池」，而任务书给的节奏下限本来就是一天。一列的取值域要和它的语义一样窄。
 */
export const cognitivePreferencesPatchSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  userModelEnabled: z.boolean().optional(),
  emotionEnabled: z.boolean().optional(),
  associationEnabled: z.boolean().optional(),
  timelineEnabled: z.boolean().optional(),
  reflectionEnabled: z.boolean().optional(),
  decisionMemoryEnabled: z.boolean().optional(),
  adaptiveMemoryEnabled: z.boolean().optional(),
  emotionTransparency: z.enum(['off', 'implicit', 'explicit']).optional(),
  reflectionCooldown: z.enum(['daily', 'weekly', 'monthly']).optional(),
  memoryWritePaused: z.boolean().optional()
});

const MEMORY_CONTEXT_VALUES = [
  'general',
  'technicalProject',
  'learning',
  'personalGoal',
  'personalReflection',
  'emotionalSupport',
  'decisionMaking'
] as const;

/**
 * 记忆策略的改动一次只针对一个情境：patch 里的字段仍然全部可选，
 * 没提交的保持原值——否则改保留期会把「允许记哪些类型」顺手重置。
 */
export const memoryPolicyPatchSchema = z.object({
  context: z.enum(MEMORY_CONTEXT_VALUES),
  patch: z.object({
    allowPersistence: z.boolean().optional(),
    allowedMemoryTypes: z
      .array(z.enum(['fact', 'preference', 'goal', 'project', 'decision', 'emotion']))
      .max(6)
      .optional(),
    requireConfirmation: z.boolean().optional(),
    retention: z.enum(['forever', 'untilSuperseded', 'days30', 'days90', 'sessionOnly']).optional(),
    allowUserProfile: z.boolean().optional(),
    allowReflection: z.boolean().optional(),
    allowAssociation: z.boolean().optional()
  })
});

export const memoryPolicyResetSchema = z.object({
  context: z.enum(MEMORY_CONTEXT_VALUES)
});

/**
 * 用户亲手改记忆：正文和理由都必填，也不许只有空格。
 * 请求体里没有 origin 这个字段——那是服务端定死的「用户已确认」，
 * 留着口子就等于允许把系统推断伪装成用户亲口说过。
 * 两个上限跟服务层（记忆正文 1000 字、理由 500 字）保持一致，服务层还会再校一遍。
 */
export const memoryReviseSchema = z.object({
  content: z.string().trim().min(1, '记忆正文不能为空').max(1000, '记忆正文不能超过 1000 字'),
  reason: z.string().trim().min(1, '改记忆要写明理由').max(500, '理由不能超过 500 字')
});

export const memoryRetractSchema = z.object({
  reason: z.string().trim().min(1, '撤回记忆要写明理由').max(500, '理由不能超过 500 字')
});

/**
 * 画像条目的写入（任务书 8.2）。
 *
 * 请求体里**没有 confirmedAt**，而且不许有：确认时间是服务在 create 那一刻自己盖章的
 * （src/lib/cognitive/user-profile.ts 的 ProfileEntryInput 根本没有这个字段）。
 * 白名单不收，从后门递进来的「我去年就确认过了」就变成用户自己能编的一列。
 *
 * 正文 1000 字、来源各 20 条这两个数字和服务层同源但各写一遍——validation.ts 不 import 认知层模块，
 * 它是这条依赖链的叶子（同 reflectionActionSchema 的理由）。数字改一边忘改另一边时，
 * 严格的那一边先报错，不会静默放宽；tests/unit/cognitive-profile-route.test.ts 钉的是 1000 字整条收、
 * 1001 字拒，两边各跑一次都跑得到。
 */
const profileSourceIdsSchema = z.array(z.string().trim().min(1, '来源 id 不能为空').max(64, '来源 id 不合法')).max(
  20,
  '来源最多 20 条'
);

export const profileEntrySchema = z.object({
  content: z.string().trim().min(1, '画像正文不能为空').max(1000, '画像正文不能超过 1000 字，请拆成多条'),
  sourceMemoryIds: profileSourceIdsSchema.optional(),
  sourceReflectionIds: profileSourceIdsSchema.optional()
});

/** 改画像正文：只有正文这一扇门。来源是「你确认那一刻的依据」，改一个字都不许顺带动它。 */
export const profileReviseSchema = z.object({
  content: z.string().trim().min(1, '画像正文不能为空').max(1000, '画像正文不能超过 1000 字，请拆成多条')
});

/** 决策的确认/拒绝（任务书 5.5）。动词只有这两个：别的动作在这一版不存在。 */
export const decisionActionSchema = z.object({
  action: z.enum(['confirm', 'reject'])
});

/** 结果链接的确认/解除（任务书 5.3）。候选才允许动，状态机在服务层再兜一次。 */
export const outcomeLinkSchema = z.object({
  action: z.enum(['link', 'detach'])
});

/** 列表的状态过滤白名单，和 DecisionStatus 枚举同词表。 */
export const decisionStatusSchema = z.enum([
  'PENDING_CONFIRM',
  'CONFIRMED',
  'AWAITING_REVIEW',
  'OUTCOME_RECORDED',
  'REJECTED'
]);

/** 洞察列表的状态过滤白名单，和 ReflectionStatus 枚举同词表。 */
export const reflectionStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EDITED',
  'SNOOZED',
  'EXPIRED'
]);

/**
 * 洞察的四个动作（任务书 6.4 的状态机）。用可辨识联合：edit 必须带齐两段文字、snooze 必须带天数，
 * 缺哪一样都是 400，而不是让服务层去猜用户按了哪个按钮。
 * 3/7/30 这一组数字的领域真相是 reflections.ts 的 ReflectionSnoozeDays（服务层只接这三个字面量）；
 * 这里再写一遍是因为 validation.ts 不 import 认知层模块，它是这条依赖链的叶子。
 * 长度上限同口径：正文不许比系统写出来的还短，否则「改一下」会把长原话截断成另一句话。
 */
export const reflectionActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('reject') }),
  z.object({
    action: z.literal('edit'),
    title: z.string().trim().min(1, '改标题不能留空').max(200, '标题不能超过 200 字'),
    body: z.string().trim().min(1, '改正文不能留空').max(4000, '正文不能超过 4000 字')
  }),
  z.object({
    action: z.literal('snooze'),
    days: z.union([z.literal(3), z.literal(7), z.literal(30)])
  })
]);

/**
 * 待确认候选的两个动作（任务书 1.2 的 ASK_CONFIRM）。只有两个，而且没有「稍后再问」：
 * 一句没被答过的话留在门口已经是负担，再给它一个「先搁着」的档位，这屏就长成了一个
 * 谁都不肯当场回答的收件箱。淘汰按最旧的 PENDING 走（服务层那 200 条上限），不需要第三个按钮。
 */
export const memoryCandidateActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('reject') })
]);

/** 候选状态过滤的白名单，用应用层小写词表——这一屏的 DTO 就是这个形状，不逼界面再翻一次枚举。 */
export const memoryCandidateStatusSchema = z.enum(['pending', 'confirmed', 'rejected']);

/**
 * 批量永久删除的范围。用可辨识联合而不是「chatId 可选」：
 * scope=chat 时 chatId 必须存在，这条约束由类型系统兜住，路由里就不用再补一次判断。
 * 两个值都来自查询串，所以 chatId 只当作不透明字符串收——归属由服务层的 userId 条件决定。
 *
 * scope=context 收的是七个情境名之一（任务书 7.3 的「忘记某个主题」）：
 * 这里只认枚举，不认自由文本。「主题」在库里就是 MemoryItem.context 这一列，
 * 放一个任意字符串进来，界面就能把「忘记主题」过一次「where context = 用户现编的词」，
 * 那既不是七个情境中的任何一个，也说不清到底删了什么。
 */
export const memoryPurgeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all'), chatId: z.null().optional() }),
  z.object({
    scope: z.literal('chat'),
    chatId: z.string().trim().min(1, '按会话删除必须指明是哪一次对话').max(64, '会话 id 不合法')
  }),
  z.object({
    scope: z.literal('context'),
    context: z.enum(MEMORY_CONTEXT_VALUES)
  })
]);
