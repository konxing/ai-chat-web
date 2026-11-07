import { describe, expect, it } from 'vitest';
import { extractMemoryCandidates } from '@/lib/cognitive/memory-extractor';

/**
 * 规则抽取（任务书 Phase 2 的 MemoryExtractor 第一版）。
 * 只从用户自己写的句子里抽，且只认「亲口陈述」的句式——问句、转述别人的话、
 * 过长的句子一律不抽，宁可少记也不能记错。这一版不碰情绪（情绪是情感引擎的活），
 * 也不调模型：没配 provider 时规则路径必须能真实落地。
 *
 * 输入是用户消息原文，输出是 [{ text, type }] 候选；候选只带句子本身，不带上下文。
 */
const one = (text: string) => extractMemoryCandidates(text);

describe('候选抽取的命中', () => {
  it('技术项目的亲口陈述抽成 project', () => {
    expect(one('我在用 Next.js 15 和 Prisma。')).toEqual([{ text: '我在用 Next.js 15 和 Prisma', type: 'project' }]);
  });

  it('「目标是」引出的学习目标按 goal 抽', () => {
    // 冒烟验收抓到的漏记：这句话没有任何一条旧标记词命中，整句被丢掉。
    const candidates = one('我在学 TypeScript，目标是今年能独立写后端服务。');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe('goal');
  });

  it('偏好、目标、决策、身份事实各归其类', () => {
    expect(one('我不喜欢被反复追问细节。')[0]?.type).toBe('preference');
    expect(one('我打算下个月把旧笔记整理一遍。')[0]?.type).toBe('goal');
    expect(one('我决定周末去杭州待两天。')[0]?.type).toBe('decision');
    expect(one('我住在杭州。')[0]?.type).toBe('fact');
    expect(one('我叫康兴，今年三十二岁。')[0]?.type).toBe('fact');
  });

  it('决策句不会被当成目标：规则按顺序取第一个命中的类型', () => {
    expect(one('我打算先观察，我决定周末去杭州待两天。')[0]?.type).toBe('decision');
  });

  it('一条消息里的多个句子各出一条候选，顺序按原文', () => {
    const candidates = one('我在用 Prisma。我喜欢喝温水。');
    expect(candidates).toEqual([
      { text: '我在用 Prisma', type: 'project' },
      { text: '我喜欢喝温水', type: 'preference' }
    ]);
  });
});

describe('候选抽取的克制', () => {
  it('问句不抽：用户在提问不是在陈述', () => {
    expect(one('我的项目怎么部署比较好呢？')).toEqual([]);
    expect(one('我该怎么办？')).toEqual([]);
    expect(one('我打算换工作吗？')).toEqual([]);
  });

  it('只靠问号收尾的疑问句也不抽：切句吃掉了标点，不等于那句话不是问句', () => {
    // 冒烟验收抓到的真缺陷：「我喜欢喝什么样的咖啡？」被当成偏好落库——
    // 它不含「吗/怎么/如何」，唯一的问句信号是那个被切句吃掉的「？」。
    expect(one('我喜欢喝什么样的咖啡？')).toEqual([]);
    expect(one('我喜欢什么？')).toEqual([]);
    expect(one('我住在哪里呢？')).toEqual([]);
  });

  it('没有第一人称的转述不抽', () => {
    expect(one('这个项目用了 Next.js。')).toEqual([]);
    expect(one('他说他用的是 Prisma。')).toEqual([]);
  });

  it('情绪句这一版不抽，交给情感引擎', () => {
    expect(one('我最近心情不太好。')).toEqual([]);
    expect(one('我今天累得不想说话。')).toEqual([]);
  });

  it('超过两百字的句子不抽：那不是记忆，是段落', () => {
    expect(one(`我在用 ${'技'.repeat(300)}。`)).toEqual([]);
  });

  it('太短的碎片不抽', () => {
    expect(one('我。')).toEqual([]);
  });

  it('同一句重复出现只留一条', () => {
    expect(one('我在用 Prisma。我在用 Prisma。')).toHaveLength(1);
  });

  it('每轮最多三条候选', () => {
    const candidates = one(
      ['我在用 Prisma。', '我喜欢喝温水。', '我打算考研。', '我住在杭州。', '我决定周末出发。'].join('')
    );
    expect(candidates).toHaveLength(3);
  });
});
