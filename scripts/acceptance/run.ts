/**
 * 验收运行器（验收总计划书第 4、18 章）。
 *
 * 一次 run 的完整生命周期：
 * 建虚拟用户 → 登录 → 开全部认知开关 → 按场景走真实 HTTP → 等后台认知任务跑完
 * → 用受控检查接口取证 → 对照标准答案逐条判定 → 出报告 → 清理虚拟用户。
 *
 * 判定口径（第 18 章）：PASS 必须有证据；FAIL 写明实际值与期望值；
 * 模型回答的话术只作软证据，硬判定一律落在 inspectVirtualUser 的解密行上。
 *
 * 用法：
 *   npx tsx scripts/acceptance/run.ts --run <runId> --scenario <id> [--base http://127.0.0.1:3100] [--keep]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../src/lib/prisma';
import { cleanupVirtualUsers, createVirtualUsers } from '../../src/lib/acceptance/virtual-users';
import { inspectVirtualUser } from '../../src/lib/acceptance/evidence';
import { getScenario, type Scenario } from './scenarios';
import {
  apiDelete,
  apiGet,
  createChat,
  enableAllCognitiveSwitches,
  login,
  sendMessage,
  type DriverContext
} from './http-driver';

interface CheckResult {
  check: string;
  pass: boolean;
  detail: string;
}

function parseArgs(): { runId: string; scenarioId: string; base: string; keep: boolean } {
  const args = process.argv.slice(2);
  const read = (name: string): string | null => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
  };
  const runId = read('run');
  const scenarioId = read('scenario');
  if (!runId || !scenarioId) {
    throw new Error('用法: --run <runId> --scenario <id> [--base url] [--keep]');
  }
  return {
    runId,
    scenarioId,
    base: read('base') ?? 'http://127.0.0.1:3100',
    keep: args.includes('--keep')
  };
}

/** 等这个用户的认知欠账全部跑完；超时算失败，不静默跳过。 */
async function waitForCognitiveTasks(userId: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await prisma.cognitiveTask.count({
      where: { userId, status: { in: ['PENDING', 'RUNNING'] } }
    });
    if (pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`后台认知任务 ${timeoutMs / 1000}s 内没有跑完（还剩 ${pending} 条）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function forgetMemoriesContaining(ctx: DriverContext, match: string): Promise<number> {
  const list = await apiGet<{ memories: Array<{ id: string; content: string }> }>(
    ctx,
    '/api/account/cognitive/memories'
  );
  const targets = list.memories.filter((memory) => memory.content.includes(match));
  for (const target of targets) {
    await apiDelete(ctx, `/api/account/cognitive/memories/${target.id}`);
  }
  return targets.length;
}

async function runScenario(
  scenario: Scenario,
  ctx: DriverContext,
  userId: string,
  checks: CheckResult[]
): Promise<void> {
  let chatId: string | null = null;
  for (const [index, step] of scenario.steps.entries()) {
    const label = `步骤 ${index + 1}`;
    if (step.act?.type === 'forgetMemoriesContaining') {
      const purged = await forgetMemoriesContaining(ctx, step.act.match);
      checks.push({
        check: `${label} 删除含「${step.act.match}」的记忆`,
        pass: purged > 0,
        detail: `删掉 ${purged} 条`
      });
    } else if (step.say) {
      if (step.newChat || !chatId) {
        chatId = (await createChat(ctx)).id;
      }
      const result = await sendMessage(ctx, chatId, step.say);
      for (const needle of step.assistantMustContain ?? []) {
        checks.push({
          check: `${label} 回答提到「${needle}」`,
          pass: result.assistantText.includes(needle),
          detail: result.assistantText.slice(0, 200)
        });
      }
    }
    if (step.settle) await waitForCognitiveTasks(userId);
  }
}

function judge(scenario: Scenario, evidence: Awaited<ReturnType<typeof inspectVirtualUser>>): CheckResult[] {
  const checks: CheckResult[] = [];
  const active = evidence.memories.filter((memory) => !memory.supersededAt);
  const allText = evidence.memories.map((memory) => memory.content).join('\n');
  const activeText = active.map((memory) => memory.content).join('\n');

  for (const needle of scenario.expect.memoriesMustContain ?? []) {
    checks.push({
      check: `记忆含「${needle}」`,
      pass: allText.includes(needle),
      detail: `记忆 ${evidence.memories.length} 条（活跃 ${active.length} 条）`
    });
  }
  for (const needle of scenario.expect.activeMemoriesMustNotContain ?? []) {
    checks.push({
      check: `活跃记忆不含「${needle}」`,
      pass: !activeText.includes(needle),
      detail: activeText.slice(0, 200) || '（无活跃记忆）'
    });
  }
  if (scenario.expect.activeMemoryCountMin !== undefined) {
    checks.push({
      check: `活跃记忆 ≥ ${scenario.expect.activeMemoryCountMin} 条`,
      pass: active.length >= scenario.expect.activeMemoryCountMin,
      detail: `实际 ${active.length} 条`
    });
  }
  for (const [table, min] of Object.entries(scenario.expect.countMin ?? {})) {
    const actual = evidence.counts[table] ?? 0;
    checks.push({
      check: `${table} ≥ ${min} 行`,
      pass: actual >= (min as number),
      detail: `实际 ${actual} 行`
    });
  }
  return checks;
}

async function main(): Promise<void> {
  const { runId, scenarioId, base, keep } = parseArgs();
  const scenario = getScenario(scenarioId);
  const users = await createVirtualUsers({ runId, count: scenario.users });
  const checks: CheckResult[] = [];
  let report: string[] = [];
  try {
    const ctx = await login(base, users[0].username, users[0].password);
    await enableAllCognitiveSwitches(ctx);
    await runScenario(scenario, ctx, users[0].userId, checks);
    await waitForCognitiveTasks(users[0].userId);

    const evidence = await inspectVirtualUser(users[0].username);
    checks.push(...judge(scenario, evidence));

    const failed = checks.filter((check) => !check.pass);
    report = [
      `# 验收报告 ${scenario.id} · run ${runId}`,
      '',
      `场景：${scenario.title}`,
      `结果：${failed.length === 0 ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length} 通过）`,
      `虚拟用户：${users.map((user) => user.username).join(', ')}`,
      '',
      '| 检查 | 判定 | 证据 |',
      '|---|---|---|',
      ...checks.map(
        (check) => `| ${check.check} | ${check.pass ? 'PASS' : 'FAIL'} | ${check.detail.replace(/\|/g, '/')} |`
      ),
      '',
      '## 活跃记忆正文（虚拟用户，解密证据）',
      '',
      ...evidence.memories
        .filter((memory) => !memory.supersededAt)
        .map((memory) => `- [${memory.type}/${memory.context}] ${memory.content}`),
      '',
      `## 派生表行数`,
      '',
      '```json',
      JSON.stringify(evidence.counts, null, 2),
      '```'
    ];
  } finally {
    const dir = join(__dirname, 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${scenarioId}-${runId}.md`), report.join('\n') || '# 运行中断\n');
    if (!keep) {
      const cleanup = await cleanupVirtualUsers({ runId });
      console.log('清理:', JSON.stringify(cleanup));
      if (Object.keys(cleanup.residue).length > 0) {
        console.error('警告：清理有残留', cleanup.residue);
      }
    }
    await prisma.$disconnect();
  }
  const failed = checks.filter((check) => !check.pass);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} ${checks.length - failed.length}/${checks.length}`);
  for (const check of checks) console.log(`${check.pass ? ' ✓' : ' ✗'} ${check.check} — ${check.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
