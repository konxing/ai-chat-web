import { describe, expect, it } from 'vitest';

/**
 * 任务书 1.2 要「不同情境不同策略」，而策略要先知道当前这句话属于哪个情境。
 * 这里不用模型来判情境：分类结果要能逐词复算，否则评测集里出错都无从解释。
 * 所以这是一个纯词法打分器，输入一段用户原文，输出情境、各情境得分和候选集合。
 * 关键约束：并列不猜——把并列的都当成候选交给写入决策，由它挑最保守的一条。
 */
async function classifier() {
  return await import('@/lib/cognitive/context-classifier');
}

describe('词法情境分类', () => {
  it('技术项目的说法明确落在 technicalProject', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('这个 Prisma schema 迁移报错了，日志说外键冲突，重新部署还是 bug');

    expect(result.winner).toBe('technicalProject');
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toEqual(['technicalProject']);
  });

  it('明确的情绪倾诉落在 emotionalSupport', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('今天跟爸妈吵架了，心里特别委屈，晚上一直想哭');

    expect(result.winner).toBe('emotionalSupport');
    expect(result.ambiguous).toBe(false);
  });

  it('要不要买、预算、值不值落在 decisionMaking', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('这台显示器要不要买，预算两千，纠结值不值，等降价会不会更划算');

    expect(result.winner).toBe('decisionMaking');
    expect(result.ambiguous).toBe(false);
  });

  it('上课、复习、考试落在 learning；减肥、攒钱、打卡落在 personalGoal', async () => {
    const { classifyContext } = await classifier();

    const study = classifyContext('这门课程的教材太难，复习到半夜还是不会做练习题');
    const goal = classifyContext('今年目标减肥十斤，每天早上六点早起打卡，把健身坚持下来');

    expect(study.winner).toBe('learning');
    expect(goal.winner).toBe('personalGoal');
    expect(goal.ambiguous).toBe(false);
  });

  it('对自己的说法落在 personalReflection', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('我是不是太没用了，为什么我总是把关系搞砸，活着到底有什么意义');

    expect(result.winner).toBe('personalReflection');
    expect(result.ambiguous).toBe(false);
  });

  it('没有任何信号时按普通情境走，而不是把七种可能都列成候选', async () => {
    const { classifyContext } = await classifier();

    const empty = classifyContext('');
    const plain = classifyContext('今天天气不错，晚饭吃了碗面条');

    expect(empty.winner).toBe('general');
    expect(empty.ambiguous).toBe(false);
    expect(plain.winner).toBe('general');
    expect(plain.candidates).toEqual(['general']);
  });

  it('只有一个弱信号时不认情境——信号不够就不该拿来改变记忆策略', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('今天有点不开心');

    expect(result.scores.emotionalSupport).toBe(1);
    expect(result.winner).toBe('general');
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toEqual(['general']);
  });

  it('两种情境打平时不硬判：ambiguous 为真，两边都进候选', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('这个 bug 让我很难受');

    // 并列时按情境表顺序取第一个纯属任意，所以这里的 winner 不享有决定权，
    // 下游写入决策必须按 candidates 里最保守的策略处理。
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toEqual(['technicalProject', 'emotionalSupport']);
    expect(result.winner).toBe('technicalProject');
  });

  it('分差不足一个门槛也算歧义，不把模糊信号当成许可', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('我定了个计划，每天早上六点早起背单词准备考试');

    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toContain('learning');
    expect(result.candidates).toContain('personalGoal');
  });

  it('同一个词反复出现只加一次分，长文本不能靠复读刷高置信', async () => {
    const { classifyContext } = await classifier();

    const repeated = classifyContext('报错 报错 报错 报错');
    const once = classifyContext('报错');

    expect(repeated.scores.technicalProject).toBe(2);
    expect(once.scores.technicalProject).toBe(2);
  });

  it('输出的候选都在七个情境之内，不含原文片段', async () => {
    const { classifyContext } = await classifier();

    const result = classifyContext('跟对象冷战了三天，我到底要不要提分手，心里堵得慌');

    const MEMORY_CONTEXTS = [
      'general',
      'technicalProject',
      'learning',
      'personalGoal',
      'personalReflection',
      'emotionalSupport',
      'decisionMaking'
    ];
    expect(MEMORY_CONTEXTS).toContain(result.winner);
    for (const candidate of result.candidates) expect(MEMORY_CONTEXTS).toContain(candidate);
    expect(JSON.stringify(result)).not.toContain('冷战');
  });
});
