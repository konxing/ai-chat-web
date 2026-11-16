import { BookOpen, Bot, Brain, Compass, Fingerprint, History, Lightbulb, Lock, Network, Scale, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';

export const SETTINGS_TABS = [
  ['profile', '个人资料', UserRound],
  ['security', '安全与登录', ShieldCheck],
  ['models', '我的模型', Bot],
  ['overview', '个人智能层', Compass],
  ['expression', '表达偏好', SlidersHorizontal],
  ['about', '安全说明', Lock]
] as const;

export const COGNITIVE_DETAIL_TABS = [
  ['memory', '记忆管理', Brain],
  ['policy', '记忆策略', SlidersHorizontal],
  ['timeline', '认知时间线', History],
  ['memoryGraph', '记忆网络', Network],
  ['decisions', '决策记录', Scale],
  ['reflections', 'AI 主动洞察', Lightbulb],
  ['userModel', '用户画像', Fingerprint],
  ['wiki', '主题知识库', BookOpen],
  ['experience', '实践经验库', Lightbulb]
] as const;

export type CognitiveDetailTab = (typeof COGNITIVE_DETAIL_TABS)[number][0];
export type SettingsTab = (typeof SETTINGS_TABS)[number][0] | CognitiveDetailTab;

const TAB_KEYS = new Set<string>([...SETTINGS_TABS, ...COGNITIVE_DETAIL_TABS].map(([tab]) => tab));

export function getSettingsTab(value: string | null): SettingsTab {
  return value && TAB_KEYS.has(value) ? value as SettingsTab : 'profile';
}

export function settingsHref(tab: SettingsTab) {
  return tab === 'profile' ? '/settings' : `/settings?tab=${tab}`;
}
