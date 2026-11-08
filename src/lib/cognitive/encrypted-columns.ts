import { bufferKeyId, cipherKeyId } from '@/lib/crypto';
import type { CognitiveAadCoord, CognitiveAadPurpose } from './aad';
import {
  cognitiveAad,
  decryptCognitiveBuffer,
  decryptCognitiveString,
  encryptCognitiveBuffer,
  encryptCognitiveString
} from './aad';

/**
 * 认知层密文列的总表：**哪个模型的哪一列，用哪一段 purpose／fieldName，是字符串还是 Bytes**。
 *
 * 这张表存在的理由只有一个：密钥轮换。`scripts/rotate-keys.ts` 之前只有 chat / message /
 * provider / attachment 四条硬编码家族，认知侧二十五个密文列一行都不重裹——旧密钥还留在
 * `MASTER_KEYRING` 里，所以当时没坏，但「轮换完成」这句话是假的。
 *
 * 手抄一份清单修不好这个：下一个新增的密文列照样会被忘掉，漏的方式和这次一模一样。
 * 所以写侧和轮换侧都查同一张表，新增列的人只要在 schema 里加一列、这里加一行，测试 A 组
 * 会把「schema 有而表里没有」直接判红。
 *
 * 两个家族的历史口径不同，表里如实保留：
 * - 记忆家族的 `fieldName` 就是列名（`contentCiphertext`），片S 起这样落库；
 * - 决策 / 反思 / 画像从第一版起用短名（`topic`、`title`、`content`），改成列名会让库里
 *   已有密文全部解不开，所以表里按短名登记，只是把出处从各模块收拢到这里。
 */

export type CognitiveColumnKind = 'string' | 'bytes';

export interface CognitiveEncryptedColumn {
  /** `prisma[...]` 上的模型键。明写出来，脚本不再靠模型名小写猜。 */
  client: string;
  model: string;
  column: string;
  /** 落进 AAD 最后一段的那个名字。记忆家族等于列名，其余家族是去掉 Ciphertext 的短名。 */
  field: string;
  purpose: CognitiveAadPurpose;
  kind: CognitiveColumnKind;
}

function stringColumn(
  client: string,
  model: string,
  column: string,
  purpose: CognitiveAadPurpose,
  field = column
): CognitiveEncryptedColumn {
  return { client, model, column, field, purpose, kind: 'string' };
}

function shortField(column: string): string {
  return column.endsWith('Ciphertext') ? column.slice(0, -'Ciphertext'.length) : column;
}

export const COGNITIVE_ENCRYPTED_COLUMNS: readonly CognitiveEncryptedColumn[] = [
  stringColumn('memoryItem', 'MemoryItem', 'contentCiphertext', 'memory'),
  {
    client: 'memoryItem',
    model: 'MemoryItem',
    column: 'embeddingCiphertext',
    field: 'embeddingCiphertext',
    purpose: 'memory-vector',
    kind: 'bytes'
  },
  stringColumn('memoryRevision', 'MemoryRevision', 'reasonCiphertext', 'memory-revision'),
  stringColumn('memoryEvidence', 'MemoryEvidence', 'noteCiphertext', 'memory-evidence'),
  stringColumn('memoryExclusion', 'MemoryExclusion', 'contentCiphertext', 'memory-exclusion'),
  stringColumn('memoryCandidate', 'MemoryCandidate', 'contentCiphertext', 'memory-candidate'),

  ...(
    [
      'topicCiphertext',
      'choiceCiphertext',
      'backgroundCiphertext',
      'constraintsCiphertext',
      'optionsCiphertext',
      'reasonCiphertext',
      'criteriaCiphertext',
      'expectedOutcomeCiphertext',
      'risksCiphertext'
    ] as const
  ).map((column) =>
    stringColumn('decisionRecord', 'DecisionRecord', column, 'decision', shortField(column))
  ),

  ...(
    [
      'actualCiphertext',
      'gapCiphertext',
      'ratingCiphertext',
      'missedFactorsCiphertext',
      'lessonCiphertext'
    ] as const
  ).map((column) =>
    stringColumn('decisionOutcome', 'DecisionOutcome', column, 'decision-outcome', shortField(column))
  ),

  ...(['titleCiphertext', 'bodyCiphertext', 'alternativesCiphertext', 'counterTokensCiphertext'] as const).map(
    (column) => stringColumn('reflectionRecord', 'ReflectionRecord', column, 'reflection', shortField(column))
  ),

  stringColumn('userProfileEntry', 'UserProfileEntry', 'contentCiphertext', 'user-profile', 'content'),
  stringColumn('capabilityDimension', 'CapabilityDimension', 'titleCiphertext', 'capability-dimension'),
  stringColumn('capabilityDimension', 'CapabilityDimension', 'goalCiphertext', 'capability-dimension'),
  stringColumn('capabilityEvidence', 'CapabilityEvidence', 'noteCiphertext', 'capability-evidence'),
  stringColumn('interventionRecord', 'InterventionRecord', 'suggestionCiphertext', 'capability-intervention'),
  stringColumn('interventionRecord', 'InterventionRecord', 'feedbackCiphertext', 'capability-intervention'),
  stringColumn('knowledgePage', 'KnowledgePage', 'titleCiphertext', 'knowledge-page'),
  stringColumn('experienceNote', 'ExperienceNote', 'titleCiphertext', 'experience-note'),
  stringColumn('experienceNote', 'ExperienceNote', 'lessonCiphertext', 'experience-note'),
  stringColumn('experienceNote', 'ExperienceNote', 'validationCiphertext', 'experience-note')
];

function columnEntry(model: string, column: string): CognitiveEncryptedColumn {
  const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.model === model && item.column === column);
  if (!entry) throw new Error(`未登记的认知密文列：${model}.${column}`);
  return entry;
}

function fieldEntry(model: string, field: string): CognitiveEncryptedColumn {
  const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.model === model && item.field === field);
  if (!entry) throw new Error(`未登记的认知密文字段：${model}.${field}`);
  return entry;
}

export function cognitiveColumnCoord(
  model: string,
  column: string,
  userId: string,
  recordId: string
): CognitiveAadCoord {
  const entry = columnEntry(model, column);
  return { purpose: entry.purpose, userId, recordId, fieldName: entry.field };
}

export function cognitiveColumnAad(
  model: string,
  column: string,
  userId: string,
  recordId: string
): string {
  return cognitiveAad(cognitiveColumnCoord(model, column, userId, recordId));
}

/** 给只知道短名的调用方用（决策 / 反思 / 画像的历史口径）。和按列名查必须给出同一个串。 */
export function cognitiveFieldAad(model: string, field: string, userId: string, recordId: string): string {
  const entry = fieldEntry(model, field);
  return cognitiveAad({ purpose: entry.purpose, userId, recordId, fieldName: entry.field });
}

/**
 * 把一行密文重裹到新密钥下。返回 null 表示「这一列不需要动」：
 * 载荷为空，或者它已经在新密钥下——后者让轮换可以中途断掉再续跑。
 *
 * 解密一律走带旧口径回退的那两个函数。对记忆家族这不是宽松：片S 之前落库的行只有旧口径，
 * 不认它就等于把这些行永久留在旧密钥下。对新口径落库的家族，回退只是多试一次就失败，
 * 不会让一把错的锁打开。
 */
export function rotateColumnPayload(
  entry: CognitiveEncryptedColumn,
  payload: string | Buffer | null,
  newKeyId: string,
  coord: CognitiveAadCoord
): string | Buffer | null {
  if (payload === null) return null;
  if (entry.kind === 'bytes') {
    const sealed = payload as Buffer;
    if (bufferKeyId(sealed) === newKeyId) return null;
    return encryptCognitiveBuffer(decryptCognitiveBuffer(sealed, coord), coord);
  }
  const sealed = payload as string;
  if (cipherKeyId(sealed) === newKeyId) return null;
  return encryptCognitiveString(decryptCognitiveString(sealed, coord), coord);
}