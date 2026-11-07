import { describe, expect, it } from 'vitest';
import {
  MEMORY_CLASSES,
  MEMORY_CLASS_LABELS,
  classifyMemoryClass,
  memoryClassLabel
} from '@/lib/cognitive/memory-display';

/**
 * 五类记忆体系（混合式记忆升级 Phase 1）。
 * 分类是现有六个 type 之上的功能层，只由 type 和原文未来标记决定，不调模型、不猜。
 * 这里钉住映射本身，以及「目标」何时归前瞻、何时归语义这条界线。
 */
describe('五类记忆分类', () => {
  it('五类齐全，working 是会话层、其余四类可落库', () => {
    expect(MEMORY_CLASSES).toEqual(['working', 'episodic', 'semantic', 'procedural', 'prospective']);
    expect(MEMORY_CLASS_LABELS.working).toBe('工作记忆');
  });

  it('项目、决策、情绪归情景记忆', () => {
    expect(classifyMemoryClass('project', '我在做智能小车')).toBe('episodic');
    expect(classifyMemoryClass('decision', '我决定接受 offer')).toBe('episodic');
    expect(classifyMemoryClass('emotion', '我最近心情不好')).toBe('episodic');
  });

  it('事实归语义记忆，偏好归程序性记忆', () => {
    expect(classifyMemoryClass('fact', '我住在杭州')).toBe('semantic');
    expect(classifyMemoryClass('preference', '我喜欢先理解原理再看解法')).toBe('procedural');
  });

  it('长期目标归语义，带明确未来说法的目标归前瞻', () => {
    expect(classifyMemoryClass('goal', '我的目标是把体脂降到 20%')).toBe('semantic');
    expect(classifyMemoryClass('goal', '我打算明年考研')).toBe('prospective');
    expect(classifyMemoryClass('goal', '我计划下个月启动这个项目')).toBe('prospective');
  });

  it('界面标签由记忆本身算出，不额外存一列', () => {
    expect(memoryClassLabel({ type: 'preference', content: '我喜欢喝黑咖啡' })).toBe('程序性记忆');
    expect(memoryClassLabel({ type: 'project', content: '我在用 ESP32-S3' })).toBe('情景记忆');
  });
});