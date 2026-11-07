import { describe, expect, it } from 'vitest';
import { routeMemoryRetrieval } from '@/lib/cognitive/retrieval-router';

/**
 * 按需召回路由（Phase 4）。钉保守原则：涉及「我」的必召回，明确 impersonal 知识/翻译/数学才跳过，
 * 拿不准默认召回（不漏个人历史）。
 */
describe('按需召回路由', () => {
  it('涉及用户自己的事 → 召回（light）', () => {
    expect(routeMemoryRetrieval('我喜欢喝什么样的咖啡？').need).toBe('light');
    expect(routeMemoryRetrieval('我的项目有哪些技术约束？').need).toBe('light');
    expect(routeMemoryRetrieval('我之前说过住在哪').need).toBe('light');
  });

  it('个人 + 综合分析 → complex', () => {
    expect(routeMemoryRetrieval('分析我这些年的职业变化').need).toBe('complex');
    expect(routeMemoryRetrieval('比较我过去几个决策').need).toBe('complex');
  });

  it('纯知识/翻译/数学（无第一人称）→ 不召回', () => {
    expect(routeMemoryRetrieval('1加1等于几').need).toBe('none');
    expect(routeMemoryRetrieval('什么是量子纠缠').need).toBe('none');
    expect(routeMemoryRetrieval('翻译这句话成英文').need).toBe('none');
    expect(routeMemoryRetrieval('Python 怎么读文件').need).toBe('none');
  });

  it('拿不准 → 保守召回', () => {
    expect(routeMemoryRetrieval('今天天气不错').need).toBe('light');
    expect(routeMemoryRetrieval('在吗').need).toBe('light');
  });

  it('带第一人称的 how-to 不误判为纯知识', () => {
    expect(routeMemoryRetrieval('怎么部署我的项目').need).toBe('light');
  });
});