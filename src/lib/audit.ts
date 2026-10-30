import type { AuditStatus, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { log } from './logger';

const SENSITIVE_KEY = /pass(word)?|secret|api[-_]?key|token|cipher|hash|private[-_]?key|authorization|session|cookie/i;

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactForAudit(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditInput {
  actorId?: string | null;
  actorLabel: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  status?: AuditStatus;
  error?: string | null;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel.slice(0, 128),
        action: input.action.slice(0, 128),
        targetType: input.targetType?.slice(0, 64) ?? null,
        targetId: input.targetId?.slice(0, 64) ?? null,
        before: (redactForAudit(input.before) ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (redactForAudit(input.after) ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        status: input.status ?? 'SUCCESS',
        error: input.error?.slice(0, 512) ?? null
      }
    });
  } catch (err) {
    // Audit failure must never break the primary operation, but must be visible.
    log.error('audit.write_failed', {
      action: input.action,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
