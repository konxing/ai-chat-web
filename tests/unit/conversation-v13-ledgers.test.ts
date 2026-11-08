import { describe, expect, it } from 'vitest';
import {
  classifyRepair, buildRepairLedger, currentRepairEntry,
  buildActiveConstraints, buildIntent, buildTopicStack, REPAIR_TTL_TURNS
} from '@/lib/cognitive/conversation/state/dialogue-ledgers';
import { buildConversationState } from '@/lib/cognitive/conversation/state/conversation-state';
import { understandDialogue } from '@/lib/cognitive/conversation/understanding/dialogue-act';
import { selectResponseAct } from '@/lib/cognitive/conversation/planning/response-act';

describe('B1 修复账本：真纠正 vs 正常追问', () => {
  it('"再深入点" 不记为 AI 失败', () => {
    expect(classifyRepair('再深入点').isRepair).toBe(false);
    expect(classifyRepair('再说说').isRepair).toBe(false);
    expect(classifyRepair('继续').isRepair).toBe(false);
  });

  it('"我不是来排查，我就想聊两句" → INTENT 纠正，期待不再推排障', () => {
    const c = classifyRepair('我不是来排查，我就想聊两句。');
    expect(c.isRepair).toBe(true);
    expect(c.type).toBe('INTENT');
    expect(c.confidence).toBe('explicit');
    expect(c.correctedExpectation).toContain('不再推送排障');
  });

  it('事实纠正 / 风格纠正 / 话题转移分类', () => {
    expect(classifyRepair('年份不对，实际上是 1969。').type).toBe('FACT');
    expect(classifyRepair('太机械了，别这么官方。').type).toBe('STYLE');
    expect(classifyRepair('换个话题，聊点别的。').type).toBe('TOPIC');
  });

  it('跨轮：纠正后 TTL 内仍活跃，之后再提 Bug 不自动回归排障', () => {
    const recent = [
      { role: 'user' as const, content: '今天那个 Bug 搞得心烦。' },
      { role: 'assistant' as const, content: '我给你几个排障步骤。' },
      { role: 'user' as const, content: '我不是来排查，我就想聊两句。' },
      { role: 'assistant' as const, content: '好，不排查。想从哪说起？' }
    ];
    // 当前轮再提 Bug（非纠正），修复账本仍在 TTL 内 → 保留"不推排障"期待。
    const ledger = buildRepairLedger(recent, '那个 Bug 还是没好。');
    const intent = ledger.find((e) => e.type === 'INTENT');
    expect(intent).toBeDefined();
    expect(intent!.correctedExpectation).toContain('不再推送排障');
    expect(currentRepairEntry(ledger, recent.length)).toBeNull(); // 当前轮本身不是纠正
  });

  it('TTL 过期：超出存活轮数后条目失效', () => {
    const recent = [{ role: 'user' as const, content: '你理解错了。' }];
    // 当前轮索引远超 TTL。
    const filler = Array.from({ length: REPAIR_TTL_TURNS + 2 }, (_, i) => ({ role: 'assistant' as const, content: ` filler ${i}` }));
    const ledger = buildRepairLedger([...recent, ...filler], '嗯');
    expect(ledger.find((e) => e.type === 'INTENT')).toBeUndefined();
  });
});

describe('B3 意图与约束账本', () => {
  it('"这次不要列点" → THIS_TURN，不写 GLOBAL', () => {
    const cs = buildActiveConstraints([], '这次不要列点。');
    expect(cs).toHaveLength(1);
    expect(cs[0].scope).toBe('THIS_TURN');
    expect(cs[0].priority).toBe('explicit_user');
  });

  it('THIS_TURN 跨主题后过期，不污染下一轮', () => {
    const recent = [
      { role: 'user' as const, content: '这次不要列点。' },
      { role: 'assistant' as const, content: '好的。' }
    ];
    const cs = buildActiveConstraints(recent, '为什么天空是蓝色的？');
    expect(cs.find((c) => c.content === '不使用列表/分点')).toBeUndefined();
  });

  it('"以后技术问题先讲原理" → GLOBAL_CONFIRMED（持久化由授权开关另行门控）', () => {
    const cs = buildActiveConstraints([], '以后技术问题先讲原理。');
    const c = cs.find((x) => x.content === '优先讨论原理');
    expect(c).toBeDefined();
    expect(c!.scope).toBe('GLOBAL_CONFIRMED');
  });

  it('自然语言撤销："恢复原来的风格" 使先前约束失效', () => {
    const recent = [
      { role: 'user' as const, content: '以后回答简短些。' },
      { role: 'assistant' as const, content: '好。' }
    ];
    const cs = buildActiveConstraints(recent, '还是恢复原来的风格吧。');
    expect(cs.find((c) => c.content === '回答简短、先给结论')).toBeUndefined();
  });

  it('改口换话题：结束旧会话约束', () => {
    const recent = [
      { role: 'user' as const, content: '只讨论原理。' },
      { role: 'assistant' as const, content: '好。' }
    ];
    const cs = buildActiveConstraints(recent, '刚才那个不用展开，换个话题。');
    expect(cs.find((c) => c.content === '优先讨论原理' && c.scope === 'THIS_SESSION')).toBeUndefined();
  });

  it('硬约束只来自用户话语：助手消息里的"不要列点"不进账本', () => {
    const recent = [{ role: 'assistant' as const, content: '你不要列点。' }];
    expect(buildActiveConstraints(recent, '继续')).toHaveLength(0);
  });

  it('意图账本：分享→goal=share；未解决问题来自 openLoop', () => {
    const intent = buildIntent('SHARE_PROGRESS', 'medium', '你是指缓存问题吗？');
    expect(intent.goal).toBe('share');
    expect(intent.unresolvedPoints).toHaveLength(1);
  });
});

describe('A.4 话题栈', () => {
  it('明确换话题关闭旧话题，不强行拉回', () => {
    const recent = [
      { role: 'user' as const, content: '容器里网络不通怎么查？' },
      { role: 'assistant' as const, content: '先分层排查。' }
    ];
    const stack = buildTopicStack(recent, 'life', '换个话题，周末去哪玩？');
    expect(stack.find((f) => f.key === 'technical')?.status).toBe('closed');
    expect(stack.find((f) => f.key === 'life')?.status).toBe('active');
  });
});

describe('账本接入回应动作（跨轮断言）', () => {
  it('纠正轮：CORRECT_COURSE 且 contextNote 含修复方向', () => {
    const recent = [
      { role: 'user' as const, content: '今天那个 Bug 搞得心烦。' },
      { role: 'assistant' as const, content: '我给你几个排障步骤。' }
    ];
    const current = '我不是来排查，我就想聊两句。';
    const u = understandDialogue(current);
    const state = buildConversationState(recent, current, u);
    const act = selectResponseAct(u, state);
    expect(act.primary).toBe('CORRECT_COURSE');
    expect(act.contextNote).toContain('不再推送排障');
  });

  it('有效约束注入 contextNote，供本轮遵守', () => {
    const current = '这次不要列点，简单说说为什么天空是蓝色的？';
    const u = understandDialogue(current);
    const state = buildConversationState([], current, u);
    const act = selectResponseAct(u, state);
    expect(act.contextNote).toContain('不使用列表/分点');
  });
});