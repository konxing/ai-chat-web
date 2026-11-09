import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  saved: [] as Array<Record<string, unknown>>,
  undos: [] as string[],
  autoLearn: true
}));
vi.mock('@/lib/cognitive/conversation/style/style-profile', () => ({
  setConversationStyle: (_userId: string, style: Record<string, unknown>) => {
    ctx.saved.push(style);
    return Promise.resolve(style);
  },
  performStyleUndo: (_userId: string, target: string) => {
    ctx.undos.push(target);
    return Promise.resolve({});
  }
}));
vi.mock('@/lib/cognitive/cognitive-flags', () => ({
  autoLearnStyleEnabled: () => Promise.resolve(ctx.autoLearn)
}));

import { extractStyleFeedback, learnConversationPreference, detectStyleUndo } from '@/lib/cognitive/conversation/learning/preference-extractor';
import { decideStyleAutonomy } from '@/lib/cognitive/conversation/learning/autonomy';

describe('extractStyleFeedback：只认明确反馈，区分范围', () => {
  it('"以后不要列点" → GLOBAL 结构最小', () => {
    const f = extractStyleFeedback('以后不要每次都列这么多点');
    expect(f?.scope).toBe('GLOBAL');
    expect(f?.adjustments.structure).toBe('minimal');
  });

  it('"这次先给结论" → TEMPORARY 不持久化', () => {
    const f = extractStyleFeedback('这次先给结论，不用展开');
    expect(f?.scope).toBe('TEMPORARY');
  });

  it('"主动指出我的错误" → GLOBAL 提高主动思考（不是无条件赞同）', () => {
    const f = extractStyleFeedback('我希望你可以主动指出我的错误');
    expect(f?.scope).toBe('GLOBAL');
    expect(f?.adjustments.proactivity).toBe('high');
  });

  it('普通聊天不产生偏好候选', () => {
    expect(extractStyleFeedback('今天天气不错')).toBeNull();
    expect(extractStyleFeedback('我喜欢喝咖啡')).toBeNull();
  });
});

describe('learnConversationPreference：授权门控 + 自然语言撤销', () => {
  it('已授权 autoLearn：GLOBAL 反馈自动写入（不弹窗）', async () => {
    ctx.saved.length = 0; ctx.autoLearn = true;
    const ok = await learnConversationPreference('u1', '以后不要列点');
    expect(ok).toBe(true);
    expect(ctx.saved.length).toBe(1);
  });

  it('未授权 autoLearn：GLOBAL 仅会话遵守，不写长期库', async () => {
    ctx.saved.length = 0; ctx.autoLearn = false;
    const ok = await learnConversationPreference('u1', '以后不要列点');
    expect(ok).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });

  it('TEMPORARY 反馈不写库（无论是否授权）', async () => {
    ctx.saved.length = 0; ctx.autoLearn = true;
    const ok = await learnConversationPreference('u1', '这次简单一点');
    expect(ok).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });

  it('无反馈不写库', async () => {
    ctx.saved.length = 0;
    const ok = await learnConversationPreference('u1', '你好');
    expect(ok).toBe(false);
    expect(ctx.saved.length).toBe(0);
  });

  it('自然语言撤销执行真正逆操作（无需授权/按钮）', async () => {
    ctx.undos.length = 0; ctx.autoLearn = false;
    const ok = await learnConversationPreference('u1', '还是恢复原来的风格吧');
    expect(ok).toBe(true);
    expect(ctx.undos).toEqual(['full']);
  });

  it('撤销简短偏好 → 恢复长度维度', async () => {
    ctx.undos.length = 0;
    await learnConversationPreference('u1', '撤销之前的简短偏好');
    expect(ctx.undos).toEqual(['length']);
  });
});

describe('detectStyleUndo：自然语言撤销解析', () => {
  it('全量恢复 / 长度 / 结构 / 非撤销', () => {
    expect(detectStyleUndo('恢复默认风格')).toBe('full');
    expect(detectStyleUndo('撤销之前的简短偏好')).toBe('length');
    expect(detectStyleUndo('撤销不要列点，恢复列表')).toBe('structure');
    expect(detectStyleUndo('以后回答简短些')).toBeNull();
    expect(detectStyleUndo('今天天气不错')).toBeNull();
  });
});

describe('C3 自主决策边界', () => {
  it('撤销：低风险可逆，直接执行无打断', () => {
    const d = decideStyleAutonomy({ scope: 'GLOBAL', autoLearnEnabled: false, isUndo: true });
    expect(d.permission).toBe('ALLOWED');
    expect(d.userInterruption).toBe('NONE');
    expect(d.canUndo).toBe(true);
    expect(d.reasonCode).toBe('UNDO_EXECUTED');
  });

  it('未授权长期：会话遵守，不持久化、不弹窗（沉默≠同意）', () => {
    const d = decideStyleAutonomy({ scope: 'GLOBAL', autoLearnEnabled: false, isUndo: false });
    expect(d.permission).toBe('DISABLED');
    expect(d.action).toBe('UPDATE_SESSION_CONSTRAINT');
    expect(d.userInterruption).toBe('NONE');
  });

  it('临时要求：TURN 范围，不持久化', () => {
    const d = decideStyleAutonomy({ scope: 'TEMPORARY', autoLearnEnabled: true, isUndo: false });
    expect(d.scope).toBe('TURN');
    expect(d.action).toBe('UPDATE_SESSION_CONSTRAINT');
  });
});