import { decryptBuffer, decryptString, encryptBuffer, encryptString } from '@/lib/crypto';

/**
 * 认知层密文的 AAD 口径（任务书 5.2）。
 *
 * 四个坐标：`purpose + schemaVersion` / `userId` / `recordId` / `fieldName`。
 * 前三个这一族一直都有，缺的是最后那一段——它管的是「同一行里 A 列的密文搬到 B 列」这种替换：
 * 没有 fieldName 时两处共用一个封口，搬过去照样解得开；有了它，那是一次失败的解密。
 *
 * `schemaVersion` 不是新加的一段，而是把每条字符串里本来就有的那个字面量 `v1` 提成一个有名字的常量。
 * 一个东西如果同时有两个版本号，迟早会互相不一致，那时候没人知道该信哪一个。
 *
 * **为什么读侧要留旧口径。** 库里的行是「没有 fieldName」那一种封的，改口径不会让旧密文跟着变。
 * 唯一的办法是新写的行走新口径、读的时候两种都认——写侧永远只写新的，所以这个回退不是把闸门放宽：
 * 一行今天新写入的密文，用旧口径打不开（`cognitive-aad.test.ts` 第 5、6 条钉的就是这个）。
 * 反过来如果哪天有人把回退删了，库里已有的话会读不回来，那是数据丢失，不是清理。
 */

export const COGNITIVE_AAD_SCHEMA_VERSION = 1;

/**
 * 六个用途就是这六条字符串里的那一段。写在这里而不是散在五个模块里：
 * 两个模块共用一个用途字符串，等于两处密文可以互换，那正是要挡的事。
 */
export type CognitiveAadPurpose =
  | 'memory'
  | 'memory-revision'
  | 'memory-evidence'
  | 'memory-exclusion'
  | 'memory-candidate'
  | 'memory-vector';

export type CognitiveAadCoord = {
  purpose: CognitiveAadPurpose;
  userId: string;
  recordId: string;
  /** 密文列的名字。用它是因为要挡的就是「同名列之间互换」，别为一个更好听的别名再造一套坐标。 */
  fieldName: string;
};

export function cognitiveAad(coord: CognitiveAadCoord): string {
  return `${coord.purpose}:v${COGNITIVE_AAD_SCHEMA_VERSION}:${coord.userId}:${coord.recordId}:${coord.fieldName}`;
}

/** 2026-11-06 之前落库的那些行的封口。它只被读侧用到，写侧一处都不该出现。 */
export function legacyCognitiveAad(coord: CognitiveAadCoord): string {
  return `${coord.purpose}:v${COGNITIVE_AAD_SCHEMA_VERSION}:${coord.userId}:${coord.recordId}`;
}

export function encryptCognitiveString(plaintext: string, coord: CognitiveAadCoord): string {
  return encryptString(plaintext, cognitiveAad(coord));
}

export function decryptCognitiveString(payload: string, coord: CognitiveAadCoord): string {
  try {
    return decryptString(payload, cognitiveAad(coord));
  } catch {
    return decryptString(payload, legacyCognitiveAad(coord));
  }
}

export function encryptCognitiveBuffer(plaintext: Buffer, coord: CognitiveAadCoord): Buffer {
  return encryptBuffer(plaintext, cognitiveAad(coord));
}

export function decryptCognitiveBuffer(payload: Buffer, coord: CognitiveAadCoord): Buffer {
  try {
    return decryptBuffer(payload, cognitiveAad(coord));
  } catch {
    return decryptBuffer(payload, legacyCognitiveAad(coord));
  }
}
