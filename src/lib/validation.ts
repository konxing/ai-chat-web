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

/** 九个字段全部可选：只提交改动的那一项，其余保持原值。 */
export const cognitivePreferencesPatchSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  userModelEnabled: z.boolean().optional(),
  emotionEnabled: z.boolean().optional(),
  associationEnabled: z.boolean().optional(),
  timelineEnabled: z.boolean().optional(),
  reflectionEnabled: z.boolean().optional(),
  decisionMemoryEnabled: z.boolean().optional(),
  adaptiveMemoryEnabled: z.boolean().optional(),
  emotionTransparency: z.enum(['off', 'implicit', 'explicit']).optional()
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

/** 决策的确认/拒绝（任务书 5.5）。动词只有这两个：别的动作在这一版不存在。 */
export const decisionActionSchema = z.object({
  action: z.enum(['confirm', 'reject'])
});

/** 列表的状态过滤白名单，和 DecisionStatus 枚举同词表。 */
export const decisionStatusSchema = z.enum([
  'PENDING_CONFIRM',
  'CONFIRMED',
  'AWAITING_REVIEW',
  'OUTCOME_RECORDED',
  'REJECTED'
]);

/**
 * 批量永久删除的范围。用可辨识联合而不是「chatId 可选」：
 * scope=chat 时 chatId 必须存在，这条约束由类型系统兜住，路由里就不用再补一次判断。
 * 两个值都来自查询串，所以 chatId 只当作不透明字符串收——归属由服务层的 userId 条件决定。
 */
export const memoryPurgeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all'), chatId: z.null().optional() }),
  z.object({
    scope: z.literal('chat'),
    chatId: z.string().trim().min(1, '按会话删除必须指明是哪一次对话').max(64, '会话 id 不合法')
  })
]);
