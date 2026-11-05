import { describe, expect, it } from 'vitest';
import { CHANGE_SIGNALS, CHANGE_SUBJECTS } from '@/lib/cognitive/change-detector';
import {
  CHANGE_AFTER_LABEL,
  CHANGE_BEFORE_LABEL,
  CHANGE_SIGNAL_LABELS,
  CHANGE_SUBJECT_LABELS,
  CHANGES_ARE_OBSERVATIONS_NOTE,
  CHANGES_EMPTY_NOTE,
  INSUFFICIENT_CHANGE_LABELS,
  INTEREST_SOURCE_NOTE,
  describeChangeConfirmation,
  describeChangeSignal,
  describeChangesCap,
  describeInsufficientChange
} from '@/lib/cognitive/change-display';

/**
 * 任务书 4.3 的措辞层。
 *
 * 检测层（`change-detector.ts`）一个字的判断性措辞都不写，这里就是句子唯一的出处。
 * 封闭句式表有两重作用：一是让「同一条观察」在界面、日志、以后可能的推送里长得一样；
 * 二是把任务书在这一节点名的红线变成可以机器检查的东西——
 * 「不允许根据极少数聊天记录预测用户未来人生或生成确定性人格结论」。
 * 下面最后那组静态断言钉的就是这一条：这一屏说得出句子，但说不出结论。
 *
 * 测试：src/lib/cognitive/change-display.ts
 */

describe('六类观察各有句子，句子只说发生了什么', () => {
  it('主题标签把六个检测面盖全，一个不漏', () => {
    expect(CHANGE_SUBJECTS.map((subject) => CHANGE_SUBJECT_LABELS[subject])).toEqual([
      '兴趣',
      '目标',
      '项目',
      '偏好',
      '反复提到的事',
      '没有下文的事'
    ]);
  });

  it('信号标签把八个检测信号盖全', () => {
    expect(CHANGE_SIGNALS.map((signal) => CHANGE_SIGNAL_LABELS[signal])).toEqual([
      '最近才反复提到',
      '从一件转到了另一件',
      '说法换过一版',
      '出现了完成说法',
      '这句话被撤回',
      '多了一版说法',
      '一直在反复提到',
      '放了很久没再提'
    ]);
  });

  it('一句观察 = 主题 + 信号，逐字钉住', () => {
    expect(describeChangeSignal('PREFERENCE', 'CHANGED')).toBe('偏好：说法换过一版');
    expect(describeChangeSignal('GOAL', 'COMPLETED')).toBe('目标：出现了完成说法');
    expect(describeChangeSignal('GOAL', 'WITHDRAWN')).toBe('目标：这句话被撤回');
    expect(describeChangeSignal('PROJECT', 'UPDATED')).toBe('项目：多了一版说法');
    expect(describeChangeSignal('INTEREST', 'EMERGED')).toBe('兴趣：最近才反复提到');
    expect(describeChangeSignal('INTEREST', 'SHIFTED')).toBe('兴趣：从一件转到了另一件');
    expect(describeChangeSignal('REPETITION', 'RECURRING')).toBe('反复提到的事：一直在反复提到');
    expect(describeChangeSignal('UNRESOLVED', 'STILL_OPEN')).toBe('没有下文的事：放了很久没再提');
  });

  it('前后两侧的说法都用同一对标签，界面不另造词', () => {
    expect(CHANGE_BEFORE_LABEL).toBe('之前：');
    expect(CHANGE_AFTER_LABEL).toBe('之后：');
  });

  it('证据不足要说清差在哪条门槛，五种理由各有句子', () => {
    expect(describeInsufficientChange('REPETITION', 'BELOW_SAMPLE_MIN')).toBe('反复提到的事：提到的次数还不够');
    expect(describeInsufficientChange('PREFERENCE', 'BELOW_CHAT_MIN')).toBe('偏好：只出现在同一个对话里');
    expect(describeInsufficientChange('REPETITION', 'BELOW_SPAN_MIN')).toBe('反复提到的事：提到的时间还太集中');
    expect(describeInsufficientChange('UNRESOLVED', 'BELOW_AGE_MIN')).toBe('没有下文的事：放下的时间还不够久');
    expect(describeInsufficientChange('INTEREST', 'BELOW_MEDIAN_GAP')).toBe('兴趣：两件事的时间离得还不够远');
    // BELOW_OUTCOME_MIN 属于 Phase 7 的决策教训，不在 4.3 的六件事里，这张表不该有它。
    expect(Object.keys(INSUFFICIENT_CHANGE_LABELS)).toHaveLength(5);
  });

  it('来源不同就换个说法：推断出来的东西不许冒充用户说过', () => {
    expect(describeChangeConfirmation(true)).toBe('依据里有亲口说过或确认过的说法');
    expect(describeChangeConfirmation(false)).toBe('由记录推断，未经你确认');
  });

  it('两条常驻说明：观察不是结论，兴趣只是两类记忆的代理', () => {
    expect(CHANGES_ARE_OBSERVATIONS_NOTE).toBe('下面每一条都只是观察：写明它依据几条记忆、跨多少天，不下结论。');
    expect(INTEREST_SOURCE_NOTE).toBe('系统没有单独的「兴趣」记录，这一栏的兴趣只看偏好和目标两类说法。');
    expect(CHANGES_EMPTY_NOTE).toBe('这次读进来的记忆里，还没有够得上任何一类观察的。');
  });

  /**
   * 变化是「这一批记忆算出来的」，批被截断时不说不等于「更早的没变化」——
   * 那是门槛 4 最不想看到的读法，和时间线、洞察两屏同一个理由。
   * 未截断时返回空串：不许在屏上留一行没有信息量的话。
   */
  it('读到上限时要说清只看了最近这一批，没到上限时一个字都不出', () => {
    expect(describeChangesCap(true)).toBe('记忆条数已达上限：变化只看最近这一批记忆算出来的，更早的没有读进来。');
    expect(describeChangesCap(false)).toBe('');
  });
});

describe('红线：这一屏说不出人格结论，也说不出未来', () => {
  /** 任务书 4.3 原文：不允许根据极少数聊天记录预测用户未来人生或生成确定性人格结论。 */
  const FORBIDDEN = ['人格', '性格', '注定', '一定', '必然', '未来', '预测', '本质', '天生', '说明你是'];

  it('句式表里每一个字都不带这些词', () => {
    const serialized = JSON.stringify({
      CHANGE_SUBJECT_LABELS,
      CHANGE_SIGNAL_LABELS,
      INSUFFICIENT_CHANGE_LABELS,
      CHANGES_ARE_OBSERVATIONS_NOTE,
      INTEREST_SOURCE_NOTE,
      CHANGES_EMPTY_NOTE,
      capNote: describeChangesCap(true)
    });

    for (const word of FORBIDDEN) expect(serialized).not.toContain(word);
  });

  it('任意主题 × 任意信号组合出的每一句都不带这些词', () => {
    for (const subject of CHANGE_SUBJECTS) {
      for (const signal of CHANGE_SIGNALS) {
        const line = describeChangeSignal(subject, signal);
        for (const word of FORBIDDEN) expect(line).not.toContain(word);
      }
    }
  });
});
