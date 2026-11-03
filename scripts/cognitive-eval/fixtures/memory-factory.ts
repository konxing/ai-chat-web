import type { EvalMemory } from '../fixture-types';

/**
 * fixture 行的默认值。
 *
 * 单独一个文件是因为分批铺量时两边都要用它：stories.ts 拼 STORIES 时要 import 后续批次，
 * 把工厂函数留在那里面就会变成循环依赖。
 */
export function memory(
  id: string,
  content: string,
  session: string,
  day: number,
  fields: Partial<EvalMemory> = {}
): EvalMemory {
  return {
    id,
    content,
    session,
    day,
    type: 'fact',
    context: 'general',
    origin: 'explicit',
    ...fields
  };
}
