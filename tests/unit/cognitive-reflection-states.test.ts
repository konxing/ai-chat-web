import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 门槛 7 的静态断言（任务书 7.4）：反思的每一个状态都必须有生产者，而且不许有人绕过读侧。
 *
 * 为什么用读源码而不是跑用例：这两件事都没有可运行的入口可试——
 * 「状态有没有人写」要跨三个文件对表，任何一条单测只看得见自己那一条路径；
 * 「有没有第二个消费者」更是纯粹的引用关系，运行时根本观察不到。
 * 表就摆在这个文件里，改枚举不补生产者、或者把洞察塞进对话提示词，都会红在这里，
 * 而不是等上线后才发现某个状态永远查不出来、或者界面上多了三条没人点过的洞察。
 *
 * 生产者表**放在测试这边**而不是导出到 reflections.ts：一份只在断言时需要的表，
 * 放进生产代码就是给测试留接口（这条口径来自「不渲染没人消费的控件」）。
 */

const REPO = process.cwd();
const read = (relative: string) => readFileSync(resolve(REPO, relative), 'utf8');

/** schema 里的六个状态 → 谁把它写进库。每一条都要能在被点名的那个文件里找到实际的赋值。 */
const PRODUCERS: Record<string, { file: string; needle: string }[]> = {
  PENDING: [
    { file: 'src/lib/cognitive/reflection-sweep.ts', needle: "status: 'PENDING'" }
  ],
  ACCEPTED: [{ file: 'src/lib/cognitive/reflections.ts', needle: "status: 'ACCEPTED'" }],
  REJECTED: [{ file: 'src/lib/cognitive/reflections.ts', needle: "status: 'REJECTED'" }],
  EDITED: [{ file: 'src/lib/cognitive/reflections.ts', needle: "status: 'EDITED'" }],
  SNOOZED: [{ file: 'src/lib/cognitive/reflections.ts', needle: "status: 'SNOOZED'" }],
  // 甲方案：过期由 sweep 抢到冷却后的第一件事收割，读侧只是同一件事的提前显示。
  EXPIRED: [{ file: 'src/lib/cognitive/reflection-sweep.ts', needle: "status: 'EXPIRED'" }]
};

function schemaStatuses(): string[] {
  const schema = read('prisma/schema.prisma');
  const block = /enum ReflectionStatus \{([^}]*)\}/.exec(schema);
  if (!block) throw new Error('prisma/schema.prisma 里找不到 enum ReflectionStatus');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('///'));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(REPO, dir))) {
    const relative = join(dir, name);
    if (statSync(join(REPO, relative)).isDirectory()) found.push(...sourceFiles(relative));
    else if (/\.(ts|tsx)$/.test(name)) found.push(relative);
  }
  return found;
}

describe('门槛 7：反思状态机每个状态都有生产者', () => {
  it('schema 里的状态集合和这张表一一对应：加一个就得在这里说出谁写它', () => {
    expect(schemaStatuses().sort()).toEqual(Object.keys(PRODUCERS).sort());
  });

  it.each(Object.entries(PRODUCERS))('%s 的赋值真的在被点名的文件里', (status, claims) => {
    for (const claim of claims) {
      const source = read(claim.file);
      expect(
        source.includes(claim.needle),
        `${status} 的生产者应当写在 ${claim.file}，但那里找不到 ${claim.needle}`
      ).toBe(true);
    }
  });
});

describe('甲方案：读侧一个字都不多写', () => {
  it('reflections.ts 不建记忆、不写画像、不注册模块', () => {
    const source = read('src/lib/cognitive/reflections.ts');
    // 采纳只翻状态。这三条禁令各挡一种「顺手记住」：写记忆行、改画像、把自己挂进对话链路。
    for (const forbidden of [
      'memoryItem.create',
      'createMemory',
      'userModel',
      'registerCognitiveModule'
    ]) {
      expect(source, `读侧不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('除了两条洞察路由，没有任何代码读它（6-E 不往提示词里塞东西）', () => {
    const allowed = [
      join('src', 'app', 'api', 'account', 'cognitive', 'reflections', 'route.ts'),
      join('src', 'app', 'api', 'account', 'cognitive', 'reflections', '[id]', 'route.ts')
    ];
    const importers = sourceFiles('src')
      .filter(
        (file) =>
          !allowed.includes(file) &&
          !file.endsWith(join('cognitive', 'reflections.ts')) &&
          read(file).includes('@/lib/cognitive/reflections')
      )
      .sort();
    // 6-F 的界面组件会出现在这里——那时要判的是它读的是接口，不是把洞察拼进发给模型的上下文。
    expect(importers).toEqual([]);
  });
});
