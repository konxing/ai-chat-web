# 认知层验收清单（任务书 7.4 十条门槛）

这份文档只回答一个问题：**每条门槛今天真被哪个测试守着、守到哪一层、边界在哪。**
它不是通过率报告。写它的那天（11-03）十条里有四条**无对象可验**，11-04 那批落地后这四条改判「部分验收」——
模块有了、服务端证据链有了，缺的是真库那一层与界面只渲染到初次挂载那一层（各门槛状态行单独标注，Phase 5/6 判词在文末两节；库里今天到底有几行、后台跑成什么样，统一写在「真库实况」一节，本文其余各处只按那一节的数字说话）。
其余每一条的证据都止于内存替身——没有一条认知单测走过真实数据库。
把这些写清楚比凑一个「10/10」有用——下一次争论「这个增强要不要上」时，这里是共同的事实基线。

核对时间：2026-11-05（7.2 的 ARCHIVE 落地；之后 7.1 检索再巩固与 7.3 按主题忘记 + 暂停写入两片落地，**那两片带的迁移 `20261106000000_memory_access` / `20261106000001_memory_write_pause` 已由我在他的批准下执行**——「你直接跑迁移就行了」，`npx prisma migrate status` 报 17 支全部 up to date，库里没有漂移的列。跑完立刻补了一次真库回滚探针，把两片各自「只有替身验过」那两条边界换成了实测数字，见下面两片的边界表）。
基线 HEAD `de70c83`（7.3 的代码与文档同批；本文档这次只改迁移状态与真库实测两处口径）。
全量单测 **81 个文件 1225 条用例**通过（`npx vitest run`），`npx tsc --noEmit` 干净。
Phase 4 之后新增的认知文件把 58 个文件 / 734 条推到 77 / 1066；**Phase 4—6 的界面那几半一条组件测试都没加**——
这个项目没有组件测试，能测的部分搬进纯函数模块，剩下那句话在各片边界表里单独写着。

## 先说清证据的分层

本仓库**没有任何认知单测走真实数据库**。`vitest.config.ts:10` 只收 `tests/unit/**/*.test.ts`，
这些文件对数据库与网络边界的处理分五类，本文每条证据都会标是哪一类（下面引用的 `cognitive-forgetting.test.ts` 行号已随 6-H 重排，全部按 11-04 现号复核过）：
本文所有测试行号在 11-04 这片做过一次机械复核——98 条引用里有 **34 条**因为测试文件先前行号漂移而对不上（不是这片改坏的，是 `e7fca9a` / `ab92040` / `9d5ab17`
那几片加用例时没回头刷新文档），现在全部按「文件里真有这条 `it`/`describe` 且标题逐字相同」重新指到位；剩下两处指向的是 `describe` 组锚点，本来就对。

| 层 | 含义 | 换不来什么 |
|---|---|---|
| **纯** | 纯函数 / fixture，无 mock | 换不来任何 I/O 行为 |
| **服务** | service 层真代码 + `vi.mock('@/lib/prisma')`（内存 Map 冒充表，加密走真 `@/lib/crypto`） | 换不来 SQL：`where` 由测试里手写的求值器解释。遗忘那套（`tests/unit/cognitive-forgetting.test.ts:39-53`）只认顶层相等、`in`、`null`，没有 `lte`/`OR`/关联/类型转换；它能按 `select` 交回指定的列，所以「读侧只取 id、不碰正文」这类断言在这套替身上是真能测的（`:130` 的 `tableClient`）；队列、worker 与本片的**路由层**用例共用另一套（`tests/unit/prisma-mock.ts`，多了 `lt`/`lte`/`gt`/`gte`、`notIn`、顶层 `AND`/`OR`、`orderBy`、`groupBy`、`findUnique`、列默认值），**两套都是替身，不是 PostgreSQL** |
| **路由** | 真 route handler + 服务或 prisma 被 mock | 换不来鉴权之外的真实数据行为。出站断言在这里拿的是 `src/lib/ai.ts:126` 序列化**之前**的 `messages` 数组 |
| **回环** | 真 `streamChatCompletion` + 真本地 HTTP 服务（请求体在服务端原样收下再解析） | 换不来 TLS 出口与线上真字节：请求方向的序列化、`providerParams` 合并、以及 Key 只进头不进体，都在这一层断；压缩与对端服务不在 |
| **离线评测** | fixture 池 + 生产纯函数（`selectMemoryCandidates` / `renderMemoryBlock`） | 换不来线上真实用户的召回质量 |

`tests/run-integration.sh` 连的是真 PostgreSQL，从 `0e5b89e` 起有一节认知断言（`Cognitive background task queue: real-database assertions`，脚本 :385-479），
覆盖 `CognitiveTask` 一张表：迁移能落到干净库、生成客户端与生产构建的新鲜度、出箱被活着的 worker 消费并作废删行、`(sourceMessageId, kind)` 唯一约束的真身、
过期租约被真实轮询回收（`attempts` 用尽判 DEAD / 没用尽回 PENDING 重跑）、日志行里没有那句话。**其余认知表（MemoryItem / MemoryRevision / MemoryExclusion / MemoryEvidence / MemoryPolicy）在真库里仍零覆盖**，
`onDelete: Cascade` 的真实外键行为也因此仍然没人验证——这是下面多条门槛共同的天花板。

这一节有个必须写清的前提出身：`0e5b89e` 之后这套断言**一次都没完整跑过**。开发机缺 `jq`、
且 `.env` 里那个应用角色 `family_chat` 的 `rolcreatedb = f`，脚本开头的 DROP/CREATE 测试库这一步就走不通（`psql: command not found` 之前实测确认过权限）。
其中不依赖服务进程的部分（迁移落库、唯一约束、僵尸行的 SQL 形状）我拿 `BEGIN … ROLLBACK` 探针在真库上逐条验过并修掉三个真错误（Message 上没有 `userId` 列、
`INSERT … SELECT 'MEMORY'` 不自动转枚举、`@default(uuid())` 在库层没有默认值），但「worker 随服务进程起来领取欠账」这类断言只有代码级证据，
**要在具备 `jq` 与建库权限的环境上跑一次才算数**。

本片给脚本补了依赖与权限预检（`tests/run-integration.sh:130-177`，硬性排在 `:186` 的 `rm -rf` 与后面的 `DROP DATABASE` 之前），原因是缺依赖会**伪装成产品回归**：
`set -e` 不终止命令替换，缺 `jq` 时构造请求体的那段静默变空，于是「expected HTTP 401, got 400」——看上去像认证坏了。现在同一台机器上第一次执行就停在：

    missing required tools: jq psql pg_dump pg_restore python3(存在但不可执行)

`python3` 单独用 `python3 -c 'import sys'` 探活（Windows 的 `WindowsApps` 存根会让 `command -v` 成功但不可执行），建库权限查的是
`rolsuper OR rolcreatedb`（超级用户的 `rolcreatedb` 同样是 `f`，只查后者会误判）加 `server_version_num >= 130000`（`DROP DATABASE … WITH (FORCE)` 要 13+）。
预检本身在本机真跑过并证明有效，**整套认知断言仍是一次都没完整跑过**。

## 十条门槛

### 1. 跨用户数据泄漏零容忍

**状态：已验收（服务层 / 路由层），真实 SQL 未验证。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:245` `AAD 绑住 userId：同一行密文换个用户解不开` | 服务（真加密） |
| `tests/unit/cognitive-memories.test.ts:380` `换情境或换类型的过滤条件不影响隔离，别人的记忆读不到` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:381` `别人的 id 删不动，返回 0，一行都没少` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:892` `别人的洞察一行都不动：条件里没带 userId 就等于跨用户删数据`（6-H 新增的派生清理同样按 userId 收） | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:904` `读引用行也带 userId：别人的引用一条都不许进这一轮的候选`（删侧带 userId 挡得住写，挡不住读；这条钉的是读） | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:991` `别人的会话 id 塞进来 ⇒ 读得到它的消息，删不掉我的任何一行`（6-H 收尾补的：路由不校验会话归属，消息那一头的查询本来就不带 userId——断言把「读确实跨了用户」和「写一行都没跟着动」同时钉住） | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:1035` `清空只清自己：别人的洞察、引用、决策一行都不动` | 服务 |
| `tests/unit/cognitive-exclusions.test.ts:226` `撤销别人的排除返回 false，一行不动` | 服务 |
| `tests/unit/cognitive-evidence.test.ts:266` `别人的证据不会抬 high 自己的记忆` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:289` `会话属于别人 ⇒ 就当没有：Message 行没有 userId，隔离锚点是 Chat.userId` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:304` `消息挂在别的会话里 ⇒ 取不到：只认 id 就等于把别人会话里的那句话记到本用户头上` | 服务 |
| `tests/unit/cognitive-memories-route.test.ts:263` `列表只按 session 用户查，查询串里的 userId 换不掉它` | 路由 |

**边界**：隔离靠的是「每条查询的 where 里带 userId」这句代码事实，而 where 的求值在测试里是那份手写匹配器。
求值器若与 Prisma 语义不一致，这类测试会一起错。加密那一层（AAD 绑 userId）是真算法，不受此限。

### 2. 敏感数据删除：所有派生数据按策略清理

**状态：已验收（限当前存在的五种派生数据；6-H 补上洞察与决策两类之后）。**

当前派生数据有五种：演化边 `MemoryRevision`、来源排除规则 `MemoryExclusion`、还没跑的认知欠账 `CognitiveTask`、
引用了被删记忆的洞察（`ReflectionRecord` + 它的 `ReflectionCitation` 行），以及某次对话产生的决策 `DecisionRecord`。

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-forgetting.test.ts:356` `指向它的演化边被摘开，活着的新版本保住「这是改口来的」这个事实` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:368` `它自己作为新版本产生的边随外键一起消失，它折叠的旧版本也不再留着` | 服务（cascade 由测试里的数组 filter 手工模拟） |
| `tests/unit/cognitive-forgetting.test.ts:420` `删除一条事件＝连它的旧版本一起删`（整组 8 条：三版链、每版各一条排除、删中间版、孤行、别人的边不引路、成环终止、按情境记证据、单事务） | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:396` `摘边、删行和建排除在同一个事务里，不走事务外的连接` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:524` `删一条就记一条排除，存的是哈希和密文，不是明文` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:622` `只清自己的，别人的记忆和演化边一行不动` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:274` `删一条记忆 ⇒ 它来源那次对话的欠账一起撤，且在同一个事务里` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:286` `别人那次对话的欠账一条都不动（同 chatId 也不行，得连 userId 一起对）` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:296` `记忆不是从对话里来的（chatId 为空）⇒ 什么都不撤：不带 chatId 是按用户全撤` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:321` `那次对话还没产出记忆（欠账还压在队列里）⇒ 撤账不能因为「没东西可删」就跳过` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:331` `清空全部 ⇒ 按用户撤干净，别人的欠账一行不动，而且这条也走事务` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:769` `删除要连带清掉派生出来的洞察与决策`（整组 **19 条**：引用即删、反证也算、读排在删之前、ACCEPTED 也删、兄弟洞察留着、链上任一版都算、别人不动（删与读各一条）、单条不碰决策、没洞察也删得掉、全在事务里、按会话收决策、引用被删决策的洞察、别的情境不动、别人的会话塞进来、清空一起清、清空只清自己、0 行也收、消息只读 id） | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:581` `命中排除表的候选既不新增也不演化` | 服务 |
| `tests/run-integration.sh:427` `作废的任务不留在库里：这张表只装还欠着的活` | 真库（**本片区未跑过**） |

**边界（四条，都得记住）**：
- 图关系还没落地；时间线派生（`src/lib/cognitive/timeline.ts`）已经落地，但它是**读时投影、不落库**，所以不进这个分母：
  删掉一行记忆，时间线上那条事件就跟着消失，没有第二份东西需要清理。
  **这句在 11-03 之前是半真话**：只删当前版本时，链上带 `supersededAt` 的旧行会作为孤立事件回到时间线上。
  「Phase 4 第四片」把 `purgeMemory` 改成沿版本链整条删之后，它才是全真（`src/lib/cognitive/forgetting.ts:178`、`:196`）。
- **洞察那一类是 6-H（11-04）才接上的**，判词是他给的三条：甲=引用即删整条洞察，「1算」=反证（`CONTRADICTS`）也算证据，
  「2一起收」=按会话删除时把该会话的决策行一起收，「3不要报」=派生删除不进文案、`PurgeResult` 不加计数。
  接上之前的真库行为是最坏那种：`ReflectionCitation.memoryId` 的级联（`prisma/schema.prisma:815`）只带走引用行，
  洞察本体留着、`dedupKey` 还占着主题位——现在两种删除都先读引用行再删记忆（`forgetting.ts:108`、`:140`）。
  **代价要说清**：洞察行删掉等于把那个主题位腾出来，之后的收割可以从剩下的证据重新提出同主题一条（不是漏洞，是甲的另一面）。
  `DecisionOutcome`（决策的结果行）**仍只由外键级联保证**（`prisma/schema.prisma:730`），代码不显式删、测试也测不到——
  它是那条决策的附属，级联方向正确，但这一类停在「schema 声明」那一层，和下面第三条同一个天花板。
- **撤销欠账只覆盖「还没被领走的行」**。租约还在、worker 正在跑的那一条撤不掉——它会在 20 秒截止内跑完并把记忆写回来。单测里 `attempts` 的领取语义有测，这个窗口没有测试，也没有对策（任务书 §6 只要「撤销还没跑的」）。
- `MemoryItem.chatId` 的 `onDelete: Cascade`（`prisma/schema.prisma:465`，`:466` sourceMessage 同）**没有任何测试断言**——
  「删会话连带删记忆」这条方向目前只由 schema 声明保证，无人验证。`CognitiveTask` 的三个外键同理，只是它的级联在真库上形状验过（`tests/run-integration.sh:438` 的插入依赖 `chatId`/`sourceMessageId` 真实存在）。
- 「回答之后写记忆」这条链路现在是两段：路由欠账（`src/app/api/chats/[id]/messages/route.ts:158` 起，`await enqueueCognitiveTask`）+ worker 执行（`src/lib/cognitive/task-worker.ts`）。
  两段的单元证据各自都在（见门槛 10 与下面这张表），真库上「一段接一段跑通」的断言写好了但没跑过。

### 3. 每条持久化记忆可追溯来源

**状态：已验收（服务层），写侧端到端缺一条。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:656` `创建记忆时留下一条支持证据，来源就是那句话所在的消息` | 服务 |
| `tests/unit/cognitive-memories.test.ts:492` `演化边记下谁取代谁、改因，以及触发它的那句话` | 服务 |
| `tests/unit/cognitive-memories.test.ts:270` `用户亲口说和确认过的必须有确认时间，推断和观察不许冒充确认` | 服务 |
| `tests/unit/cognitive-exclusions.test.ts:176` `带上来源会话和来源消息，方便日后追查这条排除是哪来的` | 服务 |
| `tests/unit/cognitive-memories-route.test.ts:273` `列表同时带回这些记忆来自哪次对话的标题，归属仍按 session 用户查` | 路由 |
| `tests/unit/cognitive-memories-route.test.ts:325` `origin 由服务端定成「用户已确认」，请求体里传什么都进不来` | 路由 |

**边界**：`sourceMessageId` 指向的 `Message` 是 `onDelete: Cascade`（`prisma/schema.prisma:447`）。
删掉原消息会把来源指针一起带走，这条行为没人测；同时手工更正的新版本继承旧 `chatId`，
「来源」在演化链上是**上一版的来源**而不是本次动作的来源——这是设计如此，但界面没说破。
再加一条：上表 `:485` 那条用例喂的是**近乎同句**的两行，而自动取代在这份**中文 fixture 语料**（虚构评测故事，不是真实用户语料）上实测 **0/36**（见「Phase 4 第三片」那一节），
所以演化边今天的实际来源主要是设置页的手工更正那条路（`src/app/api/account/cognitive/memories/[id]/route.ts:50`），不是对话里的改口。

### 4. 反思结论可追溯支持与反对证据

**状态：部分验收——服务端证据链已验收；6-F 那一屏 11-04 第一次真渲染过（入口在、组件挂得上），但行看不到、点不动，真库零行，端到端仍无法验收。**

Phase 6 在 11-04 落地到 6-E：`reflection-planner.ts`（出题，纯）→ `reflection-evidence.ts`（反证搜索 + 措辞 + EvidenceCritic，纯）
→ `reflection-sweep.ts`（落库 + 冷却 + 逐情境闸门）→ `reflections.ts`（读侧 + 状态机）。
一条洞察落库时在**同一个事务**里写 `ReflectionCitation`：支持侧 `SUPPORTS`、反证侧 `CONTRADICTS`，
每条引用要么指一行记忆、要么指一行决策（两列恰好一列为空），读侧按行把密文解回原话。

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-reflection-sweep.test.ts:493` `洞察的支持引用写 SUPPORTS 行，记忆与决策两种来源都允许但必须恰好一列非空` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:509` `只有决策证据的洞察：引用行填 decisionId、memoryId 留 null，而且不会被 critic 误判成幽灵引用` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:427` `写下去的洞察与引用行全部是同一个用户，引用只指自己读过的行` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:662` `洞察写不进库 ⇒ 一条半截的引用都不留，并把这一轮标成失败` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:567` `同主题里有一条被改过口的行 ⇒ counterHitCount 落库，正文带上余地那一句` | 服务 |
| `tests/unit/cognitive-reflection-evidence.test.ts:72` `主题命中、带否定词而支持行一个都不带 ⇒ 这才是反证` | 纯 |
| `tests/unit/cognitive-reflection-evidence.test.ts:98` `这条洞察已经引用过的行不再当成新反证：支持侧和反对侧都不许重复计数` | 纯 |
| `tests/unit/cognitive-reflection-evidence.test.ts:293` `引用了池子里没有的行 ⇒ GHOST_CITATION` | 纯 |
| `tests/unit/cognitive-reflections-service.test.ts:240` `支持证据解出记忆正文，反对证据标成 CONTRADICTS` | 服务 |
| `tests/unit/cognitive-reflections-service.test.ts:276` `决策证据解出的是主题，不是整条决策` | 服务 |

**边界（四条）**：
- 「追溯」今天在**服务层**成立：`getReflectionWithCitations` 把引用行带回并解密，路由把这份形状原样发出
  （`tests/unit/cognitive-reflections-route.test.ts:149`）。**用户那一侧只量到一半**：11-04 起他的服务、登进去，
  设置页导航里真的有「洞察」，`ReflectionPanel` 用 `react-dom/server` 渲一次也不抛错；
  但这台浏览器替身（视口 0×0、`visibilityState=hidden`、实测 `requestAnimationFrame` 一次都不回调）
  始终没把流式边界里的那棵子树 hydrate 上——按钮上没有 `__reactProps`，`click()` 切不动 tab，
  所以「点开看得到证据链」这一寸**仍然无法验收**。物证与推断的界线在文末 6-G 那一节。
- **真库零行**：`reflectionEnabled` 默认关，`ReflectionRecord` / `ReflectionCitation` 实测各 **0 行**（表已随迁移落库，见「真库实况」），没有任何一条洞察在真库里存在过。注意这和 `MemoryItem` 已经**不是** 0 行是两件事。
  上面全部是内存求值器（`tests/unit/prisma-mock.ts`）上的证据。
- 单测里「源记忆被删 ⇒ 引用还在、正文回 `text: null`」（`tests/unit/cognitive-reflections-service.test.ts:234`）
  是**求值器形状**：真库那条外键是 `onDelete: Cascade`，删记忆会把引用行一起带走，界面上看到的是「引用少了一条」而不是「一条空引用」。
  两种结果都诚实地说明了支撑变弱，但不是同一条代码路径，真库上没测过。
- 正文里的数字与引用条数只有出处：`COUNT_MISMATCH` / `UNSOURCED_ASSERTION` 是 critic 的拒稿原因码
  （`tests/unit/cognitive-reflection-evidence.test.ts:297`、`:338`），被拒的洞察不落库。

### 5. 高置信度洞察不允许出现无来源的确定性事实

**状态：部分验收——机制已验收，「洞察」无对象。**

置信度与来源的关系是真代码，并且是**读时算**，不是写入时盖一个章就不管：

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-confidence.test.ts:54` `观察、推断、假设逐级降低，都在低档——推断永远不等于用户说过` | 纯 |
| `tests/unit/cognitive-confidence.test.ts:63` `非用户确认的来源，即使带确认时间也不给那 0.05` | 纯 |
| `tests/unit/cognitive-evidence.test.ts:229` `没有证据的记忆按来源基线给分` | 服务 |
| `tests/unit/cognitive-evidence.test.ts:255` `有反对证据就压在低档` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:797` `低档位的记忆带上「不得以确定性语气使用」` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:830` `算不出置信度时按低档位处理，宁可多标一句也不冒充确定` | 服务 |

**边界**：门槛说的是「洞察」，而洞察由反思产生——反思的服务端已经在 11-04 落地（见门槛 4），
所以这条今天验的是**两侧都对得上**：反思正文的措辞档位由 `reflectionConfidence` 按样本数、跨度、反证命中算出来，
低档位不许用最肯定的那套话（`tests/unit/cognitive-reflection-evidence.test.ts:155`），
拿不到原话时不许造引号（同文件 `:251`），正文出现因果断言就被 critic 拒稿不落库（同文件 `:297`）。
仍缺的是**用户那一侧的目测**：那一屏 6-F 已经落地、11-04 也真挂上过一次（初次渲染的 markup 见文末 6-G 判词），
但真库还没有一行洞察，用户实际看到的就是「开关状态未知」那句。
上表那六条仍是这条门槛的**前置机制**：任何注入给模型的记忆都带档位，低档位强制带禁用确定语气的标注。

### 6. 模糊时间不得被伪造为确定日期

**状态：已验收（服务层 + 时间线派生层 + 时间解析层）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:283` `时间精度不够就不许写成精确日期` | 服务 |
| `tests/unit/cognitive-memories.test.ts:429` `存进去的时间精度原样回带，展示层才不会把它说得更精确` | 服务 |
| `tests/unit/cognitive-memories.test.ts:300` `失效时间必须晚于生效时间` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:195` `开关打开后，技术项目的亲口陈述按「用户明说」落库，且不编造时间` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:411` `精度未知时不显示时间，精度是年时只显示年` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:220` `句子里有词表内的时间说法时，精度和 validFrom 一起落下` | 服务（写侧接线） |
| `tests/unit/cognitive-memory-module.test.ts:234` `周档和循环说法不在词表里：这句照样按时间未知落库` | 服务（写侧接线） |
| `tests/unit/cognitive-temporal.test.ts:49` 那一段 12 条对照表：每种说法落哪个精度、哪个时刻 | 纯函数 |
| `tests/unit/cognitive-temporal.test.ts:133` 那一段 20 条 null：未来、周档、多个时间标记、裸月日、不存在的日子 | 纯函数 |
| `tests/unit/cognitive-temporal.test.ts:105` `只按传进来的说话时间算，绝不读墙上时钟` | 纯函数 |
| `tests/unit/cognitive-timeline.test.ts:98` `时间精度是未知时事件按记录时间走，绝不补出一个日期` | 派生纯函数 |
| `tests/unit/cognitive-timeline.test.ts:83` `今天提到的「去年发生的事」排在去年，不排在记录时间` | 派生纯函数 |
| `tests/unit/cognitive-timeline.test.ts:106` `同为「年」精度的两条打平时用记录时间定序，界面上不假装更精确` | 派生纯函数 |
| `tests/unit/cognitive-timeline-route.test.ts:200` `事件只带派生层算出来的那几列：没有密文，也没有演化理由` | 路由 |

**边界**：`validPrecision` 的取值不再由抽取层给出——抽取只管类型和正文，时间这一栏归
`src/lib/cognitive/temporal.ts`（Phase 4 第二片，见下文）。
「用户说了个模糊时间 → 落库为精度不足」这一段的**判断**有测，落库之后的 SQL 默认值没有。
时间线这一屏把「退到记录时间」显示成 `发生时间未知`（`src/components/settings/timeline-panel.tsx:279`），
这句文案本身没有测试守着——项目没有组件测试，能验的是它上游的 `timeSource` 字段算得对。

### 7. 未确认洞察不得写入已确认画像

**状态：部分验收——洞察侧「不写入」已经钉死；画像模块仍不存在，门槛的正面陈述无从验收。**

6-B 立项时定下的甲方案是「采纳只翻状态，一个字都不多写」。它现在有三条互相独立的证据：

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-reflections-service.test.ts:309` `accept ⇒ 只改状态和 decidedAt，一条记忆都不新增` | 服务 |
| `tests/unit/cognitive-reflection-states.test.ts:71` `reflections.ts 不建记忆、不写画像、不注册模块` | 静态（读源码） |
| `tests/unit/cognitive-reflection-states.test.ts:84` `除了两条洞察路由，没有任何代码读它（6-E 不往提示词里塞东西）` | 静态（全仓 import 扫描） |

外加门槛 7 本身要求的「每个状态都有生产者」那一条，6-E 一并补齐了：
`tests/unit/cognitive-reflection-states.test.ts:55` 拿 `prisma/schema.prisma` 的 `enum ReflectionStatus`
和一张生产者表逐一对账——schema 里多一个状态而这张表说不出谁写它，测试就红。
生产者分布是：`PENDING`/`EXPIRED` 由 `reflection-sweep.ts` 写（落库与到期收割），
`ACCEPTED`/`REJECTED`/`EDITED`/`SNOOZED` 由 `reflections.ts` 写（用户动作）；
`SNOOZED` 到期同样由 sweep 放回 `PENDING`，不留只进不出的死状态。

**边界**：`allowUserProfile` 依然**全仓无读取方**，`userModel` 模块也没有实现——
「写进了画像」这个动作今天根本不存在，所以门槛那句话仍然只能判到「机制上不可能」，不是「验过它没发生」。
第二条边界：这三条证据都在**读侧/动作侧**；写侧（sweep）本来就不碰画像，但那条路依赖 `reflectionEnabled` 默认关这一事实，见门槛 9。

### 8. 未确认决策不得建立正式记录

**状态：部分验收——决策记录模块已落地，写入仍然只从确认走。**

前四条守的是**前置**：分类为 decisionMaking 的内容在用户确认前一行记忆都不落。
5-A…5-F 之后 `DecisionRecord` 这张正式档案真的存在了，所以门槛那句话有了对象，
它靠的是同一套口径的两端：`status` 默认 `PENDING_CONFIRM`，接口只认 confirm/reject 两个动词，
`DecisionOutcome` 只挂到已确认的记录上。

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memory-policy.test.ts:123` `决策情境默认落库但必须先经用户确认` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:100` `决策情境允许落库，但必须先经用户确认` | 纯 |
| `tests/unit/cognitive-memory-module.test.ts:243` `决策情境默认要先问用户确认，这一片不假装确认过：不落库` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:217` `UPDATE 不能插队：要先确认或本来不落库的情境，即使撞上旧记忆也不动历史` | 纯 |
| `tests/unit/cognitive-decisions-service.test.ts:81` `确认只命中「自己 + 待确认」的行，并盖上确认时间` | 服务 |
| `tests/unit/cognitive-decisions-service.test.ts:100` `行不存在是 404，不是待确认是 409` | 服务 |
| `tests/unit/cognitive-decisions-route.test.ts:80` `开关关着：GET 直接 409，且一次列表查询都不发` | 路由 |
| `tests/unit/cognitive-decision-outcomes-route.test.ts:72` `开关关着：详情和链接确认都不发服务层调用` | 路由 |

**边界**：`PENDING_CONFIRM` 的行**已经在库里**——门槛字面说的是「不得建立正式记录」，
今天的实现读成「不得当作已确认的决策来用」：一行待确认的候选如果不落库，用户就没有东西可确认。
这句解释写在这里，不是把既成事实说成合规。界面入口在 5-F 已经接上；
真库上判这条，得等 `decisionMemoryEnabled` 打开、表里真有行之后看那一屏说什么。

### 9. 关闭功能后不得继续执行对应模块

**状态：已验收（凡有实现的模块开关都有关闸门的用例；`userModel` / `emotion` / `association` 三个键仍无人读取，
它们的「关了不执行」平凡成立——见下面第 2 点）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-preferences.test.ts:55` `库里没有记录时，八个开关都算关着` | 服务 |
| `tests/unit/cognitive-preferences-route.test.ts:90` `GET 返回全部八个开关，库里没记录时全是默认关闭` | 路由 |
| `tests/unit/cognitive-manager.test.ts:52` `开关没打开的模块根本不会被调用` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:371` `关掉长期记忆后，七种情境没有任何一种产生持久化写入` | 纯 |
| `tests/unit/cognitive-policy-learner.test.ts:330` `关掉之后 learnAfterPurge 返回空，证据够了也不收紧策略` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:702` `开关关了就不学：删一条不攒证据，但删除本身的派生清理一条都不少` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:205` `开关关掉 ⇒ 不跑写、删行、留下作废的痕迹` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:229` `偏好读不出来 ⇒ 行留着退避重试，不删（一次数据库抖动不能清空用户排队的活）` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:241` `开关打开 ⇒ 写这一轮跑一次，截止用的是后台的宽期限` | 服务 |
| `tests/unit/cognitive-timeline-route.test.ts:119` `timelineEnabled 关着时返回 MODULE_DISABLED，一次记忆查询都不发` | 路由 |
| `tests/unit/cognitive-timeline-route.test.ts:132` `开关读不出来时按关闭处理：拿不准就不读用户的记忆` | 路由 |
| `tests/unit/cognitive-reflection-sweep.test.ts:238` `reflectionEnabled 关着 ⇒ 什么都不做，也不给反思扫描盖时间戳` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:835` `开关关着 ⇒ 一行都不收割：后台不许替关掉反思的用户改状态` | 服务 |
| `tests/unit/cognitive-reflections-route.test.ts:101` `开关关着：列表 409，且一次查询都不发` | 路由 |
| `tests/unit/cognitive-reflections-route.test.ts:114` `偏好读不出来按关闭处理` | 路由 |
| `tests/unit/cognitive-timeline-route.test.ts:149` `timelineEnabled 开着但 memoryEnabled 关着 ⇒ 409，一次记忆查询都不发` | 路由 |
| `tests/unit/cognitive-timeline-route.test.ts:164` `两个开关都打开时才放行，且一次请求只读一遍偏好` | 路由 |
| `tests/unit/cognitive-reflections-route.test.ts:165` `memoryEnabled 关着：单条读 409，一次服务层调用都不发` | 路由 |
| `tests/unit/cognitive-reflections-route.test.ts:179` `memoryEnabled 关着不拦列表和动作：它们不读记忆行` | 路由 |
| `tests/unit/cognitive-reflections-route.test.ts:191` `memoryEnabled 关着：单条读读不出偏好也是 409` | 路由 |
| `tests/unit/cognitive-reflections-service.test.ts:155` `证据闸门：两个开关都开着才都放行` | 服务 |
| `tests/unit/cognitive-reflections-service.test.ts:161` `证据闸门：memoryEnabled 关着 ⇒ 偏好里是 false，洞察开关不受牵连` | 服务 |
| `tests/unit/cognitive-reflections-service.test.ts:167` `证据闸门：偏好读不出来 ⇒ 两道都按关闭处理` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:298` `reflectionEnabled 开着但 memoryEnabled 关着 ⇒ 不查记忆行、不写洞察` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:311` `memoryEnabled 关着时戳照盖：抢冷却不该被记忆的闸门带走` | 服务 |
| `tests/unit/cognitive-reflection-sweep.test.ts:320` `memoryEnabled 关着时收割照跑：到期和稍后到点都有人写` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:396` `暂停时写侧一次数据库读都不发生：排除表、策略、已有记忆都不问` | 服务（**7.3 暂停臂，11-05 片 b**：这条断言的是「没问」，不是「问了但没写」） |
| `tests/unit/cognitive-memory-module.test.ts:383` `暂停时一行都不落，也不记证据` | 服务（同上） |
| `tests/unit/cognitive-memory-module.test.ts:410` `暂停只管记、不管用：已存的记忆照常注入提示词` | 服务（同上；这条走 `runCognitiveReads`，所以「暂停把读一起挡掉」这种越界改动会当场红——P6 探针实测过） |

**这一条今天有四个必须写清的事实**：

1. **第八个开关 `adaptiveMemoryEnabled` 在这之前全仓无人读取。**
   `manager.ts:44` 的 `MODULE_SWITCH` 只映射七个模块键，`src/app` / `src/components` 里零命中，
   而策略学习曾在删除链路上无条件执行（`memories/[id]/route.ts:94`、`memories/route.ts:79`、`:87`）——
   门槛 9 对这一层**当时并不成立**。`4a15160` 补上闸门：`policyLearningEnabled()`（`policy-learner.ts:85`）
   读偏好、读不出来当关；`learnAfterPurge` 开头加闸（`policy-learner.ts:127`，一处盖住三条删除链路，route 不用各自记得问），
   `purgeMemory` / `purgeMemoriesByChat` 在事务前读一次（`forgetting.ts:198`、`:227`），关掉就跳过记证据。
   **排除规则和摘演化边照常执行**——那是删除本身的派生清理（门槛 2），和「学不学」是两件事。
   上面那两条新测试是先写先红的（6 条新用例在实现前全部失败），不是补的。
2. **七个模块键里只有 `memory` 真有已注册模块**：`registerCognitiveModule` 的生产调用方只有
   `memory-module.ts:242` 一处。其余六个开关「关了不执行」在 4-T1 之前是**平凡成立**——本来就没有东西在跑，
   不是被测出来的。现在 `timeline` 不再是那六个之一：`src/app/api/account/cognitive/timeline/route.ts:29-38`
   在捞记忆行**之前**读偏好，`timelineEnabled` 和 `memoryEnabled` 任一个关着（或读不出来）就不发一次查询，
   这条有上表那四行时间线用例钉着。
   注意它**不走 `manager.ts` 的注册表**——时间线是对话之外的只读接口，不参与上下文注入，所以那道闸门和
   `MODULE_SWITCH` 是两处独立代码，口径相同（读不出来 = 关）但不会互相提醒。
   **11-04 之后又少了两个「平凡成立」的键**：`decisionMemory`（5-A…5-F：`decisions.ts` + 三条路由 + 设置页面板）
   和 `reflection`（6-A…6-E：`reflection-sweep.ts` 一天一轮的后台扫描 + `reflections.ts` 读写两侧），
   它们和 `timeline` 一样**不走注册表**——都是对话之外的接口或后台任务，所以闸门同样是独立代码，
   上表那四行洞察用例就是它们的证据。剩下两个键（`userModel` / `emotion`）
   到今天仍然没有任何实现读它们，「关了不执行」还是平凡成立，不是被测出来的。
   （`association` 不再是其中之一：5c 把它当成向量补算的开关，`memory-module.ts:242` 读它——
   但**这一条没有用例钉着**，上表因此不放它的行。`MODULE_SWITCH` 里那个名字（`manager.ts:48`）
   管的是对话内的注册表闸门，盖不到后台那趟补算。这个缺口记在这儿，等它真有闸门用例再补行。）
3. **后台任务这一侧的闸门是三值的，不是开关/关闭两值**：`on` 正常跑、`off` 删行作废、**读偏好失败当 `unknown`，只退避不删行**
   （`tests/unit/cognitive-task-worker.test.ts:220`）。这条是给数据库抖动留的——一次读不出来就把用户排队的活清空，
   比多跑一次严重得多。真库上「默认全关 → 欠账被作废删行」这条出口写进了集成断言（`tests/run-integration.sh:409-427`），
   但**没有「先开后关」的对照**：那片区域没有注入点能让真库跑到「开关打开、记忆真的写进 `MemoryItem`」那一步，
   所以「闸门开着会继续执行」这一半只有单测证据（`cognitive-task-worker.test.ts:232`）。
4. **`memoryEnabled` 关掉后，派生视图也不再读记忆行**（11-04 这片补的）。规则是：
   **凡不在记忆模块自身闸门内的「记忆行读取」，先过 `memoryEnabled`，偏好读不出来按关处理**——不然「关掉长期记忆」
   只关掉了写入和对话注入，时间线、洞察详情、后台反思扫描三处仍在读 `MemoryItem`，开关就成了摆设。
   三处各自独立加闸（`timeline/route.ts:33`、`reflections/[id]/route.ts:35`、`reflection-sweep.ts:234`），
   口径与状态读取那两道一样，上表新加的十三行就是它们的证据。
   **两处刻意不拦**：① 洞察列表和动作（它们只碰 `ReflectionRecord` 自己的列，不解记忆正文，拦了等于把用户
   已经攒下的洞察锁在库里不给处理）；② **记忆管理那一屏的读 / 改 / 撤回 / 永久删除**——任务书写明用户对自己数据的
   永久访问权优先于模块开关，所以 `memoryEnabled` 关着时那一屏照常能列出并删干净，这是设计不是漏闸。
   后台那处有个可见的代价：闸门排在「收割」和「抢冷却」之后、读池子之前，所以关着时戳**照盖**
   （`cognitive-reflection-sweep.test.ts:311`）——当天把记忆开关再打开，可能要等到下一轮才有新洞察；
   换来的是到期/稍后到点那两件事不会因为记忆关着就没人处理（`:320`）。

界面暴露四个模块开关：`memoryEnabled`（`src/components/settings/memory-panel.tsx:121-138`）、
`timelineEnabled`（`timeline-panel.tsx:84-115`，控件在 `:199`）、`decisionMemoryEnabled`
（`decision-panel.tsx:87-110`，控件在 `:177`）、`reflectionEnabled`（`reflection-panel.tsx:102-124`，控件在 `:202`，
闸门在 `:111`——关着时这一屏连列表请求都不发）——后两个是 5-F / 6-F 才补的，
因为开关得先真有消费者，才轮得到它有一个控件。`adaptiveMemoryEnabled` 只能走 `/api/account/cognitive` 改。
这不是遗漏：`memory-policy-panel.tsx:23-26` 写明了立场——不做没人消费的控件，也不做用户拨了没反应的旋钮。
11-04 的 6-F 按同一立场补上了策略表的 `allowReflection` 复选框（`memory-policy-panel.tsx:261`，
消费者是 `reflection-sweep.ts:452`）；**画像与关联两列仍然不给控件**，因为 grep 全仓只摸得到存储与校验声明，
没有任何运行时读取方（`allowUserProfile` / `allowAssociation` 各两处：validation.ts 与 schema）。

### 10. 新增模块全部关闭时，原有聊天功能回归通过

**状态：已验收（路由层的上下文数组 + 回环层的请求体字节，数据库仍是内存替身）——八个开关全关时，交给模型的出站里零认知内容、读侧一次查询都不发起，并且有同池正向对照撑着；真库与 TLS 出口仍未覆盖。**

| 证据 | 层 |
|---|---|
| `tests/unit/chat-message-route-side-effects.test.ts:477` `记忆开关打开且池里有记忆时，认知块作为第二段 system 出现在交给模型的上下文里` | 路由（正向对照，真调 route handler） |
| `tests/unit/chat-message-route-side-effects.test.ts:497` `八个开关显式全关：同一个候选池一个字都不出去，而且记忆表一次都没被查` | 路由 |
| `tests/unit/chat-message-route-side-effects.test.ts:515` `库里连偏好行都没有时走代码里那份 OFF：结论与显式全关一致` | 路由 |
| `tests/unit/cognitive-chat-wiring.test.ts:97` `开关关着时只有基础 system 和本轮用户消息` | 服务（真调 `buildConversation`，断言记忆表一次都没查） |
| `tests/unit/cognitive-chat-wiring.test.ts:135` `记忆读取失败时对话照旧，只是没有认知块` | 服务 |
| `tests/unit/cognitive-manager.test.ts:247` `认知引擎整体退化成「什么都没做」，对话不受影响` | 服务 |
| `tests/unit/cognitive-manager.test.ts:129` `模块卡住时在截止时间内被放弃，对话不必等它` | 服务 |
| `tests/unit/cognitive-manager.test.ts:213` `写侧的截止由调用方给：后台任务等得起，读侧仍然卡一秒就放弃` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:382` `一次 tick 把领到的任务一个个跑完，绝不重叠` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:429` `上一轮还没跑完时，下一个 tick 不重入` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:498` `领取这一步自己炸了也不 reject：一次数据库抖动不能变成 unhandledRejection` | 服务 |
| `tests/unit/cognitive-eval-snapshot.test.ts:40` `现状不许比改造前的基线更差` | 离线评测 |
| `tests/unit/ai-outbound-request-body.test.ts:105` `交进去的 messages 逐字出现在模型收到的字节里，认知块也在` | 回环（数组→字节的保真，正向对照） |
| `tests/unit/ai-outbound-request-body.test.ts:120` `明文 API Key 只在 Authorization 头里，一个字节都不进请求体` | 回环 |

**为什么正向对照是这条门槛的一部分，而不是附赠**：「全关 ⇒ 出站没有认知内容」这句话，在一台根本没有记忆行的机器上、在一条根本不读偏好的代码路径上都同样成立——它自己证明不了自己。
所以 `:477` 先证明「同一个内存池、同一批记忆行，闸门打开时认知块**确实**作为第二段 system 进了 `messages`」（`src/lib/chats.ts:396`），
`:497` 再把八个布尔显式置 false，池子里那一行原封不动。两条用例只差那八个开关，其余 fixture 完全相同。
每条用例开头还有一句 `expect(memoryItem.rows.size).toBe(1)`：先证明有东西可注入，再断言它没出去，否则「零认知内容」可能只是「零数据」。

**四条变异探针，证明这些断言真的连着被测代码，而不是碰巧绿**（跑完立刻 `git checkout --` 回滚，`git diff --stat src/` 为空；P1/P2 管闸门，P3/P4 管出站字节这一层）：
- P1 删掉 `manager.ts:122` 那道闸门 ⇒ `:497` 与 `:515` 双双变红、`:477` 照旧绿（`Tests 2 failed | 11 passed`）。这正是设计如此：正向对照本来就不该测出闸门缺失。
- P2 把 `preferences.ts:41` 的 `memoryEnabled` 默认从 `false` 翻成 `true` ⇒ **只有** `:515` 变红（`expected [ { userId: 'user-1', …(3) } ] to deeply equal []`，`Tests 1 failed | 12 passed`）。
  这条证明了「库里没有偏好行」那半边真的走 `preferences.ts:87` 的 `{ ...OFF }`，而不是碰巧和显式全关得出同一个结论。
- P3 把 `src/lib/ai.ts:126` 的 `messages: input.messages` 改成出口前过滤掉 system ⇒ **只有**回环层的 `:105` 变红。这条钉的是「数组→字节」那段真有人看着：
  今天 `streamChatCompletion` 对 `messages` 只做透传，将来谁在出口前加一次改写（截断、剔除、重排），这里先红。
- P4 把明文 Key 塞进请求体（`JSON.stringify({ ...body, key: apiKey })`）⇒ **只有** `:120` 变红（`expected '{"model":"probe-model",…}' not to contain 'sk-outbound-probe-4f7b'`）。
  `:120` 不是为门槛 10 加的：它是出站请求体这条链上顺手能钉的密钥边界——Key 只应出现在 `Authorization` 头里。

**残余缺口（三条，逐条显式）**：
1. **数组到字节这一段缝上了，但缝在本地回环**。路由层断言拿的是 `src/lib/ai.ts:126` 序列化**之前**的 `messages` 数组，
   `ai-outbound-request-body.test.ts:105` 用真本地 HTTP 服务证明这段序列化逐字保真（多行中文认知块与 `ChatContentPart[]` 两种形状都在），
   两条合起来才得出「全关时字节层同样没有认知内容」——这是复合结论，不是单条断言。
   没覆盖的是 TLS 出口与真模型服务：集成链上的 `tests/mock-ai.mjs:30-48` 收下请求体、只把最后一句用户话回显成 `MOCK_REPLY:`，从不落盘，那里仍无字节断言。
2. **八个键里只有 `memoryEnabled` 真的参与了这条断言**。`manager.ts:44` 的 `MODULE_SWITCH` 映射七个模块键，而除 `memory` 外没有已注册模块
   （见门槛 9 第 2 点），其余键「关了不注入」是**平凡成立**，等模块实现时这条门槛才第一次真正吃紧。
   `timelineEnabled` 现在有服务端消费者了，但它在**只读接口**那一侧，不在这条出站上下文的链路上，所以这句话对它同样成立。
3. **内存替身不是 PostgreSQL**。读侧那段真实谓词（`supersededAt: null`、`origin.notIn`、`validFrom/validTo` 的双 `OR`）由 `tests/unit/prisma-mock.ts`
   的求值器解释，真库上这条端到端链路零覆盖——「其余认知表在真库仍零覆盖」那句天花板对这里同样成立。

**「后台任务永不阻塞对话」今天有两层证据**：请求侧只剩一次 `await enqueueCognitiveTask`（`tests/unit/chat-message-route-side-effects.test.ts:431`
断言路由真的等到落库才写审计，`:460` 断言失败的轮次不欠账），执行侧跑在请求之外的轮询里，写侧失败只进日志和退避。
入队之所以敢 `await`，是因为 `enqueueCognitiveTask` 自己不 reject（`task-queue.ts:42-58`），而且它在 `controller.close()` 之后。

**这一条曾经缺的东西**（`0e5b89e` 起写在这里，现在补上了）：读侧证据真调的是 `buildConversation` 而不是 route handler，
而真调 route 的那个文件当时只管失败收尾与欠账，对**读**侧不做任何断言——两边没接上，所以把 `manager.ts` 的闸门整段删掉，全仓仍然一片绿。

## Phase 4 第一片：时间线读侧验到哪一层

任务书 Phase 4 要事件抽取、自然语言时间解析、变化检测、时间线四样。这一片只做了最后一样的**读侧投影**，
形状是「每条事件都指得回一行真实记忆」：`src/lib/cognitive/timeline.ts` 是纯函数（不 import prisma），
输入是记忆行 + 演化边四列，输出按发生时间从早到晚的事件；`src/app/api/account/cognitive/timeline/route.ts`
加闸门并读那两样；`src/components/settings/timeline-panel.tsx` 是设置页新加的「认知时间线」那一屏。
26 条新用例：派生纯函数 13、只读接口 9、服务层读接缝 4。

**四件事按任务书红线写在这里，别让下一片顺手做掉**：

1. **不虚构经历**。任务书列的事件类型里 `INTEREST_EMERGED`、`MILESTONE`、`CHALLENGE`、`GOAL_COMPLETED`
   在现有列上没有来源，所以一条也不生成。类别筛选用的是记忆自己的六个 `type`（`TYPE_LABELS`），
   没有为界面另造一套词汇。
2. **历史时间不被记录时间冒充**。`timeSource` 只有 `validity` / `recorded` 两种值，
   退到 `recorded` 的那一条在界面上必须挂「发生时间未知」——这是这一片唯一会撒谎的地方，所以单独成了一个字段。
3. **上限会吃掉最老的历史**。`MEMORY_LIST_MAX_ROWS = 200` 按 `recordedAt desc` 截断，顶到上限时
   **最老的记忆先被丢**，接口用 `capped: true` 明说「只覆盖最近这一批」。同一原因下 `historyCount` 可能小于
   `version - 1`：界面对应那句「更早的版本已不在库里」，严格说是「没被这一批读回来」——分页还没做。
4. **旧版本浏览不在这一屏**。时间线只给折叠计数，链的走法留在「记忆」那一屏的「版本」。
   这一片立的那条「同一个动作不做两个入口」，到第四片被你**批准地**开了一处口子：「更正」和「永久删除」在时间线上也各有一个按钮，
   走的是同一对端点，见「Phase 4 第四片」那一节。

**这一片今天验到的边界**：

| 边界 | 现状 |
|---|---|
| 真库数据 | `MemoryItem` **2 行** / `MemoryRevision` **0 行**（11-04 实测，见「真库实况」；这一片写下时是 0/0）。写侧已经真落库过，两行的 `validPrecision` 都是 `UNKNOWN`。但这一屏我**没在他的服务上点开过**，所以事件排布、折叠计数、来源跳转仍然**无法验收**——有数据可看 ≠ 看过了 |
| 求值层 | 服务层那 4 条新用例跑在 `tests/unit/prisma-mock.ts` 的谓词求值器上，不是 SQL：`includeSuperseded` 放宽的到底是哪一条、边按 `userId` 隔离，真库上零覆盖 |
| 界面 | 项目没有组件测试。`timeline-panel.tsx` 的文案与「一次只展开一个」这类形状全部没有断言守着 |
| 闸门 | `timelineEnabled` 的强制在 route 里自己读偏好，**不走 `manager.ts` 的注册表**：和 `MODULE_SWITCH` 是两处代码，口径相同但不会互相提醒 |

**这片的顺序瑕疵，用探针补了证据**：服务层那 4 条用例（`includeSuperseded`、`listRevisionEdges`）是先写实现后补测试的。
11-03 各做了一次变异探针（改完立即还原，没进提交）：把 `listMemories` 改成「无论是否放宽都滤掉被取代的行」，
只有 `cognitive-memories.test.ts:718` 那条转红；把 `listRevisionEdges` 改成带走 `reasonCiphertext` 并解密理由，
只有 `:743` 那条转红（报的是 `Unsupported ciphertext format`，正是那句注释预言的炸法）。两次都只牵动对应那一条，说明用例不是装饰。

## Phase 4 第二片：自然语言时间解析（缩小版）验到哪一层

任务书 4.2 要的是「自然语言时间解析」。这一片只做了**一个纯函数**：
`src/lib/cognitive/temporal.ts` 的 `resolveTemporalFrame(text, saidAt)`，返回 `{ precision, validFrom }` 或 `null`；
唯一消费者是写侧的 `src/lib/cognitive/memory-module.ts:191`——那里原来一律写 `precision: 'unknown'`，
第一片时间线每行都挂「发生时间未知」就是这个原因。没有新增开关：这一条跟 `memoryEnabled` 走，
落不落地都不改变「这条记忆允不允许存在」。

**为什么是缩小版：先量了语料，再写代码。** `scripts/cognitive-eval/fixtures/` 里 `lines: [...]` 共 **182** 条，
含时间表达的只有 **36** 条，逐词实测：`今年` 3、`明年` 3、`这个月` 1、`下个月` 4、`上周` 1、`这周` 2、`下周` 2、
`每周` 9、`周X`（非「每周」）13、绝对日期 **0**、`昨天 / 前天 / N天前` **0**、`去年 / 上个月` **0**。
按「宁可 unknown 也不撒谎」逐条判：`每周X / 周X`（22 条）多数是习惯而不是时点，落成某一个周三是造事实；
`上周 / 这周 / 下周`（5 条）卡在枚举里没有周档；`明年 / 下个月`（7 条）是未来，按选定的 (a) 方案保持 unknown。
**于是这片能诚实落地的只有 `今年` + `这个月` 那 4 条，覆盖率 4/36 ≈ 11%。** 收益就这么大，不夸大。

**词表就到这儿**（`temporal.ts:42`）：`今年 / 去年 / 前年`、`这个月 / 上个月`、`昨天 / 前天 / N天前`、
绝对写法 `YYYY年M月D日 / YYYY年M月 / YYYY年 / YYYY-MM-DD`。表外一律当作没有时间表达。

**四条 null 红线，每条都有用例钉着**（`tests/unit/cognitive-temporal.test.ts:133` 起，20 条）：

1. **未来的说法不落 validFrom**——`明年 / 下个月 / 明天` 不在表里，未来的绝对写法由
   `validFrom > saidAt` 判掉（`:174`）。把计划写成已经发生，和检索侧故事 `s14-p3` 拦的是同一件事。
2. **周档与循环事件不做**——`每周三打球` 落到某一个周三是撒谎；`上周 / 这周` 落不进现有 enum（见下面的靶子）。
3. **一句只容得下一个时间标记**——`matches.length !== 1` 直接判 null（`temporal.ts:47`，用例 `:151` 起三条）。
   「取最近的那个」是我们编的规则，不是用户说的。
4. **不带年份的月日不猜年**——`3月5日` 认不出是哪一年，所以它压根不在词表里。副作用正好：
   「今年3月」只落**年**，不因为我们猜出月份而写进一个可能错的起点（`:125`）。
   第五条同样小但同样硬：日历上不存在的日子（`2025年2月30日`、`13月`）判 null，不许悄悄滚到隔壁那天（`:161-162`）。

**validTo 一律不给**。「去年在学吉他」的去年只是起点，这段说法什么时候失效我们并不知道，
填一个年末等于替用户宣布「今年就不学了」。开区间由 `validTo === null` 表达。

**精度对齐不是风格问题，是硬闸门**：`src/lib/cognitive/memories.ts:226-233` 会拒掉
`day` 带时分秒、`month` 不是 1 日、`year` 不是 1 月 1 日的写入（报「有效时间不许写成更精确的日期」）。
所以解析器全部用 `Date.UTC(...)` 和 UTC 日界向下取整产出时刻，测试里复刻了同一道校验（`expectAlignedToPrecision`）。
两边各守一半：解析器证明「给出的时刻与精度对齐」，`cognitive-memories.test.ts:276` 证明「服务端真的拒不对齐的」——
而写侧那两条接线用例把 `createMemory` mock 掉了，所以「解析器的输出过得了那道闸门」这一句是**推断**，
它的证据是两处用的是同一个 `TimePrecision` 类型和同一套 UTC 边界，不是某一条跑绿的用例。

**变异探针（11-03，四条各改一次、跑完立即还原，改动没进提交）**：


| 探针 | 转红 | 用例数 |
|---|---|---|
| 删掉 `validFrom > saidAt` 的未来判掉 | 两条未来用例 | 2 |
| `matches.length !== 1` 改成 `< 1`（允许多个时间标记） | 「昨天和前天」「今年…去年…」「2025年和2026年」 | 3 |
| 日精度不再抹掉墙上时钟（直接用 `saidAt` 毫秒） | 昨天/前天/3天前 + 那条 `toEqual` | 4 |
| 「去年」算成今年 | 对照表里的去年行 + 跨年那条 | 2 |

四次都有反应，且每次只牵动对应那几条（其余 37/36/35/37 条照绿）——新用例不是装饰。

**这一片验到的边界**：


| 边界 | 现状 |
|---|---|
| 真库 | `MemoryItem` 11-04 实测 **2 行**（这一片写下时是 0 行，见「真库实况」），两行 `validPrecision` 全是 `UNKNOWN`——「发生时间未知」第一次有了真数据。但我没起他的服务，落库后的 `validFrom` 列长什么样、那一屏上少了几条，仍然**无法验收** |
| 覆盖率 | 11%（4/36）是这片的全部实际收益，且分母是虚构评测语料，不是真实用户语料（任务书 7.1 禁止拿真实家庭成员聊天记录做测试）。真实占比只会不同，不会更可信 |
| 前置依赖 | 抽取器要有 marker 才产出候选（`memory-extractor.ts:19` 那张表）。一句带时间的实话如果压根没被抽成候选，这片永远轮不到它——探针时实测「每周三晚上我打球。」落不进候选，改成「我习惯周三打球。」才走通写侧 |
| 中文分词 | 词表是子串匹配，没有词边界。理论上「这两年」里的字面不会误命中，但「去去年」这类叠字、以及未来任何新增词都可能踩到；这是词表法的天花板，不是用例能补的 |

**两个后续靶子，判完了：都不做。判词连实测数字留在这里，下次不必重推**：

1. **周档（给 `TimePrecision` 加 `WEEK`）——不做。**
   先更正这一片交完时的说法：**成本不在迁移**。`AlterEnum` 在本仓库有真先例，而且就跑在这台真库上——
   `prisma/migrations/20261030172159_email_change_tokens/migration.sql:2` 只有一条
   `ALTER TYPE "EmailTokenPurpose" ADD VALUE 'EMAIL_CHANGE'`，PG17 允许，Prisma 不重建类型。
   真正的成本是两处**语义决定**：
   - `src/lib/cognitive/memories.ts:226-233` 那道 `validateMoment` 要加 `week` 分支，就得先定「周从周一算还是周日算」——这个约定是我们替用户定的；
   - `src/lib/cognitive/memory-display.ts:133-142` 的 `formatDate` 要能回显「周」。ISO 周号（`2026年第44周`）几乎不可读，
     要显示成「11月2日那一周」就得把跨度算出来。两处都不是加一个 `if` 了事的。

   买到的实测只有 **3 句**：`上周` 1 + `这周` 2；`下周` 那 2 句按选定的 (a) 方案仍然是 unknown；
   而 `每周` 9 + `周X` 13 那 22 句（占含时间句的六成）**一条也不靠这个字段解决**。
   所以换来的只是时间线上少挂 3 句「发生时间未知」，而那 3 句现在挂的标签本来就是真话。
   **再评估的触发条件**：`precision` 真的被拿来筛选或分组（今天没有，只有排序 `timeline.ts:107` 和回显 `memory-display.ts:148` 两处）。
   那时把枚举值、`validateMoment` 的周起点、界面措辞一次定完，别拆开做。

2. **循环事件（`frequency` 那一类新字段）——不做，而且这一片现有的形状就是对的。**
   - 「每周三打球」不是一件有起止区间的事。加 recurrence 等于把双时间模型换成两套时间语义，
     而**区间那一半在生产里从来没被写过**：`validTo` 有四个读取点（`memories.ts:336` 的 asOf 过滤、
     `confidence.ts:72` 的 expired 因子、`memory-display.ts:150` 的区间回显、`timeline.ts:119` 的透传），
     但三个写入调用点（`memory-module.ts:204`、`memory-module.ts:209`、
     `src/app/api/account/cognitive/memories/[id]/route.ts:50`）**没有一个传它**，`src/app` 下 `validTo` 零命中
     ——也就是 expired 那个置信度因子在真实数据上永不触发。
   - 「周三」已经在正文密文里，用户看得见、AI 读注入块时也看得见；再加字段是把同一句话说两遍。
   - 给它落 `validFrom` 会**主动造假**：`timeline.ts:107` 拿 `validFrom` 排序，把一个习惯钉在某一个周一上，
     时间线就凭空多出一条他某周「发生过」的经历，正撞任务书 4.4。

   剩下的真缺口在**检索**、不在时间列：`每周三打球` 属于那 44 条「与查询词面零重合」的 gold 里的一类
   （判词与实测在 [docs/vector-retrieval-go-no-go.md](vector-retrieval-go-no-go.md)），给记忆表加字段治不了它。

## Phase 4 第三片：变化检测——实测 0/36，判词是「词法方案不做」

**这片没写一行生产代码。** 11-03 的做法还是先量再判：把评测语料 30 个故事里 **36 条带 `supersededDay` 的行**
（gold 认定「这件事后来改了」）逐条拿去过今天的取代判定 `src/lib/cognitive/write-decision.ts:180`，
问的是那个从来没人问过的问题——**如果这句话真的在对话里被说出来，这套词法相似度认不认得出它是旧行的新说法？**
探针放在仓库外的临时目录里跑真函数，跑完即删，之后 `git status --short` 为空。

| 实测项 | 数字 |
|---|---|
| 故事 / gold 被取代行 | 30 / 36 |
| **机制重建出的边** | **0 / 36** |
| 每条未重建边「最像的那条后行」的相似度 | 最高 **0.34**、中位数 **0.11** |
| 相似度分布 | ≥0.3 三条｜0.2–0.29 三条｜0.1–0.19 十三条｜**<0.1 十七条**（含 6 条 0.00） |
| 闸门 | 相似度 `0.8`（`write-decision.ts:148`）+ 长度比 `0.6`（`:149`） |
| 误合（候选把 gold 里两条仍在世的判成同一件事） | 0 |
| 原话重说（归一化同句，走 `recordRestatement` 那条分支） | 0 |

**一句话结论：这套相似度在这份语料上一次也没触发过。** UPDATE 分支（`memory-module.ts:173` 查旧行 →
`memories.ts:371` 给旧行盖 `supersededAt`）在这份语料上是死路——不是擦边没过 0.8，是最高值只有 0.34。

**为什么那 30 条 `category: 'update'` 的探针看着像已经覆盖了**：`scripts/cognitive-eval/metrics.ts:38` 自己标的是
`update: 'mirror'`，而 `:34` 那段注释写明 mirror 的含义——「靠 harness 里那份 `visibleAt` 复刻守住，真实来源是
`listMemories` 的 SQL 条件」。所以那 30 条问的是**读侧有没有把旧行漏进上下文**，从没问过**写侧认不认得出这是一次改口**。
这个区分此前没写在文档里，它才是这片真正的缺口。

**这把数字直接砍掉两个候选改法**，都不必再做前后对照：

1. **调阈值——死。** 要接住最差那几条得把 0.8 降到 0.05，等于「只要主题是周报 / 订单库 / 面包，就算同一件事」。
   0.8 与 0.34 差 2.3 倍，不存在一个既不误合又能命中的中间值。
2. **拆掉「只比同 `type`」那道门槛——同样死。** 上表那些相似度是**跨类型**取的最大值，全集最高才 0.34，
   拆掉类型门槛命中数依然是 0。不过这道门槛确实**独立地**封死了 5 条（`s3-m2`、`s12-m1`、`s20-m4`、`s23-m4`、`s28-m6`：
   后行里没有一条同类型，全是 `goal`→`fact` 那类「我说过要做 X」→「我做完了 X」）——封死归封死，够不着 0.8 才是主因。

**剩下的真缺口**是「同一主体、不同取值」的识别（周报 周一→周五、镜头 加了→卖了、目标 六万→十二万）。
那需要**主语/槽位抽取**，是新子系统：它必然引入模型推断，而任务书禁止把推断冒充为用户事实；要做就得先定
「谁有资格盖掉谁」的口径。按这片开工前讲好的升级规则，**走到这里停手，不动**。

**现有那个形状反而该记一功**：词法猜不出谁赢的时候，系统的正确答案是「两条冲突说法并存、置信度压到 `low` 并带上标注」——
那 13 条 `category: 'conflict'` 由 `seam` 守着（`metrics.ts:36`），走的是线上 `selectMemoryCandidates` / `renderMemoryBlock`，
不是复刻。误删一条真记忆比多留一条脏数据贵，这条取舍在 `write-decision.ts:173` 那段注释里就写着，本次实测给它补了数字。

**三条边界，不写清就是夸大**：

| 边界 | 现状 |
|---|---|
| 语料 | 全部是虚构评测 fixture（任务书 7.1 禁止拿真实家庭成员聊天记录做测试集）。0/36 说的是「按 gold 定义的改口，词法认不出」，**不能外推成「真实用户不会这样改口」** |
| 真库 | `MemoryItem` 11-04 实测 **2 行**（见「真库实况」）——「线上到底会不会命中」第一次有数据可测，但真库检索一次都没跑过，本片全部数字仍来自 fixture 重放 |
| 正面反证 | 临时探针**没跑出一组函数级命中**——它证明的是「调用返回 0」，不能单独证明「门槛算数上就算不出」。函数级唯一那次命中（`我在用 Next.js 15` ↔ `我在用 Next.js 14`）由仓库既有的绿用例 `tests/unit/cognitive-write-decision.test.ts:269` 守着，不是我这次跑的 |

**六组控制句（11-03）**：相似度与长度比按 `write-decision.ts:148-192` 那套公式重算（归一化 → 字符 bigram → Jaccard → 门槛 0.8 + 0.6）。
其中第 4、5、6 行**另外真过了函数本体**，三次都返回 null；第 1 行的函数级命中是既有用例 `:269` 的那条；第 2、3 行只有重算值。

| 控制句 | 相似度 | 长度比 | 命中 | 证据级别 |
|---|---|---|---|---|
| `我在用 Next.js 15` ↔ `我在用 Next.js 14` | **0.818** | 1.00 | **是** | 函数级（既有用例 `:269`） |
| `我住北京市` ↔ `我住北京` | 0.750 | 0.80 | 否 | 仅公式重算 |
| `我们的周报是周一早上交的` ↔ `我们的周报是周五早上交的` | 0.692 | 1.00 | 否 | 仅公式重算 |
| `我加了一个长焦镜头` ↔ `我买了一个长焦镜头` | 0.600 | 1.00 | 否 | 函数级 + 重算一致 |
| `我把周报改成周五下班前交` ↔ `我把周报改成周五交` | 0.583 | 0.75 | 否 | 函数级 + 重算一致 |
| `我住北京` ↔ `我住上海` | 0.200 | 1.00 | 否 | 函数级 + 重算一致 |

**这张表比 0/36 更要紧**：中文短句**改一个词，实测相似度落在 0.20–0.75，全部够不着 0.8**；
句子里 11 个 bigram 只要错开两个就出局。唯一越线的那对靠的是 `Next.js 15` 那串 ASCII——
型号、版本号这种写法 bigram 密度够高，才撑得起一个字的改动。
所以 0/36 **不是这份语料碰巧不像**，是**中文改口在结构上就进不了这套词法门槛**；
`:173` 那段注释早就写了「短句里换一个词占比就过半」，这次把「过半」量成了 0.20–0.75 这个具体位置。

**再评估的触发条件（11-03 按任务书 4.3 原文改写过）**：

任务书 4.3 的**原文**这次拿到了（在本会话的附件记录里，仍然**没有进仓库**——本文档里能逐字引用的还是转述）。
原文要的是**聚合式观察**：六类检测（兴趣出现和变化、目标状态变化、项目进展、偏好变化、长期重复主题、长时间未解决的事项）、
**必须保留样本数量和观察时间跨度**、**数据不足时输出 `INSUFFICIENT_EVIDENCE`**，并禁止据极少数聊天记录预测人生或生成确定性人格结论。
原文**一个字也没要求写侧自动取代**。所以这一片的判词范围要收窄清楚：

- 0/36 否掉的是**「用词法相似度把改口识别成取代」这一种实现**（调阈值、拆类型门槛都算在内）；
- 0/36 **不是** 4.3 的验收结论——4.3 的实体（`ChangeDetector`：样本数 + 观察跨度 + `INSUFFICIENT_EVIDENCE`）今天**不存在**，
  `src/lib/cognitive/` 里没有一行聚合观察的代码。它和逐条取代是两件事，以后别再互相冒充。

于是触发条件只剩两条：一、真要建 4.3 那个 `ChangeDetector`，那是引入模型推断的新子系统，**按 architectural 出 spec** 才能碰，
不在时间线或写入决策这一层顺手做；二、真库里出现第一批 ≥20 行真实记忆时，这份 0/36 应当用真实语料重测一遍——分母换掉，结论可能不一样。

## Phase 4 第四片：纠正错误事件、删除事件及其派生记录

任务书 4.4 列的八项，前六项（排序、类别筛选、事件详情、原始来源、确认状态、历史版本）4-T1 就已经在了；
**最后两项——「纠正错误事件」和「删除事件及其派生记录」——在时间线那一屏上一直没有入口**，
要改要删只能先去「记忆」那一屏把同一行找出来。这片补的就是这两项：**零新表、零新端点、零迁移、零新开关**。

**交付两件事。**

一、**服务层：永久删除一条 = 删掉整条版本链**（已提交 `53f6967`）。

- **为什么必须改**：只删当前那一行会留下带 `supersededAt` 的旧行，而时间线的折叠口径在找不到后继时
  **会把孤立的旧行单独成一个事件**（`src/lib/cognitive/timeline.ts:96-101`，由 `tests/unit/cognitive-timeline.test.ts:168` 守着）——
  用户刚删掉的内容换个旧说法回到他眼前，正撞 4.4 的「删除事件及其派生记录」。
  而且旧行一旦孤立就没有别的入口：「记忆」那一屏列的是当前有效行（`memories.ts:331` 的 `supersededAt: null` 过滤），
  版本链要从头一行点进去走，头一行没了链就走不到。
- **实现**：`src/lib/cognitive/forgetting.ts:178` 的 `eventChainIds` 沿 `MemoryRevision.previousId` 从被点那一行往回走
  （`where` 带 `userId`、`orderBy: { createdAt: 'asc' }`、`seen` 集合挡成环），`purgeMemory`（`:113`）把整条 id 列表
  交给原有的摘边 / 删行 / 建排除 / 撤欠账 / 记证据那套；链上产生的边由外键 cascade 带走（`prisma/schema.prisma:490`）。
- **`purged` 报的是行数，不是事件数**：删一条三版的历史返回 `purged: 3`。审计和界面都按这个数说话。

二、**界面：时间线一屏内联「更正」与「永久删除」**（`src/components/settings/timeline-panel.tsx`，复用现有那对端点）。

| 位置 | 内容 |
|---|---|
| `:321` `:328` | 展开区尾部两个按钮：`更正`、`永久删除` |
| `:118` `:124` | 收起条目即清动作状态；一条事件同时只开一个动作区 |
| `:128` | 更正框**预填当前这一版正文**——起点是他看到的那句话，不是一个空框 |
| `:148` | `PATCH /api/account/cognitive/memories/[id]`，成功提示 `已按新说法更新，旧版本仍保留`，然后重载时间线 |
| `:163` | `DELETE` 同一路径，提示 `已永久删除`，然后重载 |
| `:175` | `purgeWarning` 按事件形状给三种警示：折叠到 N 个历史版本 → 「这条事件和它折叠的 N 个历史版本会一起从数据库里删掉，不可恢复」；链上有这一屏没列出的更早版本 → 另说一种；没有前身的孤行 → 第三种。**三种都以「原对话记录不动」收尾**（7.3 要求区分「忘记记忆」和「删除聊天」） |
| `:336` `:345` `:362` `:382` | 表单措辞 `新的说法` / `为什么改` / `保存新版本` / `确认永久删除`，与「记忆」那一屏一字不差 |

**同一动作两处入口是你批准的取舍**，代价记在这儿：这两句文案以后要改口径得同时改两个文件（`timeline-panel.tsx` 和 `memory-panel.tsx`），
它不像「版本浏览」那样只有一处。4-T1 那条「同一个动作不做两个入口」的规则，这是唯一一处经你点头开的口子。

**顺带转正一句假话**：`memory-panel.tsx:633` 从写下那天就承诺「这条记忆和它的历史版本会一起从数据库里删掉」，
`53f6967` 之前它**不是真的**——`purgeMemory` 只删传进来的那一行。这片让它第一次对上代码。

**证据**：

| 证据 | 层 |
|---|---|
| 先红 **7 条**（`tests/unit/cognitive-forgetting.test.ts` 共 40 条，7 failed）。11-03 复核做法：把 `forgetting.ts` 临时退回 `53f6967^`、只跑这一个文件，跑完立即还原，之后 `git status --short` 只剩界面那一个 `M` | 服务 |
| 红的构成：新组 `:369` 「删除一条事件＝连它的旧版本一起删」8 条里的 6 条 + 既有那条 `:317` 改写后的新断言 | 服务 |
| 新组里 **2 条按设计就是绿的**，不是漏红：`「一条没有前身的记忆照旧只删自己」` 守不变的行为，`「别人的边不给我的链引路」` 防的是「走链不判 `userId`」这种错实现——旧代码只删头一行，本来也不会误删别人 | 服务 |
| `npx vitest run` = **58 文件 / 734 用例全绿**；`npx tsc --noEmit` exit **0** | 全量 |
| `:454` 走链也整个在同一个事务里：`db.txOps` 含 `edge_find`、`db.topOps` 为空 | 服务 |
| `:383` 链上每一版各记一条来源排除，两个不同的 `contentHash`——旧说法也不许被后台记回来 | 服务 |

**边界，不写清就是夸大**：

| 边界 | 现状 |
|---|---|
| 真库 | `MemoryItem` **2 行** / `MemoryRevision` **0 行**（11-04 实测，见「真库实况」）——版本链在真库里从没形成过。「在时间线上点一次永久删除，链真的整条消失」这一层**无法验收**——上表全部数字来自 `tests/unit/cognitive-forgetting.test.ts:39-53` 那套文件内自带的内存替身，不是 SQL |
| 界面 | 项目没有组件测试：两个按钮、三种警示、预填、「一次只开一个动作区」这些形状**一条断言都没有**。而且我**没在浏览器里验证过**——按规矩我不启动你的服务，这一屏渲染归你 |
| 「纠正」的边界 | 更正只改得了说法，**改不了时间**：PATCH 的请求体只有 `{content, reason}`（`src/lib/validation.ts:163-166`），`validFrom` / `precision` 没有任何写入口。所以 4.4 的「纠正错误事件」今天**不含纠正时间**——时间记错了只能删了重说 |
| 排序口径 | `eventChainIds` 那句 `orderBy: { createdAt: 'asc' }` 在测试替身上**不真排序**：这个文件自带的 `memoryRevision.findFirst`（`tests/unit/cognitive-forgetting.test.ts:170`）只按数组插入顺序取第一条，`orderBy` 参数根本没被读——它和 `prisma-mock.ts` 是两套，后者才实现 `orderBy`。一行只有一条后继边时两种取法等价；真库上「同一版挂着多条后继边」时跟着哪一条走**无法验收** |
| 「派生」覆盖到哪 | 显式处理的是演化边、来源排除、策略证据、未跑的认知任务欠账。支持证据行靠外键 cascade（`schema.prisma:542`）消失，**级联行为没人测**（同「下一步」第 3 条那条天花板） |
| 限流 | 两处入口共用同两个桶（`memory-revise` 30/小时、`memory-purge` 20/小时，按 `userId`）。从时间线删和从记忆屏删**合起来算**，不是各自 20 次 |

## 末段那条规则：先跑基线，再定阈值

任务书 7.4 末段：**「先运行基线，再根据结果设定正式阈值；没有实测收益的模块不应默认启用。」**

这条规则的落地形态是三样东西，都在仓库里：
- `scripts/cognitive-eval/report.md` + `summary.json`：30 个虚构故事 / 180 会话 / 231 行（可见 186）/ 116 提问的实测基线，
  对照臂 A2（改造前：按 recordedAt 取最近 8 条）→ 现状：**Recall@8 0.0374 → 0.7274**、MRR 0.0154 → 0.5828、
  至少命中一条 3.7% → 80.4%、违禁项泄漏 1 → 0。
- `tests/unit/cognitive-eval-snapshot.test.ts`：逐字节比对已提交的 snapshot。
  以后谁改了召回参数，数字一动就必须带着 diff 显式更新这份 snapshot——基线不再能被人悄悄挪。
- `src/lib/cognitive/preferences.ts:40` 的 `OFF`：**八个开关默认全部 `false`**（`schema.prisma:388-395` 那八列的 `@default(false)` 同口径）。
  「没有实测收益的模块不应默认启用」在代码里的表现就是这一份默认值，不是一句承诺。

一个已经付了成本、还没有兑现的取舍，写在报告里而不是藏在这里：
**44 条标准答案一次都没被关键词召回捞回**（core 7 / batch1 17 / batch2 20），
共同形态是词面零重合的语义改写（「我还钓鱼吗」vs「我不钓了，装备挂在闲鱼了」；
「我雅思哪一项最弱」vs「写作一直是我的短板」；「为什么不当面试官了」vs「HC 冻结了」）。
上不上向量 Embedding 这个决定，现在有一手的标注语料可以据以做了——**做过一次，结论是 no-go；11-04 被推翻重来**：
这 44 条逐条分类后 **44/44 都是「与查询零共同词」**（0 条被池子/保留期挡掉，0 条被名额挤掉），
更便宜的松匹配改法实测能捞回 11 条（Recall@8 0.7274 → 0.7975）但会打破 `update` 守卫（违禁 0 → 1）；
当时的拦路石是本机没有 pgvector、没有 embedding 端点、Prisma 6.11 的 `Unsupported("vector")` 列
对 client 不可见。**Owner 的裁决是「把这个向量做完」并选择自己提供一个 `/v1/embeddings` 端点**，
所以拦路石按「等一个端点」处理，而不是按「做不到」处理。分类判据、成本实测、未决红线和再评估触发条件仍在
**[docs/vector-retrieval-go-no-go.md](vector-retrieval-go-no-go.md)**。

11-04 落地的四片（5a–5d，**一个字节也没出过站**，因为端点还没到）：
`embedding` 进了能力清单（`src/lib/providers.ts:10`），向量以 **AES-256-GCM 密文**存进
`MemoryItem.embeddingCiphertext`（`bytea`，AAD 绑定 `userId + memoryId + 字段名`；pgvector 已实测排除），
后台写记忆时顺手补算（`associationEnabled` 闸门，5c），读侧的余弦与 RRF 混合排序已接进那条唯一的纯函数接缝
`selectMemoryCandidates`（`src/lib/cognitive/memory-module.ts:116`，5d）。
**5d 之后线上读侧的行为逐字节没变**：`readMemory` 不传查询向量，混合排序就没有入口——
一次查询 embedding 是每轮对话关键路径上的一个出站请求，付不付它由 5e 的实测增益决定。
关键词基线在 5d 之后重跑仍是 Recall@8 **0.7274** / MRR **0.5828** / 违禁 **0**（`npm run eval:cognitive`，
与 `tests/unit/cognitive-eval-snapshot.test.ts` 那份 snapshot 一致）。
**5e（11-04 实测：端点这件事比「等他配好」更硬，仍未验收）**：原计划 302 次出站 + 缓存，
量出向量臂的 Recall@8 / MRR / 违禁泄漏；判词规则写死在这里——增益量不出来、或违禁从 0 变成 ≥1，就报「不值」，模块继续默认关。
花钱之前先拿**两次**调用探了一下他配的那两个 provider（探针脚本是一次性的，跑完已删；只打印状态码与字节数，Key 与返回体原文一个都没出屏幕）：

- `deepseek-flash`（`isDefault`，`https://api.deepseek.com`）→ `POST /embeddings` **404，返回体 0 字节**。这台 host 通，但没有这个端点。
- `kimi`（`https://ark.cn-beijing.volces.com/api/plan/v3`）→ `POST /embeddings` 在**生产的 `safeFetch` 路径上**抛 `502 AI_UNREACHABLE`；
  换 `fetch` 直连同一 host 拿 `/models` 是 404——host 通，是那条路径与这台服务的形态不对（`/api/plan/v3` 是订阅计划端点）。

两个 provider 的 `capabilities` 里都写着 `"embedding"`，因为那一栏是**用户自己勾的**（`providers.ts:9-10` 的清单，勾了就当有），
所以「开启了语义向量」这个界面事实**不等于**那儿真能算向量。更要紧的是第三条，它和端点无关、他现在配什么都绕不过去：

**`embedMemoryText` 把 `provider.modelId` 当成 embedding 模型名发出去**（`embedding.ts:99`：`body: JSON.stringify({ model: provider.modelId, input: text })`），
而 `modelId` 是聊天模型那一栏——库里那两个值分别是 `deepseek-flash` 与 `ark-code-latest`。
schema 里**没有**第二个模型字段能给向量用（`AiProvider` 的列：`id,ownerType,userId,name,baseUrl,apiKeyCiphertext,modelId,capabilities,params,enabled,isDefault,createdAt,updatedAt`）。
所以就算他指到一个真服务 `/embeddings` 的 host，请求也会拿聊天模型名去要向量。

**这条不是「再等一个端点」，是一次设计改动**：要么给 provider 加一个可选的 embedding 模型字段（迁移 + 管理界面一栏 +
挑法改成认这个字段），要么定一个约定（比如从 `params` 里带）。两种都要先跑通「能不能算出一个向量」这件事，
而那需要他给一个**真服务的** embedding host + 模型名。**Owner 的输入是缺的**：5e 因此停在无法验收，
读侧的混合排序继续没有入口，`MemoryItem.embeddingCiphertext` 继续全 `NULL`。

## 真库实况（11-04 复核：两支迁移落了地，写侧第一次真落过库）

这一节是 3-c 收尾时实测的。它推翻本文此前十几处「真库 0 行 / 迁移未执行」的说法——那些话在写下的那天是对的，
之后他授权把两支待执行迁移打下去了（`npx prisma migrate deploy`，那一刻 `npx prisma migrate status` 报 14 支全部 up to date；到 11-05 两片新迁移落地后是 17 支），
而写侧在此之前就已经真的往库里落过东西。下面全部是**只读计数与列名**探针的结果：一行 `SELECT` 都没碰密文正文，
本文与日志都不带内容，id 只截前 8 位。

| 对象 | 实测 | 说明 |
|---|---|---|
| `MemoryItem` | **2 行**（11-05 复核：两行都归 konxing、都是 `GENERAL`） | 都是 `type=GOAL` / `context=GENERAL` / `origin=EXPLICIT` / `version=1`，`recordedAt` 2026-11-03T17:32:58Z（同一轮写的两条） |
| `MemoryRevision` | **0 行** | 真库里从没形成过一条演化边——门槛 2 那条「版本链整条删掉」在库层仍无对象可验 |
| `MemoryItem.embeddingCiphertext` | 两行都是 `NULL` | 向量一次都没写成功过，`embeddingModel` 同样 `NULL`——5e 卡的正是这里 |
| `CognitiveTask` | **3 行，全 `DEAD`、`attempts=3`** | `kind=MEMORY`，`lastErrorCode` 三条都是 `PREFERENCES_UNAVAILABLE`，`createdAt` 2026-11-04T10:54–10:56Z（本地 18:54–18:58） |
| `DecisionRecord` / `DecisionOutcome` | 0 行 / 0 行 | 表已存在（迁移已执行） |
| `ReflectionRecord` / `ReflectionCitation` | 0 行 / 0 行 | 表已存在（迁移已执行） |
| `CognitivePreference`（他这个账号） | 一行 | `memoryEnabled=true`、`timelineEnabled=true`，其余五个开关关着，`reflectionSweptAt=NULL` |
| `CognitivePreference.memoryWritePaused` | 库里唯一一行读回来是 `false`（11-05 实测） | 新列默认值真的生效，且**今天没人按过暂停**。81 条单测里那条「暂停时写侧一次数据库读都不发生」第一次有了库层的对照 |
| `MemoryAccessTurn` | **0 行**（11-05 实测） | 迁移刚落地，写入点（`messages/route.ts:171-175`）还没被真实对话跑过一次——「这一轮被再次调用」今天真的能进库了，但库里还没有它的第一个证据。**要看到它，得他发一轮真的会注入记忆的对话** |

### 那三条 `DEAD` 是实测到的唯一真故障，原因已经查清

**根因（下面是推断，逐条标清哪一步是直接观测到的）**：worker 每条欠账先过一次三值闸门（`task-worker.ts:140` → `gateOpen` → `getCognitivePreferences`），
读不出来就按 `unknown` 退避不删行，三次用尽判 `DEAD`（`task-worker.ts:142`）——这套行为本身是对的，
和单测（`cognitive-task-worker.test.ts:229`）、集成断言写的一致。
**直接观测到的只有两件事**：三条行的 `lastErrorCode` 都是 `PREFERENCES_UNAVAILABLE`（那是我们自己打的标签，不是数据库的错误码），
以及同一时刻那三条 `CognitiveTask` **插入成功了**——后者是关键判别：库如果连不上、或者服务进程没起来，出箱这一步就先炸了，
攒不下行。所以「库整体不可用」这个解释被这三条行自己否掉了，剩下能解释「只有读偏好抛错」的，是我推断的这一条：
`getCognitivePreferences` 用 `findUnique({ where: { userId } })` 且没有 `select`（`preferences.ts:86`），
Prisma 因此按模型**整行**发 `SELECT`，列里带着 `reflectionSweptAt`——那一列是
`20261104110000_proactive_reflection` 才加的（`grep -l reflectionSweptAt prisma/migrations/` 只有这一支命中），
而这支迁移在他跑那几轮的时候**还没执行**（6-A′ `9bfbe06`，11-04 10:25 把 schema 与迁移文件一起提交，`prisma generate` 之后客户端就认识这一列了；
三条行的 `createdAt` 是 18:54，晚于它）。库里没有这一列 → 每次整行读抛 P2022 → 每个后台任务被判成「拿不准」。

**这推断今天能补上的一半**：迁移执行之后，我拿**同一个读法**（`findUnique({ where: { userId } })`，不带 `select`）实测能读回那一行，
`reflectionSweptAt` 现在是 `NULL` 而不是「列不存在」。另一半补不上——要直接看到 P2022 得把那列再删掉，那是破坏性操作，我没做。
原始抛错原文也不在磁盘上：`src/lib/logger.ts:18-20` 只有 `console.error/warn/log`，没有文件 sink；
仓库里那个 `dev.log` 停在 2026-10-31 23:42，不是这一刻的输出捕获。他那一刻的控制台输出只有他自己有。

**这也解释了为什么它只伤后台，不伤聊天**：聊天链路读偏好的那几处把抛错当「关着」处理（门槛 9 的口径），
界面照常能用；只有 worker 会把一次抛错记成欠账的失败次数。

**现在的状态**：两支迁移执行完之后，同一个 `findUnique` 我实测能读回那一行（上表最后一条就是证据），
所以这个故障的成因已经消失。但**三条 `DEAD` 行是历史尸体，不会自己复活**，那两轮记忆抽取的欠账真的没了——
库里那两行记忆是更早（11-03）落下的，不是这三条任务做出来的。**要不要清掉这三行、以及要不要给已存在的记忆补向量，是他判的事，我没动**。

### 这条根因暴露的一个通用约束（还没落成代码）

「生成的客户端比库新」这件事**不需要后台任务，任何一次不带 `select` 的整行读都会中招**，
而它的失败形状和「数据库抖动」一模一样——都是 `catch` 里一个不区分原因的抛错。
今天没有任何一处能告诉运维「列不存在」和「连不上」是两回事。这是 `migrate deploy` 与 `prisma generate` 的**顺序依赖**，
不是某个模块的 bug；要治要么在启动时比一次 `migrate status`，要么给认知侧的读偏好路径加一个能区分 P2022 的日志字段。
两片都不在今天这片里，写在这里是为了下次争论时不必重新查。

---

## 下一步（按性价比排序）

1. **先在有 `jq` 和建库权限的机器上跑一次 `npm run test:integration`**——门槛 2/9/10 新写的那批真库断言（`tests/run-integration.sh:385-479`）
   从 `0e5b89e` 起一次都没完整跑过。这一步不产生新代码，但它是目前**唯一把「worker 随服务进程活着」从推断变成观测**的机会。
   本片加的预检（`:130-177`）只保证「缺什么工具/权限」在第一秒就说清楚，它替不了这一跑。
   **11-03 实测过一次变异探针**（临时把 `forgetting.ts:269-270` 的 `userId` 过滤整个去掉，跑完立即还原，改动没进提交；那是 `purgeAllMemories` 的 `deleteMany` 与撤欠账两行）：
   上表 `:331`（别人的欠账一行不动）与 `:622`（别人的记忆和演化边一行不动）**同时**转红，其余 30 条照样绿（那次跑的是第四片之前的 32 条文件）——
   这两行不是空断言，`purgeAllMemories` 的用户隔离在 mock 层真的守着。真库那一半仍然要靠集成 `:418`。
2. 出站字节的最后一寸：**真 TLS 出口与真模型服务**。本地回环已经验过序列化保真（`tests/unit/ai-outbound-request-body.test.ts:105`），
   剩下的是让集成链上的 `tests/mock-ai.mjs` 把收到的 body 落盘再断一次——但那需要真库里的「闸门打开 + 有一行记忆」的注入点，成本比这片高。
3. 门槛 2/3 共同的天花板：`onDelete: Cascade`（`prisma/schema.prisma:465-466`）真实外键行为零覆盖。
   `CognitiveTask` 的三个外键这轮只在真库上验了「行插得进去、约束在库上」，级联删的行为同样没测。
4. 门槛 4/5/7/8：**「无对象可验」这一句在 11-04 作废**——Phase 5（决策记忆 5-A…5-F）与 Phase 6（主动洞察 6-A…6-F）的模块都落了地，
   四道门槛的判定已按各片判词改成「部分验收」，缺口统一是两件事：真库那一层（派生表零行，写侧只落到两行——见「真库实况」）、界面只实测到「入口在真渲染里存在 + 组件挂得上」这一层
   （6-G 那一节写了 11-04 起服务登进去之后到底量到了什么、点不动的原因是什么）。
   画像模块仍然不存在，所以门槛 7 的正面陈述照旧无从验收。
5. 界面暴露更多开关之前，先让那个开关真的有消费者——第八个开关这次的顺序就该反过来：先有代码读它，再谈要不要给它一个控件。
6. **Phase 4 的四片到此判完**：时间线读侧（已建）、时间解析（已建，收益 11%）、变化检测（11-03 实测 0/36，**词法方案不做**，判词在上一节）、
   纠正与删除事件（已建，判词在「Phase 4 第四片」）。时间这一层没有待写的代码了。
   还挂着的两件事都**不是**「再写一片就完」：
   - 任务书 **4.1 事件抽取**今天不存在——时间线里的每条事件都是一行记忆，而不是一个抽取出来的事件，
     所以 12 类事件里有 4 类一条也生成不了（4-T1 第一节写明了原因：宁可少几类，不凭语感造经历）。
   - 任务书 **4.3 的 `ChangeDetector`**（六类聚合观察 + 样本数 + 观察跨度 + `INSUFFICIENT_EVIDENCE`）同样不存在。
     它和 4-T3 否掉的「词法取代识别」是两件事，别互相冒充；要建得走 architectural 出 spec，因为它必然引入模型推断。
   在此之前不建议再调相似度阈值：0.20–0.75 那组实测已经说明没有既不误合又能命中的中间值。

## 这份清单不覆盖什么

- 不覆盖写侧的真实数据库行为（抽取、情境分类、演化落库全部止于 mock 边界）；本轮只把 `CognitiveTask` 一张表推进到真库断言，而且那批断言还没真跑过。
- **不覆盖 TLS 出口上的字节**。请求体在本地回环上真收发过（序列化保真、Key 只进头不进体都在 `ai-outbound-request-body.test.ts`），
  但 https 之外那一跳（真模型服务、代理、传输层）今天没有任何断言。
- 不覆盖性能与容量：延迟、存储增长、后台任务耗时在评测报告里逐项标注为「未实现，所以不测」。
  队列这轮改了口径——「回答之后再写」变成「欠账 + 后台跑」，但**每条任务真实耗时仍没有观测值**：
  `cognitive.task_done` 里的时长要等它跑起来才有数，60 秒租约目前是推断（`task-queue.ts:22-24` 的注释自己写了「真正的判断依据是实测每任务耗时」）。
- **不覆盖进程被真杀的场景**。租约回收有 SQL 层证据（种一行过期 RUNNING，看它被判 DEAD / 回 PENDING），
  但没有「写到一半 SIGKILL」的实验——没有注入点能让写停在半路等着被杀，硬做就是 sleep 赌时序。
  同理：`server.js` 的优雅退出**不等在跑的 tick**（`shutdown()` 5 秒后就 `process.exit(0)`，硬 await 一个 20 秒截止只会拖慢发布），
  停机时正在执行的那一条靠租约过期恢复，不是靠 drain。
- **不覆盖多副本部署**。worker 没有开关，两个实例都会起轮询。条件 UPDATE 保证同一行只被执行一次，
  但抢输的一方会把 `attempts` 白刷一次；真上多副本时这条要重新提出来。
- 不做真实会话回放，不碰任何真实家庭成员的私人聊天记录（任务书 7.1 明令）；
  语料全部虚构，标准答案由 Agent 起草、口径经用户复核，不含糊成「人工标注」。

## Phase 5 判词（决策记忆，11-04 六片全落）

- **数据模型**：`prisma/schema.prisma:634`（DecisionRecord）与 `:672`（DecisionOutcome）。
  九个内容列全密文，AAD 比记忆严一格（带字段名，列与列之间不能互换）；
  DecisionOutcome 对 `(decisionId, userId)` 建复合外键，跨用户连边在库层建不出来（5.1）。
  迁移 `20261104100000_decision_memory` 由 migrate diff 生成，**11-04 经他一次性授权已在这台真库执行**（见「真库实况」），`DecisionRecord` / `DecisionOutcome` 实测各 0 行。
- **抽取**：词法 v1，`decision-extractor.ts`（六类「动词+领域」标记，问句/偏好/闲聊不抽，一轮最多两条）；
  结果匹配 `outcome-extractor.ts:38` 两道闸：结果标记 + 与已确认决策主题至少一个共同词，
  连出来一律 `CANDIDATE`——归因是用户的判断，不是词法的判断（5.3）。
- **门槛 8 的库里形态**：`decisions.ts:96` 的确认只从 `PENDING_CONFIRM` 出发（where 带状态），
  并发两次确认第二次是 409；「正式决策记录」= status 为 CONFIRMED 的行，不靠调用方记得判。
- **门槛 9**：`decisions.ts:73` 的闸门在两个路由最前面，关着或偏好读不出时一次查询都不发；
  写侧挂在现有 CognitiveTask 通道上，`decisionMemoryEnabled` 本就在 MODULE_SWITCH 表里。
- **5.4 的禁令在提示词里的形态**：`decisions.ts:237` 的块头——
  「仅供参考，需结合当前约束重新分析，不要照搬过去的选择」；零分一条不送。
- **界面**：设置页「决策」tab（`decision-panel.tsx`），五个列表 = 五个 status，
  候选行才有确认/拒绝，结果候选带「确认关联 / 解除关联」，没有默认答案。
- **测试**：`tests/unit/cognitive-decision-*.test.ts` 四个文件 + 召回探针；全量 829 过、tsc 干净。

### Phase 5 仍然无法验收的部分

- 整条 5.5 链路（识别→确认→保存→关联→结果→召回）**没有真库行为证据**：两张表已落库但实测 0 行，上面所有断言止于 mock 边界。等他开 `decisionMemoryEnabled`（今天实测是关的）、聊几轮后才能转真。
- 界面**没有浏览器验证**：本机不起他的服务，面板只过了 typecheck；
  他下次起服务打开「决策」tab 时才是第一次真渲染。
- 7.2 的 D 臂仍缺：评测语料没有决策字段，探针只是单元级的「该连连、不该连不连」。

## Phase 6 判词（主动洞察，11-04 六片落齐 6-A…6-F）

- **数据模型（6-A）**：`prisma/schema.prisma:744`（ReflectionRecord）与 `:804`（ReflectionCitation）。
  标题、正文、竞争解释、反证关键词四列全密文，AAD 和决策一样带字段名
  （`reflection:v1:${userId}:${id}:${field}`，`src/lib/cognitive/reflections.ts:42`）。
  `@@unique([userId, dedupKey])` 让同主题的第二条**在库层插不进来**，去重不靠应用层记着。
  迁移 `20261104110000_proactive_reflection` 由 migrate diff 生成，**11-04 经他一次性授权已在这台真库执行**（见「真库实况」），`ReflectionRecord` / `ReflectionCitation` 实测各 0 行。**这支迁移曾经把后台写侧整条链路打死过**，原因写在「真库实况」里。
- **规则层（6-B，零模型调用）**：七类 `ReflectionType`（`schema.prisma:165`）都有出题函数与写成常量的阈值
  （`reflection-planner.ts:29-43`：`PATTERN_MIN_SAMPLES=3`、`PATTERN_MIN_CHATS=3`、`PATTERN_MIN_SPAN_DAYS=14`、
  `UNRESOLVED_MIN_AGE_DAYS=60`、`INTEREST_SHIFT_MEDIAN_GAP_DAYS=30`、`TOPIC_MIN_OVERLAP=2`），
  凑不齐阈值的主题进 `plan.insufficient` 并只记类型和两个计数进日志——**证据不足不硬写一条**。
  成簇是并查集，`dedupKey = TYPE:sha1(主题词)`。
- **措辞与自查（6-C）**：反证只认「主题命中 + 带否定词（`不/没/无/别`）+ 支持行自己不带这个否定词」，
  已被取代或已撤回的行算反证，已引用过的行不重复计数（`reflection-evidence.ts:104`）。
  置信度按样本数、跨度、反证命中算（`reflectionConfidence`），反证扣分有上限；
  `importance` 是**不扣反证**的那一份证据量——两个数各说各的事。
  EvidenceCritic（`reflection-evidence.ts:218`）五种拒稿码：`GHOST_CITATION` / `UNSOURCED_ASSERTION` /
  `COUNTER_UNMENTIONED` / `COUNT_MISMATCH` / `HYPOTHESIS_DROPPED`，被拒的洞察**不落库**。
- **落库与冷却（6-D）**：`reflection-sweep.ts:63-72` 四个常量——一天一轮、一轮最多三条、没人理的活 30 天、单轮硬截止 15 秒。
  冷却用条件 UPDATE 抢（和 task-queue 领任务行同一协议），先抢后跑。逐情境闸门读策略表的 `allowReflection`
  （`reflection-sweep.ts:452`），这是那个字段在服务端的第一个读取方。
- **状态机与读侧（6-E）**：六个状态的生产者说得出名字（门槛 7 的静态对账，
  `tests/unit/cognitive-reflection-states.test.ts:55` 直接拿 schema 的 enum 和这张表对账，多一个状态就红）：
  `PENDING`/`EXPIRED` 归 sweep，`ACCEPTED`/`REJECTED`/`EDITED`/`SNOOZED` 归用户动作。
  「过期」有两处判：sweep 每天收割一次，读侧在 `expiresAt` 已过时当场派生成 `EXPIRED`
  （`reflections.ts:93`），否则 30 天的 TTL 在界面上要拖到下一次扫描才生效；
  动作侧同样拒过期行（409），界面和库里不会各说一套。
  `SNOOZED` 到期由 sweep 放回 `PENDING`，不留只进不出的死状态。
- **界面（6-F）**：设置页「洞察」tab（`src/components/settings/reflection-panel.tsx`）读那两条已有路由，
  六个区就是六个状态（11-04 判的甲：全列，空区不渲染）；行内按钮只由 `isActionable` 决定，
  状态机入口只有 `PENDING`，所以给已处理的行摆按钮等于摆一个必然 409 的控件。
  展示词汇搬进纯模块 `src/lib/cognitive/reflection-display.ts`（只 `import type`，
  否则 prisma 驱动会被拖进浏览器包——这条边界和 `memory-display.ts` 同一套）。
  **时间按 `timePrecision` 降级**：只有年就不露月日，到日就不露时分，精度未知整行不显示（门槛 6 在界面上的落点）。
  原话已经不在了的引用不列（宁少不编，门槛 4）；一条都不剩时落进「这条洞察没有可展示的原始依据。」。
  「改写」这一版**不给入口**（11-04 判的乙：服务端已实现并测过，界面不露）。
  策略面板补了 `allowReflection` 复选框（11-04 判的第三个：只补这一个）——它的消费者是
  `reflection-sweep.ts:452`；画像与关联两列至今 grep 到的只有存储与校验声明，没有任何运行时读取方，
  所以仍然不给控件。
- **三条裁定都落在代码上**：甲（零模型，规则出题）、乙（采纳只翻状态——行为用例 + 源码禁写 + 全仓 import 扫描三道，
  见门槛 7）、丙（v1 不做读侧提示注入：洞察除了两条自己的路由，全仓无人 import）。
- **测试**：8 个反思文件共 203 条用例（11-04 逐文件重跑量出来的：planner 40 / evidence 40 / sweep 38 / 读侧服务 21 /
  路由 15 / 状态对账 9 / 展示纯函数 22 / 界面静态断言 18——前六支是 6-E 那批，后两支是 6-F 与 6-G）；
  全量 `npx vitest run` 1036 条通过（77 个文件），`npm run typecheck` 干净。
  8 个变异探针逐个验证「破坏保证必有测试变红」：去掉动作的条件 `status: 'PENDING'`（1 红）、
  accept 顺手写一行记忆（2 红）、snooze 改成删行（1 红）、闸门不读偏好（5 红）、
  稍后天数不设限（1 红）、去掉 SNOOZED 收割（1 红）、关掉复活例外（2 红）、读侧不判过期（2 红）。
  **第一条探针在探测前是没有覆盖的**——补了一条模拟交错的用例（读回 PENDING 之后、条件更新之前把行翻成 ACCEPTED），
  它才红得起来；求值器不模拟行锁，这条钉的是「UPDATE 自己带状态条件」，不是「数据库会替你拦」。
- **6-F 的八个界面探针（同样每个都弄红过一条测试才收）**：摘掉 `isActionable` 闸门（1 红）、面板里加出改写入口（1 红）、
  采纳文案被「润色」成已记住（2 红）、时间降级失效让 YEAR 也显示到日（1 红）、设置页渲染分支被摘掉（1 红）、
  给无消费者的画像列加控件（1 红）、面板改引带 prisma 的服务端模块（1 红）、闸门失效让关着也发请求（1 红）。
  跑探针的脚本第一版有 bug：还原前又把已变异的文件二次备份，于是变异累积留在工作区——四个文件带着改动一路跑到 P8。
  发现后逐处复原（typecheck + 43 条相关断言重跑全绿），脚本改成「改前留档、还原后按 md5 校验与原文一致」再重跑，
  才有上面这八行。

### 6-G：日期口径统一 + 补上的两句话 + 第一次真渲染（11-04 他判的三个「1 统一 / 2 按你说的做 / 3 你能起就起」）

- **日期统一到时间线那一屏的「年月日」**：`reflection-display.ts` 的 `formatAt` 原来输出 `2026-11-04`，
  和 `memory-display.ts:133-142` 那套 `2026年11月4日` 是同一个项目里同一精度的两种写法。现在按 `YEAR → 2026年`、
  `MONTH → 2026年11月`、其余到日、`TIMESTAMP` 才带时分，降级台阶一个字没动（门槛 6 的「不许说得比记录的更精确」照旧）。
  「已推迟到」那行的日期跟着换成同一套。跨文件的口径由一条断言钉住：
  `tests/unit/cognitive-reflection-display.test.ts` 直接读 `memory-display.ts` 的源码，要求两边都是「年＋月＋日」，
  并且这边不再出现 `-NN-NN` 那种 ISO 串——界面里也不许自己 `new Date()` 格式化（另一条断言守着，面板只调纯函数）。
- **补上的两句话**（他让我自拟文案，所以这两句**不在 11-04 那张逐字表里**，要他过一遍）：
  每条洞察的区头下面多一行 `生成于 2026年11月4日`——之前的行只有「依据的时间」，用户分不清那是事情发生的时间还是系统想出来的时间；
  列表读满 100 行（`REFLECTION_LIST_MAX_ROWS`，`reflections.ts:35`）时顶部多一条提示
  `洞察比这一屏多：这里只列出最近 100 条，更早的没有读进来。`——服务端本来就只发 100 行并带 `capped`，
  不说出来就等于用「看不见」冒充「没有」。截断句用的是**实际渲染出来的条数**而不是抄常量，
  因为那个常量在带 prisma 的模块里，界面 import 它会撞上一条边界测试（`cognitive-reflection-panel.test.ts` 的包边界那组）。
- **第一次真渲染（部分量到，部分量不到）**：起他的服务登进 `/settings` 之后，
  设置页那一屏的导航真的把「洞察」摆了出来（`nav button` 的 textContent 实测九项，它排在「决策」之后）。
  **再往下一寸没走到**：这一屏的正文在流式 Suspense 边界（`#S:0`）里，而那个边界始终没被 hydrate——
  页面上 194 个 DOM 节点只有 12 个挂着 fiber，`<洞察>` 那颗按钮上没有 `__reactProps`，所以 `click()` 与
  `dispatchEvent` 都切不动 tab；同一页面里实测 `requestAnimationFrame` 一次都不回调（`visibilityState=hidden`、视口 0×0），
  `MessageChannel` 却正常。这是**这台浏览器替身的限制，不是应用的缺陷**：它的 `mcp` 点击工具同一个原因直接报
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`。
  能补的证据补到「组件真的挂上去了」为止：用 `react-dom/server` 的 `renderToStaticMarkup` 渲了一次 `ReflectionPanel`，
  不抛错，产出的是「AI 主动洞察」＋说明句＋「开关状态未知」——即 `enabled === null` 那一支，也就是任何请求返回之前用户看到的第一个画面。
  这个探针跑完即删，没进提交（渲染它需要把 esbuild 的 JSX 打到 automatic，仓库里没有 DOM 测试环境这一既成事实照旧）。
  **仍无法验收**：行内排布、三个按钮点下去、依据展开、六个区的空区不渲染、真数据下的换行。
  而且今天就算界面能动也只见空态——`reflectionRecord` / `reflectionCitation` / `decisionRecord` 三张表 11-04 已随迁移落库但实测 0 行（见「真库实况」），
  `reflectionEnabled` 默认关，路由在碰到表之前就 409。

### Phase 6 仍然无法验收的部分

- **界面只量到「入口在 + 挂得上」**：6-F 那一屏接进了设置页，11-04 起服务登进去第一次看到它——导航里真有「洞察」，
  `renderToStaticMarkup` 渲 `ReflectionPanel` 不抛错。但**这台浏览器替身（0×0、hidden、rAF 不回调）点不动那个 tab**，
  所以行内排布、三个按钮、依据展开、空区不渲染全部仍未验（过程与物证见上一节 6-G）。
  像素与交互这一层从来不在 vitest 的能力范围内（跑在 node，仓库里没有 jsdom 和渲染器），
  所以这一屏能验的推到「纯函数 + 源码静态断言 + 初次挂载」三层，剩下的只能他自己在真浏览器里看一眼。
  原先「故意没显示」的那两处信息（行的生成时间、列表截到 100 条）**6-G 已经补上**，文案是他让我自拟的那两句，还没过他的目。
- **真库零行**：`reflectionEnabled` 默认关，`ReflectionRecord` 实测 0 行（表已存在），历史上没有任何一条洞察在真库里存在过；
  上面全部是内存求值器上的证据。冷却、限量、逐情境闸门、复活这四件事都要等他起服务、开开关、聊出几十条记忆之后才谈得上目测。
- ~~**删除侧漏了洞察（门槛 2 的新缺口）**~~ **6-H 已补**（同日下午他判的甲 +「1算 2一起收 3不要报」）：
  `forgetting.ts` 现在读 `reflectionCitation`、删 `reflectionRecord` 与 `decisionRecord`，判词与证据见下一节。
- **复活判据是从实测里重推出来的，不是原判据**：他批的语义是「这条洞察的支持证据里有 decidedAt 之后新记的记忆」，
  实测证明这个条件恒为 false——CONTRADICTION 的支持证据固定是相抵那两句的代表，第三句同话题的话根本进不去。
  现在实现的是「池子里 decidedAt 之后新记的行，与这条洞察的主题词重合 ≥ 成簇阈值」（`reflection-sweep.ts:497`），
  尺子和成簇同一把（`sharesTopicWith` 由 planner 导出）。副作用也测出来了：那第三句会另外撑出一条新洞察（PATTERN），
  所以复活用例全部按行 id 找目标，不假设库里只有一行。
  另外实测发现**复活写回的正文可能和原来一字不差**（finding 本身没变），所以那条用例钉的是
  「密文重写 + 状态复位 + 引用整批替换」，不是「文字必须变」——这句要说给他听，因为原判据的意图正是「别用同一句话骚扰」。

### 6-H：删除连带清掉洞察与决策（门槛 2 的补刀，11-04 他判的甲 +「1算 2一起收 3不要报」）

**这一片改的是不可逆动作，所以口径全部由他判，我不替他选**：
甲＝被引用的洞察**整条删掉**（不是留个「依据已删」的空壳，也不是连引用行都不许碰）；
「1算」＝只作为反证（`CONTRADICTS`）被引用也算这条洞察的证据，删掉反证那条洞察同样死；
「2一起收」＝`DecisionRecord` 在本片一起清；
「3不要报」＝派生删除不进界面文案、`PurgeResult` 不加计数，所以 `memory-panel.tsx` 一行没动，也没有新的批准文案。

#### 代码事实（三条入口各自收什么）

| 入口 | 收派生数据 | 位置 |
|---|---|---|
| `purgeMemory`（删一条＝删整条版本链） | 引用链上**任一版**的洞察（含它的引用行）；**不碰决策行** | `src/lib/cognitive/forgetting.ts:196`，调用 `:212` 的 `insightIdsCiting(tx, userId, ids, [])` |
| `purgeMemoriesByChat`（忘记这次对话） | 这批记忆引着的洞察 + 这次对话产生的**决策行** + 那些决策引着的洞察 | `:226`；`decisionIdsByChat` 在 `:159`，收口在 `:234-242` |
| `purgeAllMemories`（清空全部） | 本用户的洞察、引用行、决策行（按 userId 全清，和「清空」的范围一致） | `:267-275` |

三个顺序上的硬规定，都在代码注释里各写了一句为什么：
一、**读引用行排在删记忆之前**（`forgetting.ts:108` 的注释、用例 `:838`）。真库上 `ReflectionCitation.memoryId` 是
`onDelete: Cascade`（`prisma/schema.prisma:815`），记忆一删引用行就没了，那时候再问「谁引用过它」查无此据——洞察正好留在原地，就是这片要修的那个洞。
二、**删洞察排在删引用行之后**（`deleteInsights`，`forgetting.ts:140`）。反过来说不通：引用行是洞察的一部分，先删本体在真库靠级联能过，但那等于让清理靠库层兜住。
三、**派生清理和删行在同一个 `$transaction` 里**（用例 `:939`）；`purgeAllMemories` 本来就在事务内，三条删除同样在里面。

`DecisionOutcome`（决策的结果行）**这片不显式删**，由它自己那条指向 `DecisionRecord` 的外键级联带走（`prisma/schema.prisma:730`，`onDelete: Cascade`）。
Embedding 不需要清理——它是 `MemoryItem` 自己的一个密文列（`embeddingCiphertext`），随行一起消失。这两条是 schema 事实，不是本片新增的用例。

#### 先红与变异探针

| 步骤 | 结果 |
|---|---|
| 先红（只加替身和用例、`forgetting.ts` 未改） | `tests/unit/cognitive-forgetting.test.ts` 56 条里 **12 failed**：40 条既有用例全绿，当时那 16 条新用例里 12 红 4 绿——绿的正是「别人的不许动 / 单条不许碰决策 / 别的情境不许动」这类**反向守门**用例，代码什么都没做时它们本来就该绿 |
| 实现后 | 同一文件 **59 条全绿**（`Tests 59 passed (59)`），全量 **77 个文件 1055 条**绿，`npx tsc --noEmit` 干净。先红那轮 56 条，之后多出 3 条：`:904` 是 P5 逼出来的，`:1049`（0 行也收决策）和 `:991`（别人的会话塞进来）是复核补的**守门用例**——加进来到下一次有记录的运行都是绿的，不是逼出来的，各自靠 P3/P7 证明它们不是空断言 |
| P1 只删引用行、留下洞察行（甲的另一半） | **7 条转红**（`:810`、`:826`、`:850`、`:861`、`:877`、`:939`、`:963`）——「洞察还挂着但证据没了」这个具体后果被钉住了 |
| P2 只在 `kind: 'SUPPORTS'` 时才算证据 | **1 条红**（`:826`「1算」那条）——他判的「反证也算」有唯一的看守者 |
| P3 按会话删决策时不带消息范围（`where: { userId }`） | **1 条红**（`:952`）——「忘记这次对话」不会顺手清掉他轮的决策 |
| P4 只查被点那一行的引用（`[head.id]` 代替整条链） | **1 条红**（`:877`）——链上任一版作证据都算，和 4-T4 的整链删除口径对齐 |
| P5 读引用行时不带 `userId` | **第一次探测没有测试变红**：两次删除都带 `userId`，跨用户的读变不成跨用户的写。补了 `:904`（断言这一轮引用行候选里一条别人的都没有）之后重探，该条转红 |
| P6 把找洞察挪到删记忆之后 | **1 条红**（`:838` 的顺序断言）——注意它钉的是**调用顺序**这个形状：替身不做外键级联，所以「挪到后面就查不到」这个真库后果在这套内存替身上复现不出来 |
| P7 读候选决策行时不带 `userId`（`decisionIdsByChat` 那条 `findMany`） | **1 条红**（`:991`，该轮 59 条里 1 红 58 绿）——和 P5 完全同一课：删除那一层还带着 userId，所以跨用户的**读**变不成跨用户的**写**，只有把「读到的候选必须为空」写成断言才看得见 |

P5 和 P7 落的是同一条规律，也不是他自己选的三条判词里的东西（隔离口径），所以按事实写：读侧漂移在本片的行为层不可观测，只有 id 会漏；
补的两条用例把「读也带 userId」从推断变成断言，代价是这两条只钉形状不钉后果。
收尾复核时还改掉了一句注释：`decisionIdsByChat` 原先写「能走到这里说明这一轮至少有一条本用户的记忆挂着它」，
那是错的——`memories/route.ts` 的 DELETE 不校验会话归属，`chatId` 是查询串里的任意字符串，原样传进服务层。
现在注释写的是事实：**这一头的读跨用户，隔离全靠写侧那一道 userId**，`:991` 钉的就是它。

#### 这一片的边界

- **真库无法验收**：`reflectionRecord` / `reflectionCitation` / `decisionRecord` 三张表**今天在真库里已经存在**（`20261104100000_decision_memory`、`20261104110000_proactive_reflection` 两支迁移 11-04 经他授权执行，`prisma migrate status` 报 up to date），但实测**各 0 行**；`MemoryItem` 2 行 / `MemoryRevision` 0 行（见「真库实况」）。上面 59 条全部走的是文件内自带的内存求值器（`:39-53`），不是 SQL。
- **级联行为仍零覆盖**：甲的实现方式让删除顺序在真库上和级联重叠（显式删完之后再删记忆，库层再兜一遍，无害）。
  重叠是否真的无害，只有集成链能回答，而那条链他没再提（`tests/run-integration.sh` 从 `0e5b89e` 起一次没跑完过）。
- **`dedupKey` 主题位空出来这件事是可见后果**：删掉洞察后，下一次收割可以就同一主题重新出一条（剩下的证据够的话）。
  这不是修复，是甲的另一面——任务书 6.6 的去重键防的是「同一时刻两条同主题」，防不了「旧的一条被删掉之后再来一条」。
- **`chatId` 没有归属校验，这一片的隔离全靠写侧的 `userId`**：`memories/route.ts` 的 DELETE 把查询串里的 `chatId` 原样交给服务层，
  `Message` 表又没有 `userId` 列（`prisma/schema.prisma:269-291`），所以「忘记这次对话」在找候选决策行时**确实会读到别人会话的消息 id**。
  今天它到不了写：每一条 `deleteMany` 都带着 userId，`:991` 把这件事钉住了。真库上如果哪天出现「我的决策行指向了别人的消息」这种脏数据，
  这一片不会把它带走（写侧条件不匹配），但也说明写侧的归属校验在别处（worker），不在这里。
- **界面一句话都没改**（他判的「3不要报」）：所以用户在「记忆」那一屏点永久删除时，
  不会看到「同时删掉了 N 条相关洞察」这种数字。这条口径的代价要记着：
  洞察屏上那条洞察会**凭空少掉**，两个屏之间没有任何解释。等他哪天觉得这说不通，改的是文案和 `PurgeResult`，不是这里的删除逻辑。

## 8.2：聊天里那句「这一轮带上了哪几条记忆」（方案甲，11-04 他判的「按方案甲开工」）

任务书 8.2 那两句是「聊天界面支持显示 AI 引用历史记忆的轻量提示」和「用户可以点击查看原始记忆来源」。
甲的形状：**零迁移、零新表**——引用清单在服务端算好，随本轮的 `done` 帧一起交出去，界面只拿它说话；
点开时复用既有的 `GET /api/account/cognitive/memories`，不新开通向记忆正文的口子。
代价是这份清单**只活在这一页**：刷新、切会话、重新进来都没了，因为没有任何地方记住过它。
（乙是落一张 `TurnCitation` 表，能持久但也多一支迁移；他没选乙。）

### 代码事实（这条链一共五处，每处只干一件事）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 块的形状 | `src/lib/cognitive/manager.ts:29-34` | `CognitiveBlock` 多一个可选的 `memoryIds`，注释写明「填的必须是进了 `text` 的那几条」 |
| 谁进的提示词 | `src/lib/cognitive/memory-module.ts:146,158,162` | `renderMemoryBlock` 边拼行边记 id，预算截断掉的那条**不记** |
| 本轮的清单 | `src/lib/chats.ts:353-362,410,454` | `buildConversation` 的返回值从 `AiMessage[]` 变成 `{ messages, citedMemoryIds }`，清单是各块 `memoryIds` 的去重并集 |
| 交出去 | `src/app/api/chats/[id]/messages/route.ts:148-151` | `done` 帧多一个 `memoryIds` 字段；只有成功帧给 |
| 说话 | `src/lib/cognitive/citation-display.ts`（新）+ `chat-workspace.tsx:112,158,178-187,554-560,1398,1417-1486` | 纯模块出句子和行形状，组件只管渲染与点开时那一次读 |

两个形状上的选择值得记下来：
一、**清单在服务端算，不在界面数**。界面手上只有发给模型的文本，重算等于再猜一次；服务端拼块那一刻知道得最清楚，就在那一刻记。
二、`citation-display.ts` 是**客户端可安全引用的纯模块**，运行时只 import `memory-display`（同样不碰 prisma），
   和 `memory-display.ts` / `reflection-display.ts` 是同一套理由；这条边界由用例 `cognitive-citation-display.test.ts:103` 的静态断言钉住。

### 文案（他批过的那张表，两处偏差在最下面）

| 位置 | 字面 |
|---|---|
| 收起态 | `这一轮带上了 N 条长期记忆`（N=0 时整句不渲染，界面什么都不摆） |
| 展开区顶部 | `这只是这一轮随问题一起交给模型的资料，不代表模型按它回答了。` |
| 每行说明 | `记于 2026年11月3日 · 可信度中 · 来自《关于项目》`（日期走 6-G 那套「年月日」，标题拿不到就不提来源） |
| 那条已经不在了 | `这条记忆已不在你的有效记忆里（可能已被更新或删除）` |

**偏差一**：批准表里写的是「可信度：中」，实现用的是仓库里已有的 `CONFIDENCE_BAND_LABELS`（「可信度中」，没有冒号）。
同一件事不该有两套词，所以选了既有那套；要回到批准表的原字面，改的是 `memory-display.ts` 那份标签，全项目一起变。
**偏差二**：点开时那一次读失败要有一句可说的话，批准表里没有这句，实现用的是「这条清单没读到，稍后再试试」——**这句没批过，等他判**。

### 先红与变异探针

| 步骤 | 结果 |
|---|---|
| 先红（只加替身和用例、`citation-display.ts` 未建） | `cognitive-citation-display.test.ts` 因为模块不存在**整文件加载失败**（一条用例都没被收集），另外三个文件里那 7 条新断言全红：`Tests 7 failed | 37 passed (44)`（seam `:236,:247`、wiring `:161,:168,:175`、route `:535,:545`）；红的理由各自是 `expected undefined to deeply equal ['a','b']` 这类**字段根本不存在**，不是断言写歪 |
| 实现后 | 那四个文件 **52 条全绿**；全量 **78 个文件 1081 条**绿，`npx tsc --noEmit` 干净 |
| P1 `citationHint` 去掉 `count <= 0` 那条守卫 | 1 红——「0 条不摆控件」有看守者 |
| P2 配不上的 id 改成空正文、`missing: false` | 1 红——「少列一条不解释」会被这个数字与清单对不上的形状抓住 |
| P3 去掉 `if (title)` 守卫（标题拿不到也拼「来自《undefined》」） | **2 红**（`:55` 的顺序用例 + `:83` 的不编来源用例） |
| P4 档位算不出时按 `high` 报 | 1 红——报高比报低乐观，这条把口径钉回「按低说」 |
| P5 行的顺序改成照记忆列表排 | 1 红——清单顺序是**进提示词的顺序**，不是列表自己的顺序 |
| P6 给 `citation-display.ts` 加一条运行时 `import { listMemories } from './memories'` | 1 红（静态断言：`['./memory-display','./memories']` ≠ `['./memory-display']`） |
| P7 `used.push(memory.id)` 挪到预算判断之前（截断的也报） | 1 红（`:239`）——「报一条模型没读到的记忆」正是这条用例要拦的 |
| P8 `buildConversation` 里那句 `flatMap` 换成常量 `[]` | 1 红（`:161`）——链路真的接上了，不是各自单测自己那块 |
| P9 `done` 帧去掉 `memoryIds` 字段 | **2 红**（`:535` 给 id、`:545` 关着时给空数组而不是缺字段） |

九个探针各杀各的用例，全部当场回滚；回滚后重跑那四个文件仍 52 条全绿。

### 这一片的边界

- **界面没有真渲染验收**：这一片没起服务，也没点过。`chat-workspace.tsx` 里那段只过了类型检查，
  「点开能看到正文、收起不占地方、刷新就没了」这三句今天是**推断**，不是实测。他要哪一条变成实测，需要他起服务（我不启动他的服务）。
- **刷新即消失**：甲不持久化，所以历史气泡在重新载入后没有引用提示——包括那一轮真的带过记忆。这不是 bug，是甲的定价。
- **只有成功帧带清单**：`partial`（中断）和 `error` 两帧没有 `memoryIds`。中断那一轮其实可能真注入了记忆，界面不说有也不说没有。
- **只有记忆模块产出 id**：`emotion` / `reflection` / `decision` 这几块今天不填 `memoryIds`，
  所以那句「N 条长期记忆」里的 N 是**记忆条数**，不是「这一轮一共注入了几块认知资料」。字面没骗人，但别把它读成后者。
- **截断的那条不报**（P7 钉住的），报的是进了那块字的。字符预算截掉谁取决于排序，所以「为什么这条没被列出来」这个问题，界面答不了。
- **数字与清单可能各说一面**：数字是注入那一刻的条数，清单是点开这一刻的有效记忆。中间用户删过或改过口，
  清单会多出一行「已不在你的有效记忆里」而不是少一行——这条是 `CITATION_MISSING_LABEL` 那句的存在理由，P2 守着它。
- **点开那一次读的是全量列表**：`/api/account/cognitive/memories` 不带过滤参数（当初就是这么定的，见该路由注释），
  引用只有两三条时它也照样把整个有效记忆列表和解密做完。今天库里 `MemoryItem` 只有 2 行（见「真库实况」），这条成本看不见；
  等有效记忆上百条，代价会从这一屏先露出来。
- **id 出服务端了，正文没出**：`done` 帧里只有那几条记忆的 id，密文和正文都留在服务端，
  点开时仍走原来那条已经鉴权的路。审计与日志本片一条都没加，也就没有新的明文面。

## 7.2：ARCHIVE——可逆的归档（11-05 他判的 R1 乙 / R2 甲 / R3 甲 / R4 甲，文案「没问题，我相信你」）

任务书 7.2 那四条是 `ARCHIVE：归档，仍可在允许范围内恢复` / `EXPIRE：过期，不再作为当前有效事实` /
`SUPERSEDE：被新版本取代，保留历史` / `DELETE：永久删除`。**这片补的是 ARCHIVE，因为它是四条里唯一零实现的那一条。**
另三条早就有：SUPERSEDE 是 `reviseMemory`（新行 + 旧行盖 `supersededAt` + 一条带理由的边），
EXPIRE 是 `retention.ts` 的读侧窗口，DELETE 是 `forgetting.ts` 的链式永久删除。四条到这片才算齐。

为什么不能拿既有动作冒充归档，三条都是硬的：
一、**撤回不是归档**。`retractMemory`（`src/lib/cognitive/memories.ts:430`）覆写的是 `origin=RETRACTED`，
被覆掉的原值（explicit / inferred / hypothesis）没有任何路径换回来，界面上也没有恢复入口——它是单向的。借它表达「收起」，
「仍可在允许范围内恢复」就只是句漂亮话。二、**EXPIRE 不是逐条动作**，它按情境（`MemoryContext`）整块算窗口，
用户没法只收起一句话。三、**`validTo` 不是保留期**，它回答的是「这件事到什么时候不再成立」，不是「这条记录还留不留」。

所以形状只有一种：一列可空的 `archivedAt`（R2 甲）。四个批准点记在这儿，因为它们都是会反悔的那种：

| 判 | 内容 |
|---|---|
| R1 乙 | 行上按钮位给「归档」，「撤回」收进归档的展开区当一个链接——**可逆的那个排在顺手的位置** |
| R2 甲 | 新加 `archivedAt` 一列，不借 `origin`、不借 `validTo` |
| R3 甲 | 归档**不写排除表**：写了以后「恢复」会被自动记账挡回去，动作就成了假的 |
| R4 甲 | `includeSuperseded` 不放宽归档——归档行连「人生时间线」那一屏也不出现 |

### 代码事实（一列、两个函数、四处读口径、两条路由、一屏界面）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 数据列 | `prisma/schema.prisma:529-532` | `MemoryItem` 多一个可空 `archivedAt`，注释写明为什么不走 `origin` |
| 迁移 | `prisma/migrations/20261105000000_memory_archive/migration.sql` | 一条 `ALTER TABLE ... ADD COLUMN`。**只加列不加索引**：读侧永远先按 `userId` 筛，现有的 `(userId, supersededAt)` 前导列已覆盖，且列表本身有 200 行硬上限。**这一支已于 11-05 由他执行**（`npx prisma migrate status` 报 15 支 up to date），见下面边界第一条 |
| 服务 | `src/lib/cognitive/memories.ts:464`（归档）/ `:473`（恢复） | 各一条 `updateMany`，条件里带 `userId`；除此之外一个字节都不写 |
| 读侧默认口径 | `src/lib/cognitive/memories.ts:335`（`archivedAt: null`）+ `:337`（`archivedOnly` 反过来） | 对话注入、记忆管理、时间线、写侧去重池**共用这一个漏斗**，所以一处改完四处都收 |
| 读侧漏在漏斗外的第五处 | `src/lib/cognitive/reflection-sweep.ts:381-382` | 反思池自己 `findMany`，不读 `listMemories`——得自己带上同一口径，否则用户收起来了，洞察还在正文里复述它 |
| API | `.../memories/[id]/archive/route.ts`、`.../restore/route.ts`（两个新文件） | POST：鉴权 → 分桶限流（各 60 次/小时）→ 服务函数 → 0 行即 404 → 审计只带 id。**不要求理由** |
| GET | `.../memories/route.ts:47-49,63-64` | 同一份响应多带一个 `archived`（`archivedOnly: true`，与当前那一份**并行**发出），不喂 chats、不参与置信度；两份列表各带自己的截断标志 `capped` / `archivedCapped` |
| 界面（截断提示） | `src/lib/cognitive/memory-display.ts:127`/`:132` + `src/components/settings/memory-panel.tsx:404,405,435,755` | 两个纯函数只产出句子，面板负责把两句各挂在自己的列表上方；没到上限返回空串，界面一个字都不摆 |
| 界面 | `src/components/settings/memory-panel.tsx:268`（归档调用）/ `:286`（恢复调用）/ `:525`（行上按钮）/ `:751`（已归档区块） | 行上按钮换成归档、归档展开区里给撤回留一句、已归档区块 + 恢复 |
| 8.2 那句话 | `src/lib/cognitive/citation-display.ts:23` | 「（可能已被更新或删除）」→「（可能已被更新、删除或归档）」 |

两个形状上的选择值得记下来：
一、**GET 必须把归档那份带回来**。可逆不是服务端留着那一列就算的——界面没有入口，那一列就是黑洞。
所以「已归档」区块和「不再自动记住的内容」那张表是同一职责：都给一个已经发生的动作留回来的地方。
二、**归档不取消后台欠账**（`CognitiveTask` 里那条记忆的向量任务照旧算完）。省那一次调用换来的是恢复后不能立刻被向量召回，
不划算；留着则恢复那一刻什么都不用补。这是选择，不是遗漏。

### 文案（他批过的那张表，两处补充在最下面）

| 位置 | 字面 |
|---|---|
| 行上按钮（顶掉「撤回」） | `归档` |
| 展开区标题 | `把这条收起来？` |
| 展开区正文 | `收起后这条不再进入对话，也不会再被当作洞察的证据。正文和版本都留着，随时可以恢复。` |
| 确认按钮 | `确认归档` |
| 已归档区块的行标签 / 按钮 | `已归档` / `恢复` |
| 两个 toast | `已归档，这条不再进入对话` · `已恢复，这条重新作为当前有效记忆` |
| 屏顶那句 | `更正会留下旧版本，归档随时可以恢复；永久删除不可恢复。` |
| 开关关掉时的提示 | `要逐条停掉，用「归档」。` |
| 8.2 点开时那条 | `这条记忆已不在你的有效记忆里（可能已被更新、删除或归档）` |
| 撤回展开区 | 一字未改，只是入口挪了位置 |

**补充一（没批过，等他判）**：归档展开区里那条指向撤回的链接，批准表只说了「撤回收进展开区」，没给字面。
实现用的是 `撤回这条（写明理由，这一屏没有恢复入口）`——括号那半句是说清两个动作的区别，不是装饰。
**补充二（没批过，等他判）**：「已归档」区块顶部那句说明 `这些内容不参与对话，也不会被当作洞察的证据。要重新使用，点「恢复」。`
表里只有行标签和按钮，这段说明是新写的。区块为空时整块不渲染，所以不会出现「一段没有内容的解释」。

**补充三（没批过，等他判）**：两份列表各自的截断提示，`记忆比这一屏多：这里只列出最近 N 条，更早的没有读进来。`
与 `已归档的记忆比这一屏多：这里只列出最近 N 条，更早的没有读进来。`——口径和时间线（「记忆条数已达上限：时间线只覆盖最近这一批」）
与洞察一屏（`describeListCap`）一致：**到顶必须说出来，不能被读成「更早的没有了」**。两句分开写、各自挂在自己那一块列表上方，
因为「记忆比这一屏多」和「归档比这一屏多」是两件不同的事；条数用的是这一屏实际渲染的 `memories.length` / `archived.length`，
不是抄一个 200 的常量——抄了常量，将来改上限或读回来的条数不足时说的就成了假话。

### 这一片改完之后，三个设计后果（不是遗漏，是他要知道的）

| 后果 | 为什么是这个形状 |
|---|---|
| **归档后再说同一句话，会新建一条当前有效记忆，而不是把归档那条改回来** | 写侧去重池走 `listMemories`，默认口径已经把归档行排除（P8 钉住）。归档的意思是他说了「这条不再代表现在的我」，于是重新说一次就是新的一次表达，不该跟一条他自己收起来的旧行去演化。代价：同一件事在库里可以有两行「当前有效」，历史看起来分叉 |
| **时间线里看不见归档的行** | R4 甲直接定过：`includeSuperseded` 不放宽归档，被取代的老版本都要在时间线露面，归档那条反而不露——只有「已归档」区块能看见它 |
| **一条洞察的证据里若引用了已归档的记忆，点开数字仍然看得见那条正文** | `reflections.ts:168-172` 的解释是「引用行已写死了这一行 id：那才是这一条洞察当时依据的东西」，读的是 `findMany({ where: { id: { in: ids } } })`，不经 `listMemories`，所以没有归档口径。这是既有形状：引用要能追溯当时依据的那句话，而不是那句话现在的状态 |

### 真库回滚探针（11-05 他批的第 4 次动库）

只读，或包在事务里 rollback，一个字节都不留下（`archivedAt` 全程只在内存变量里算过，没进 `tx`；`rollback()` 在任何写之前）。
它把「替身求值器 ≠ 真实 SQL」这条洞在归档这一处量掉了：

| 量到 | 证据 |
|---|---|
| 读侧默认口径 | Prisma 6.11 把 `where: { archivedAt: null }` 编成 SQL 参数 **0 个**，只有 `WHERE ("t0"."userId" = $1 AND "t0"."archivedAt" IS NULL)`——空值筛是真 `IS NULL`，不是 `= NULL` |
| 归档口径反过来 | `{ archivedAt: { not: null } }` 编成 `"t0"."archivedAt" IS NOT NULL`，同样 0 个参数 |
| `enum` 的 `notIn` | 编成 `"t0"."origin" NOT IN (CAST($2::text AS "public"."MemoryOrigin"), CAST($3::text AS "public"."MemoryOrigin"))` |
| 跨用户写不进去 | `updateMany({ where: { id: <别人的行>, userId: <我> }, data: { archivedAt } })` 真库返回 `{ count: 0 }`，未匹配的那一行**原样未变** |
| 自己那一行写进去 | 同形状的 `updateMany` 返回 `{ count: 1 }` |
| 没有写坏他的数据 | 收尾一次纯读：`{ total: 2, archived: 0 }`——库里那 2 行一条没被归档、一条没被删 |

**这条探针的边界要说清**：它只验了归档那两处 `where` 的 SQL 形状和跨用户不匹配。`archivedAt` 上的索引、上百行时的
查询计划、归档前后 `assessMemories` 与演化边的真库行为**仍没实测**——下面「界面没有真渲染验收」那条的天花板没有变。

### 先红与变异探针

| 步骤 | 结果 |
|---|---|
| 先红（服务层 + 反思池） | 6 条服务用例和 1 条反思池用例先写后红：`archiveMemory` / `restoreMemory` 当时还不存在，调用即抛。**这一步的精确计数没留档**，非空由下面的 P1—P7 逐条补上 |
| 写侧那条是守成用例，落地时就绿 | `cognitive-memory-module.test.ts:273` 钉的是「写侧调 `listMemories` 时不传 filters」这个调用形状——它守的是**别在后来**把归档行自己捞回匹配池，不是本片新加的行为。不假装它红过；它的非空由 P8 补 |
| 先红（路由） | 8 条路由用例全红——`archive/` 与 `restore/` 两个模块不存在，用例里的动态 `import` 直接失败；文件里既有用例不受影响 |
| 实现后 | 服务 + 写侧 + 池三个文件 136 条绿；路由文件 52 条绿；全量 **78 个文件 1097 条**绿，`npx tsc --noEmit` 干净 |
| 截断提示落地后 | 新增 **18 条**：`memory-display.test.ts` 3 条（两句提示的字符串）+ 路由 3 条（两个标志各报各的）+ 新文件 `cognitive-memory-panel.test.ts` 12 条（5 条逐字钉住本片已批文案、3 条钉「控件必须有消费者」、4 条钉截断提示的接线）。全量 **79 个文件 1115 条**绿，`npx tsc --noEmit` 干净 |
| P1 `listMemories` 去掉默认的 `archivedAt: null` | **4 红**（`cognitive-memories.test.ts:797/811/848/859`）——这一处守卫同时守着「不进当前有效」「不进时间线」「恢复列表拿得到它」 |
| P2 归档顺手盖上 `supersededAt` | 3 红，目标 `:797`「只写这一列」在内 |
| P3 归档的 `where` 去掉 `userId` | 1 红（`:824`）——跨用户改状态在这一条上守着 |
| P4 恢复写成时间戳而不是 `null` | 1 红（`:811`） |
| P5 `archivedOnly` 那道分支失效 | 1 红（`:859`） |
| P6 归档顺手写一条演化边 | 6 红（目标 `:836`「既不写边也不记证据」在内）——归档不是改口，也不是撤回 |
| P7 反思池不带归档口径 | 1 红（`cognitive-reflection-sweep.test.ts:458`） |
| P8 写侧去重池自己捞归档行 | 1 红（`cognitive-memory-module.test.ts:273`） |
| P9 GET 的响应里去掉 `archived` | 2 红（`cognitive-memories-route.test.ts:470/481`）——「进去出不来」在这儿就被抓住 |
| P10 归档路由去掉 404 分支 | 1 红（`:494`） |
| P11 归档路由去掉限流 | 1 红（`:527`） |
| P12 恢复路由去掉 404 分支 | 1 红（`:494`） |
| P13 恢复路由与归档共用同一个限流桶 | 2 红（`:540` 分桶那条 + `:494`）——同桶时「反悔」那一路会被归档用掉的额度直接挡住 |
| P14 审计的 `after` 里夹一条正文标记（**合成变异**） | 1 红（`:506`）——那条断言真会咬。说清楚：今天的代码路径手上根本没有正文，这条用例守的是「以后有人往审计里塞行对象」 |

探针逐个当场回滚，回滚后重跑相关文件全绿。**其中一次回滚出过事故，必须记下来**：P9 那步我用 `git checkout --` 还原
`memories/route.ts`，而这个文件带着本片未提交的改动，于是 GET 里那 8 行被抹回了 HEAD。发现后按原样重新落地并重跑（路由 52 条绿、
`git diff` 复核到就是那 8 行）。教训是探针回滚只许用逐字替换，不许用 `git checkout` / `git stash` 这类会连带吞掉未提交改动的操作。**截断提示这一刀另起了三轮探针，全程按这条执行**：
第一轮三处变异（`capped` 换成归档那一份的长度、删掉当前列表上面那行 `<Alert>`、把归档提示的「已归档的」前缀去掉）→ **4 红**：
路由两条（两处都用错了同一个长度）、面板一条（提示没渲染）、纯函数一条（两句混成一句）；回滚后这 3 个文件 89 条绿。
第二轮单独把 `archivedCapped` 换成 `memories.length` → 2 红（「两个桶各报各的」那两条同时抓住）；回滚后绿。
第三轮只删已归档区块那一行 `<Alert>` → 1 红（「只算出字符串不渲染，等于没说」那条）；回滚后绿。
每一次回滚都是字面替换，回滚后立刻 `grep` 复核那几行的当前内容。

### 这一片的边界

- **迁移已由他执行**：`20261105000000_memory_archive` 于 11-05 用 `npx prisma migrate deploy` 落地，`npx prisma migrate status` 报
  15 支 up to date，`MemoryItem.archivedAt` 真库已有这一列。此条从「这片不可用」降级为只剩两条未闭合：**界面没有真渲染验收**（下一条），
  以及**真库上归档前后的行为没实测过**（库里那 2 行有没有被归档过、恢复后 `supersededAt`/证据/演化边是否原样，都得他起服务点一遍才算数）。
- **界面没有真渲染验收**：`memory-panel.tsx` 过了类型检查，并且现在有一份**静态断言**（`tests/unit/cognitive-memory-panel.test.ts`：
  已批文案逐字、两个按钮各打自己的路由、空区块不渲染、恢复入口只有一处、两句截断提示都真的进了 JSX）。
  但静态断言只证明「源码里写了这句话/这一行」，不证明 React 真的把它画出来。「点归档 → 行掉到已归档区块 → 点恢复 → 回到当前有效」
  这三步今天是推断，不是实测。要变成实测得他起服务。
- **归档行的置信度不变**：证据与演化边一条都没动，`assessMemories` 的账还是那本账；恢复后档位与因子和归档前一致。
  GET 里那份 `archived` 不算置信度，所以归档列表旁没有档位标签——那一屏只要求「看清收起来的是什么，然后恢复」。
- **撤回仍是单向**：这片没有给撤回加恢复入口，也没有把它改写成走 `archivedAt`——那样两个动作就成一个了，任务书的 7.2 少一臂。
  如果他要撤回也可逆，那是一个新的判：得再加一列或把 `origin` 的原值留到别处。
- **`where` 求值器是替身，但归档这一处已经拿真库对过**：P1—P8 走的是内存 Map 里手写的求值器（`{ not: null }`、`archivedAt: null` 都按字面解释）。
  上面「真库回滚探针」那一节把 `archivedAt` 的两处口径、`origin` 的 `notIn` 与跨用户 `updateMany` 在 PostgreSQL 17 上实测过了，
  所以**这一片的 SQL 形状不再是推断**。其余认知条目仍然只有替身求值（见「先说清证据的分层」）。
- **两批解密与两次读**：GET 现在对同一个用户读两遍 `MemoryItem`（各带 200 行硬上限）并解密两份正文，两批并行发出。库里今天只有 2 行，成本看不见；
  有效记忆上百条时，这一屏先露出来。**到顶不再静默**：两份列表各自带截断标志，界面各摆一句，所以上面那句「上百条时先露出来」现在
  是用户看得见的一件事，不是一个只有开发者知道的秘密。
- **8.2 的引用行会多一行说明**：归档一条曾在本轮被引用的记忆，点开数字看到的是「已不在你的有效记忆里（可能已被更新、删除或归档）」，
  不是默默少列一条——这是既有形状，本片只改了那句话的字面，而那句由 `cognitive-citation-display.test.ts:98` 逐字钉住（先红后绿）。

## 7.1：检索再巩固——先把「被调用」变成库里的一个事实（11-05 片 a）

任务书 7.1 原文列了五项检查，末尾两句是红线：

```
记忆被再次调用时，检查：
- 是否出现了新的支持信息。   - 是否出现了新的反例。   - 是否已经过时。
- 是否需要更新摘要。         - 是否需要修改关联关系。
检索次数不能直接提高事实可信度。
访问频率只能影响检索排序，不能替代证据。
```

**开工前这片是 0%，而且卡在一个更基本的事实上：「被再次调用」这件事当天根本没有留下凭据。**
`selectMemoryCandidates` 挑完、`renderMemoryBlock` 拼完，流关掉以后，库里查不出「那一轮真进了提示词的是哪几条」。
没有凭据，五项检查一项都谈不上验收。所以这片第一步不是算标记，是**把调用记成一行**。

### 五项检查的诚实账（做三项，两项判为无法验收，不发明）

| 检查 | 今天有没有 | 这一片 |
|---|---|---|
| 新的支持信息 | 有：`recordRestatement` 会补一条 SUPPORTS（`memory-module.ts:274-288`），证据行带 `createdAt` | **做**：`createdAt > recordedAt` 才算新的 |
| 新的反例 | **行**有（`reviseMemory` 写 CONTRADICTS，`memories.ts:424`），**发现**没有 | **只报库里已有的行**。词法反例发现不接进来，见 `docs/cognitive-acceptance.md:537-570` 那次实测 36 条候选 0 条真是反例 |
| 已经过时 | 全有，读侧：`validTo` / `supersededAt` | **做**，且与 `confidence.ts:72` 用同一个 `<=`，不留两处口径 |
| 需要更新摘要 | **「记忆摘要」这个东西不存在**：`MemoryItem` 没有摘要列 | **不做**。不发明一个没有库存的对象来凑一项 |
| 需要修改关联关系 | **没有可写的关系表**（2a 那次校准的结论，`cognitive-relations-calibration.test.ts:7-29`），派生图是只读的 | **不做**。检查将来能从只读派生邻居回答，动作没有可写的地方 |

### 代码事实（一张新表、一个纯函数、两个旁表字段、一屏标记）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 数据表 | `prisma/schema.prisma:848-860` | `MemoryAccessTurn { id, userId, sourceMessageId, memoryIds String[], createdAt }`。**只有 id，没有正文**（抄 `CognitiveTask` 的口径）；`@@unique([sourceMessageId])` 是幂等锚点；**没有 chatId**：「这一轮发生在哪次对话」等于 `sourceMessageId` 那条消息所在的会话，多一列没有读者，而会话真删时那条外键是 CASCADE，消息一走这一行自己就走 |
| 为什么不放在 `MemoryItem` 上 | 同上，加一条静态用例 | 一轮最多注入 8 条（`memory-module.ts:44`），计数列放进那一行就等于挨着 `assessConfidence` 正在读的 `supersededAt` / `validTo`——红线只能靠自觉。放进另一张表，红线靠形状守着 |
| 迁移 | `prisma/migrations/20261106000000_memory_access/migration.sql` | 建表 + 唯一索引 + `(userId, createdAt)` + 两条 CASCADE 外键。**11-05 已执行**（真库形状见下面边界第一条） |
| 写入 | `src/lib/cognitive/access.ts:64`（`recordMemoryAccess`） | 空列表返回 false、`P2002` 返回 false、任何其他失败也只返回 false 并记一条只带 id 的日志。契约照抄 `enqueueCognitiveTask` |
| 写入点 | `src/app/api/chats/[id]/messages/route.ts:171-175` | 在 `controller.close()`（`:154`）**之后**。「并行任务不应该阻塞主回复」靠位置保证，不靠新机制，所以位置本身有一条静态用例守着（P2） |
| 统计 | `src/lib/cognitive/access.ts:91`（`listAccessStats`） | 取 `MAX_ROWS + 1` 行只为了知道有没有被截断——「恰好读了 200 轮」和「还有更多轮没读」在数字上一样，在诚实程度上不一样 |
| 检查 | `src/lib/cognitive/reconsolidation.ts:54`（`reviewMemory`）/ `:79`（`reviewMemories`） | **纯函数**：输入是已经查回来的列和证据条，输出标记数组，不算分、不排序、不碰库。三种终态（被取代 / 归档 / 撤回）不产标记 |
| 证据的批量读 | `src/lib/cognitive/evidence.ts:166`（`listEvidenceRows`） | 一屏一次查完，只取 `memoryId / kind / createdAt`，说明文字的密文不经过这条路。方向映射仍只有 `fromDbKind` 一份，所以这个读留在证据账本里，不搬进 `reconsolidation.ts` |
| API | `src/app/api/account/cognitive/memories/route.ts:69-76,105-108` | GET 多带 `reviews` / `access` / `accessWindow` / `accessCapped` 四个字段，与置信度、标题**并行**发出。`reviews` 对每条记忆都有一项（空数组 ≠ 缺席）；`accessWindow` 报**实际扫过的轮数**，不把 `MEMORY_ACCESS_MAX_ROWS` 抄给界面 |
| 文案 | `src/lib/cognitive/memory-display.ts:125`（`RECONSOLIDATION_LABELS`）/ `:157`（`describeAccessCount`）/ `:162`（`describeAccessCap`） | 三个纯函数/常量，只产出句子 |
| 界面 | `src/components/settings/memory-panel.tsx:613`（标记芯片）/ `:621`（「最近 N 轮里被带到 M 次」）/ `:552`（截断提示） | 芯片用中性 `chip`，不用琥珀色——琥珀色那一档已经是「可信度低」，「值得回看一眼」不是「不可信」 |
| 忘记连带清理 | `src/lib/cognitive/forgetting.ts:198`（单条）/ `:231`（按来源会话）/ `:282`（按主题，7.3 片 b 补的第四臂）/ `:317`（清空全部） | 派生数据从五种变第六种。删的口径是**被删的那批记忆 id**，整行删（不是把 id 从数组里挑出来——一个已删记忆的 id 本身就是被删内容的痕迹，而残缺的组合比没有组合更误导）；只有清空全部走 `deleteAllAccess`（`:327`），因为「全部」没有子集可挑 |

### 「检索次数不能提高可信度」这一条怎么证（不靠注释）

三层，缺一层都只是一句承诺：

| 层 | 手段 | 用例 |
|---|---|---|
| 结构 | 访问表与 `MemoryItem` 分开；`ConfidenceInput`（`confidence.ts:35-45`）与 `ConfidenceSubject`（`evidence.ts:58-64`）里没有访问字段 | `cognitive-access.test.ts` 「访问计数不放在 MemoryItem 上」「这张表里没有正文列」 |
| 依赖 | `confidence.ts` / `evidence.ts` / `retrieval.ts` / `memory-module.ts` 四个文件不许 import 访问模块 | 同文件「置信度与挑记忆那一侧根本不 import 访问模块」。**这一条本片返工过**：原判词写作 `not.toContain('cognitive/access')`，而同目录的引用写作 `'./access'`——P1 探针实测漏过，已改成匹配 import 语句本身（`/from\s+['"][^'"]*\/access['"]/`），两种写法都咬得住 |
| 行为 | 喂 0 次与 60 次访问，要求置信度输出 `JSON.stringify` **逐字节相同**；再加一条正向对照（多一条真的支持证据必须变），否则上一条是在测一台没接上任何东西的机器 | 同文件「访问不改变置信度（行为证明）」两条 |

### 先红与变异探针

| 步骤 | 结果 |
|---|---|
| 先红 | 服务层 16 条、纯函数 15 条、路由 8 条、忘记 5 条、写入点 3 条、文案 2 条、面板 7 条**先写后红**——`access.ts` / `reconsolidation.ts` 两个模块当时不存在，动态 `import` 直接失败；`listEvidenceRows` 未导出时按命名导入报 `does not provide an export`；面板那批用 `stripComments` 后逐项扫描，「接线了但没渲染」当场抓住 |
| 本片新增用例 | **63 条**：`cognitive-access.test.ts` 21 + `cognitive-reconsolidation.test.ts` 17（两个新文件）+ 路由 8 + 忘记 5 + 面板 7 + 文案 2 + 写入点 3 |
| 实现后 | 全量 **81 个文件 1179 条**绿，`npx tsc --noEmit` 干净。评测快照**未重生**：这一片不改排序、不改注入，`cognitive-eval-snapshot.test.ts` 逐字节比对原样通过 |
| P1 让置信度吃访问计数（`evidence.ts` import `listAccessStats` 并把次数抬进 `score`） | **6 红**：行为证明那条 + 批量置信度 5 条（替身库里没有访问表时 `listAccessStats` 直接抛，也是红）。**但第一轮跑的时候静态守卫是绿的**——它当时只查 `cognitive/access` 字样，放走了 `'./access'`。补强后再喂同一条 import 变异：**1 红**，咬住了 |
| P2 把写入挪到 `controller.close()` 之前 | **1 红**（「访问记录写在 done 帧和 close() 之后」）。这条用例是探针逼出来的：先前没有任何用例区分位置——`recordMemoryAccess` 自己不抛，所以「写坏了不影响那一帧」那条测不出挪动 |
| P3 `listAccessStats` 的 `where` 去掉 `userId` | **1 红**（「别人的轮次一条也不进来」） |
| P4 `newSupport` 改成统计 `recordedAt` 之前的证据 | **4 红**：纯函数两条（创建时那条基线证据、更早的证据）、路由一条（「证据只喂给纯函数，路由不改这个口径」）、外加标记顺序那条——多出来的 `newSupport` 挤进了原本只有 `['outdated']` 的那条 |
| P5 按会话忘记不删访问痕迹 | **1 红**（「按会话忘记清的是被删的那批记忆，不是在这个会话里发生的检索」） |
| P6 让代码多产出一个 `needsSummary` 标记 | **第一轮 0 红**——「标签恰好三项」那条只钉住了 `RECONSOLIDATION_LABELS` 这张表，钉不住产标记的那只手。补上「证据再多也只产这三项」这条行为用例后重跑同一条变异：**1 红**。这正是这片要记的一条：表对了，不等于产出对了 |

探针逐个当场回滚，回滚后立刻 `grep` 复核当前内容；全程只用字面替换，不碰 `git checkout` / `git stash`。

### 这一片的边界

- **迁移已执行，真库形状实测过**：`20261106000000_memory_access` 于 11-05 由我在他的批准下跑下（「两支迁移都还没落库，你直接跑迁移就行了」），`npx prisma migrate status` 报 17 支 up to date。跑完当场做了一次**真库回滚探针**（临时事务，每支都以 `throw` 收尾，事后核对 `probeUsers=0 / accessRows=0`，真实用户那行一点没动），量到的是：
  - 表 5 列：`id/userId/sourceMessageId` text、`memoryIds` **ARRAY**、`createdAt` timestamp 默认 `CURRENT_TIMESTAMP`；
  - `hasSome` 在真 Postgres 上编成 `"memoryIds" && $n`（数组重叠，参数是数组）——命中 1、不命中 0，替身求值器这一处**和真库一致**；
  - 两条外键的 `ON DELETE CASCADE` 都实测生效：裸 SQL 删那条消息，access 跟着变 0；`prisma.message.delete` 删另一条，同样变 0。上一片担心的「消息一走这一行自己就走」今天不再只是 schema 声明；
  - 同一 `sourceMessageId` 重发 ⇒ **P2002**，`recordMemoryAccess`（`access.ts:76`）捕获后返回 `false`——它走的是独立 `create`，不在事务里，所以这个 catch 干净。
- **顺手量到一条约束，记在这里以免将来踩**：在 `prisma.$transaction` 里 catch 住 P2002 之后，同一个事务的后续查询会**全部失败**（Postgres `25P02`「当前事务被终止」）——捕获不等于豁免，事务已经废了。今天三个 P2002 捕获点（`access.ts:76`、`task-queue.ts:48`、`reflection-sweep.ts:355`）**都摆在事务外面**，`writeReflection` 那个 `$transaction`（`reflection-sweep.ts:548`）是整体抛出、由调用方捕获，所以形状是对的；这条探针给出的正是「为什么不能图省事把 catch 挪进事务里」。
- **界面没有真渲染验收**：`memory-panel.tsx` 过了类型检查，并有静态断言（文案只从 `RECONSOLIDATION_LABELS` 与两个纯函数出来、界面里不许出现「需要更新摘要」「需要修改关联关系」这两个词、不许硬编码「最近 200 轮」、已归档那份不渲染标记）。但静态断言只证明源码写了这一行，不证明 React 画出来了。
- **不碰排序**：这一片只让访问成为事实 + 把标记摆出来。`retrieval.ts` 一行没改，所以「访问频率只能影响检索排序」那半句今天仍然是**未实现**——排序入口在片 f（向量臂通了才有 A/B 可比）。红线此刻守住的是「不许拿访问顶替证据」，不是「访问已经参与排序」。
- **窗口是 200 轮，且会说话**：超过 200 轮以后的访问不计入 `count`，`capped` 为真，界面摆一句「访问记录比这一屏多：这里只统计最近 N 轮对话」。所以那个数字是**下限**，不是全生命周期条数。
- **「忘记这次对话」不清这一轮在这段对话里发生过的检索**：只有被删的那批记忆的检索痕迹走。留着的 `acc-stay` 是真实发生过的历史，删掉它等于篡改另一件事；而真的删除整个会话时，那些行靠 `sourceMessageId` 外键自己走。
- **两项无法验收的检查不会出现在界面上**：不摆控件、不给文案、不产标记。「摘要」与「关联关系」将来若落地，得先有可写的位置，再回来加第四、第五项——顺序不能反。

## 7.3：忘记某个主题 + 暂停长期记忆写入（11-05 片 b）

7.3 这一条上今天已经有四臂：单条永久删除、按来源会话忘记、清空全部长期记忆、原句永久排除（`recordExclusions`，上面 ④a / ④b 那两节）。这片补最后两臂——**按主题忘记**和**暂停写入**，并把「关了就真的不读不写」这条门槛（第 9 条）在暂停这一臂上做成字面成立的。

### 「主题」的身份是我替他定的，不是从界面里长出来的

「忘记某个主题」里的「主题」，库里三条候选轴：

| 候选 | 判词 |
|---|---|
| `MemoryItem.context`（七个值，`MemoryContext`） | **采用**。唯一同时有逐情境策略行（`MemoryPolicy @@id([userId, context])`）和写侧消费者的枚举轴——删完还能在「记忆策略」里把同一条轴关掉，两臂说的是同一件事 |
| `ReflectionRecord.dedupKey` | 不采用。删它其实是 Phase 6 已经有的洞察删除，换个名字再交一遍是范围蔓延 |
| `DecisionRecord.topicCiphertext`（自由文本） | 不采用。要先把密文主题搜出来才能删，而那正是 4-T3 那次 0/36 判词禁掉的词法搜索 |

这个身份定的后果是**接口上「主题」只收七个值之一**（`validation.ts:241-251` 的 discriminatedUnion）。放任意字符串等于让界面过一次「`where context = 用户现编的词`」，换来的是一次「删了 0 行」的假成功，所以不在合法值之外留静默返回 0 的路：非法值直接拒（`cognitive-forgetting.test.ts` 有一条专门钉这个）。

### 代码事实（一支迁移、一个服务函数、一个闸门、一条路由分支、一屏两个控件）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 迁移 | `prisma/migrations/20261106000001_memory_write_pause/migration.sql` | 只加一列 `memoryWritePaused Boolean @default(false)`。**11-05 已执行**（真库列形状与读写往返见下面边界第二条）。默认 false 让「库里没有这一行」等于没暂停，和这张表其余开关同构 |
| 它不是第九个模块开关 | `preferences.ts:27`（`FlagKey` 把它和 `emotionTransparency` 一起 `Exclude` 掉）、`:90`（单独一条 PATCH 分支） | 模块开关管「这个模块要不要工作」，关掉后读侧也不注入；这一列只管「还记不记新东西」。**混进 `COGNITIVE_FLAGS` 会让它变成一个能被批量清空的开关**，P5 探针专门咬这个 |
| 写侧闸门 | `memory-module.ts:169-174` | 开在能开的最早处：`memoryEnabled`（`:170`）之后、`excludedHashes` / `getMemoryPolicies` / `listMemories`（`:178-183`）**之前**。所以门槛 9 那句「关闭后不再执行对应的数据读取」在这一臂上字面成立——零读零写，不是「读了但没写」 |
| 读侧不动 | `memory-module.ts:76-89` | `readMemory` 一次都不看这张偏好。「记住但先别带入」是关模块，「先别记、带着已有的接着用」是暂停，两件事必须分得开 |
| 服务函数 | `forgetting.ts:282-304`（`purgeMemoriesByContext`） | 照 `purgeMemoriesByChat`（`:231`）抄，三处差异：where 换成 context；**不**扫决策；**不**撤别的主题的欠账。同一事务里顺手建原句排除、清版本链指针、清访问痕迹 |
| API | `memories/route.ts:140-147` + `:24` | 新分支 `scope=context`，独立限流桶 `memory-purge-context:{userId}`（20/小时，和另外两臂同宽），审计 `user.memory_purge_by_context`，`targetType='context'`、`after.purged` **只带条数和主题名，不带正文** |
| 界面 | `memory-panel.tsx:431`（`purgeByContext`）/ `:645-658`（行内按钮）/ `:523-542`（暂停三态控件） | 「忘记这个主题」和「忘记这次对话」两个入口都摆着，因为它们不是一件事。暂停控件在总开关打开时才摆——总开关关着时暂停是句废话 |

### 文案（他批的姿势：确认框里就把边界说完）

`忘记「${CONTEXT_LABELS[context]}」这个主题的全部记忆？` / `这个主题下记住的内容会一起删掉，不可恢复。对话本身保留，其它主题和决策记录都不动。同一个主题的新说法还会照常记下来；要让它不再记，去「记忆策略」里关掉这个主题的写入。`

暂停那一句是 `已暂停新的记忆写入，已记住的内容照常带入对话`——**「照常带入」是这句的功能，不是修饰**，它说的正是上面「读侧不动」那行代码。

### 先红与变异探针

| 步骤 | 结果 |
|---|---|
| 先红 | 本片新增 **46 条**用例：`cognitive-forgetting.test.ts` +15、`cognitive-memories-route.test.ts` +9、`cognitive-memory-panel.test.ts` +11、`cognitive-memory-module.test.ts` +4、`cognitive-preferences.test.ts` +3、`cognitive-preferences-route.test.ts` +3、`cognitive-task-worker.test.ts` +1。红法是：`purgeMemoriesByContext` 未导出时命名导入直接报 `does not provide an export`，`memoryWritePaused` 不在 `CognitivePreferences` 上时那三条偏好用例断言不到字段，面板那批用 `stripComments` 逐字扫源码、「接线了但没渲染」当场抓住。**另外一处不是用例而是替身行**：`chat-message-route-side-effects.test.ts:129-144` 那个逐列写全的偏好行必须跟着加这一列——留空等于让替身替产品决定默认值，那条文件一条新用例都没加（18 条前后相同），改的是夹具 |
| 立刻绿、我没改用例的三条 | 路由那 9 条里「缺 context 报 400」「非法主题报 400」「未登录 401」**第一轮就是绿的**——今天的 `scope` 不认识自己也 400。它们钉的是「将来也不会松」，不是「这片新加的」 |
| worker 那条也是立刻绿 | 「暂停写入不是关掉模块 ⇒ 欠账照样排空、行照样删」写出来就过。`gateOpen`（`task-worker.ts:124-128`）本来就只看模块开关，**故意不看这一列**——暂停期间欠账照排空，只是不落库，不往队列里堆尸体 |
| **丢 `userId`（`findMany` 的 where 只留 context）** | **第一轮 0 红——这片最重要的发现。** 两个原因叠着：`deleteMany` 那一边还带着 `userId`，所以删的还是对的行；`recordSources` 碰到别人的行会解密失败（AAD 绑的是那一行自己的 userId）而被 `catch` 吞掉，排除表条数一点没变。**修法不是改探针，是补用例**：替身 `findMany` 把 where 原样收进 `db.readFilters`，断言这次读**带着 `userId`**——读条件一旦漂移就红，不再靠「删得对」倒推。补完后同一条变异：**1 红** |
| P3 跳过 `recordSources` | **3 红**（计划预期 1 红）：「每条被删正文进排除表一次」那条 + 按主题删的两条连带断言。红得比预期多，方向是对的 |
| P4 把暂停检查挪到 `listMemories` 之后 | **1 红**：「暂停时写侧一次数据库读都不发生」。那条断言的是 `db.exclusionCalls` / `db.policyCalls` / `db.listFilters` **为空**——「没问」和「问了但没写」在这里第一次能被区分 |
| P5 把新列塞进 `COGNITIVE_FLAGS` | **1 红**（计划预期 ≥2 红）。**预期错了**：`grep` 复核后只有 `cognitive-preferences.test.ts` 那一条专门用例吃这张表，路由与面板都按字段名点名，所以「批量清空」的第二处红源并不存在。数目如实记 1 |
| P6 暂停连读一起挡 | **1 红**，但这条是返工过一次才有效力的。第一版用例直接 `await memoryModule.read(...)`，而读侧的闸根本不在模块里，在 `manager.ts:128` 的 `enabledModules` 上——把变异放在闸门处，那条用例绿给你看。**改成走 `runCognitiveReads`（线上真正的读入口）后**，同一条变异：**1 红**（「暂停只管记、不管用」）。另记一笔：第一次实现这条变异时我在 `runCognitiveReads` 里多插了一次没有 try/catch 的 `getCognitivePreferences`，于是多红了第二条（「开关本身读不出来时……」）——那条红的是我这只手，不是那个语义；换成在 `enabledModules` 里改，才是 1 红 |

探针逐个当场回滚，回滚后立刻 `grep` 复核当前内容；全程只用字面替换，不碰 `git checkout` / `git stash`。

### 「缓存」这一条：判词是「无记忆派生缓存可清」，不是「缓存不存在」

任务书这条要求删除时清掉派生缓存。核实过：进程内确有缓存（`admin.ts:509` 的库大小展示值、`:604` 的目录大小、`ssrf.ts:88` 的目标解析结果、`env.ts:45` 的整份环境、`rate-limit.ts` 的限流桶），但**没有一个按记忆内容或记忆 id 做键**，所以没有该清的东西。时间线是读时投影（`timeline.ts:65`），每次现算，也不需要一个清的动作。这句话要说准：说「缓存不存在」是假话。

### 这一片的边界

- **两支迁移都已执行**：11-05 由我跑下（「两支迁移都还没落库，你直接跑迁移就行了」），`npx prisma migrate status` 报 17 支全部 up to date。这条把「先拉代码后跑迁移会 P2022」这个坑在他本机**关掉**了；但它对**任何一份还没跑迁移的库**仍然成立——认知读侧的 `SELECT` 引用了新列（下面那条列了读列），所以「部署 = 先 `migrate deploy` 再起服务」这条顺序是硬要求，不是建议。那三条历史 `DEAD` 行就是这个根因（上面「那三条 `DEAD`」那节），它 fail safe：模块错误隔离让回复照常，worker 的 `gateOpen` 读不出来当「未知」走重试。
- **按主题忘记不扫决策记录**：`DecisionRecord` 既没有 `context` 也没有 `chatId`，一次主题删除拿不到「哪些决策属于这个主题」这个问题的答案。文案里「决策记录都不动」是**明说的边界**，不是遗漏。
- **不撤别的主题的欠账**：一条 `CognitiveTask` 欠账对应的是「这一轮」，不是「这个主题」。删一个主题时把整轮的欠账一起撤掉，会连带作废另一个主题的提取机会。要停掉整个后台，用总开关。
- **暂停不追溯**：这一列只管之后的写入。已经记住的照常带入对话，欠账照常排空（只是不再落库）。要清已有的，用「忘记」那四臂。
- **界面没有真渲染验收**：`memory-panel.tsx` 过了类型检查，并有静态断言（DELETE 的 query 串、确认文案逐字、暂停控件在 `enabled === true` 之内、`toggleEnabled` 里也要 `setPaused`），但静态断言只证明源码写了这一行，不证明 React 画出来了。真渲染在片 g。
- **真库上这一臂跑过了**：同一次回滚探针（事务以 `throw` 收尾，跑完核对 `probeUsers=0`、`MemoryItem` 仍是 2 行、两行都归 konxing 且都是 `GENERAL`——库里那两条真实记忆一根手指都没碰）量到三件事：
  - `where: { userId, context }` 在真 Postgres 上编成 `"userId" = $1 AND "context" = CAST($2::text AS "public"."MemoryContext")`——枚举是**带 schema 限定的 CAST**，参数传字符串。替身求值器把 `context` 当普通字符串比，这一处**恰好等价**，所以它的判定没有骗人，但「等价」这次是量出来的，不是推的；
  - 一条都不剩时 `deleteMany({ where: { userId, id: { in: [] } } })` 被 Prisma 折成 `DELETE FROM "MemoryItem" WHERE "userId" = $1 AND 1=0`——**带了 `userId`**。上面 P1 那条探针（丢掉 `userId` 就 0 红）在真库层也没留缝：空列表不会退化成「删全表」；
  - `memoryWritePaused` 落成 `boolean NOT NULL`、默认 `false`；`create → 读回 false → update true → 读回 true` 往返正确，`ALTER TABLE ... ADD COLUMN ... DEFAULT false` 在 PostgreSQL 17 上是元数据改动、当场返回。库里那唯一一行真实偏好读回来是 `false`——暂停这件事今天没人按过。



