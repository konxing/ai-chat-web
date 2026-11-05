import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decryptBuffer, decryptString, encryptBuffer, encryptString } from '@/lib/crypto';
import {
  COGNITIVE_AAD_SCHEMA_VERSION,
  cognitiveAad,
  decryptCognitiveBuffer,
  decryptCognitiveString,
  encryptCognitiveBuffer,
  encryptCognitiveString,
  legacyCognitiveAad,
  type CognitiveAadCoord
} from '@/lib/cognitive/aad';

/**
 * 任务书 5.2：AAD 应绑 userId / recordId / fieldName / schemaVersion 四个坐标。
 *
 * 摸清现状之后的事实（不是猜的，逐处对过 `src/lib/cognitive/*.ts` 的 `aadFor`）：
 * - `userId`、`recordId` 一直都有。
 * - `fieldName` 只有 decision / reflection / user-profile 三家绑了；memory 这一族六处没有。
 * - `schemaVersion` 全仓没有这个名字，但每条字符串里那个字面量 `v1` 干的就是这个活。
 *   这里把它请出来变成一个有名字的常量，而不是再造第二个版本号——一个东西有两个版本号，
 *   迟早会互相不一致，那时候谁也不知道该信哪一个。
 *
 * 所以这一片补的是那六处的 `fieldName` 段。它**不改库里已有的行的封口**：
 * 那些行是旧口径封的，唯一的办法是新写的行走新口径、读的时候继续认旧口径。
 * 下面第 3、4 条用例钉的就是这件事——它是这一片唯一的红线：
 * **绝不能让一句已经落库的话因为口径变了而读不回来。** 那是数据丢失，不是重构。
 *
 * 第 5、6 条钉的是回退没有把闸门放宽：两个口径互不通用，回退只认它那一种旧形状。
 * 第 7 条是 fieldName 这一段真正买到的东西：同一行、同一个人、同一个 id，
 * 换一个字段名就打不开——把 A 列的密文搬到 B 列这件事，从此是失败的解密而不是成功读出别人的话。
 */

const USER = 'user-aad-test';
const RECORD = 'rec-aad-test';

const coord = (overrides: Partial<CognitiveAadCoord> = {}): CognitiveAadCoord => ({
  purpose: 'memory',
  userId: USER,
  recordId: RECORD,
  fieldName: 'contentCiphertext',
  ...overrides
});

describe('AAD 四坐标：字符串的形状', () => {
  it('新口径把四个坐标按 purpose / 版本 / userId / recordId / fieldName 拼出来', () => {
    expect(cognitiveAad(coord())).toBe(`memory:v${COGNITIVE_AAD_SCHEMA_VERSION}:${USER}:${RECORD}:contentCiphertext`);
  });

  it('schemaVersion 是这一族唯一的版本号：字符串里那一段就是它，不是另写的字面量', () => {
    expect(COGNITIVE_AAD_SCHEMA_VERSION).toBe(1);
    expect(cognitiveAad(coord({ purpose: 'memory-evidence' }))).toContain(`:v${COGNITIVE_AAD_SCHEMA_VERSION}:`);
    // 旧形状和新形状共用同一个版本号——它们的分别是「有没有 fieldName 那一段」，不是两个版本。
    expect(legacyCognitiveAad(coord())).toBe(`memory:v${COGNITIVE_AAD_SCHEMA_VERSION}:${USER}:${RECORD}`);
  });

  it('旧口径就是新口径少了最后一段：库里的行只可能长成这个样子', () => {
    expect(legacyCognitiveAad(coord())).toBe(`${cognitiveAad(coord()).slice(0, -':contentCiphertext'.length)}`);
  });
});

describe('AAD 四坐标：旧行必须还能读回来', () => {
  it('用旧口径封的记忆，走新的读法解得开（这就是「带旧密文回退」那句话）', () => {
    const sealedWithLegacy = encryptString('我在用 Next.js 15', legacyCognitiveAad(coord()));

    expect(decryptCognitiveString(sealedWithLegacy, coord())).toBe('我在用 Next.js 15');
  });

  it('新口径写进去的行，读法照样取得回来——写入和读取用的是同一个配方', () => {
    const sealedWithNew = encryptCognitiveString('我住在杭州', coord());

    expect(decryptCognitiveString(sealedWithNew, coord())).toBe('我住在杭州');
    // 并且它真的是新口径封的，不是回退帮它蒙过去的。
    expect(() => decryptString(sealedWithNew, legacyCognitiveAad(coord()))).toThrow();
  });

  it('两个口径互不通用：回退只认它那一种形状，不是「打不开就再试一次」的万能钥匙', () => {
    const legacy = encryptString('上周我把服务器迁了', legacyCognitiveAad(coord()));

    expect(() => decryptString(legacy, cognitiveAad(coord()))).toThrow();
  });

  it('同一个人同一条行，换一个字段名打不开：搬列就是失败的解密', () => {
    const content = encryptCognitiveString('我把碗筷洗了一遍', coord());

    expect(() => decryptCognitiveString(content, coord({ fieldName: 'embeddingCiphertext' }))).toThrow();
  });

  it('换 userId 打不开：坐标里那一段一直是用户隔离', () => {
    const mine = encryptCognitiveString('我决定辞职', coord());

    expect(() => decryptCognitiveString(mine, coord({ userId: 'user-other' }))).toThrow();
  });
});

describe('AAD 四坐标：记忆这一族的封口不许再有第二处手写', () => {
  // 逐个文件扫，而不是只数已知那五个：这一片的价值全在「一个用途只有一个封口」。
  // 将来新开一张表随手写一个 `memory-thing:v1:${userId}:${id}`，加表的人不会想起回头改这里，
  // 但这条用例会红——那正是我希望它拦住的东西。
  //
  // 这一条只管记忆这一族六个用途，不管 decision / reflection / user-profile：那三家本来就绑了字段名，
  // 把它们挪进同一个 builder 是纯改名，字符串一个字节都不变，却要重排二十五处调用点——
  // 为一个静态断言好看去动已经正确的加密路径，风险收益不划算。它们留在原地，理由记在验收文档里。
  it('src/lib/cognitive 里没有第二处手写这六个用途的封口', () => {
    const dir = 'src/lib/cognitive';
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && name !== 'aad.ts')
      .filter((name) => {
        const source = readFileSync(`${dir}/${name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        return /[`'"]memory(?:-[a-z]+)*:v\d:/.test(source);
      });

    expect(offenders).toEqual([]);
  });
});

describe('AAD 四坐标：向量列那一族（Buffer 不是 String）', () => {
  const packed = Buffer.from([1, 2, 3, 4]);

  it('旧口径封的向量，走新的读法解得开', () => {
    const sealedWithLegacy = encryptBuffer(packed, legacyCognitiveAad(coord({ purpose: 'memory-vector' })));

    expect(decryptCognitiveBuffer(sealedWithLegacy, coord({ purpose: 'memory-vector' }))).toEqual(packed);
  });

  it('新口径写的向量读得回来，且旧口径打不开', () => {
    const sealedWithNew = encryptCognitiveBuffer(packed, coord({ purpose: 'memory-vector' }));

    expect(decryptCognitiveBuffer(sealedWithNew, coord({ purpose: 'memory-vector' }))).toEqual(packed);
    expect(() => decryptBuffer(sealedWithNew, legacyCognitiveAad(coord({ purpose: 'memory-vector' })))).toThrow();
  });
});
