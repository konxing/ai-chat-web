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
  attachmentIds: z.array(z.string().uuid()).max(12).default([])
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
  maxUploadMB: z.number().int().min(1).max(100).optional(),
  maintenanceNotice: z.string().max(500).optional()
});
