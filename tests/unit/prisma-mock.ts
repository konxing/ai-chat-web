/**
 * 认知测试共用的 prisma 替身。
 *
 * 为什么要有这一份：每个认知测试文件各自养一个 `satisfies/matches` 求值器，
 * 五份副本已经开始漂移（有的支持 `in`，有的不支持 `orderBy`）。后台队列这套东西
 * 恰恰靠「谁能被领走」的谓词成立，谓词解释错了测试就成了装饰，所以这一份要把
 * 时间比较、排序、自增、唯一约束冲突都补齐，并且只有一份实现。
 *
 * 队列/worker 之外，它现在还是 `chat-message-route-side-effects.test.ts` 那条**读侧**断言的替身，
 * 所以 `notIn`、顶层 `AND`/`OR`、`groupBy`、`findUnique`、标量数组的 `hasSome` 按
 * `memories.ts` / `evidence.ts` / `preferences.ts` / `access.ts` 的真实谓词形状补齐——
 * 一处能力只服务一个真实消费者，不预先铺没人用的分支。
 *
 * 它依旧是**求值器不是 SQL**：`updateMany` 的并发安全靠的是真库的行锁，这里换不来。
 * 这一层能证明的是协议形状，不是原子性——边界写在 docs/cognitive-acceptance.md。
 */

type Condition = unknown;
type Where = Record<string, Condition> | undefined;

export type Row = Record<string, unknown>;

function comparable(value: unknown): number | string | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

/** 时间字段的先后比较：`lt`/`lte`/`gt`/`gte` 只在这上面有定义，比不了就当不匹配。 */
function ordered(field: unknown, bound: unknown): { left?: number | string; right?: number | string } {
  return { left: comparable(field), right: comparable(bound) };
}

export function satisfies(field: unknown, condition: Condition): boolean {
  if (condition === undefined) return true;
  if (condition === null) return field === null || field === undefined;
  if (typeof condition !== 'object') return field === condition;
  const c = condition as Record<string, unknown>;
  if ('notIn' in c) return !(c.notIn as unknown[]).includes(field);
  if ('in' in c) return (c.in as unknown[]).includes(field);
  // 标量列数组（`String[]`）的「至少命中一个」：访问表按 memoryIds 找轮次用的就是它。
  if ('hasSome' in c) return Array.isArray(field) && (c.hasSome as unknown[]).some((v) => field.includes(v));
  if ('not' in c && !('lt' in c) && !('lte' in c) && !('gt' in c) && !('gte' in c)) {
    return !satisfies(field, c.not);
  }
  if ('lt' in c || 'lte' in c || 'gt' in c || 'gte' in c) {
    const { left, right } = ordered(
      field,
      c.lt ?? c.lte ?? c.gt ?? c.gte
    );
    if (left === undefined || right === undefined) return false;
    if ('lt' in c && !(left < right)) return false;
    if ('lte' in c && !(left <= right)) return false;
    if ('gt' in c && !(left > right)) return false;
    if ('gte' in c && !(left >= right)) return false;
    return true;
  }
  return field === condition;
}

/**
 * 顶层 `AND` / `OR` 里装的是**完整的 where**，不是某一列的条件，所以这里递归的是 matches 而不是 satisfies。
 * Prisma 允许写成对象或数组（`AND: {...}` / `AND: [{...}, {...}]`），两种都收。
 * `NOT` 没有调用方，就不先写一份没人跑的取反。
 */
function branches(condition: unknown): unknown[] {
  return Array.isArray(condition) ? condition : [condition];
}

export function matches(row: Row, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'AND') return branches(condition).every((branch) => matches(row, branch as Where));
    if (field === 'OR') return branches(condition).some((branch) => matches(row, branch as Where));
    return satisfies(row[field], condition);
  });
}

/** orderBy 只支持单字段（真用法就这一种）；不写顺序时保持插入顺序。 */
function sorted(rows: Row[], orderBy: unknown): Row[] {
  const entry = Object.entries((orderBy ?? {}) as Record<string, string>)[0];
  if (!entry) return rows;
  const [field, direction] = entry;
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = comparable(a[field]);
    const right = comparable(b[field]);
    if (left === undefined || right === undefined) return 0;
    return left < right ? -sign : left > right ? sign : 0;
  });
}

function projected(row: Row, select: unknown): Row {
  if (!select) return { ...row };
  const keys = Object.entries(select as Record<string, boolean>)
    .filter(([, on]) => on)
    .map(([key]) => key);
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

export interface MockTable {
  rows: Map<string, Row>;
  /** 直接塞行：不走 create，所以时间戳完全由测试决定。 */
  seed(...rows: Row[]): MockTable;
  findMany(args: { where?: Where; orderBy?: unknown; take?: number; select?: unknown }): Promise<Row[]>;
  findFirst(args: { where?: Where; orderBy?: unknown }): Promise<Row | null>;
  /** 按唯一键取一行，取不到就是 null——偏好表的「没配过 = 用默认值」全靠这个返回值区分。 */
  findUnique(args: { where: Where }): Promise<Row | null>;
  /**
   * 分组计数。只做 `_count._all`（今天唯一的用法：证据表按 `memoryId + kind` 数条数），
   * `_sum` / `_avg` 这些没有调用方，就不写一份没人验证过的聚合。
   */
  groupBy(args: { by: string[]; where?: Where; _count?: Record<string, boolean> }): Promise<
    Array<Row & { _count: { _all: number } }>
  >;
  create(args: { data: Row }): Promise<Row>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
  deleteMany(args: { where?: Where }): Promise<{ count: number }>;
  count(args: { where?: Where }): Promise<number>;
}

export interface TableOptions {
  /** 唯一约束：字段名数组，命中就抛 P2002，和真库一样让调用方自己去分诊。 */
  unique?: string[][];
  /** 主键字段名，默认 id。 */
  idField?: string;
  /**
   * 列默认值，对应 schema 里的 `@default(...)` 与可空列的 null。
   * 必须由夹具补上：真库在建行时填这些列，服务层代码读它们（领取看 status、
   * 退避算 attempts、候选比 availableAt）。不补的话 create 出来的行只有调用方
   * 传的那几列，「新行是 PENDING」测到的是替身漏掉的列，不是这张表。
   */
  defaults?: () => Row;
}

export function createTable(options: TableOptions = {}): MockTable {
  const idField = options.idField ?? 'id';
  const unique = options.unique ?? [];
  const rows = new Map<string, Row>();
  /** 同一毫秒内连续建行也要能排出先后，所以时间戳单调递增一毫秒。 */
  let tick = 0;
  const stamp = () => new Date(Date.now() + (tick += 1));
  /** 顶替 `@default(uuid())`：只要每行不同就够，测试要断的是「键不撞」。 */
  let sequence = 0;

  const violating = (candidate: Row): boolean =>
    unique.some((fields) =>
      [...rows.values()].some(
        (row) =>
          row[idField] !== candidate[idField] &&
          fields.every((field) => comparable(row[field]) === comparable(candidate[field]))
      )
    );

  const table: MockTable = {
    rows,
    seed(...seeded) {
      for (const row of seeded) rows.set(String(row[idField]), row);
      return table;
    },
    findMany({ where, orderBy, take, select }) {
      const found = sorted(
        [...rows.values()].filter((row) => matches(row, where)),
        orderBy
      );
      return Promise.resolve(found.slice(0, take ?? found.length).map((row) => projected(row, select)));
    },
    findFirst({ where, orderBy }) {
      const found = sorted(
        [...rows.values()].filter((row) => matches(row, where)),
        orderBy
      )[0];
      return Promise.resolve(found ? { ...found } : null);
    },
    /**
     * 单列唯一键够用：今天的调用方是 `{ userId }`（偏好表）。
     * 复合唯一在 Prisma 里写成 `{ userId_context: {...} }`，那种形状这里解不开，
     * 传进来只会得到 null——真要用它的测试出现时再补，而不是先写一份没人调的解析。
     */
    findUnique({ where }) {
      const found = [...rows.values()].find((row) => matches(row, where));
      return Promise.resolve(found ? { ...found } : null);
    },
    groupBy({ by, where }) {
      const groups = new Map<string, { key: Row; count: number }>();
      for (const row of [...rows.values()].filter((item) => matches(item, where))) {
        const key = Object.fromEntries(by.map((field) => [field, row[field]]));
        const signature = JSON.stringify(by.map((field) => row[field] ?? null));
        const group = groups.get(signature);
        if (group) group.count += 1;
        else groups.set(signature, { key, count: 1 });
      }
      return Promise.resolve(
        [...groups.values()].map((group) => ({ ...group.key, _count: { _all: group.count } }))
      );
    },
    create({ data }) {
      const now = stamp();
      const row: Row = {
        [idField]: `row-${(sequence += 1)}`,
        createdAt: now,
        updatedAt: now,
        ...(options.defaults ? options.defaults() : {}),
        ...data
      };
      if (violating(row)) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed on the fields'), { code: 'P2002' })
        );
      }
      rows.set(String(row[idField]), row);
      return Promise.resolve({ ...row });
    },
    updateMany({ where, data }) {
      const targets = [...rows.values()].filter((row) => matches(row, where));
      for (const row of targets) {
        for (const [field, value] of Object.entries(data)) {
          const increment = (value as { increment?: number } | undefined)?.increment;
          row[field] =
            increment !== undefined ? Number(row[field] ?? 0) + increment : value;
        }
        row.updatedAt = stamp();
      }
      return Promise.resolve({ count: targets.length });
    },
    deleteMany({ where }) {
      const targets = [...rows.values()].filter((row) => matches(row, where));
      for (const row of targets) rows.delete(String(row[idField]));
      return Promise.resolve({ count: targets.length });
    },
    count({ where }) {
      return Promise.resolve([...rows.values()].filter((row) => matches(row, where)).length);
    }
  };
  return table;
}
