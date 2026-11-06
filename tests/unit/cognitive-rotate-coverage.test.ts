import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cipherKeyId, decryptString, encryptString } from '@/lib/crypto';
import { resetEnvCacheForTests } from '@/lib/env';
import { decryptCognitiveBuffer, encryptCognitiveBuffer } from '@/lib/cognitive/aad';
import {
  COGNITIVE_ENCRYPTED_COLUMNS,
  cognitiveColumnAad,
  cognitiveColumnCoord,
  cognitiveFieldAad,
  rotateColumnPayload
} from '@/lib/cognitive/encrypted-columns';

/**
 * 密钥轮换的覆盖面（片S 顺手量到的那个缺口）。
 *
 * `scripts/rotate-keys.ts` 的头注释宣称 re-encrypts every encrypted database field，
 * 而它的模型清单只有 chat / message / aiProvider / attachment 四条——认知侧 25 个密文列一行都不重裹。
 * 旧密钥还留在 MASTER_KEYRING 里，所以这不是数据损坏，是**注释在撒谎 + 轮换后那 25 列事实上仍在旧密钥之下**。
 *
 * 补法只有一种站得住：**把「哪个模型的哪一列用哪把封口」收成一张表**，写侧和轮换侧都查它。
 * 只要脚本里还手抄着一份 AAD 串，下一个新增的密文列就还会漏——漏的方式和这次一模一样。
 * 所以这一片真正的验收物不是「脚本跑通了」，是这四件事：
 *
 * 一、**表和 schema 逐列对照**（A 组）。新增加密列而没进表 → 红。这条是自动的，靠人不记得列名是没用的。
 * 二、**写侧短名和轮换侧列名查到同一条目**（A2）。`decisions.ts` 里那把封口用的是 `'topic'`，
 *     轮换只知道列名 `topicCiphertext`；两个查法必须给出同一个串，否则轮换是在换一把错的锁。
 * 三、**真用两把密钥转一次**（B 组，直接调 `@/lib/crypto`，不碰数据库）。
 *     其中 B3 是「读侧旧口径回退什么时候才能删」的唯一入口：量出来的结论是**还不能删**——
 *     只有完整跑过一次本片轮换的库，才把所有旧封口换成了新封口。
 * 四、**非认知家族一寸都不许动**（C4）。`chat-title:` / `message:` / `file:` 那几把封口如果跟着口径表改了，
 *     历史聊天记录会当场读不回来——那才是真的数据损坏。
 */

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');

function useKeys(primaryId: string, primaryKey: string, ring: Record<string, string>) {
  process.env.MASTER_KEY_ID = primaryId;
  process.env.MASTER_KEY = primaryKey;
  process.env.MASTER_KEYRING = JSON.stringify(ring);
  resetEnvCacheForTests();
}

/** 轮换前的世界：主密钥是 ka，kb 还没进环。 */
function beforeRotation() {
  useKeys('ka', keyA, {});
}

/** 轮换中的世界：脚本已经把 kb 装进环并设成主密钥，ka 仍可读。 */
function afterKeyInstall() {
  useKeys('kb', keyB, { ka: keyA });
}

function source(file: string): string {
  return readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

describe('覆盖表和 schema 逐列对照', () => {
  it('认知九个模型的每个密文列都在表里，表里也没有多余的条目', () => {
    const schema = source('prisma/schema.prisma');
    const cognitiveModels = [
      'MemoryItem',
      'MemoryRevision',
      'MemoryEvidence',
      'MemoryExclusion',
      'MemoryCandidate',
      'DecisionRecord',
      'DecisionOutcome',
      'ReflectionRecord',
      'UserProfileEntry'
    ];
    const fromSchema: string[] = [];
    let current = '';
    for (const line of schema.split(/\r?\n/)) {
      const model = /^model (\w+) /.exec(line);
      if (model) current = model[1];
      const column = /^\s+(\w*Ciphertext)\s/.exec(line);
      if (column && cognitiveModels.includes(current)) fromSchema.push(`${current}.${column[1]}`);
    }
    const fromTable = COGNITIVE_ENCRYPTED_COLUMNS.map((entry) => `${entry.model}.${entry.column}`).sort();

    // 少一条 = 那一列轮换不到；多一条 = 脚本会去 update 一个不存在的列。
    expect(fromTable).toEqual([...fromSchema].sort());
    expect(fromTable.length).toBe(25);
  });

  it('写侧的短名和轮换侧的列名查到同一条封口', () => {
    for (const entry of COGNITIVE_ENCRYPTED_COLUMNS) {
      const byColumn = cognitiveColumnAad(entry.model, entry.column, 'user-1', 'row-1');
      const byField = cognitiveFieldAad(entry.model, entry.field, 'user-1', 'row-1');
      expect(byField, `${entry.model}.${entry.column}`).toBe(byColumn);
    }
  });

  it('每把封口都带上四坐标，且列名与短名各自唯一', () => {
    const seenColumn = new Set<string>();
    const seenField = new Set<string>();
    for (const entry of COGNITIVE_ENCRYPTED_COLUMNS) {
      const key = `${entry.model}.${entry.column}`;
      expect(seenColumn.has(key), key).toBe(false);
      seenColumn.add(key);
      const fieldKey = `${entry.model}.${entry.field}`;
      expect(seenField.has(fieldKey), fieldKey).toBe(false);
      seenField.add(fieldKey);
      // 串的形状：purpose:v1:userId:recordId:fieldName。少了最后一段就是片S 之前的旧口径。
      expect(cognitiveColumnAad(entry.model, entry.column, 'u', 'r')).toBe(
        `${entry.purpose}:v1:u:r:${entry.field}`
      );
    }
  });

  it('历史口径逐字保留：短名那一族不能跟着记忆家族改成列名', () => {
    // 上面 A3 是从表自己推出来的，改错了也自洽。这五条是钉死的库里已有密文：
    // 决策 / 反思 / 画像从第一版起就是短名，改成列名等于让历史行全部解不开。
    expect(cognitiveColumnAad('MemoryItem', 'contentCiphertext', 'u', 'r')).toBe(
      'memory:v1:u:r:contentCiphertext'
    );
    expect(cognitiveColumnAad('DecisionRecord', 'topicCiphertext', 'u', 'r')).toBe(
      'decision:v1:u:r:topic'
    );
    expect(cognitiveColumnAad('DecisionOutcome', 'actualCiphertext', 'u', 'r')).toBe(
      'decision-outcome:v1:u:r:actual'
    );
    expect(cognitiveColumnAad('ReflectionRecord', 'titleCiphertext', 'u', 'r')).toBe(
      'reflection:v1:u:r:title'
    );
    expect(cognitiveColumnAad('UserProfileEntry', 'contentCiphertext', 'u', 'r')).toBe(
      'user-profile:v1:u:r:content'
    );
  });

  it('只有向量那一列是 Bytes，其余走字符串密文格式', () => {
    const bytes = COGNITIVE_ENCRYPTED_COLUMNS.filter((entry) => entry.kind === 'bytes');
    expect(bytes.map((entry) => `${entry.model}.${entry.column}`)).toEqual(['MemoryItem.embeddingCiphertext']);
    expect(COGNITIVE_ENCRYPTED_COLUMNS.filter((entry) => entry.kind === 'string')).toHaveLength(24);
  });

  it('prisma 的模型键由表给，不在脚本里靠字符串小写猜', () => {
    const schemaModels = new Set([...source('prisma/schema.prisma').matchAll(/^model (\w+) /gm)].map((m) => m[1]));
    for (const entry of COGNITIVE_ENCRYPTED_COLUMNS) {
      // 脚本拿 entry.client 去索引 prisma 对象，所以它必须由表给出、且真对应 schema 里的模型。
      expect(entry.client).toBe(`${entry.model[0].toLowerCase()}${entry.model.slice(1)}`);
      expect(schemaModels.has(entry.model), entry.model).toBe(true);
    }
  });
});

describe('真转一次：两把密钥、不碰数据库', () => {
  beforeEach(() => beforeRotation());

  it('旧密钥封的字符串列转完之后，用同一个坐标在新密钥下解得开', () => {
    const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.model === 'DecisionRecord')!;
    const coord = cognitiveColumnCoord(entry.model, entry.column, 'user-1', 'row-1');
    const aad = cognitiveColumnAad(entry.model, entry.column, 'user-1', 'row-1');
    const sealed = encryptString('周末去爬山', aad);
    expect(cipherKeyId(sealed)).toBe('ka');

    afterKeyInstall();
    const rotated = rotateColumnPayload(entry, sealed, 'kb', coord);
    expect(typeof rotated).toBe('string');
    expect(cipherKeyId(rotated as string)).toBe('kb');
    expect(decryptString(rotated as string, aad)).toBe('周末去爬山');
  });

  it('已经在新密钥下的行返回 null——轮换因此能中途断了再续跑', () => {
    const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.model === 'ReflectionRecord')!;
    afterKeyInstall();
    const coord = cognitiveColumnCoord(entry.model, entry.column, 'user-1', 'row-1');
    const aad = cognitiveColumnAad(entry.model, entry.column, 'user-1', 'row-1');
    const sealed = encryptString('这句已经是新密钥了', aad);

    expect(rotateColumnPayload(entry, sealed, 'kb', coord)).toBeNull();
  });

  it('载荷是 null 就什么都不做（那一列今天没写过）', () => {
    const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.column === 'embeddingCiphertext')!;
    const coord = cognitiveColumnCoord(entry.model, entry.column, 'user-1', 'row-1');
    expect(rotateColumnPayload(entry, null, 'kb', coord)).toBeNull();
  });

  it('记忆正文的旧封口转完之后只剩新口径——而今天还删不掉那个回退', () => {
    const entry = COGNITIVE_ENCRYPTED_COLUMNS.find(
      (item) => item.model === 'MemoryItem' && item.column === 'contentCiphertext'
    )!;
    const coord = cognitiveColumnCoord(entry.model, entry.column, 'user-1', 'row-1');
    // 片S 之前落库的那批行：purpose:v1:userId:recordId，没有 fieldName 那一段。
    const legacyAad = 'memory:v1:user-1:row-1';
    const sealed = encryptString('我姐下个月生孩子', legacyAad);

    afterKeyInstall();
    const rotated = rotateColumnPayload(entry, sealed, 'kb', coord) as string;
    // 新口径解得开……
    expect(decryptString(rotated, cognitiveColumnAad(entry.model, entry.column, 'user-1', 'row-1'))).toBe(
      '我姐下个月生孩子'
    );
    // ……旧口径解不开：轮换把那一行升到了带 fieldName 的封口上。
    expect(() => decryptString(rotated, legacyAad)).toThrow();
    // 但没跑过轮换的库里，旧封口那批行仍然只靠读侧回退才解得开，所以回退现在还不能删。
    expect(decryptString(sealed, legacyAad)).toBe('我姐下个月生孩子');
  });

  it('Bytes 列（向量）转完之后是新密钥下的封包，内容一个字节都没变', () => {
    const entry = COGNITIVE_ENCRYPTED_COLUMNS.find((item) => item.column === 'embeddingCiphertext')!;
    const coord = cognitiveColumnCoord(entry.model, entry.column, 'user-1', 'row-1');
    const vector = Buffer.from([1, 2, 3, 4, 5, 6]);
    const sealed = encryptCognitiveBuffer(vector, coord);
    expect(Buffer.from(sealed).subarray(5, 7).toString('utf8')).toContain('ka');

    afterKeyInstall();
    const rotated = rotateColumnPayload(entry, sealed, 'kb', coord);
    expect(Buffer.isBuffer(rotated)).toBe(true);
    expect(decryptCognitiveBuffer(rotated as Buffer, coord).equals(vector)).toBe(true);
  });
});

describe('封口串只有一个出处', () => {
  it('认知目录里除 aad.ts 和覆盖表之外，没有第二个文件自己拼 :v1: 串', () => {
    const dir = path.resolve(process.cwd(), 'src/lib/cognitive');
    const files = readdirSync(dir);
    const allowed = ['aad.ts', 'encrypted-columns.ts'];
    const builders = files.filter(
      (file) =>
        file.endsWith('.ts') &&
        !allowed.includes(file) &&
        // 只看代码：解释口径的注释里出现 `:v1:` 不是第二个建造者。
        /:v1:|:v\$\{|v\$\{COGNITIVE_AAD_SCHEMA_VERSION\}/.test(
          source(`src/lib/cognitive/${file}`)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
        )
    );
    expect(builders).toEqual([]);
  });

  it('十一个写入方文件全部改成查覆盖表', () => {
    const writers = [
      'memories.ts',
      'evidence.ts',
      'exclusions.ts',
      'memory-candidates.ts',
      'embedding.ts',
      'decisions.ts',
      'decision-module.ts',
      'reflections.ts',
      'reflection-sweep.ts',
      'user-profile.ts',
      'profile-reads.ts'
    ];
    for (const file of writers) {
      const code = source(`src/lib/cognitive/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).toMatch(/from '\.\/encrypted-columns'/);
      expect(code, file).toMatch(/cognitiveColumnAad|cognitiveFieldAad|cognitiveColumnCoord/);
    }
  });

  it('轮换脚本遍历覆盖表，源码里没有手抄的认知封口串', () => {
    const code = source('scripts/rotate-keys.ts');
    expect(code).toContain('encrypted-columns');
    expect(code).toContain('COGNITIVE_ENCRYPTED_COLUMNS');
    // 只 import 不遍历是满足不了这条的：真正重裹每一行必须靠这张表驱动。
    expect(code).toMatch(/for \(const entry of COGNITIVE_ENCRYPTED_COLUMNS\)/);
    expect(code).toContain('rotateColumnPayload(entry,');
    // 认知那 25 把锁一把都不许在脚本里重写一遍。
    expect(code).not.toMatch(/(memory|decision|reflection|user-profile)(-\w+)?:v1:/);
  });

  it('非认知家族的封口一寸都没动', () => {
    const code = source('scripts/rotate-keys.ts');
    // 这四把（加文件那一把）改一个字符，历史数据当场读不回来。
    for (const literal of ['`chat-title:${', '`message:${', '`provider-key:${', '`attachment-name:${', '`file:${']) {
      expect(code, literal).toContain(literal);
    }
    const chat = source('src/lib/chats.ts');
    expect(chat).toContain('chat-title:');
  });
});
