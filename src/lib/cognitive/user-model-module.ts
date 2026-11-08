import { listProfileEntries, type ProfileEntryDto } from './user-profile';
import { PROFILE_EDITED_LABEL } from './user-profile-display';
import { PROFILE_FRAMING, renderFramingHeader } from './response-policy';
import type { CognitiveBlock, CognitiveModule, CognitiveTurn } from './manager';
import { routeMemoryRetrieval } from './retrieval-router';
import { PROFILE_SELECTION_POOL, selectRelevantProfileEntries } from './profile-selection';
import { capabilityContextBlocks } from './capability-context';

/**
 * 用户模型模块（任务书 8.2 / 8.3 的注入侧）。
 *
 * 只读，**没有 write**：画像是用户确认出来的东西，系统不许在自己的后台里往这张表写一行。
 * 于是 `userModelEnabled` 这个开关第一次有了真消费者，而它的语义也就此定死——
 * 开：把已确认的画像条目端给模型；关：连读都不读。
 *
 * 注入的是**已确认的条目**，不是候选。候选连这个函数都进不来：`read` 只调 `listProfileEntries`，
 * 拿到的类型是 `ProfileEntryDto`，那张表里根本没有未确认的行（写路径只有确认那一次）。
 * 「系统觉得你可能是这样」的东西一次都没进过提示词，这是结构，不是自觉。
 *
 * 预算比长期记忆小得多（6 条 / 800 字）：画像说的是「这个人是什么样」，
 * 一句话就够，堆十条只是在教模型一个它本该从对话里自己发现的偏见。
 */
export const USER_MODEL_MAX_ITEMS = 6;
export const USER_MODEL_MAX_CHARS = 800;

const PROFILE_TEXT_HEADER = renderFramingHeader(PROFILE_FRAMING);

/**
 * 把条目渲染成一段「数据不是指令」的上下文——纯函数，不碰数据库。
 *
 * 条数与字符两条预算都在这里收口：读侧只负责把最近的那几条捞回来，
 * 界面（洞察一屏那种）将来也要用同一份措辞，不能各写一份「取前几条」。
 */
export function renderProfileBlock(entries: readonly ProfileEntryDto[]): CognitiveBlock[] {
  const lines: string[] = [];
  let size = PROFILE_TEXT_HEADER.length;
  for (const entry of entries) {
    if (lines.length >= USER_MODEL_MAX_ITEMS) break;
    const line = `- ${entry.content}${entry.editedAt ? PROFILE_EDITED_LABEL : ''}`;
    if (size + line.length > USER_MODEL_MAX_CHARS) break;
    lines.push(line);
    size += line.length;
  }
  if (lines.length === 0) return [];
  // 不填 memoryIds：画像条目不是记忆 id，填进去会让引用提示报出模型根本没读到的东西（任务书 8.2）。
  return [
    {
      module: 'userModel',
      label: PROFILE_FRAMING.bracket,
      text: [PROFILE_TEXT_HEADER, ...lines].join('\n')
    }
  ];
}

async function readUserModel(turn: CognitiveTurn): Promise<CognitiveBlock[]> {
  // 与个人情况无关的纯知识问题不加载画像；减少无关个人资料的出站。
  if (routeMemoryRetrieval(turn.content).need === 'none') return [];
  const entries = await listProfileEntries(turn.userId, PROFILE_SELECTION_POOL);
  const profiles = renderProfileBlock(selectRelevantProfileEntries(turn.content, entries, USER_MODEL_MAX_ITEMS));
  const capabilityBlocks = await capabilityContextBlocks(turn.userId, turn.content);
  return [...profiles, ...capabilityBlocks];
}

export const userModelModule: CognitiveModule = { key: 'userModel', read: readUserModel };
