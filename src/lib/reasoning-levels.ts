export const reasoningLabels = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高'
} as const;

export type ReasoningLevel = keyof typeof reasoningLabels;

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && Object.hasOwn(reasoningLabels, value);
}

export interface ReasoningOptions {
  levels: ReasoningLevel[];
  defaultLevel: ReasoningLevel | null;
}

export function readReasoningOptions(data: unknown, modelId: string): ReasoningOptions {
  const models = (data as { data?: unknown } | null)?.data;
  const model = Array.isArray(models) ? models.find((item) => item?.id === modelId) : null;
  const effort = model?.effort;
  const levels: ReasoningLevel[] = Array.isArray(effort?.supported_levels)
    ? Array.from(new Set<ReasoningLevel>(effort.supported_levels.filter(isReasoningLevel)))
    : [];
  const defaultLevel = levels.includes(effort?.default_level) ? effort.default_level : null;
  return { levels, defaultLevel };
}
