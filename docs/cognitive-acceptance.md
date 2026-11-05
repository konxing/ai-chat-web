# 认知层验收清单（任务书 7.4 十条门槛）

这份文档只回答一个问题：**每条门槛今天真被哪个测试守着、守到哪一层、边界在哪。**
它不是通过率报告。写它的那天（11-03）十条里有四条**无对象可验**，11-04 那批落地后这四条改判「部分验收」——
模块有了、服务端证据链有了，缺的是真库那一层与界面只渲染到初次挂载那一层（各门槛状态行单独标注，Phase 5/6 判词在文末两节；库里今天到底有几行、后台跑成什么样，统一写在「真库实况」一节，本文其余各处只按那一节的数字说话）。
**「界面只渲染到初次挂载」这一半 11-05 片 g 起已经不准了**：真渲染与点击那条路走通了，四条路径在真库上验到「界面字面 + HTTP + 库」三层一致；剩下的缺口改成两件具体的事——像素与排版依旧没量（视口 0×0），以及洞察/决策两屏还没有对象可点。
其余每一条的证据都止于内存替身——没有一条认知单测走过真实数据库。
把这些写清楚比凑一个「10/10」有用——下一次争论「这个增强要不要上」时，这里是共同的事实基线。

核对时间：2026-11-05（7.2 的 ARCHIVE 落地；之后 7.1 检索再巩固与 7.3 按主题忘记 + 暂停写入两片落地，**那两片带的迁移 `20261106000000_memory_access` / `20261106000001_memory_write_pause` 已由我在他的批准下执行**——「你直接跑迁移就行了」，`npx prisma migrate status` 报 17 支全部 up to date，库里没有漂移的列。跑完立刻补了一次真库回滚探针，把两片各自「只有替身验过」那两条边界换成了实测数字，见下面两片的边界表）。
片 j 与片 k 都落在 11-06：前者是读侧派生，后者是一屏界面多接一个库里已有的布尔。两片都没跑迁移、没写任何行、
没替他改过任何一个开关的值。片 k 收尾时按只读计数重新核了一遍「真库实况」那节——旧数字一条没变，那一节另补上 `MemoryPolicy` / `MemoryPolicySignal` 两行的首次实测。
基线 HEAD `e7d18f6`（片 j 的关联闸门；本文档这次加的是片 k——第八个开关 `adaptiveMemoryEnabled` 的控件与一屏过期文案，**零迁移、零新表、零模型调用**）。
全量单测 **98 个文件 1586 条用例**通过（`npx vitest run tests/unit`），`npx tsc --noEmit` 干净。
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

**状态：部分验收——服务端证据链已验收；6-F 那一屏 11-04 第一次真渲染过（入口在、组件挂得上）。
「点不动」那一半 11-05 片 g 解开了（`initScript` 补丁后按钮真挂上 `__reactProps`，见「片 g」一节），
但洞察这一屏仍然没有对象可点：他库里 `ReflectionRecord` 0 行，起服务走那一屏的动作也还没做过——端到端仍无法验收。**

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

**状态：部分验收——机制已验收；「洞察」这个词 11-04 之后有对象了（Phase 6 全链路在库里），
缺的是真库那一行与用户那一侧的目测——见下面边界段。**

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

**状态：部分验收——洞察侧「不写入」已经钉死；11-05 片 d 把画像模块建起来之后，正面那一半也有用例了（见下面第三点）。**

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

**边界**：~~`allowUserProfile` 依然全仓无读取方，`userModel` 模块也没有实现~~——**这一条 11-05 片 d 作废**，
画像模块现在有实现、有表、有界面，所以门槛那句的正面一半第一次有了可验的东西：
「未确认的洞察不写进已确认画像」今天由三道独立的构造守住，且都有用例——
① 候选不落库（`profile-candidates.ts:71` 是纯函数，用例 `tests/unit/cognitive-user-model.test.ts:151`
`派生层不碰数据库：候选永远不落库，进表只能走确认那一次`）；
② 状态过滤在库里（`tests/unit/cognitive-profile-reads.test.ts:288` `PENDING 和 REJECTED 的洞察不成候选`，
以及 `cognitive-user-model.test.ts:122` `还没被采纳的洞察一条都不提议`）；
③ 写侧根本没有那个旋钮（`ProfileEntryInput` 没有 `confirmedAt`，服务在 `create` 那一刻自己盖章；
`tests/unit/cognitive-profile-route.test.ts:247` 从请求体那一侧钉住，片 d 的 P16/P17 两个探针各红一次）。
还有一条不是推断而是编译期事实：`userModelModule` 的读侧只有 `read`、没有 `write`
（`tests/unit/cognitive-user-model.test.ts:223`），所以系统侧不存在往画像表写行的那条路。
**仍然保留的边界**：这三条证据都在**读侧/动作侧**；写侧（sweep）本来就不碰画像，但那条路依赖 `reflectionEnabled` 默认关这一事实，见门槛 9。
另一条：`UserProfileEntry` 在他真库里今天 0 行（见「真库实况」），所以上面三条是机制证据，不是「他那台机器上验过」。

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

**状态：已验收（凡有实现的模块开关都有关闸门的用例；八个键里今天仍然无人读取的只剩 `emotionEnabled` 一个，
它的「关了不执行」平凡成立——见下面第 2 点）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-preferences.test.ts:55` `库里没有记录时，八个开关都算关着` | 服务 |
| `tests/unit/cognitive-preferences-route.test.ts:90` `GET 返回全部八个开关，库里没记录时全是默认关闭` | 路由 |
| `tests/unit/cognitive-manager.test.ts:52` `开关没打开的模块根本不会被调用` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:371` `关掉长期记忆后，七种情境没有任何一种产生持久化写入` | 纯 |
| `tests/unit/cognitive-policy-learner.test.ts:330` `关掉之后 learnAfterSignals 返回空，证据够了也不收紧策略` | 服务 |
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
| `tests/unit/cognitive-profile-route.test.ts:165` `userModelEnabled 关着：四个动词全 409，一次服务层调用都不发` | 路由（**片 d，11-05**：读写两侧共用一道闸，`profile/route.ts:38`/`:83`） |
| `tests/unit/cognitive-profile-reads.test.ts:221` `偏好读不出来时三个闸门全按关闭处理` | 服务（同上；画像一屏的三道闸一次读完） |
| `tests/unit/cognitive-memory-graph-route.test.ts:155` `associationEnabled 关着时返回 MODULE_DISABLED，一次记忆查询都不发` | 路由（**片 c，11-05**：`graph/route.ts:37`，与时间线同一个理由） |
| `tests/unit/cognitive-memory-graph-route.test.ts:206` `闸门关着时连策略表都不读：这一屏不开，就没有必要知道七行策略` | 路由（**片 j，11-06**：新增的第二读之后，闸门仍然排在四读之前） |

**这一条今天有四个必须写清的事实**：

1. **第八个开关 `adaptiveMemoryEnabled` 在这之前全仓无人读取。**
   `manager.ts:44` 的 `MODULE_SWITCH` 只映射七个模块键，`src/app` / `src/components` 里零命中，
   而策略学习曾在删除链路上无条件执行（`memories/[id]/route.ts:94`、`memories/route.ts:79`、`:87`）——
   门槛 9 对这一层**当时并不成立**。`4a15160` 补上闸门：`policyLearningEnabled()`（`policy-learner.ts:85`）
   读偏好、读不出来当关；`learnAfterSignals` 开头加闸（`policy-learner.ts:127`，一处盖住三条删除链路，route 不用各自记得问），
   `purgeMemory` / `purgeMemoriesByChat` 在事务前读一次（`forgetting.ts:198`、`:227`），关掉就跳过记证据。
   **排除规则和摘演化边照常执行**——那是删除本身的派生清理（门槛 2），和「学不学」是两件事。
   上面那两条新测试是先写先红的（6 条新用例在实现前全部失败），不是补的。
2. **七个模块键里只有 `memory` 真有已注册模块**（**这句到 11-05 片 d 为止作废**：`registerCognitiveModule`
   今天有三个生产调用方——`memory-module.ts:352`/`:353`/`:354` 分别是记忆、决策记忆、画像注入，
   注册表那三道闸从此是真闸；原文里的 `:242` 是当时的行号，现在那个位置是向量补算那一读）。
   其余六个开关「关了不执行」在 4-T1 之前是**平凡成立**——本来就没有东西在跑，
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
   （**11-05 片 d / 11-06 片 j 之后这一段作废两处**：`userModel` 不再是「无人读」——`userModelModule` 已经
   `registerCognitiveModule`（`memory-module.ts:354`），画像一屏和画像路由各自有闸，上表新加的四行就是证据；
   `association` 也不止 5c 那一处——`graph/route.ts:37` 是它的第一个只读闸门，片 j 又把策略表那一读放在它后面。
   **今天仍然只有 `emotionEnabled` 是全仓无人读取的键**（`manager.ts:59` 只有映射表和 `preferences.ts` 的存取声明，
   `src/lib` / `src/app` / `src/components` 里没有一个运行时代码读它），所以它照旧没有界面入口。）
   （`association` 更早那一条：5c 把它当成向量补算的开关，`memory-module.ts:299` 读它——
   行号是这片复核时改的，原文写 `:242` 已经漂到注册那几行上。补算那一路**仍然没有单独的闸门用例**，
   上表因此不放它的行。`MODULE_SWITCH` 里那个名字（`manager.ts:60`，原文写 `:48`）
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
因为开关得先真有消费者，才轮得到它有一个控件。**`adaptiveMemoryEnabled` 在 11-06 片 k 之前只能走
`/api/account/cognitive` 改，没有界面入口**；片 k 给了它控件，位置不在模块开关那一屏，而在策略那一屏的
「自动收紧」卡（`memory-policy-panel.tsx:448-490`，复选框在 `:459`）——它的读者是学习层的闸门
（`policy-learner.ts:85`），改的又是这张屏上那七行策略，入口放在被改的东西旁边才说得清它在改什么。
这不是遗漏：`memory-policy-panel.tsx:24-29` 写明了立场——不做没人消费的控件，也不做用户拨了没反应的旋钮。
三个下游许可各自都是「先有代码读它，再给它控件」：`allowReflection` 是 11-04 的 6-F 补的
（控件 `memory-policy-panel.tsx:360`，消费者 `reflection-sweep.ts:454`）；`allowUserProfile` 是 11-05 片 d 补的
（控件 `:375`，消费者 `profile-candidates.ts:62`）；`allowAssociation` 是 11-06 片 j 补的
（控件 `:390`，消费者 `memory-graph.ts:97` 那个关联池）。
这三处控件行号是片 k 在同一个文件里插了一张卡之后重新指的；原文写 `:325`/`:340`/`:355`，那是片 j 时代的位置。
至此这张七行情境策略表里每一列都有运行时读者；仍然没有读者的只剩偏好表里的 `emotionEnabled`，所以它仍然没有控件。

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
   —— 这一条到 **4.1（片 i）** 被部分取代：`GOAL_COMPLETED` 和 `INTEREST_EMERGED` 后来找到了来源
   （版本链上的完成说法、4.3 的兴趣簇观察），界面筛选也按任务书 4.4 改成了事件类别。
   「不另造词汇」这半句仍然成立——词汇就是 4.1 那 12 类，没有为界面写第十三个名字。判词与理由见「片 i」第三节。
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
  **（11-05 更新：这一句的「今天」是 11-03。`ChangeDetector` 已经在片 h 落地，判词见「片 h：任务书 4.3 的 `ChangeDetector` 落地」那一节。）**

于是触发条件只剩两条：一、真要建 4.3 那个 `ChangeDetector`，那是引入模型推断的新子系统，**按 architectural 出 spec** 才能碰，
不在时间线或写入决策这一层顺手做；二、真库里出现第一批 ≥20 行真实记忆时，这份 0/36 应当用真实语料重测一遍——分母换掉，结论可能不一样。
**（11-05 更新：条件一已经发生，而他批准的那份认知层 plan 就是 spec；实际实现没有引模型——同一件事由库里的演化边给定、
主题聚类由 6.1 那套已审计的簇算法给定，所以「必然引入模型推断」这个前提不成立。条件二仍未触发：真库还是 2 行。）**

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
| `CognitiveTask` | **3 行，全 `DEAD`、`attempts=3`**（**片 g 已清，现在 0 行**，判词与安全性见「片 g」第八节） | `kind=MEMORY`，`lastErrorCode` 三条都是 `PREFERENCES_UNAVAILABLE`，`createdAt` 2026-11-04T10:54–10:56Z（本地 18:54–18:58） |
| `DecisionRecord` / `DecisionOutcome` | 0 行 / 0 行 | 表已存在（迁移已执行） |
| `ReflectionRecord` / `ReflectionCitation` | 0 行 / 0 行 | 表已存在（迁移已执行） |
| `CognitivePreference`（他这个账号） | 一行 | `memoryEnabled=true`、`timelineEnabled=true`，其余五个开关关着，`reflectionSweptAt=NULL` |
| `CognitivePreference.memoryWritePaused` | 库里唯一一行读回来是 `false`（11-05 实测） | 新列默认值真的生效，且**今天没人按过暂停**。81 条单测里那条「暂停时写侧一次数据库读都不发生」第一次有了库层的对照 |
| `MemoryAccessTurn` | **0 行**（11-05 实测） | 迁移刚落地，写入点（`messages/route.ts:171-175`）还没被真实对话跑过一次——「这一轮被再次调用」今天真的能进库了，但库里还没有它的第一个证据。**要看到它，得他发一轮真的会注入记忆的对话** |
| `MemoryPolicy` | **0 行**（11-06 片 k 实测） | 他从来没在「记忆策略」那一屏保存过一次。读侧不为缺失建行（`policy.ts` 的 `getMemoryPolicies` 拿 `DEFAULT_MEMORY_POLICIES` 兜），所以那七张卡今天显示的是**默认表**，不是库里的行——第一次点「保存」才是这张表有行的那一下 |
| `MemoryPolicySignal` | **0 行**（11-06 片 k 实测） | 学习层从没攒下一条证据。这和上表 `CognitivePreference` 那条自洽：他这个账号的第八个开关（`adaptiveMemoryEnabled`）今天关着，`forgetting.ts:200`/`:232`/`:287` 那三处 `recordSignals` 全是 `false`。**所以「{windowDays} 天内攒到 {threshold} 次」这条规则在他的真库里一次都没成立过** |
| 11-06 复核 | `MemoryItem` **2 行** / `MemoryRevision` **0 行** / `ReflectionRecord` **0 行** | 与 11-04、11-05 的计数一致，两片新代码没有往库里多写一行；上面三条计数同一次只读 `SELECT count`，没碰任何密文列 |

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
（**11-05 片 g 更新**：他后来把权限全交给我，这三行清掉了，`taskCount` 实测 0；补向量今天做不了也没做，两行记忆的 `embeddingCiphertext` 仍都是空。逐条见「片 g」第八节。）

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
   （6-G 那一节写了 11-04 起服务登进去之后到底量到了什么、点不动的原因是什么。
   **11-05 片 g 把「点不动」那一半解开了**：`initScript` 用普通语句补丁 `requestAnimationFrame` 之后，
   流式 Suspense 边界真的 hydrate，归档/恢复、记忆网络、画像增改删、按主题忘记四条路径在真库上走通过——
   视口仍是 0×0，所以打开的是行为这一层，像素与排版依旧没验。洞察/决策两屏现在**可验**，只差有人起服务。）
   ~~画像模块仍然不存在，所以门槛 7 的正面陈述照旧无从验收。~~ **这一句 11-05 片 d 作废**：
   画像模块已建（一张 `UserProfileEntry` + 三条读闸 + 一屏界面），门槛 7 的正面一半改判为「有用例守着」，
   证据行在门槛 7 那一节的边界段里；它剩下的缺口和其余三道是同一件事——他库里那张表今天 0 行。
5. 界面暴露更多开关之前，先让那个开关真的有消费者——第八个开关这次的顺序就该反过来：先有代码读它，再谈要不要给它一个控件。
   **这条已经按它说的顺序执行完三轮**：`allowReflection`（6-F）、`allowUserProfile`（片 d）、`allowAssociation`（片 j）
   都是先补运行时读者、再补控件；`emotionEnabled` 至今没有读者，所以至今没有控件。
   上一段那个「八个开关」里的最后一个缺口——`associationEnabled` 在对话内的注册表闸门盖不到后台向量补算——**仍然开着**。
6. **Phase 4 到此四片判完，另加片 h、片 i**：时间线读侧（已建）、时间解析（已建，收益 11%）、
   变化检测（11-03 实测 0/36，**词法的「逐条取代识别」方案不做**，判词在上一节）、纠正与删除事件（已建，判词在「Phase 4 第四片」）、
   **4.3 的 `ChangeDetector`（11-05 片 h 已建，判词见「片 h」那一节——它不走词法相似度，走库里的演化边 + 6.1 的簇，所以 0/36 那个结论没有被推翻，也没有被用来否掉它）**、
   **4.1 的 `EventExtractor`（11-05 片 i 已建，判词见「片 i」那一节）**。
   时间这一层没有待写的代码了。
   ~~还挂着的一件事：任务书 4.1 事件抽取今天不存在，所以 12 类事件里有 4 类一条也生成不了~~
   ——**这一句被片 i 取代**：那一层做成「给已有的事件起名」而不是第二条流水账，12 类里落地 9 类；
   剩下的 `DECISION_MADE` / `MILESTONE` / `CHALLENGE` 三类**不是没做，是库里没有出处**，
   原因写在 `UNEMITTED_EVENT_KINDS` 那块数据和「片 i」第三节。
   再调相似度阈值仍然不建议：0.20–0.75 那组实测已经说明没有既不误合又能命中的中间值。

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
  `reflection-sweep.ts:454`；那天画像与关联两列 grep 到的还只有存储与校验声明，所以各不给控件。
  这条立场后来按同一个理由各补上一次：画像列 11-05 片 d 有了读者（`profile-candidates.ts:62`），
  关联列 11-06 片 j 有了读者（`memory-graph.ts:97` 的关联池），控件才跟上——见文末片 j 一节。
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
- **补上的两句话**（他让我自拟文案，所以这两句**不在 11-04 那张逐字表里**；**11-05 他一句「你说的文案都通过了」，两句转正**）：
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
  （**11-05 片 g 更正**：「切不动 tab」这条天花板找到了原因并被绕过——`initScript` 要用**语句体**给 `requestAnimationFrame` 打 `setTimeout` 补丁，
  箭头函数那一支会被静默忽略；补上之后 Suspense 边界 hydrate、按钮全挂上 `__reactProps`。**这一屏的交互今天还是没走**，只是从「量不了」变成「量得了」。）
  而且今天就算界面能动也只见空态——`reflectionRecord` / `reflectionCitation` / `decisionRecord` 三张表 11-04 已随迁移落库但实测 0 行（见「真库实况」），
  `reflectionEnabled` 默认关，路由在碰到表之前就 409。

### Phase 6 仍然无法验收的部分

- **界面只量到「入口在 + 挂得上」**：6-F 那一屏接进了设置页，11-04 起服务登进去第一次看到它——导航里真有「洞察」，
  `renderToStaticMarkup` 渲 `ReflectionPanel` 不抛错。但**这台浏览器替身（0×0、hidden、rAF 不回调）点不动那个 tab**（**11-05 片 g 已推翻这条限制，办法见「片 g」第五节；这一屏本身仍未走**），
  所以行内排布、三个按钮、依据展开、空区不渲染全部仍未验（过程与物证见上一节 6-G）。
  像素与交互这一层从来不在 vitest 的能力范围内（跑在 node，仓库里没有 jsdom 和渲染器），
  所以这一屏能验的推到「纯函数 + 源码静态断言 + 初次挂载」三层，剩下的只能他自己在真浏览器里看一眼。
  原先「故意没显示」的那两处信息（行的生成时间、列表截到 100 条）**6-G 已经补上**，文案是他让我自拟的那两句，**11-05 已批**。
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
   和 `memory-display.ts` / `reflection-display.ts` 是同一套理由；这条边界由用例 `cognitive-citation-display.test.ts:118` 的静态断言钉住（片 g 新增两条用例后行号从 `:103` 移到 `:118`，此处按实测更正）。

### 文案（他批过的那张表，两处偏差在最下面）

| 位置 | 字面 |
|---|---|
| 收起态 | `这一轮带上了 N 条长期记忆`（N=0 时整句不渲染，界面什么都不摆） |
| 展开区顶部 | `这只是这一轮随问题一起交给模型的资料，不代表模型按它回答了。` |
| 每行说明 | `记于 2026年11月3日 · 可信度中 · 来自《关于项目》`（日期走 6-G 那套「年月日」，标题拿不到就不提来源） |
| 那条已经不在了 | `这条记忆已不在你的有效记忆里（可能已被更新、删除或归档）`（**片 g 更正**：这一行原来抄的是 11-04 那批的字面「（可能已被更新或删除）」，7.2 那一片给括号里补了「归档」，见下面「7.2：ARCHIVE」一节的代码事实表与文案表；批准表本身没跟着改，所以这张表第一次和实现不一致） |

**偏差一**：批准表里写的是「可信度：中」，实现用的是仓库里已有的 `CONFIDENCE_BAND_LABELS`（「可信度中」，没有冒号）。
同一件事不该有两套词，所以选了既有那套；要回到批准表的原字面，改的是 `memory-display.ts` 那份标签，全项目一起变。
（**11-05 已判**：他说「你说的文案都通过了」，**无冒号那套就是批准后的字面**，批准表那侧不再追改。）
**偏差二**：点开时那一次读失败要有一句可说的话，批准表里没有这句，实现用的是「这条清单没读到，稍后再试试」——**这句没批过，等他判**。
（**11-05 已批**：同上那一句授权，这句现在是批准字面，并由用例 `cognitive-citation-display.test.ts:103` 逐字钉住。）

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
  （**11-05 片 g 更新**：服务起了、点了、跑完就关。量到的是**负例**——一轮没注入记忆的对话里那个控件根本不摆，
  与 `citationHint(0) === ''` 一致；**正例与读失败那句仍未出现**，原因写在「片 g」边界第一条，不是补种 `MemoryAccessTurn` 能补的。）
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

**补充一（11-05 已批）**：归档展开区里那条指向撤回的链接，批准表只说了「撤回收进展开区」，没给字面。
实现用的是 `撤回这条（写明理由，这一屏没有恢复入口）`——括号那半句是说清两个动作的区别，不是装饰。
**补充二（11-05 已批）**：「已归档」区块顶部那句说明 `这些内容不参与对话，也不会被当作洞察的证据。要重新使用，点「恢复」。`
表里只有行标签和按钮，这段说明是新写的。区块为空时整块不渲染，所以不会出现「一段没有内容的解释」。

**补充三（11-05 已批）**：两份列表各自的截断提示，`记忆比这一屏多：这里只列出最近 N 条，更早的没有读进来。`
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
  不是默默少列一条——这是既有形状，本片只改了那句话的字面，而那句由 `cognitive-citation-display.test.ts:99` 逐字钉住（先红后绿；片 g 在文件顶部 import 里加了一个名字，行号从 `:98` 移到 `:99`）。

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

## 8.2：记忆网络——把已经在库里的关系画第二次（11-05 片 c）

任务书 8.2 要的是「记忆之间的关联可视化」。这一片**零迁移、零新表、零写字节**：库里已经有三种关系在写（`MemoryRevision` 的演化边、`MemoryItem.chatId` 的同场对话、`ReflectionCitation` 的同条洞察引用），已经有三屏在读它们（记忆、时间线、洞察）。这一片做的事是把**同一批行**画第二次，所以它没有自己的数据、没有自己的真相，也就不会出现「图上的关系和库里不一致」这种状态。

### 五个决定，每个都挡掉一件具体的坏事

| 决定 | 理由 | 挡掉的后果 |
|---|---|---|
| **不建 `MemoryRelation`** | 2a 那次阈值校准的结论就是不建表：一旦为画图加一张边表，它的维护者只能是猜 | 「第二真相」。这条由两条静态用例钉着（`cognitive-memory-graph.test.ts:484-500`：`schema.prisma` 里不许出现 `model MemoryRelation`，`src/` 里不许出现 `prisma.memoryRelation` 这种属性访问）——哪天有人为了画得好看去加表，这两条先红 |
| **同 `context` 只做分组，不成边** | 七个主题乘两百行是一把毛线球：画出来好看，读出来信息量为零 | 主题在界面上以**点的颜色**出现（`GRAPH_CONTEXT_COLORS`），不以线的形式出现。图例里没有「同一主题」这一种线，display 用例专门钉这一点 |
| **星形，不是两两全连** | 同一场对话里 50 条记忆，真实关系是「都发生在那一场对话」，不是「两两各有一层关系」 | 全连给 1225 条边，星形给 49 条，而两种画法的可读性差别是零。锚点取这段对话里**最早**记下的那条（按 `recordedAt`，不是数组第一条） |
| **闸门是两道：`associationEnabled` 且 `memoryEnabled`** | 前者管这一屏开不开，后者管「能不能读 `MemoryItem` 的正文」 | 只查前者的话，关掉长期记忆后这里照常返回记忆内容——等于给它自己开了个后门。`graphGates`（`route.ts:53`）一次读一遍偏好，两道闸共用，读不出来按**关闭**处理 |
| **这一屏只读** | 纠正、永久删除、归档在「记忆」和「认知时间线」两屏各有一个入口 | 同一个动作第三个入口 = 第三套文案。`cognitive-memory-graph-panel.test.ts` 用「PATCH 只出现一次」+「没有记忆写端点」两条钉住 |

### 代码事实（四个新文件、一处新读、三处接线）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 派生纯函数 | `src/lib/cognitive/memory-graph.ts:77`（`deriveMemoryGraph`） | 输入三份已经在库里的行，输出节点/边/分组/预算。**不碰 prisma、不解密**。节点先按 `recordedAt→id` 定序再截最近 120 条（`:79`）；三种边按「演化 → 同场 → 共引用」的优先级生成，同一条 `push`（`:85-91`）做双向去重 |
| 引用行的定序 | `memory-graph.ts:108` | 读回来的那批是「最近 200 条、时间倒序」，**那个次序不是这里的输入契约**。派生层自己按 `(reflectionId, memoryId)` 排一次，否则上限一截、边的先后跟着晃（这条是 P2 探针实测的，见下面） |
| 第四批关系的读 | `memories.ts:540`（`listCitationEdges`） | `where: { userId, memoryId: { not: null } }`、`take: 200`、只 `select` 两列。放在 `memories.ts` 而不是 `reflections.ts`：`cognitive-reflection-states.test.ts` 那条导入禁令不许别的模块 `import` 洞察服务，而「记忆之间的关系」本来也是记忆这一侧的事 |
| 浏览器侧的词表 | `memory-graph-display.ts` | 只有 `import type`，零运行时依赖。线的三种说法、点的七种颜色、`isGraphDrawable`、`describeNotAGraph`、`describeGraphBudget`、`truncateNodeLabel` 全在这一个文件，界面不许自己编句子 |
| 只读 API | `src/app/api/account/cognitive/graph/route.ts:27` | 三个读并发（`Promise.all`），派生，会话标题走旁表、空图时一次都不发（`:45`）。返回体只有图 + `chats`，没有正文之外的列 |
| 界面 | `src/components/settings/memory-graph-panel.tsx:62` | 手写 SVG 圆周布局（`CANVAS = 360`，`:44`），不引任何图布局库。被取代的旧说法仍画出来（它就是那条边的另一端），但降透明度 + 虚线描边 + 「已被新说法取代」标记 |
| 设置页接线 | `settings-workspace.tsx:87` / `:351` / `:758` | Tab 联合类型、导航项、渲染分支三处，和「时间线」「洞察」两屏同一形状 |

### 空画布不许装成有意义

这是这一屏最容易骗人的地方：任何三个点连两根线，看起来都「像个网络」。三道闸：

1. **只有一个判据**：`isGraphDrawable`（display `:60`）——有线**且**不少于三个点。判不过就退回记忆列表，界面里不许再写一份「有线就画」（`PANEL_CODE` 里连 `edges.length >` 这个比较都不许出现）。
2. **句子只有一个来源**：画不出来时念 `describeNotAGraph(节点数, 边数)`（display `:69`），三句按真实条数分叉——零条记忆 / 有点但零根线 / 「这两个点之间确实有关系，可三个点以上的连线才叫网络」。界面里再抄一份，两处就会漂成两个说法，所以面板用例正向查 `describeNotAGraph(` 的调用、反向查那三句话**不许**出现在面板里。
3. **位置不携带含义，并且明说**：圆周布局的唯一目的是不重叠，界面上那句「点的位置只为了铺开不重叠，不表示任何东西」是硬要求；用例同时检查 `Math.cos` / `Math.sin` 在（证明布局是手写的）且 `package.json` 里没有 d3 / cytoscape / vis-network / react-force-graph / viz.js（证明没有哪个力学模型在偷偷决定谁挨着谁）。

预算截断同理：`capped` 时说的是**真实条数**（`totalNodes` / `totalEdges`），不是画布上那 120 个点——「这里画不全：你一共有 260 条记忆，画布最多放 120 个点，显示的是最近那批」。display 与 derive 两处各存一份上界常量，由一条 drift 用例比对，防它们悄悄分家。

### 先红与变异探针

先红：本片新增 **76 条**用例——四个新文件 26 / 19 / 12 / 16 条，外加 `cognitive-memories.test.ts` +3 条（共引用边那一批）。红法分别是：命名导入 `listCitationEdges` 时报 `does not provide an export`；`Cannot find module '@/app/api/account/cognitive/graph/route'`（12 条一起红）；面板那条红在 `readFileSync` 找不到 `memory-graph-panel.tsx`。

探针逐个当场回滚，全程只用字面替换，不碰 `git checkout` / `git stash`。

| 探针 | 结果 |
|---|---|
| P1 撤回的说法也摆进图（去掉 `origin === 'retracted'` 过滤） | **1 红**：「撤回的说法不摆进图——只剩一条边连向它就是把『已撤回』画成『还在用』」 |
| P2 引用行不再定序（去掉 `.sort(compareCitations)`） | **1 红**，且**这就是这片真正的 bug**：边的先后原本悄悄依赖读回来的次序，而边正是按 240 的上限**按先后截**的——同一份库，读的顺序一变，图上少哪几根线就跟着变。补了「传入次序打乱，边一条不多一条不少、先后也一样」这条用例后，变异当场红 |
| P3 星形锚点改成这段对话里**最晚**那条 | **2 红**（「50 条给 49 条边」+「锚点是按 `recordedAt` 最早的那条，不是数组第一条」） |
| P4 去重键不再做双向归一（`from\u0000to` 直接拼） | **1 红**，红因值得记：不是同一对记忆连出两根 `update`，而是 `sameChat` 把已被 `update` 连过的那一对**又补了一根**。跨来源的去重靠的正是那个归一 |
| P5 `totalNodes` 报画布上的条数而非真实条数 | **1 红**：「节点超过上限时留最近那批，并说 capped」。注意 display 那条「报的是真实条数不是画布上的点数」的用例**挡不住这个**——它是手搓的图对象，只有派生层这条用例在管 |
| P6 `isGraphDrawable` 三个点放宽成两个 | **1 红**：「点不足三个就不画：两个点加一根线说明不了『网络』这两个字」 |
| P7 引用读丢掉 `memoryId: { not: null }` | **1 红**：「memoryId 空着的引用不是边：一条连着『没有记忆』的线画不出来」 |
| P8 `memoryEnabled` 硬编码成 `true` | **1 红**：「关联开着但长期记忆关着时也不许读：图是它的派生视图，不能当后门」 |
| P9 空图也发 `listChatTitles` | **1 红**：「一行记忆都没有时返回空图，不报错」那条同时断言标题查询**零次** |
| P10 引用读改成 `createdAt: 'asc'` | **1 红**：「顶到上限时留的是最近这批：图上活着的节点是最近的记忆，太老的引用连不上它们」 |
| P11 面板绕过判据，自己写 `graph.edges.length > 0` | **1 红**，但**这条挖出了一个断言漏洞**：原来那条反向断言是 `/edges\.length\s*>\s*0\s*&&/`，只挡得住 `… > 0 && …` 这一种写法，`graph.edges.length > 0;` 从它眼皮底下过去。第一轮的 1 红其实是被正向的 `toContain('isGraphDrawable(')` 抓住的。已收紧为 `/edges\.length\s*>/`（这一屏比较边数的地方只许是那次函数调用），收紧后干净源码 16 条全绿、同一条变异重跑仍 1 红 |

### 一条 tsc 抓到的、测试体系抓不到的

120 条相关用例全绿之后 `npx tsc --noEmit` 报了两条：`memory-graph.ts:2` 从 `./memories` 导入 `MemoryType`，而 `memories.ts` 只是从 `./policy` **转 import** 了这个类型、并没有 `export` 它（`policy.ts:40` 才是声明处）；下游 `memory-graph-panel.tsx` 跟着报 `TS7053`（拿 `MemoryType` 去索引 `Record<…, string>`）。

这不是孤例，是这套体系的固定盲区：**vitest 走 esbuild，抹掉类型但不核对类型**。所以「先红—绿—探针—全绿」这条链走完了仍然必须跑一次 `tsc`，两者不互相替代。改法是让 `memory-graph.ts` 直接从 `./policy` 取这个类型（那一行本来就在从 `policy` 取 `MEMORY_CONTEXTS`）。

### 这一片的边界（含无法验收项）

- **界面没有真渲染验收**：面板过了类型检查，16 条静态断言钉住文案、判据、只读、包边界。但本机没有 jsdom，这一屏也没起服务真渲染过——SVG 在浏览器里到底画成什么样、点够多时标签会不会糊在一起，**全部未验收**。真渲染归片 g。
- **今天他库里这张图画不出来**：`MemoryItem` 2 行、`MemoryRevision` 0 行（11-05 片 a 那次回滚探针实测的数，本片没有重新查库）。2 个点 0 根线走的是 `describeNotAGraph` 那句「现在还不是一张图：你的 2 条记忆之间没有更新边，也没有共来源会话。图只从已经存在的关系里推导，不猜。」——这不是 bug，是这一片诚实的样子。
- **共引用边今天有没有货，没查**：`ReflectionCitation` 的行数这次没实测。它有没有边，和上面那条一样，要等他真的攒出洞察并且洞察引用落到记忆之后才知道。
- **星形不是全连，所以图上「A 和 C 有关系」这件事看不见**：同一场对话里的 50 条记忆在图上是一朵梅花，不是网。这是 P3 那个决定的直接后果，也是它换来的东西——1225 根线读不出任何一条线说什么。
- **上限是两份常量**：`memory-graph.ts:27-28` 和 display 各写了一遍 120 / 240，靠 drift 用例比对。改一处忘另一处会红，但红的是用例不是编译——这是刻意选择（浏览器包里不该 import 服务端的数），不是洁癖。
- **`associationEnabled` 第一次有了消费者**：在这之前它只是库里的一个布尔值，没有任何一屏读它。这一片是它的第一个消费者，所以「打开这个开关会多出什么」这个问题从今天起才有答案。

## 8.2/8.3：用户画像 + 情绪呈现档位（11-05 片 d）

任务书 8.3 要的是「从记忆和洞察里整理出对用户的理解，但每一条都得用户确认过才算数」。这一片是 Phase 8 里**唯一新增写侧表**的一片：一张 `UserProfileEntry`、一支迁移（`20261107000000_user_profile_entry`，实测 `_prisma_migrations.finished_at = 2026-11-05T08:39:47Z`，已落库）。

同一份 8.3 里的「情绪」那一半，按 11-05 那次范围裁决**不做标签**：不给用户的情绪下判断，只把「模型这一轮看到的那批记忆里有没有情绪类的那几行」这件事说明白。所以那一半零迁移——`emotionTransparency` 这一列早就在偏好表里，缺的从来不是字段，是消费者。

### 六个决定，每个都挡掉一件具体的坏事

| 决定 | 理由 | 挡掉的后果 |
|---|---|---|
| **不给「不确认」留入口** | `ProfileEntryInput`（`user-profile.ts:41`）里没有 `confirmedAt` 这个字段，确认时间是服务在 `create` 那一刻自己盖章的（`:112`）；表上这列不可空、迁移 SQL 不给 DEFAULT | 「未经确认不得建立画像」不是一句谁都要记得判的约定，而是一个编译期递不进去的参数。P16 往入参里加一行 `confirmedAt?: Date` 立刻红 |
| **候选不落库** | 候选是纯函数在读侧现算的（`profile-candidates.ts:71`）：只有 `explicit` / `userConfirmed` 的记忆（`:26`）和已采纳（`ACCEPTED` / `EDITED`，`:27`）的洞察能成候选 | 库里不存在「系统猜的但用户没表态」这一类行，也就不会有哪天界面把它当成你确认过的东西。画面上只有「收进画像」一个动作：服务层没有「拒绝候选」的写路径，界面就不许摆这颗按钮（P11 实测） |
| **画像不随「清空全部长期记忆」删** | 它是你确认过的东西，不是派生记录；`forgetting.ts` 一行都不碰这张表，面板另给一个明确的清空入口（`clearProfileEntries`，`user-profile.ts:156`） | 忘记一条记忆不该连带抹掉你当时确认过的那句话。这条由静态用例钉着（`cognitive-user-profile.test.ts:319-321` 不许在 `forgetting.ts` 里出现 `userProfileEntry`），P15 把删除语句塞进去就红 |
| **改写覆盖同一行，不开版本链** | 记忆要被时间线追溯、要能回滚成「那个说法」；画像条目只有「你确认过这句」和「你刚改成这句」两个状态，中间那次说法从来不是事实的来源——来源是原会话 | 一张 revision 表换不来任何能被追问的东西。所以 `reviseProfileEntry`（`:128`）只动正文和 `editedAt`，`confirmedAt` 故意不碰 |
| **正文密文落库，AAD 绑死三样** | `user-profile:v1:${userId}:${id}:content`（`:28`），跟记忆、洞察同一套口径；解不开的那一行不拖垮整屏，正文位置换成一句实话（`toDto`） | 密文搬到另一行或另一个人下面就读不出来。P9 把 `v1` 改成 `v2` 红 2 条，其中一条正是别处抄了这句 AAD 的锁 |
| **情绪只报条数，不贴标签** | 三档只改「端不端给模型、说不说有」：`off` 在排序之前就把情绪类的行丢掉（`memory-module.ts:149`，连看都不看），`explicit` 只在末尾加一句「其中 N 条与情绪有关」（`:204`）。界面把三档各自的实际效果逐条写全（`memory-policy-panel.tsx:394` 起那张卡） | 系统不许在这里长出「焦虑」「抑郁」这种给用户情绪命名的词——用例直接对 `/焦虑\|抑郁\|悲伤\|紧张\|情绪不稳定/` 做反向断言。而 `emotionEnabled` 至今没有运行时消费者，所以界面上不摆它：一个没人读的开关摆在设置页就是骗人（P12 实测） |

### 代码事实（八个新文件、三处改造、四处接线）

| 环节 | 位置 | 只干什么 |
|---|---|---|
| 写侧服务 | `src/lib/cognitive/user-profile.ts`（174 行） | 建 / 改 / 删 / 清 / 列表。正文 `trim` 后 1–1000 字（`:20`），列表上限 200 行是**调用方能收紧不能放宽**的那道闸（`listProfileEntries` `:167` 的 `Math.min`，P14 实测拆掉就红），来源 id 去重封顶 20 个但不校验存在性（认不认得出来是界面的事） |
| 候选派生 | `profile-candidates.ts:71` | 纯函数，不碰数据库。记忆一路三道 `continue`（`:74-76`：来源、已画像过、情境闸门），洞察一路三道（`:88-90`：状态、情境闸门、引用不全） |
| 画像一屏的读 | `profile-reads.ts:75` | 三道闸门一次读完（`profileGates` `:62`，读不出来按**全关**处理，和洞察、时间线、记忆网络同一口径），条目 + 候选 + `entriesCapped` 一次带回 |
| 洞察标题的解密 | `profile-reads.ts:37` | 这一屏要显示候选来自哪条洞察，所以自己复制了一份洞察的 AAD。它是**故意的重复**，由静态用例钉着：`cognitive-reflection-states.test.ts` 不许别处 `import` 洞察服务，而这里的字符串必须和 `reflections.ts` 逐字相同 |
| 注入 | `user-model-module.ts:33` | 每轮只端**最近 6 条、800 字**（`:19-20`），只读已确认的条目——候选连这个函数都进不来。没有 `memoryIds`：画像不是这一轮的引用 |
| API | `src/app/api/account/cognitive/profile/route.ts` + `[id]/route.ts` | GET 走闸门，POST / DELETE 走 `assertWritable`（`:81`），PATCH / DELETE 单条在 `[id]`。限流 60 次/小时、清空 3 次/小时。审计只带条目 id 和来源条数，**正文不进日志也不进审计** |
| 界面 | `src/components/settings/profile-panel.tsx`（407 行） | 已确认条目 + 待确认候选两栏；句子只从 `user-profile-display.ts` 取，界面不许自己编 |
| 情绪档位 | `memory-module.ts:145-207` + `manager.ts:83` | `renderMemoryBlock` 多收一个档位参数；那一行偏好每轮只读一次，由引擎递给模块（P13 实测：manager 里硬编码成 `implicit` 就红） |
| 设置页接线 | `settings-workspace.tsx` | import / Tab 联合类型 / 导航项 / 渲染分支四处，和「时间线」「洞察」「记忆网络」同一形状。策略面板一屏现在是六列控件 |

### 先红

本片新增 **111 条**用例：五个新测试文件 21 + 17 + 19 + 21 + 22 = 100 条，既有文件 +11 条（`cognitive-manager.test.ts` +1、`cognitive-memory-module.test.ts` +2、`cognitive-memory-seam.test.ts` +8，其中 1 条是 P2 探针挖出来的洞补的），另把 `cognitive-reflection-panel.test.ts` 的关联禁令那 1 条改成「关联仍禁、画像必须给」。

红法：`Cannot find module '@/lib/cognitive/user-profile'`；`listProfileEntries` 那个命名导入报 `does not provide an export`；面板那条红在 `readFileSync` 找不到 `profile-panel.tsx`。

### 变异探针

17 条，逐个当场回滚，全程只用字面替换。这一轮改用一个小跑批脚本（临时放在仓库外的 `%LOCALAPPDATA%\Temp\qoder-probe.mjs`）：先要求锚点在文件里**恰好出现一次**，否则拒绝改动；跑完在 `finally` 里按字节还原并自证 `RESTORED byte-equal: true`。

| 探针 | 结果 |
|---|---|
| P1 `off` 档不丢行（把候选池过滤退回 `input.rows`） | **1 红**：「情绪行的三档真的挂在读路径上：off 不带入…」 |
| P2 那句条数改成数候选池（`emotionUsed` → `emotionInPool`） | **第一遍 0 红——这是一条断言漏洞**。原有的截断用例里池子和文字的情绪行数相等（都是 1），两种写法数出来一样，那句「N 数的是真进了提示词的条数」其实没被钉住。补了一条「池子 2 条、文字 1 条」的用例（`cognitive-memory-seam.test.ts:325`）后，同一条变异重跑 **1 红** |
| P3 候选不再要求已确认来源（去掉 `CONFIRMED_ORIGINS` 那道 `continue`） | **2 红**（`profile-reads` 与 `user-model` 各一条：系统观察到的记忆不许成候选） |
| P4 画像情境闸门恒开（`allowsProfile` 直接 `return true`） | **3 红**，含「引用的记忆里有一个情境关了门，这条洞察就不提议」 |
| P5 `allowUserProfile === true` 改成 `!== false` | **0 红，等效变异**。`getMemoryPolicies` 对七个情境恒返回完整布尔，`undefined` 这个分支今天递不进去。**这条不算通过**，它只说明：判定里那层「拿不准按关」今天没有对应的输入形状 |
| P6 洞察闸门拆掉（`if (!gates.reflectionEnabled) return []`） | **1 红**：「洞察关着：只有记忆那一路的候选，洞察表一次都不查」 |
| P7 `entriesCapped` 恒 `false` | **1 红**：「条目读满 200 行时 `entriesCapped` 为真」——截断必须说出来 |
| P8 画像写闸门拆掉 | **3 红**：四个动词全 409、读写两句文案各自说清、偏好读不出来按关闭处理。**第一次尝试被脚本拒绝**：锚点 `if (!gates.userModelEnabled) {` 在文件里出现两次（GET 的读闸和 `assertWritable` 的写闸），二选一就是猜，所以改成语义完整的那一段再打 |
| P9 画像 AAD 从 `v1` 改成 `v2` | **2 红**：本文件那条列表解密 + `profile-reads` 里那句「长期记忆关着，已确认的画像条目照常带回」——后者用的是**抄在另一个文件里的那句 AAD**，它一红就说明这份复制是被看着的 |
| P10 注入条数 `USER_MODEL_MAX_ITEMS` 6 → 12 | **1 红**，红的是面板那条「三行数字不许从服务端抄：条数上限由服务层拿」的 drift 用例。服务端自己的用例**挡不住这个**——它按常量走，不认数值 |
| P11 界面摆出「拒绝候选」 | **1 红**：「候选只有『收进画像』一个动作：服务层没有拒绝的写路径」 |
| P12 策略面板摆出 `emotionEnabled` | **1 红**：「`emotionEnabled` 至今没有运行时消费者，界面不许摆」 |
| P13 manager 硬编码 `emotionTransparency: 'implicit'` | **1 红**：「那一行偏好每轮只读一次，档位由引擎交给模块」 |
| P14 `listProfileEntries` 的 `Math.min` 拆掉 | **1 红**：「调用方能收紧上限，但放宽不了」 |
| P15 忘记路径顺手删画像表 | **1 红**：「『清空全部长期记忆』不碰这张表」 |
| P16 `ProfileEntryInput` 加一行 `confirmedAt?: Date` | **1 红**：「写入入参里根本没有『确认时间』这个旋钮」——这条钉的是**形状**，不是运行时行为 |
| P17 路由把请求体里的 `confirmedAt` 递给服务层 | **1 红**：「请求体里写 `confirmedAt`，服务层收到的形状里没有这个键」 |

P16 / P17 是同一个红利的两端：入参没有这个旋钮（编译期），请求体递不进来（运行时白名单）。两条都探过，才敢说「库里只存你确认过的」是结构而不是约定。

### 这一片的边界（含无法验收项）

- **界面没有真渲染验收**：画像一屏和情绪档位卡过了类型检查，22 + 若干条静态断言钉住文案、包边界、只读闸门。但本机没有 jsdom，这两屏都没起服务真渲染过——候选多到一屏时的排版、`档位未知` 那一行的真实观感、确认后列表刷不刷得干净，**全部未验收**。真渲染归片 g。
- **他库里这张表今天 0 行**：`UserProfileEntry` 实测 0 行（列 9 个，与迁移一致）。`MemoryItem` 2 行、`embeddingCiphertext` 非空 0 行。所以「画像一屏长什么样」目前只有空态被代码覆盖过，**候选能不能从他那 2 条记忆里派生出来，没实测**。
- **情绪三档没在真提示词里量过**：测的是渲染函数的文字和「偏好行 → 引擎 → 模块」这条传递链，没起服务发过一次真请求。`off` 那一档到底省下多少字、`explicit` 那句会不会被模型复述给用户，**无法验收**。
- **K5 是等效变异，不是通过**：`!== false` 与 `=== true` 今天走不到不同分支。留着它是为了说明：`allowsProfile` 的「拿不准按关」这一层，目前没有任何输入能触发。
- **两处上限仍是两份常量**：`PROFILE_LIST_MAX_ROWS = 200` 在服务层，界面只许转述服务端说过的话；`USER_MODEL_MAX_ITEMS = 6` 同理由 drift 用例比对（P10 的红因就是这个）。改一处忘另一处会红，但红的是用例不是编译——这是刻意选择（浏览器包里不该 import 服务端的数）。
- **8.1 对照表那一行当时还没改**：User Modeling 从今天起由「不存在」变「存在」，但站点对照表的口径统一放在片 e 一次性改，这里不动它。（**片 e 已兑现**：那张表现在在本文末尾「8.1：十六个站点摊成一张表」那一节，User Modeling 那一行写的就是「存在（片 d 起）」。留这句是为了记下这一片的口径是「一张表一次改」，不是两处各写各的。）

---

## 8.1：十六个站点摊成一张表 + 「哪个站点挂了」进审计（11-05 片 e）

任务书 8.1 画了一条 16 站点的管线（读侧 11 个 + 聊完之后的 5 个），并要求「并行任务不应该阻塞主回复」。这一片的交付**不是**一条管线：`CognitiveModule` 已经是站点接口，再套一层 `Station/Pipeline` 只有一个消费者、重复那张开关表，理由逐条写在下面。所以这里做两件事——**把 16 个站点的真实下落摊成一张可追问的表**，再**补掉这张表逼出来的唯一一个真洞**。

### 为什么不建站点抽象（四条，带证据）

- **接口已经有了**：`manager.ts:43` 的 `CognitiveModule`（键 + `read` + 可选 `write`）、`:56` 的 `MODULE_SWITCH` 逐键闸、`:53` 的 1000 ms 硬截止、`:88-92` 的错误隔离——四件套齐全，缺的从来不是抽象。
- **编排器已经有了**：`runCognitiveReads`（`manager.ts:77`）就是那个「按开着的键依次读、单点挂了不带走全链」的循环，唯一调用点在 `chats.ts:404`。
- **注册表只有三个模块**：`memory-module.ts:352-354` 注册 `memory` / `decisionMemory` / `userModel`。`MODULE_SWITCH` 里另外四个键（`emotion` / `association` / `timeline` / `reflection`）**没有模块挂着**——它们各自的开关由别处的闸门消费（时间线一屏、图一屏、反思后台），不进读管线。这就是下面那张表里「存在但不在这个站点上」那几行的由来。
- **想把它接到反思读侧也不行**：`cognitive-reflection-states.test.ts:71-80` 明令 `reflections.ts` 不建记忆、不改画像、不 `registerCognitiveModule`。采纳一条洞察只翻状态——多一层管线正好会诱使它「顺手挂进对话链路」。

### 16 站点对照表（+1 行本片新增）

「在不在」只说**任务书点名的那个形状**在不在，不替相邻实现背书。

| 任务书站点 | 在不在 | 落点（今天实测过的行号） |
|---|---|---|
| 身份鉴权 | 存在，且在认知之前 | `messages/route.ts:47` `requireUser` → `:49` 限流 → `:56` `getChatOwned`。认知读全部发生在这之后 |
| 用户模块配置 | 存在 | `manager.ts:78` 每轮读一次偏好行，`:80` 按 `=== true` 筛站点；偏好缺失时 `:79` 直接返回空 |
| Memory Retrieval | 存在 | `memory-module.ts:88-108` 取池 → 排序 → 算置信度 → 渲染。排序在 `retrieval.ts:75`（关键词）/ `:161`（余弦）/ `:209`（RRF 混合） |
| Graph Association | **不存在**（作为站点） | 图是**只读派生视图**：`account/cognitive/graph/route.ts:31-34` 两道闸 + `memory-graph.ts` 从记忆行现算。读管线里没有这个键的模块 |
| Temporal Filtering | 存在，但只两处 | 读侧有效期过滤 `memories.ts:342-345`（`validTo ≥ asOf` 且 `validFrom ≤ asOf`）；写侧时间框架 `temporal.ts:45`。**检索排序不看时间**，只有 `recordedAt desc` 的取行次序（`memories.ts:350`） |
| User Modeling | 存在（片 d 起） | `user-model-module.ts:48` 读已确认画像条目、`:53` 挂键、`memory-module.ts:354` 注册。开关 `userModelEnabled` 第一次有了真消费者 |
| Emotion Analysis | **不存在** | 没有任何「分析情绪」的代码：`emotion` 键在 `manager.ts:59` 的开关表里，但**没有模块注册它**。存在的只有呈现档位 `memory-module.ts:149`（`off` 丢行）/`:204`（`explicit` 报条数），它不给用户的情绪命名 |
| Response Policy | **不存在** | 全仓库无 `responsePolicy` / 回复策略。`MemoryPolicy` 是**写侧**策略（决定记不记），不改回复的一个字 |
| Context Assembler | 存在 | `chats.ts:390` 基础 system → `:409` 逐块追加认知 system → `:420` 历史窗口 → `:454` 本轮（含附件）。就是那个装配器 |
| 原有 AI Provider | 存在，未改动 | `ai.ts:111` `streamChatCompletion`，`messages/route.ts:115` 调用。认知块以普通 system 消息递进去，模型侧不知道它来自哪 |
| 流式回复 | 存在，未改动 | `route.ts:101` `ReadableStream`，`:111` 逐帧 `data: …\n\n` |
| 后台记忆提取 | 存在，且不阻塞 | `route.ts:154` `close()` **之后**才 `:162` `enqueueCognitiveTask`；真正执行在 `task-worker.ts:186` `runCognitiveWrites`。落库而不是当场跑，所以进程被杀也不丢这一轮 |
| 事件更新 | **不存在**（是读时派生的改名） | `timeline.ts:65` `deriveTimelineEvents` 把记忆行 + 演化边现算成事件。没有任何「事件表」被写过——这是 4.1 那一片明写的取舍 |
| 关联更新 | 只有向量这一路，且从没成功过 | 写侧 `memory-module.ts:299` 按 `associationEnabled` 决定补不补向量，`:311-317` 失败只记一条不含正文的告警。**今天实测：`MemoryItem` 2 行、`embeddingCiphertext` 非空 0 行** |
| 决策候选提取 | 存在，但读侧只认已确认 | 写侧 `decision-module.ts:44-51`（候选 `:48`、结果 `:50`）只落 `PENDING_CONFIRM`；读侧 `decisions.ts:252` 只取 `status='CONFIRMED'`。**实测：`DecisionRecord` 里 `CONFIRMED` 0 行**，所以这一路今天递出去的是空块 |
| 反思任务触发判断 | 存在 | `task-worker.ts:113` 每轮按「这轮有活的 user」触发 `runReflectionSweep`（`reflection-sweep.ts:139`），冷却由它自己那道条件 UPDATE 保证 |
| **本轮哪个站点挂了**（本片新增） | 存在 | `manager.ts:89` 收键 → `chats.ts:458` 交回 → `route.ts:237-242` 写进 `writeAudit.after.cognitiveFailed`。**只有模块键，没有正文、没有报错原文**（同 `:91` 那条 `log.warn` 立的规矩） |

**「并行任务不应该阻塞主回复」这一句的判法**：不是并行，是**入队即返回**——`close()` 已经把字节全交给客户端之后才 `enqueueCognitiveTask`（`route.ts:154-162`）。读侧那一半靠 `manager.ts:53` 的每模块 1000 ms 截止兜住，最坏比没有认知多花一秒，不会更多。后台是串行的：`task-worker.ts:55-60` 的 `drain` 锁让「一轮跑完才进下一轮」成为事实。**没有给 `CognitiveTaskKind` 加枚举值**——那是 `schema.prisma` 的迁移，给不存在的站点排队务只会多一种要清尸体。

### 那个真的洞：`failed` 以前被扔掉

`runCognitiveReads` 交回 `{ blocks, failed }`，`chats.ts` 从前只取 `blocks`。后果不是功能坏，是**事后没法追问**：「你自己把这个站点关了」和「站点开着但它挂了」在库里长得一模一样，都是「这一轮没带记忆」。修法是让那个数组穿过两层，落在审计的一个数组上：

| 位置 | 改动 |
|---|---|
| `chats.ts:363` | `ConversationContext` 多一个 `cognitiveFailed: CognitiveModuleKey[]`；`:18` 连带 import 那个类型 |
| `chats.ts:458` | `return { messages, citedMemoryIds, cognitiveFailed: cognitive.failed }` |
| `messages/route.ts:83` | 解构多取这一个字段 |
| `messages/route.ts:237-242` | `writeAudit` 的 `after` 里加 `cognitiveFailed`（打完探针后按本文件风格折成多行；断言钉的是**位置**，不是排版） |

一行代码都没改判定——`manager` 那侧的行为早就对了，只是没人接。这也是为什么它单独一片、单独先红。

### 先红

`cognitive-chat-wiring.test.ts` 7 → **10 条**。新增的三条是这张表的追问面：站点开着但读挂了要交回 `['memory']`；站点关着要交回 `[]`（**这个字段不许把两件事混成一件**）；路由确实把它写进了 `after`（静态断言 `readFileSync` + 正则钉住「在 `after` 那个对象里」，而不只是「在文件里」）。

红法（实现前）：`TS2339 Property 'cognitiveFailed' does not exist on type 'ConversationContext'`，两条运行时用例红在 `undefined` 不等于 `['memory']` / `[]`。**这一片又踩到同一个盲区**：`npx tsc --noEmit` 抓到的那条（`ConversationContext` 少字段）vitest 一条都不红——esbuild 只剥类型不求值。

### 变异探针

5 条，逐个当场回滚，仍用仓库外那个小跑批脚本（锚点必须恰好出现一次，`finally` 按字节还原并自证 `RESTORED byte-equal: true`）。

| 探针 | 结果 |
|---|---|
| E-P1 `chats.ts` 交回硬编码空数组 | **1 红**：「站点开着但读挂了：交回挂了的那个模块键」 |
| E-P2 `route.ts` 的 `after` 里去掉这个键 | **1 红**：那条静态断言的 `after: {…cognitiveFailed…}` 正则 |
| E-P3 把它从 `after` 挪到 `writeAudit` 的同级参数 | **1 红**，红因同上。这条钉的是**位置**：审计的行形状由 `after` 承载，挪出去等于没进库 |
| E-P4 `manager.ts:89` 不再 `failed.push` | **1 红**：「站点开着但读挂了」。**这条同时证明接线用例没在自证**——它 mock 的只有 prisma，`runCognitiveReads` / `settle` / 截止全是真的 |
| E-P5 `manager.ts:80` 的筛选从 `=== true` 改成 `!== false` | **1 红**：红的是「站点开着但读挂了」那条，**不是**「站点关着」那条。原因值得记：测试替身的偏好行只填了 `memoryEnabled` 一个键，`!== false` 于是把其余站点当成开着，它们的读在缺模型的 mock 上炸掉，`failed` 多出键。所以「关了不是挂了」那条用例挡不住这个变异，挡住它的是**数组恰等于 `['memory']`** 这个形状 |

### 这一片的边界（含无法验收项）

- **相邻的那个洞没修，也没用例**：`manager.ts:79`——**整行偏好读不出来**时（`readPreferences` 抛错）返回 `{ blocks: [], failed: [] }`，于是「配置面挂了」仍然和「全关着」同形。今天只有 `cognitive.preferences_unavailable` 那条**日志**（`manager.ts:144`）能证明它发生过，库里没有痕迹。不修的代价是失败方向安全（什么都不读、什么都不写），修的代价是给 `CognitiveReadResult` 和审计形状再加一个旋钮。**这一条留给裁决，不混进本片。**
- **`after.cognitiveFailed` 至今没有真实一行**：要它非空得真有一个站点挂掉，本机 2 条记忆、模块全默认关，跑不出一条非空审计。**「写进了库」这一句目前只有静态断言 + 单测里的 `writeAudit` 参数为证，无法验收真库那一行。**
- **界面不读这个字段**：`.tsx` 里 `cognitiveFailed` 零命中。它是给排障和审计看的，不是给用户看的——所以按「不摆没人消费的东西」那条规矩，它不该出现在任何屏上；这里它也没成为一个控件，只是一个后端数组。
- **表里那四处「不存在」一片都没动**：Graph Association、Emotion Analysis、Response Policy、事件更新四行仍写「不存在」（事件更新那一行的真相是「读时派生换了个名字」）。这一片只把 User Modeling 从「不存在」改成「存在」——那是片 d 的成果，今天才落进表。**不建它们**：图是只读派生、情绪呈现是档位、回复策略没有需求来源——凭空建站点违反「认知模块一律默认关，且必须带实测增益」。
- **行号会漂**：这张表和 `manager.ts` / `chats.ts` 的行号是今天逐一 `grep` 复核过的（上一片就发现旧计划里的 manager 行号已经过期）。之后任何一片动到这几个文件，这张表要一起改。

---

## 连接层只试第一个地址：那一次探针顺手量到的真 bug（11-05 片 f-0）

片 f 要用掉你给的那一次探针。第一趟请求**根本没发出去**——报的是「无法连接模型服务，请检查 Base URL 与网络」（`AI_UNREACHABLE`，`ssrf.ts:195`），而对面活得好好的。三条实测把责任从「他那边的端点」挪回到我们自己的地址解析：

| 实测 | 结果 |
|---|---|
| `dns.lookup('ark.cn-beijing.volces.com', { all: true, verbatim: true })` | 先回 `2406:d440:…`（AAAA），再回 `118.196.65.58`（A） |
| 直连那个 IPv6 的 443 | **6 秒超时** |
| 直连那个 IPv4 的 443 | **通** |

**根因**：旧 `pinnedLookup` 是 `candidates[0] || target.addresses[0]`——**只交回一个地址**，交回去的那个正好是 DNS 排在最前面的 AAAA。这台机器没有 v6 出口，于是每次连接都撞死在它上面，而连接层根本不知道还有第二个地址可试。

**影响面不止探针**：`safeFetch` 有五个调用点——对话流式（`src/lib/ai.ts:131`）、非流式（`ai.ts:283`）、模型自检两处（`src/lib/providers.ts:294` / `:329`）、语义向量（`src/lib/cognitive/embedding.ts:95`）。任何一个 provider 的域名先回 AAAA，它在生产上就是**整条不可用**，而且报的是「请检查 Base URL 与网络」这种把矛头指向配置的错误。这条不是推测：本机那个 provider 今天就是这样，而它的 IPv4 是通的。

**修法**（`ssrf.ts:134-148`）：把**校验过的那批地址整组交回**，并把 IPv4 排在前面；调用方点名要某一族时仍按族过滤，过滤空了就退回全组（不让只有 AAAA 的解析把自己筛成零）。防 DNS rebinding 的语义没动——交回去的仍然只有 `validateProviderTarget` 校验过的那批，只是从「挑一个」变成「全都要」。

### 先红与探针

`tests/unit/ssrf.test.ts` 10 → 13 条。三条行为用例先红（`pinnedLookup` 当时还不是导出的，红因是 `TypeError: (0 , pinnedLookup) is not a function`——不是断言不对，是缝还没开），实现后 13 全绿；第 4 条「dispatcher 用的就是这一个解析器」是静态断言，**RED 时就过了**，它是给下面 S-P1 暴露的那个洞补的钉（不假装它是先红）。

| 变异探针 | 结果 |
|---|---|
| S-P1 只交回排序后的第一个地址 | **1 红**：「全都要」那条。等于退回旧行为 |
| S-P2 不排序，按 DNS 给的原序交回 | **1 红**：同一条，红在顺序 `[v6, v4]`。这条钉的是「v4 在前」，不是「多地址」 |
| S-P3 去掉「过滤空了就退回全组」 | **1 红**：「只解析出一个 v6、却被要求 v4」那条 |

回归物证是网络本身：修完再探同一个 host，结果从「请求没发出去」变成 **HTTP 400**——请求真的出去了，对面开始评价参数。离线单测只能证明交回的清单对，「连接层真的会换着试」这一句靠那一趟实测。

### 这一片的边界

- **IPv4 优先是本机的经验，不是普适正确**：一个只有 v6 出口的环境里，v4 先试要白等一轮连接超时（`AGENT_OPTIONS.connect.timeout = 10_000`，`ssrf.ts:85`）才轮到下一个。**无法验收**——本机没有 v6-only 网络可测。换部署形态时回看这一条。
- **没改用例去断言「undici 真的会多地址竞速」**：那是 Node 的 `autoSelectFamily` 行为，我们的用例只钉自己这一层（交回什么）。

---

## 5e / 片 f：向量臂的模型名放哪、那一次探针、四臂收口（11-05）

### 为什么先加一个 `params.embeddingModel`

`AiProvider` 上只有 `modelId` 一个模型字段，而对话模型和向量模型常常不是同一个（同一个 host 两条 endpoint 是常态）。不加列、不建新表，约定就落在已有的 `params` 上。动手前它有三处会拦：`providerInputSchema` 是 `.strict()`（陌生键直接 `unrecognized_keys`，实测红因就是这个）、`normalizeParams` 只认 `temperature` / `maxTokens`（会把它抹掉）、`embedding.ts` 发的是 `provider.modelId`。

规则（`providers.ts:76-82` 的 `embeddingModelOf`）：`params.embeddingModel` 优先，缺省退回 `modelId`；**绝不填一个默认模型名**——猜错会把「端点不支持」和「我们猜的」混成同一件事，这条是计划里的不变量。空串在 schema 层就不收（`.trim().min(1)`），宁缺勿滥。

### 先红（含两条 0 红，如实记）

两个文件 25 条：**4 红 / 21 绿**。红的是 `unrecognized_keys: ["embeddingModel"]`（schema 拦）、`masked.params` 里键没了（归一化抹）、出站 body 仍是 `ark-code-latest` 两处（请求体和行上记的模型名）。**另外两条新用例当时就是绿的，不冒充先红**：

- 「空串不是模型名」——那时 `.strict()` 先一步把整个陌生键拒掉，`success` 自然 `false`。它真正开始生效是在实现之后，由 F-P3 证明。
- 「没配 embeddingModel 时退回 `modelId`」——它钉的不是新功能，是**别把缺省改掉**：一条特征守卫，故意在 RED 就过。

### 变异探针

| 探针 | 结果 |
|---|---|
| F-P1 `embeddingModelOf` 忽略覆盖，永远回 `modelId` | **2 红**：出站 body 的模型名 + 行上记的模型名 |
| F-P2 `normalizeParams` 不再保留这个键 | **3 红**：上面两条 + 管理台读回来的 `masked.params` |
| F-P3 schema 去掉 `.min(1)`（收空串） | **1 红**：「空串不是模型名」 |
| F-P4 `embedding.ts` 绕开解析器直接取 `provider.modelId` | **2 红**：同 F-P1 那两条。**这条证明客户端确实问过那个约定**，不是只写着好看 |
| F-P5 schema 里这个键改名（等于没有这个键） | **1 红**：「schema 不许把它当陌生键拒掉」，红回 `unrecognized_keys` |

### 那一次探针的结果（只记状态码和维度数）

第一轮（片 f-0 之前）：kimi 报 `AI_UNREACHABLE`（我们的连接层，不是端点）、deepseek 报 404。修完连接层**两趟都重跑**，记录以下——deepseek 那个 404 是应用层回答，说明它本来就连上了，重跑是为了让两条口径一致。

| provider | 解析出来的模型名 | 结果 |
|---|---|---|
| `kimi`（ark.cn-beijing.volces.com） | `ark-code-latest`（缺省退回 `modelId`） | **HTTP 400** `InvalidParameter`——请求发出去了，对面说参数不合法：发过去的是对话模型名，它不是向量模型 |
| `deepseek-flash`（api.deepseek.com） | `deepseek-flash`（同上） | **HTTP 404**、返回体为空——这台 host 上没有 `/embeddings` 这条路 |

**两个都没拿到维度数**，所以按你给的判法：**5e 向量臂标「无法实测」，读侧的关键词 ⊕ 余弦混合排序继续没有入口**。库里今天实测：`MemoryItem` 2 行，`embeddingCiphertext` 非空 **0** 行——`retrieval.ts` 那半条臂有单测、没有真数据走过一次。

**解锁触发条件（一句话）**：`params.embeddingModel` 被填成**该 host 确实提供**的向量模型名，且探针拿到维度数；那一刻混合排序才第一次有真向量可排。**这次探针没有改库**：两个 provider 的 `params` 仍是 `null`，一行都没写。

探针脚本是仓库里的一次性文件（`probe-embedding.once.ts`），跑完即删、未提交；它只打印状态码 / 维度数 / 截断后的错误体，且任何要打印的字符串先 `split(key).join('***')`，key 出不了屏幕。

### 四臂收口：一臂一行，带原因和解锁条件

写进现成的两张表（`scripts/cognitive-eval/report.ts:173` 的四臂表加了「解锁触发条件」这一列，`:255` 那张「今天测不了的指标」补上 B 臂的真实原因），不编数字：

- **A1**（只有近期上下文）不可建：harness 离线不调模型，也没有标准答案之外的判分人。
- **A2** = 现有旧基线，跑了。
- **B**（+ 向量）不可建：就是上面那两次探针 + 库里 0 / 2 行向量。
- **C**（+ 图关联）不可建：2a 那次阈值校准的结论是不建关系表；记忆网络是从三种**已经存在**的关系读时派生的（演化边 / 同场对话 / 洞察引用，`src/lib/cognitive/memory-graph.ts:1-20`），里面没有「相关度」也没有多跳——「图关联命中率」没有可测对象。
- **D**（+ 反思与决策经验）**按数据**不可建：代码和确认界面都在（`src/components/settings/decision-panel.tsx:236` 那个「确认」按钮），库里 `DecisionRecord` / `ReflectionRecord` **各 0 行**（今天实测）。旧表里那句「Phase 5/6 未开始、确认界面还没做，今天一条决策记忆都落不进库」是过期陈述，这一片改成按数据说。
- 改完重跑 `npm run eval:cognitive` 重生 `report.md`（`cognitive-eval-snapshot.test.ts` 逐字节比对）。**A2 和现状的数字一个没动**：Recall@8 仍是 0.0374 → 0.7274、MRR 0.0154 → 0.5828、违禁注入 1 → 0，动的只有那两张表的措辞和新加的那一列。

### 这一片的边界（含无法验收项）

- **后端收了，界面没有入口**：管理台的 provider 表单只有 `temperature` / `maxTokens` 两个输入（`src/components/admin/models-tab.tsx:316` 那份本地 `params` 类型也没有这个键）。所以「填上真模型名」这一步今天要么直接改库、要么加一个输入框——**加输入框是新文案，等你点头再加**，不混进这一片。
- **混合排序仍没被真数据走过**：写侧 `embedding.ts` 和读侧融合都有单测，但库里 0 行向量，端到端那一次「有向量的检索」至今**无法验收**。这不是缺口，是同一个缺口的两侧：都卡在对面那个模型名上。
- **B 臂的数字仍然是空的**：这一片只把「为什么没有」写清楚，没给任何估算值。
- **行号会漂**：`ssrf.ts` / `providers.ts` / `embedding.ts` / `report.ts` 的引用都是今天逐一 `grep` 复核过的。

---

## 片 f-5：真实语料今天能量出什么、量不出什么（11-05）

计划里这一片的原话是「从本仓库自己的 `Message` 行（已加密，解密要本机 key 文件）导到 **`C:\Users\kkxin\family-ai-chat-eval\real-corpus\`，仓库外**……仓库里**只出聚合数字**——计数、Recall@8/MRR 差值、违禁数，不带发言原文」。**这一片只做了后半句，前半句没做**：那个目录今天不存在（`ls` 实测），扫描全程在内存里，只 `console.log` 一个 JSON 聚合，脚本跑完即删，仓库内外都没留下一份明文语料。偏离的理由写在第三节，不藏。

### 一、真实语料和认知库今天到底有多大（今天逐一 count，一条原文都没读）

| 项 | 今天 |
|---|---|
| `Chat` 行 | 9 |
| `Message` 行 | 33，其中 `role=USER` 17 |
| 有用户发言的账号 | 2 |
| 时间跨度 | 11-02 → 11-04（最后一条用户发言 11-04 16:52） |
| 用户发言长度 | 中位 13 字、最短 3 字、最长 7604 字；超过 500 字的只有 1 条 |
| 词面集合规模（`tokenize` 后去重） | 中位 11 个词，17 条合计 2570 个——合计里绝大部分是那条 7604 字贡献的 |
| 解密 | 17 条全部解开，0 条失败、0 条空正文 |

| 认知库的表 | 行 |
|---|---|
| `MemoryItem` | 2（带向量的 0） |
| `MemoryEvidence` | 2（两条记忆各 1 条证据） |
| `MemoryRevision` | 0 |
| `DecisionRecord` / `ReflectionRecord` | 0 / 0 |
| `UserProfileEntry` | 0 |
| `MemoryAccessTurn` | 0 |

两条 `MemoryItem` 的元数据（`contentCiphertext` / `embeddingCiphertext` 两列根本没请求）：`context=GENERAL`、`type=GOAL`、`origin=EXPLICIT`、`version=1`、`confirmedAt` 非空、`validPrecision=UNKNOWN`、都带来源会话与来源消息，`recordedAt` 是 11-03 17:32:58 的 `.646` 与 `.661`。**差 15 毫秒 = 同一轮真实对话写出来的两条**，不是两次不同的使用。这一条把「写侧在真库上到底走过没有」从推测变成实测：**走过，一次**。

`MemoryAccessTurn` 那 0 行不是洞，是时序：记录「这条记忆这一轮被检索到了」是 11-05 片 a 才落地的，而那两条记忆 11-03 就写进去了，之后没有新的真实会话。开了 `memoryEnabled` 聊一轮就会长出行。

### 二、不需要 gold 就能量的三件事（跑的全是线上那两个/那三个纯函数）

| 量的是什么 | 真实语料上的数 | 判读 |
|---|---|---|
| 情境分类落点：`classifyContext`（`src/lib/cognitive/context-classifier.ts:168`）逐条跑 17 句 | general 12 / emotionalSupport 2 / personalGoal 2 / technicalProject 1；带情境信号的 5/17；`ambiguous` 0 | 「怎么只记了 2 条」这件事，得先从写侧的触发率看起——17 句里 12 句连情境信号都不带，检索再准也无从下手。**这只改了「该往哪看」，没改任何判定** |
| 时间表达命中：`resolveTemporalFrame`（`src/lib/cognitive/temporal.ts:45`）逐条跑 17 句 | 0/17；已入库那两条的 `validPrecision` 也都是 `UNKNOWN` | 4-T2 那条链在真实使用里**零流量**。单测全绿只证明它按规则算得对，不证明真实句子会走到它。两个数是并列，不是互证：那两条记忆 11-03 写入时的口径与今天是否一致，我没复核 |
| 关键词召回的空转率：`scoreByKeyword`（`src/lib/cognitive/retrieval.ts:87`）15 次探测 | top-8 全 0 分 3 次（18%）；但这 3 次全落在池子不足 8 条的早期消息上；池子 ≥8 的 8 次探测 0 次空转，top-8 里平均 60.9% 有条目带词面命中 | 见下面那段——这一条量出来的是一个**待定的设计问题**，不是一个通过的验收 |

口径：探测按用户分段（绝不跨用户），池子是同一用户**更早**的用户发言，所以没有未来泄漏；取的 8 就是线上那一个 8（`MEMORY_READ_MAX_ITEMS = 8`，`src/lib/cognitive/memory-module.ts:45`），切法也和线上一字不差——`rankMemories` 的本体就是 `scoreByKeyword(...).slice(0, limit)`（`src/lib/cognitive/retrieval.ts:83`）。分池子大小两组，是因为池子不满 8 条时 top-8 就是整池，两组混在一起平均会把「池子还太小」误报成「召回变差了」。

**那 3 次全 0 命中说明的不是「读侧没静默失效」，恰恰相反**：`rankMemories` 那条关键词分支没有分数下限，一个词都没命中也照样把 8 个位子端出去。报告里早就有个指标在看着这件事——`avgNonGoldSlots`（`scripts/cognitive-eval/report.ts:227` 那句「其中 N 条不是这一问该答的」），真实语料上那 3 次就是这个数的极端形：占位的全是非命中。**「词面零命中该不该干脆不注入」今天既没实现也没判过**，是这一片量出来的下一个待定项；它改动的是注入语义（会给「记忆太少」再加一道闸），所以留给你判，不混进这一片。

### 三、Recall@8 / MRR 在真实语料上：无法验收，以及为什么不导出明文

计划要的是「真实语料上的 Recall@8/MRR 差值」。今天给不出，两条理由各自独立：

1. **没有 gold，这个指标在结构上就不存在**。`scripts/cognitive-eval/metrics.ts:126` 把 `recall === null` 的探测全滤掉，`:151` 的 `recallAt8` 只对剩下的那批取平均——gold 为空的提问根本不进分母。而 gold 的口径写在 `scripts/cognitive-eval/fixture-types.ts:16`：「这一问该注入哪些条」的**封闭集合**——今天 30 个故事摊出 116 次提问（`summary.json` 的 `counts`），每一次的 gold 都是手写死的。真实语料要进指标，就得有人逐条判「这句该让它记起哪条」，那是**你本人的判断**，不是规则派生得出来的。用 `scoreByKeyword` 自己的高分项当 gold，等于拿被评的打分器给它自己打满分：循环，而且必然漂亮。
2. **就算标了，n=17 / 2 天也出不了可追问的差值**。两臂在 30 个故事上的差是 0.0374 → 0.7274；同一个算子搬到 17 条真实发言上，任何一个小分母上的抖动都能把这个读数淹掉。

为什么不导出那份明文语料（偏离计划前半句的理由，三条）：
- 明文 dump 你专门删过一次（迁移前那一份），「导出到仓库外的目录」正好是把那件事再做一遍；
- 任务书禁止「直接使用真实家庭成员的私人聊天记录构建**公开**测试集」；本地留一份明文只是把风险从库里搬到磁盘上，不改变它是一份可被再次上传的东西；
- 这一片要的每一个数都能在内存里算完，**没有一个数需要一个中间文件**。

所以做法是：一次性 tsx 脚本读 `Message` 行 → 内存里解密 → 内存里跑那几个纯函数 → 只打印聚合 → `rm`，未提交、未落盘。AAD 是手抄 `src/lib/chats.ts:68-70` 那份 `message:${id}`；抄错的自我检测就是 `decryptFailures` 这个字段，真实值 0（17 条全解开），所以说抄对了。脚本没有 import `chats.ts`：它会顺着 `src/lib/files.ts:5` 拖进 `file-type`（只有 ESM 入口），`tsx` 在 CJS 下解析不了——这是脚本层面的绕行，产品代码的 import 链一点没动。

### 四、解锁条件

| 要往下走需要什么 | 在谁的手上 |
|---|---|
| 真实语料上的 Recall@8 / MRR | 你本人对真实提问逐条标 gold；且记忆条目和消息量得先长起来（分母现在是 2 行记忆 / 17 条发言） |
| 「词面零命中不注入」这道闸要不要加 | 你的裁决：加了会让注入条数更少，与「记忆太少」那条观感直接冲突 |
| 时间链在真实使用里的命中 | 只能等真实发言里出现带时间表达的话，代码这边无事可做 |
| `MemoryAccessTurn` 长出行 | 开 `memoryEnabled` 聊一轮 |

B 臂那一行（`scripts/cognitive-eval/report.ts:179`）本片**没有**改变：探针拿不到维度数，库里向量列仍全空。

### 这一片的边界（含无法验收项）

- **本片 0 处生产代码改动**，所以没有先红、也没有变异探针可做——探针需要有可破坏的断言，这一片一条都没新增。这一行是刻意写出来的，不是漏填。
- 门禁照跑过：`npx tsc --noEmit` 干净；`npm run test:unit` 90 文件 / 1425 用例全绿，与片 f 提交时同一组数，没动。
- **没起服务发过一次真请求**：上面三个数都是离线把真实密文喂给线上那几个纯函数得到的，和真实一轮对话里「闸门 → 模块被调 → 记忆被选中 → 被注入」之间还隔着开关、1 秒超时与错误隔离。这一段仍是无法验收，和片 d 情绪三档同一类空白。
- 那 5 条「带情境信号」只说明分类器给出了 winner，**不等于**写入策略允许它们落库——策略那一层（`MemoryPolicyService` + 每用户开关）今天没在真实语料上重放过。
- 长度分布决定了这批数的天花板：一条 7604 字的消息把词面集合总量撑到 2570，而中位只有 11 个词——这种偏斜下算出来的任何重叠率都更该被当成「分布观察」，不是「指标」。
- **行号会漂**：`context-classifier.ts:168` / `temporal.ts:45` / `retrieval.ts:83,87` / `memory-module.ts:45` / `metrics.ts:126,151` / `fixture-types.ts:16` / `report.ts:179,227` / `chats.ts:68-70` / `files.ts:5` 都是今天逐一 `grep` 复核过的。

## 片 g：Phase 1–6 的三条残项收口 + 第一次「点得动」的真渲染（11-05 他把权限全给我那一阵）

计划里这一片只有三件事：那句没批过的读失败文案抽出来逐字钉住、三条 `DEAD` 行给个建议并执行、真渲染验收四条路径。
前两件是纸面活，第三件是这片真正的分量——**11-04 那份文档说过「这台浏览器点不动」，今天点动了**，
所以有好几行「界面没有真渲染验收」从今天起可以改成实测。

### 一、代码事实（三处，一共 20 行）

| 位置 | 改了什么 |
|---|---|
| `src/lib/cognitive/citation-display.ts:25-29` | 新增 `CITATION_LOAD_FAILED_NOTE = '这条清单没读到，稍后再试试'`，和上面两句同一份来源 |
| `src/components/chat/chat-workspace.tsx:41-47`、`:1466` | 那处原本把句子写成组件里的裸字面量，现在 import 常量、渲染 `{CITATION_LOAD_FAILED_NOTE}` |
| `tests/unit/cognitive-citation-display.test.ts:102-113` | 8 → **10** 条：一条逐字钉住字面，一条 `readFileSync` 读组件源码，要求它**不含**「这条清单没读到」且**含**那个常量名 |

为什么值得为一句话做抽常量：这一屏三句话里，前两句（`CITATION_NOTE` / `CITATION_MISSING_LABEL`）本来就是常量、有用例逐字守着，
唯独这句留在 JSX 里——它是这一屏唯一一处「东西没拿到」的坦白，最不该由谁顺手改着玩。第二那条用例守的是**只有一个来源**，
不是守字面：字面改了就红，两处各留一份也会红。

### 二、先红（把两处实现退回、用例留着，实测跑了一遍）

`Tests 2 failed | 8 passed (10)`。红的正是这两条新用例，理由各不相同：
一条 `expected undefined to be '这条清单没读到，稍后再试试'`（命名导入不存在时 vitest 不报加载失败，只给 `undefined`——
这跟 8.2 那一片「整文件加载失败」不一样，因为这次模块本身存在，缺的只是那一个导出）；
一条 `expected '<组件源码>' not to contain '这条清单没读到'`。
恢复实现后同一个文件 10 条全绿。

### 三、变异探针（三条，各自杀各自那条，全部当场逐字回滚）

| 探针 | 改法 | 结果 |
|---|---|---|
| G-P1 | 常量末尾少一个「试」字 | 1 红（`:103` 逐字用例），红的理由就是那两个字面差一个字 |
| G-P2 | 组件里 `{CITATION_LOAD_FAILED_NOTE}` 换回内联字面量（import 留着） | 1 红（`:111` 「一句只有来源一份」）。这条证明的不是字面，是**只有一份** |
| G-P3 | 把 `citation-display.ts` 的导出改名（组件与用例都还在引旧名） | vitest 1 红（`expected undefined to be …`）**且** `npx tsc --noEmit` 两处 TS2724 |

G-P3 值得单独记一句：接线断了的时候，逐字用例只会说「拿不到值」，**是类型门禁在报「谁没接上」**（`chat-workspace.tsx:42` 与用例 `:15` 各一条）。
这条片子里第一次出现「同一处断裂被两层各说一遍」——不是冗余，用例那层不看引用点、tsc 那层不看字面。
三条探针回滚后 `git diff --stat` 与本片目标逐字一致，重跑该文件 10 条绿。

### 四、口径核实（计划给的两句，一句改文档、一句本来就没写歪）

- **`memory-display.ts:82-84` 是「可信度高/中/低」，没有冒号**——今天真渲染量到过：那一行界面上摆的就是无冒号那一套。
  文档里唯一的「可信度：中」在「8.2」那一节的**偏差一**（`:1059`，实测过），那一行本来就是**标注偏差**（批准表 vs 实现），不是把带冒号那套当成实现字面，所以不改。
  要回到批准表原字面，动的是 `memory-display.ts` 那份标签，全项目一起变——**11-05 他一句「你说的文案都通过了」，无冒号那套就是终稿**。
- **顺手抓到一处真错**：「8.2」那一节文案表里「那条已经不在了」那行还抄着 11-04 那批的字面「（可能已被更新或删除）」，
  而 7.2 那一片已经把实现改成「（可能已被更新、删除或归档）」（「7.2：ARCHIVE」一节的代码事实表与文案表都记过），批准表没跟着改。
  现在把 `:1057` 更正成当前实现字面并注明来源，**表本身的历史没被抹掉**。

### 五、真渲染：那把锁是怎么开的

11-04 的结论（6-G 那节，`:933-941`，以及「Phase 6 仍然无法验收的部分」`:949-950`）是「这台浏览器替身 0×0、`visibilityState=hidden`、`requestAnimationFrame` 一次都不回调，
所以流式 Suspense 边界永远不 hydrate，切不动 tab、点不动按钮」。**这个结论被推翻了，办法不在应用侧，在注入脚本的写法上**：

- 浏览器替身的 `navigate_page` 支持 `initScript`。**箭头函数那一支会被静默接受但从不执行**（我按箭头函数写了第一次，实测 `rafOk:false`、13 个按钮 0 个挂 fiber，等于没注入）；
  **写成普通语句**（直接给 `window.requestAnimationFrame` / `cancelAnimationFrame` 赋值，rAF 用 `setTimeout(cb, 16)` 兜）才真的生效。
- 补上 rAF 之后，React 就把 `#S:0` 那个边界 hydrate 了：13 个按钮 13 个挂上 `__reactProps`，`click()` 切得动 tab，弹窗点得掉。
  `visibilityState` 仍是 `hidden`、视口仍是 0×0，所以**这一屏验的是「行为」，不是「像素」**——排版、换行、行内间距今天依旧没验，
  这一条不要因为能点了就当过了。
- 服务是 `npm run dev` 起的 `127.0.0.1:3000`，走的是计划 `:152` 那条他特批的例外；**跑完已停**，
  `Stop-Process` 之后 3000 端口没有 LISTENING（npm 那个壳退出后 node 子进程还活着，得单独收）。

### 六、四条路径逐条（界面字面 / HTTP / 库，三层各留一份）

| 路径 | 界面量到的 | HTTP | 库 |
|---|---|---|---|
| 归档 → 已归档 → 恢复 | 行上「归档」→ 展开区「确认归档」→ 提示 `已归档，这条不再进入对话`（`memory-panel.tsx:674,759,322`）；该行从有效列表挪进「已归档」区块（`:900`，标题就是这三个字），恢复后区块整块不渲染 | `POST …/archive` 与 `POST …/restore` 各 200 | `archivedAt` 写上又清空；收尾 `archived: 0`；审计两条 `user.memory_archive.after.archived` / `user.memory_restore.after.restored` |
| 记忆网络 | 关着时那一屏只说开关没开；`associationEnabled` 打开后真的摆出派生句 `2 个点、1 根线连不成一张图：这两个点之间确实有关系，可三个点以上的连线才叫网络。`（`memory-graph-display.ts:74`，数字是真库里的 2 行 / 1 条边） | `GET …/memory-graph` 200 | 零迁移派生，没写任何行 |
| 画像：候选 → 收进 → 改 → 删 | 关闭态说清没开；开着时**两个候选**（服务端现算，库里 0 行）→ 点「收进画像」出 `已收进画像。`（`profile-panel.tsx:129`）；改正文走行内 textarea + 保存；删的时候弹窗 `删除这条画像？`，确认钮是「删除」（`:171-190`）→ `已删除这条画像。`（`:183`） | `POST` / `PATCH` / `DELETE` 打在 `/api/account/cognitive/profile[/{id}]`（`profile-panel.tsx:33`）各 200 | `PATCH` 后该行 `content` 长度 11、与我键入的那串逐字相等、`editedAt` 写上、`confirmedAt` 保留（`user-profile.ts:128-141` 的语义第一次被真机验到）；删完 `UserProfileEntry` 回到 0 行 |
| 忘记这个主题 | 弹窗标题 `忘记「学习」这个主题的全部记忆？`，确认钮字面「删除记忆」（`memory-panel.tsx:435,396`） | `DELETE …/memories?scope=context&context=learning` 200 | **为了让这条可验，先造了一行只属于 `LEARNING` 的一次性记忆**（内容我自己写的），删的就是它；他那两行 `GENERAL` 的 `recordedAt` 仍是 `.646` / `.661`，`archivedAt` / `supersededAt` 都没被碰 |

另外两件一起量了：
- **暂停长期记忆写入**：开 → `已暂停新的记忆写入，已记住的内容照常带入对话`，关 → `已恢复新的记忆写入`（`memory-panel.tsx:210`），库里 `memoryWritePaused` 跟着 true/false 各读回一次。
- **聊天里那句引用提示（负例）**：`/chat` 发一轮，气泡正文完整、footer 摆出 `100 tokens 输入 · 52 tokens 输出`，**没有引用控件**——
  这正是 `citationHint(0) === ''` 那一支该有的样子，也对应库里 `MemoryAccessTurn` 仍 0 行。

### 七、我自己犯的两次错（都改成物证了，不是应用缺陷）

- 一次 `document.querySelector('main textarea')` 抓错了框：画像那一屏**有两个 textarea**（「写下这条」的草稿框和行内改正文的框），
  我第一次量到的是草稿框，于是报了个假 bug——「改正文没生效」。换成行内那一个（`profile-panel.tsx:335`）之后
  界面、HTTP、库三层全部一致。**报错的代价是我自己写的一条断言，不是生产代码。**
- 应用级确认弹窗渲染在 **portal** 里，挂在 `main` 外面：所以 `main.innerText`、`main button` 都找不到它，
  我第一次点「删除」以为没反应。改读 `document.body` 之后弹窗与按钮立刻现身。这条对手动测试的人也成立——不是替身独有的怪事。

### 八、三条 `DEAD` 行：建议是清，已经清了

`CognitiveTask` 现在 `taskCount = 0`（`groupBy status` 返回空数组，实测）。清之前逐条确认过：

- **它不带任何正文**：`prisma/schema.prisma:644-675` 那张表没有 payload 列，只有 id、状态、次数、租约和 `lastErrorCode(64)`——
  表的设计职责就是「只装还欠着的活」。所以删它不删掉任何用户内容，也不留痕丢失：审计与日志本来就只带 id。
- **`DEAD` 不会被自己救回来**：worker 失败三次用尽后就判死（`task-worker.ts:142` → `task-queue.ts:136-138` → `killCognitiveTask` `:155`），此后不再被取；留着只是每次数表都要多扫三行。
- **成因已消失**：`:769-770` 那半边补上了（迁移后同一个 `findUnique` 不带 `select` 实测能读回整行，`reflectionSweptAt` 是 `NULL` 而不是「列不存在」）。
- **计划里那句「根因已查清」比本文档自己的标注强**：`:755-767` 那节明确写了推断的边界（直接观测到的只有 `lastErrorCode` 这个**我们自己打的标签**和「插入成功」两件事）。
  以文档为准，不以计划口径为准。
- **要不要给已有记忆补向量：今天做不了，也没偷偷做**。两行记忆的 `embeddingCiphertext` 实测仍都是空（`hasVector:false` ×2），
  因为片 f-4 四臂里那条向量臂还卡在端点没有可用的 embedding 模型；现在补一行 `CognitiveTask` 只是攒一条注定失败的欠账。
  这条等 B 臂解锁（见片 f-4 那张表）之后重估。

### 九、「日志与审计只带 id」这一条今天真的量到了形状

拿 `AuditLog.after` 逐个字段打印**形状**（类型 / 数组长度 / 首元素长度 / 是否像 UUID），不打印任何值：

| action | 字段 | 形状 |
|---|---|---|
| `user.memory_archive` / `user.memory_restore` | `archived` / `restored` | boolean |
| `user.cognitive_update` | 八个开关 + `memoryWritePaused` | boolean；`emotionTransparency` 是 string（三档枚举字面，不是内容） |
| `user.profile_create` | `memories` / `reflections` | number（候选条数） |
| `user.profile_revise` | `edited` | number |
| `user.memory_purge_by_context` | `purged` / `learned` | number / string 数组，实测长度 0 |

`learned` 那一项数组元素是 `MemoryContext` 枚举，不是记忆 id 也不是正文（`policy-learner.ts:122-135` 返回 `MemoryContext[]`，
route 签名 `learned: readonly string[]`），这一条是读源码定的，因为实测那一次它是空数组——空数组证明不了元素类型。
**结论**：这一屏今天新写的审计里没有一处带正文或密文。

### 这一片的边界（含无法验收项）

- **引用提示的正例和那句读失败文案，真渲染里都没出现**，而且不是补种数据能补的：
  `chat-workspace.tsx:164` 那份 `citations` 是**临时客户端态**、按**助手消息 id** 索引，id 只来自那一轮流式响应的 `done` 帧；
  而 `MemoryAccessTurn.sourceMessageId` 存的是**用户**消息 id（`messages/route.ts:171-175`），只被 `listAccessStats`（`access.ts:91`）读，
  界面根本不查这张表。所以往 `MemoryAccessTurn` 里种行**点不出那个控件**——这条我是先试过才写下的。
  要看到正例得起一轮真会注入记忆的对话，那会往他库里写新记忆，我没替他做。
  `CITATION_LOAD_FAILED_NOTE` 的失败分支同理：要造一次 4xx/5xx 才渲染，今天只有用例和类型在守它。
- **像素、排版、换行、行内间距一条都没验**：替身视口 0×0、`hidden`，能点不等于能看见。6-F/6-G 那两屏的「行内排布」「依据展开」「六个区的空区不渲染」
  从今天起**能点了**，但我今天的时间花在四条功能路径上，那几条还挂在「未验」。
- **文案批准记录（11-05 他这句「你说的文案都通过了。然后继续往下做。你需要的权利都授权给你。尽可能你自己做，不要找我。」）**：
  此前挂着的六处全部转正——偏差一（无冒号的「可信度中」就是终稿，不回改 `memory-display.ts`）、偏差二（`这条清单没读到，稍后再试试`）、
  6-G 自拟的两句（行的生成时间 + 洞察列表截到 100 条）、7.2 的补充一（撤回链接字面）、补充二（「已归档」区块说明句）、
  补充三（两份列表各自的截断提示）。这一句同时是把「我自己起服务、自己跑验证」的权限再给一次——
  但**服务用完必须关**这条不随之放松，他的库和端口不是我的常驻资源。
- **词面零命中该不该干脆不注入**（片 f-5 留下的那条）仍然待定，不是本片范围。
- **他的状态已复位并实测**：八个开关回到 `memoryEnabled=true` / `timelineEnabled=true` / 其余六个 false /
  `memoryWritePaused=false` / `reflectionSweptAt=null`；`UserProfileEntry` 0 行、`MemoryAccessTurn` 0 行、`CognitiveTask` 0 行、
  两行 `GENERAL` 记忆未归档未覆写。用完的临时脚本（六个 `*.once.ts` + 一个收尾复核）全部删除，`git status` 只剩本片四个文件。
- **门禁**：`npx tsc --noEmit` 干净；`npm run test:unit` **90 文件 / 1427 用例**全绿——比片 f-5 提交时的 1425 多出的正是本片那 2 条。

## 片 h：任务书 4.3 的 `ChangeDetector` 落地（11-05）

11-04 那份清单里挂着的两件「不是再写一片就完」的事，今天补掉了后一件（`ChangeDetector`）。
**零新表、零迁移、零模型调用、零新开关**，四件产物：

| 产物 | 角色 | 用例 |
|---|---|---|
| [src/lib/cognitive/change-detector.ts](../src/lib/cognitive/change-detector.ts) | 六类观察的派生纯函数。不碰数据库、不碰 crypto、不调模型 | 39 |
| [src/lib/cognitive/change-display.ts](../src/lib/cognitive/change-display.ts) | 封闭句式表：主题×信号、五种证据不足、是否确认过、上限那句 | 10 |
| [src/app/api/account/cognitive/changes/route.ts](../src/app/api/account/cognitive/changes/route.ts) | 只读端点 + 两道闸门 + 正文旁表 | 12 |
| [src/components/settings/timeline-changes.tsx](../src/components/settings/timeline-changes.tsx) | 时间线那一屏里的「变化」区块 | 16（静态断言，见下面第七节） |
| 合计 | | **77 条新用例**（90 文件/1427 → **94 文件/1504**） |

### 一、六件事分两条路走，而这条路不是把 4-T3 那条死路再走一遍

- **②目标状态变化、③项目进展、④偏好变化走版本链**。演化边是写侧（Phase 2C 改口接线）判过「这两句说的是同一件事」
  才留下的，这一层**继承**那个判断，不重做词法相似度。
- **①兴趣出现和变化、⑤长期重复主题、⑥长时间未解决的事项走主题簇**，用的是 6.1 那把尺子：
  同一个 `tokenize`、同一个 `TOPIC_MIN_OVERLAP`、同一组门槛常量（`PATTERN_MIN_SAMPLES/CHATS/SPAN_DAYS`、
  `UNRESOLVED_MIN_AGE_DAYS/QUIET_DAYS`、`INTEREST_SHIFT_*`）。片 h 只往 `reflection-planner.ts` 加了导出，
  一个常量都没抄——抄一份就是给同一个概念养两套算法，早晚长成「洞察说在重复、时间线说不是」。
- ②③④ 只多了一道自己的门槛 `CHAIN_MIN_CHATS = 2`：**同一会话里改两次口是一次讨论，不是一种变化**。

**这条路的代价要说出来**：②③④ 的召回上限就是写侧那道 0.8 相似度的召回上限。4-T3 量到的 0/36 今天没有改变，
它只是不再假装是这一层能修的东西——链侧一条观察都不产出时，界面上看到的不是「他没改过口」，而是「这一层没继承到边」。

### 二、11-04 那句「要建得走 architectural 出 spec，因为它必然引入模型推断」——前提今天被打掉了一半

那片判词的理由是「聚合观察必然要理解句子」，今天的实现不需要：**同一件事由库里的边给定，主题聚由已审计过的簇算法给定**。
所以这一片没引模型、没引新阈值、没引新环境变量。另一半仍然成立：真要按 4.3 那种「主语/槽位」识别改口，
那是引入推断的新子系统，得先出 spec。这一片是按他 11-05 批准的那份认知层 plan 执行的（plan 与任务书一样只在会话里，不进仓库）。

### 三、⑤ 与 6.1 的形状重叠是刻意的，不是漏删

`REPETITION/RECURRING` 和 6.1 的 `PATTERN`、`INTEREST EMERGED/SHIFTED` 和 6.1 的 `INTEREST_SHIFT`
判的是同一件事，因为 4.3 点名要这六类观察、而 6.1 的产出是要人处理的候选（有状态机、有反证、有冷却）。
两屏读同一批簇，所以不会互相打脸；打脸的那条路（各写一套分词和门槛）才是真风险。

### 四、「兴趣」在库里没有对应的记忆类型

`MemoryType` 七类里没有「兴趣」。① 只由 `preference` + `goal` 两类行代表（`INTEREST_TYPES`），
这个局限不靠自觉保密，靠文案：`INTEREST_SOURCE_NOTE` =「系统没有单独的「兴趣」记录，这一栏的兴趣只看偏好和目标两类说法。」
用例 `兴趣只由「偏好＋目标」两类行代表` 钉的是反面：同一批 `fact` 行在 ⑤ 那边照样成立、在 ① 这边一条不产。

### 五、先红：四条用例是我自己写歪的，不是应用缺陷

实现之前先写的 39 条里有四条错在我这边，全部在实现前就改掉了，逐条留档：

| 我写错的 | 错在哪 | 依据什么改的 |
|---|---|---|
| WITHDRAWN 的 id 摆错侧 | 我把撤回那行放进 `afterMemoryIds`，等于让界面把「现在」指向一句已被收回的话 | 撤回没有「后」的一版；`beforeMemoryIds:['gone']` |
| 孤行目标断言 `insufficient` 为空 | 那条 fixture 合法地产出 `UNRESOLVED/BELOW_AGE_MIN`，是我没算过时间门槛 | 读 `UNRESOLVED_MIN_AGE_DAYS` 那条分支重算 |
| 排序 fixture 断言只有一条观察 | 实际三条——一个静默 118 天的当前目标合法地报 `STILL_OPEN` | 按真实产出改断言，不反向改规则 |
| 「两条就够不上重复」那条 | 我给的三个日期跨度 12 天 < 14，`REPETITION` 根本到不了样本门槛那一步 | 用 `PATTERN_MIN_SPAN_DAYS` 重排日期 |
| 双主题 fixture 用「这件事」收尾 | `tokenize` 出的是二元组，两个主题共享「这件事」这两个词就 ≥ `TOPIC_MIN_OVERLAP`，簇被并成一个、`SHIFTED` 永远不可能出现 | 换成「晨间跑步」/「晚间唱歌」：同主题共享 ≥3 词、跨主题共享 0 词 |

最后那条是分词层面的坑，值得单独记：**任何共享两个以上 token 的填充语都会把主题黏在一起**。

### 六、枚举词汇有两套，抄错就是永远为真

界面/读接缝那套是**小写**（`preference` / `explicit` / `unknown` / `superseded`），6.1 的 `Reflectable*` 那套是 **prisma 大写**。
这一层只在 `toReflectable()` 一处转换（`toDbMemoryType` / `toDbMemoryOrigin` / `toDbTimePrecision`），
比较全在大写侧。`isActive` 那类判断如果按小写字面量写，`'retracted' !== 'RETRACTED'` 会让撤回的行一直算「还在世」。
路由测试因此不 mock 转换器，用 `importOriginal` 展开真实现——**在测试里手写一份映射就是给同一套枚举造第二把尺子**。
另：`toDbMemoryType` 是 `policy.ts` 导出、`memories.ts` 只 import 不 re-export，第一次从 `memories.ts` 引它在模块初始化就 `is not a function`。

### 七、闸门：不新增第九个开关

`COGNITIVE_FLAGS` 是任务书固定的八个，这一片不偷偷加一个 `changesEnabled`。变化区块复用时间线那对闸门：
`timelineEnabled` 管这一屏显不显示、`memoryEnabled` 管这份数据能不能被读（1.1 逼出来的：变化读的就是长期记忆正文）。
两道闸门一次 `getCognitivePreferences` 读完，**读不出来时按关闭处理**——拿不准就不读用户的记忆。
界面上它是 `timeline-panel.tsx` 里挂在 `enabled === true` 那一支的子区块，只有一个 `revision` 计数跟着更正/永久删除重读，
自己不发 PATCH、不摆第二个 checkbox。

### 八、日志与审计只带 id：这一片的形状是可断言的

`InsufficientChange` 结构里**没有主题词也没有正文**（只有 subject + reason + 两个计数），整包进日志不泄露用户说过什么；
`ChangeObservation` 同样只有 id、计数、时刻、主题词。界面上「之前/之后」那两句原文走路由的旁表 `sources`，
只装被引到的行——用例 `旁表只装被引到的两行，别人的行和没被引到的行都不回` 和
`观察结构里没有密文，也没有演化理由` 钉的就是这条。

### 九、变异探针：21 条，杀 20 条，1 条活着

全部用一次性脚本 `scripts/mutation-probe-*.mjs`（跑完即删，`git status` 已复核无残留），每条逐字替换、当场逐字回滚，**没有用 `git checkout`/`git stash`**。

| 探针 | 结果 | 杀掉它的用例 |
|---|---|---|
| h-P3 完成说法不看新那一版 | KILLED 红 1 | `新那一版里出现完成说法就是 COMPLETED` |
| h-P4 兴趣允许 `fact` 行代表 | KILLED 红 1 | `兴趣只由「偏好＋目标」两类行代表` |
| h-P5 撤回边不再产出 WITHDRAWN | KILLED 红 1 | `RETRACTED 那条边是 WITHDRAWN` |
| h-P6 ⑥ 取消静默期 | KILLED 红 3 | STILL_OPEN 两条 + 排序那条 |
| h-P7 EMERGED 去掉时间窗 | KILLED 红 1 | `很久以前就在说的主题不算新出现` |
| h-P8 SHIFTED 的两个簇各自再报 EMERGED | KILLED 红 1 | `一个主题进了 SHIFTED 就不再重复报 EMERGED` |
| h-P9 ⑥ 起点摊成完整时刻 | KILLED 红 1 | `validFrom 带着精度时起点跟着那个精度走` |
| h-P10 ⑤ 的跨度门槛写成 0 | KILLED 红 1 | `同一批行在 ⑤ 那边是证据不足，在 ① 这边照样成立` |
| h-P11 ⑤ 把被取代的旧说法算进当前样本 | KILLED 红 1 | `被取代的旧说法进「变化前」那一侧` |
| h-R1 路由不看 `memoryEnabled` | KILLED 红 1 | `memoryEnabled 关着时 409` |
| h-R2 路由不看 `timelineEnabled` | KILLED 红 1 | `timelineEnabled 关着时 MODULE_DISABLED，一次查询都不发` |
| h-R3 时钟可由客户端传 | KILLED 红 7 | 冻结时钟那条 + 依赖「服务端现在」的 6 条 |
| h-R4 旁表把整批正文都发出去 | KILLED 红 1 | `旁表只装被引到的两行` |
| h-R5 偏好读不出来时当开着 | KILLED 红 1 | `开关读不出来时按关闭处理` |
| h-R6 身份改从查询串取 | KILLED 红 8 | 归属只来自 session + 全部读侧断言 |
| h-C1 上限那句在界面里抄一份 | KILLED 红 1 | `读到上限时那一行来自 describeChangesCap` |
| h-C2 区块自己抄一句主题×信号 | KILLED 红 2 | 函数出处 + 字面量不许出现 |
| h-C3 区块不挂在时间线闸门那一支 | KILLED 红 1 | `区块挂在 enabled === true 那一支里` |
| h-C4 更正后不顶 `revision` | KILLED 红 1 | `两个写动作成功后都把 revision 顶上去` |
| **h-C5 没命中旁表的出处也渲染一行** | **SURVIVED 红 0** | **没人杀——见下面边界第一条** |
| h-D1 没到上限也念截断 | KILLED 红 2 | `describeChangesCap(false)` 必须是空串 + 红线那组 |
| h-D2 第六种证据不足理由混进句式表 | KILLED 红 2 | `Object.keys(...)` 恰为 5 + 红线那组 |

**探针跑批本身也错过一次，记下来**：第一版 runner 用 `execFileSync('npx', …)`，在 Windows 上 `spawnSync npx ENOENT`，
我的 catch 把「一条都没跑成」印成了「KILLED 红 0 条」——18 条全绿是假的。
换 `execSync` + 剥 ANSI 之后才拿到上面这张表，另加一次 `from` 串在源码里出现 0 次时**报 SKIPPED 而不是当它过了**。

### 这一片的边界（含无法验收项）

- **「变化」区块一次都没真渲染过**。本会话没有 jsdom，今天也没起服务，16 条全是读源码的静态断言。
  探针 h-C5 活着就是这条边界的物证：`data.sources[id] ? (…) : null` 那一处「没命中就整行不渲染」的行为
  **今天只有代码在守，没有测试在守**——把它改坏，静态断言一条都不会红。
  要补的是渲染层测试（jsdom 或起服务真点一次），不是再往静态断言里加一条正则。
- **真库上六类观察一条也产不出**：`MemoryItem` 两行、`MemoryRevision` 零行（11-05 实测，见「真库实况」），
  全部够不上 `PATTERN_MIN_*` 与 `CHAIN_MIN_CHATS`。所以这一屏真库上的产出形状仍是**无法验收**，
  而且这不是补种数据能补的——补出来的行是我编的，不是他的经历。
- ①⑤⑥ 的中文簇能力受 `tokenize` 那套二元组的上限约束（第五节那条「共享两词就黏住」是同一个上限的另一面）。
  ②③④ 的召回上限等于写侧相似度的召回上限，第一节已经写明。
- **红线「不许预测未来、不许生成确定性人格结论」这次有机器检查**：`change-display.test.ts` 那组 FORBIDDEN 词面断言
  覆盖句式表的每一个字，以及主题×信号的全部 48 个组合。词表是我列的（人格/性格/注定/一定/必然/未来/预测/本质/天生/说明你是），
  它只能证明「这一屏说不出这些词」，不能证明句子永远无害。
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run tests/unit` **94 文件 / 1504 用例**全绿。
  94 − 90 = 本片 4 个新文件；1504 − 1427 = 77 = 39 + 10 + 12 + 16。
- **未做任何改动到他库上的事**：这一片是读侧派生，没跑迁移、没写任何行、没动他的八个开关。

## 片 i：任务书 4.1 的 `EventExtractor` 落地（11-05）

片 h 之后，Phase 1–8 里唯一还挂着**真 0%** 的就是 4.1。今天补完。
**零新表、零迁移、零模型调用、零新开关、零新增一次数据库查询**，五件新产物 + 两处改动：

| 产物 | 角色 | 用例 |
|---|---|---|
| [src/lib/cognitive/event-extractor.ts](../src/lib/cognitive/event-extractor.ts) | 给已经在时间线上的事件**起名**：判它属于 4.1 那 12 类里的哪一类，一类到底 | 23 |
| [src/lib/cognitive/event-display.ts](../src/lib/cognitive/event-display.ts) | 12 类的中文名 + 这一屏筛得起的 9 类 + 少掉那 3 类的那句话 | 6 |
| [src/app/api/account/cognitive/timeline/route.ts](../src/app/api/account/cognitive/timeline/route.ts) | 在同一次读上多接一列 `kind` | 15（其中新增 4） |
| [src/components/settings/timeline-panel.tsx](../src/components/settings/timeline-panel.tsx) | 筛选 chips 从「记忆类型」换成「事件类别」 | 15（静态断言） |
| 合计 | | **48 条新用例**（94 文件/1504 → **97 文件/1552**） |

### 一、它的形状是「给已有的事件起名」，不是「第二个事件生成器」

时间线上的一条事件已经是 `deriveTimelineEvents` 算出来的了（一行记忆、或一条版本链的头）。
如果 4.1 再做成一个从记忆行生产事件的组件，同一屏上就会并排站着**两条流水账**：
一条按记忆行排，一条按抽出来的事件排，它们对同一个昨天的说法可以给出不同答案。
那种矛盾不是 bug，是用户同一天看到两个世界——所以这一层只加一列 `kind`，
`CognitiveEvent extends TimelineEvent`，除这一列以外一个字段都不动、顺序也不动
（用例 `除 kind 以外逐字段等，顺序和条数都不动` 钉的就是这个）。

11-04 判 4.1 时写的是「事件抽取必然引入模型推断，要动就得先出 spec」。**这个前提和 4.3 那条一样被打掉了**：
12 类里能落地的那些，判据全是库里已有的列——版本号的链、演化边、以及 4.3 已经算好的簇观察。

### 二、三条判据的来源全部是已经审过的东西，这一层一个新判据都不立

- **「完成」用 6.1 / 4.3 同一张 `COMPLETION_MARKERS`**，而且和 4.3 的 `chainSignal` 一样**只在版本链上算**：
  第一版目标里带一句「我完成了…」不是一次到达，那只是第一次提到。没有另立第二张完成说法表。
- **「兴趣出现 / 转移」直接继承 4.3 的观察**，不在这里重做主题相似度——4-T3 量过，词法相似度在中文语料上 **0/36**。
  只读 `subject === 'INTEREST'` 的观察，而且**只站在新那一侧**（`afterMemoryIds`）：旧那一簇有它自己的事件，
  跟着变成「兴趣转移」就把两件事算成了三件。
- **「是不是新版本」看 `version`，不看 `historyCount`**。后者会被 `MEMORY_LIST_MAX_ROWS = 200` 吃掉
  （4-T1 第三条那个洞），而 `version` 是写侧改口时递增出来的，跟这一批读回什么无关。
  探针 i-A 动这一条，红了 6 条。

优先级也写死了：版本链上的说法比簇算出来的「兴趣」更具体，所以目标 / 项目 / 改过口的偏好先走完，
剩下没有更强说法的行才轮到兴趣两类，最后落进「一段经历」。

### 三、12 类里这一屏只生成 9 类，那 3 类不是没做，是没有出处

`UNEMITTED_EVENT_KINDS` 把这件事写成**数据**而不是注释，界面那句说明读的就是它，不是我另编的一句话：

- **`DECISION_MADE`** 的出处在 Phase 5 的 `DecisionRecord`——那边才有「待确认的候选连决策都还不算」那个确认状态。
  记忆行里的 `decision` 类型只表示「系统记得你说过这句话」，拿它冒充一次决策事件就是替用户把话说重。
  有用例专门守着这条：`决策类型那一条不冒充 DECISION_MADE：这一层没有确认状态可依`。
- **`MILESTONE`** 归 6.1，而 6.1 的里程碑恰好由「目标完成」和「决策落定」两件事构成——在这一层再发一份
  就是同一个事实的**第三种**说法。
- **`CHALLENGE`** 在库里没有任何一列记过它。

**这就是 4-T1 第一条判词被取代的地方**：那片写「`GOAL_COMPLETED`、`INTEREST_EMERGED` 在现有列上没有来源，
所以一条也不生成」，今天这两类找到了来源（版本链 + 4.3 簇），于是那一半判词作废；
`MILESTONE`、`CHALLENGE` 仍然没有来源，那条红线原样保留。
同一片的「类别筛选用的是记忆自己的六个 `type`」也按任务书 4.4（要「按事件类别筛选」）改成了 12 类词汇——
4.4 这句话在 4.1 落地之前没有出处，落地之后才有。

### 四、界面：chips 只列这一批里真出现过的类别

筛选状态从 `MemoryType | 'all'` 换成 `EventKind | 'all'`，chips 由
`FILTERABLE_EVENT_KINDS.filter((kind) => events.some(…))` 驱动。
理由和「不摆没人消费的控件」是同一条：12 类里 3 类不生成，把它们硬摆出来，用户点三个都得到一句「还没有」，
就会以为系统里有那些事件、只是这一批没筛出来。少掉的那 3 类另有一句常驻说明（`UNEMITTED_EVENT_KIND_NOTE`）。
记忆类型没被删掉，它从筛选项退回成每条事件上的一个数据标签——那才是它真正的身份：派生的输入，不是给用户点的按钮。

顺带删掉了 `这个类别还没有事件。` 那一支：筛中的类别由 `presentKinds` 保证在这一批里至少有一条，
退回逻辑（`activeFilter`）又保证选中的类别不会在批次变化后失效，**那一支已经不可达**。
留着它就是一句永远显示不出来的话。

### 五、探针：7 条，其中一条第一次活着——原因记在这里

全部逐字替换、当场逐字回滚，**没有用 `git checkout` / `git stash`**；`git status` 与全文 grep 复核过无残留。

| 探针 | 结果 | 杀掉它的用例 |
|---|---|---|
| i-A `version > 1` 换成 `historyCount > 0` | KILLED 红 6 | `改过一版的目标是一次「目标改了说法」`、`新版本里出现完成说法…`、`第一版项目是「新项目」，新版本是「项目更新」`、`改过一版的偏好…`、簇里那条偏好、`造得出 9 类…` |
| i-B 完成说法不再要求是新那一版 | KILLED 红 6 | `第一版目标是一次「定下目标」`、`第一版带完成说法不算到达`、`折叠不到的旧版本行仍然算它那次的「定下目标」`、簇里那条第一版目标、9 类齐全那条、路由 30 天窗口那条 |
| i-C 删掉 `subject !== 'INTEREST'` 那道过滤 | **第一次 SURVIVED 红 0** → 补测试后 KILLED 红 1 | 见下面那段 |
| i-D SHIFTED 标在旧那一侧（读 `beforeMemoryIds`） | KILLED 红 3 | `兴趣转移的另一侧不跟着变` + 9 类齐全那条 |
| i-E 路由不传观察（`observations` 恒空） | KILLED 红 1 | 30 天窗口那组（`INTEREST_EMERGED` 变回 `EXPERIENCE`） |
| i-F 路由不调 `annotateEventKinds` | KILLED 红 4 | 逐字段形状那条（多不出 `kind` 列）+ 三条类别用例 |
| i-G 界面删掉「筛中的类别不在这一批就退回全部」 | KILLED 红 1 | `这一批里不再有刚选的那个类别时退回全部` |

**i-C 是这一片唯一一次被自己的测试骗到**。原来那条用例写的是
`{ subject: 'REPETITION', change: 'RECURRING' }`——它把 `subject` 和 `change` 一起换掉了，
于是它真正守的是「`change` 不是 EMERGED/SHIFTED 就不进集合」这一半，而不是它自称守的「主题不是兴趣就不进集合」。
把主题过滤删掉，它照过。**已把它拆成两条**：`别的主题就算带着 EMERGED / SHIFTED 也不影响分类`（只翻 `subject`）和
`INTEREST 主题里的 RECURRING 不冒充「新提起的事」`（只翻 `change`）。
**这条过滤今天仍是合同而不是活路**：`grep -n "subject:" change-detector.ts` 数过，EMERGED / SHIFTED 目前只可能
和 `INTEREST` 一起出现，所以删掉过滤在今天的产出上没有任何区别——它守的是「这一层只继承 4.3 的兴趣判断」这句话本身。
这一点写进 `annotateEventKinds` 的注释里，别让它看起来像一条被验证过的防线。

### 这一片的边界（含无法验收项）

- **`kind` 会随着「今天」变**。界面按 `validFrom` 排，那一列是历史事实；但「新提起的事」有自己的 30 天窗口，
  窗口原点是服务端读的那一刻。同一批行在 11-05 和 2027-06-01 两次读里，同一个事件会从
  `INTEREST_EMERGED` 变成 `EXPERIENCE`（路由那条用例两头都钉住了）。**界面对这件事一个字都没说**——
  这是这一片新增的、唯一会撒谎的地方，和 4-T1 那条「发生时间未知」同级，但没有对应的红旗。
  要补就得先定一句话：类别到底是「当时判的」还是「现在判的」。
- **顶到 200 行上限时，被吃掉的类别连带 chips 一起消失**。这和 4-T1 第三条是同一个原因，
  只是这一片让它多了一个可见后果：chips 那一排会变短。`capped` 那句提示说的是「更早的没有读进来」，没说类别少了几样。
- **真库上这一屏仍是无法验收**。`MemoryItem` 两行、`MemoryRevision` 零行、两行 `validPrecision` 都是 `UNKNOWN`
  （11-05 实测，见「真库实况」）。这两行今天最多落 `EXPERIENCE` 或 `GOAL_CREATED` 两类，
  也就是说 12 类词汇在他真库上的覆盖是 **1–2 类**，chips 大概率只有「全部 + 一段经历」。
  我也**没有在他的服务上点开过这一屏**，所以 chips 排布、类别标签的长度撑不撑得破那一行、
  加上类别之后 chips 与说明会不会把这一屏挤得太长——全部**无法验收**。
- **求值层**：路由那 4 条新用例跑在 `tests/unit/prisma-mock.ts` 的谓词求值器上，不是 SQL。
  探针 i-E / i-F 杀的是接线，杀不掉「真库里这两列读得对不对」。
- **界面**：项目没有组件测试、没有 jsdom，15 条全是读源码的静态断言。它只能证明
  「界面里没有第二份词汇表、没多一个开关、类别名取自那张表」，不能证明渲染出来读得通。
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run` **97 文件 / 1552 用例**全绿。
  97 − 94 = 3 个新测试文件；1552 − 1504 = 48 = 23 + 6 + 15 + 4。
- **未做任何改动到他库上的事**：读侧派生，没跑迁移、没写任何行、没动他的八个开关、没起服务。

## 片 j：情境策略的最后一列有了运行时读者——`allowAssociation` 变成画布上的硬闸门（11-06）

到 11-05 为止，任务书 1.2 那张七行情境策略表里只剩一列**没有任何运行时代码读它**：`allowAssociation`。
它有存储（`policy.ts:55`）、有校验（`validation.ts:158`）、有 PATCH 通路（`policy.ts:214`），写入计划里还带着它
（`write-decision.ts:143`）——唯独没有读者。也就是说用户在那一屏能说出一句系统不听的话：
「这类东西不要拿去联想」。这一片先让这句话有反应，再谈要不要给它一个控件，顺序按仓库自己的立场走
（`memory-policy-panel.tsx:23-31`：不做没人消费的控件）。

### 一、为什么这一片不是「补上 LINK 和 DELETE 两个动作」

计划里 Phase 2 写的是六种操作（ADD/UPDATE/LINK/DELETE/SEARCH/FILTER），代码只有四个动作。逐条查过之后，那两个洞不是待建：

| 表面上缺的 | 今天的事实 |
|---|---|
| LINK（建立关联） | 2a 那次阈值校准判的是**不建关系表**，实测数据钉在 `tests/unit/cognitive-memory-graph.test.ts` 的静态用例里；`memory-graph.ts:10-15` 与 `reconsolidation.ts:15` 都写明了「没有可写的关系表，派生图是只读的」。一个不存在的表没有「写入它」这个动作 |
| DELETE（遗忘） | 已经上线，而且不 in 写入决策层：纠正 / 归档（7.2）/ 永久删除（含按主题、按来源会话）各自有入口、路由和服务（`forgetting.ts`）。它是用户点出来的，不该由词法猜 |

剩下真正没人读的只有那一列。所以这一片做的是**权限落地**，不是补动作。

### 二、闸门挡的是线，不是点——三条判据都是抄来的，一条都不新立

| 判据 | 抄自 |
|---|---|
| 关掉那种情境的行**不进关联池**（既不做锚点也不做成员），`sameChat` 与 `coCitation` 两种推导都从池子里取 | `profile-candidates.ts:62`（`policies[context]?.allowUserProfile === true`）——同一张表、同一列的另一种下游许可 |
| 读不到某个情境的策略行时**按关着处理**（`=== true` 而不是 `!== false`） | 同上：`?.` + `=== true` 的组合天然 fail-closed |
| 演化边（`update`）**不受这一列影响** | `MemoryRevision` 是库里记着的事实，不是系统的联想；把「谁被谁改成」按一个联想开关抹掉，等于替用户忘记他没说忘的东西 |

第四条是这一片自己踩过的坑，也记在这里：**过滤必须放在分组之前，不能补一道端点检查**。
如果先按 `chatId` 分组、再检查两端是否在池子里，锚点是「这场对话里最早的一条」——它一关关联，
整场对话的星形就整体塌了，用户关掉一条记忆，别人之间的线跟着消失。用例
「关掉关联的那条不做星形的锚点：剩下两条照常连，锚点换成池里最早的那条」（`cognitive-memory-graph.test.ts`）钉的就是这个。

点也不挡：被关掉的行照旧在 `nodes` 里、照旧能点开。一句「这些记忆已隐藏」会把一个策略读成一次删除，
那是这一屏最不该说的话——`describeAssociationGate`（`memory-graph-display.ts:93-99`）因此只报条数，
并且当场说清挡的只有关联线。

### 三、这批读一个字节的库都没写

`GET /api/account/cognitive/graph` 现在是四批读：记忆行、演化边、共引用边、七行政策表。
前三批这一屏早就在读，第四批（`getMemoryPolicies`）是**别的三屏已经在读的那张表**（写入决策、画像、洞察各读一遍），
这一片只是让它多一个读者。零迁移、零新表、零模型调用、零新环境变量。

策略表那一读**故意不兜底**：读失败就让路由抛（`api()` 落成 500 `INTERNAL_ERROR`）。
兜一张「全都允许」的默认表等于在用户没表达过的地方替他表达，正好把这道闸门反过来打开。
用例「策略表读不出来时报错，不许当成「全都允许」把用户挡掉的线画出来」（`cognitive-memory-graph-route.test.ts`）钉这条。

### 四、界面上两句说的是同一个数字，所以必须互斥

`associationGated` 是派生层算好透出的（`memory-graph.ts:146`，数的是**画布上的点**，被预算截掉那批本来就不在图上）。
画得出来时由 `describeAssociationGate` 单独说一句（`memory-graph-panel.tsx:137`、`:170`）；
画不出来时那个数字由 `describeNotAGraph` 的第三参数说进「还不是一张图」那一句里（`:280`）。
两句同时冒出来就是重复；而 `describeNotAGraph` 如果不管闸门一律念「没有更新边，也没有共来源会话」，
它就当场说谎——那时线是被挡的，不是不存在的。`memory-graph-display.ts:73-89` 因此分了三条零线的说法。

### 五、先红与变异探针

先红顺序（每步都实测过红再实现，红的理由都是「功能不存在」而不是打字错）：
派生层 6 条 → 措辞 4 条 → 路由 5 条 → 界面 2 条 → 策略面板 1 条（+ 删掉 1 条旧用例，它钉的是
「关联一列没有消费者所以不许给控件」，前提今天反了）。**净新增 23 条**（新写 24、删 1）。

七条探针，各自杀各自那条，全部当场逐字回滚（这个仓库不用 `git checkout` / `git stash` 做回滚）：

| 探针 | 改哪里 | 杀它的用例 |
|---|---|---|
| j-A | 关着的行仍进关联池（`=== true` 读成 `!== false`） | 「策略表里少一个情境时按关着处理…」（1 红） |
| j-B | 端点补检查而不是池子过滤 | 「关掉关联的那条不做星形的锚点…」、上面那条（2 红） |
| j-C | 演化边也过闸门（`present` 读成 `associated`） | 「演化边不受这一列影响…」（1 红） |
| j-D | `associationGated` 报成池内点数 | 派生 2 条 + 路由 2 条（4 红） |
| j-E | `describeNotAGraph` 的闸门分支变成死支（`> 0` 读成 `< 0`） | 「零线但有闸门时不许说「没有共来源会话」…」（1 红） |
| j-F | 路由把策略表读失败兜成默认表 | 「策略表读不出来时报错…」（1 红） |
| j-G | 闸门句不再看 `drawable` | 「闸门提示来自 describeAssociationGate，且只在画得出图时说」（1 红） |

第八条不是探针，是**当场抓到的真 bug**：策略面板的脏检查 `isSameDraft` 漏了 `allowAssociation`，
后果是「复选框在、单独拨它永远显示没有改动、保存按钮死着」。先按真 bug 的顺序处理——
把那一行删掉、写用例、看它红（红的是 `expected '…' to contain 'allowAssociation'`，逐字留着），再把那一行补回去转绿。
用例「草稿里的每个字段都参与脏检查：漏一个就存不了那一个改动」从源码里读字段表，不在测试里抄一份，所以以后加列漏检查同样会红。

### 六、过期口径修正（一片代码顺带把话说不圆的地方找回来）

| 位置 | 原来写的 | 为什么错 |
|---|---|---|
| `write-decision.ts:19-21` | LINK 「要的是 Phase 2 片C/片D 的图」 | 那张图今天不建表，2a 已经判过；照旧写「待建」会让人去建 `MemoryRelation` |
| `memory-module.ts:41-43` | DELETE 「要的是用户点下那个按钮（Phase 6 界面）」 | 三种忘记（含 7.2 归档、7.3 按主题）早已上线，这一句把已交付的东西写成待办 |
| `docs/cognitive-acceptance.md:905-907`（6-F 那节）与本文开头 | 「画像与关联两列至今没有任何运行时读取方，所以不给控件」 | 画像列片 d 起有读者、关联列本片有读者；两处都按日期改写成「那天如此，后来各自补上」 |

这一片动代码时顺手把**文档自己**也扫了一遍，又找出五处「写的那天对、今天不对」的话。它们都不是笔误，
是后面的片子改了前面片子的结论，而没有人回头改前文——正是这份文档承诺要当事实基线的那件事：

| 位置 | 原来写的 | 今天的事实 |
|---|---|---|
| 本文头三行 | 「缺的是真库那一层与界面只渲染到初次挂载那一层」 | 片 g 之后「初次挂载」那一半已经不准：真渲染 + 点击走通四条路径，缺口换成像素未量 + 洞察/决策两屏没对象可点 |
| 门槛 4 状态行 | 「但行看不到、点不动」 | 「点不动」被片 g 解开；这一屏剩下的缺口是 `ReflectionRecord` 0 行，起服务走那一屏的动作仍未做过 |
| 门槛 5 状态行 | 「机制已验收，『洞察』无对象」 | 和它自己下面那段边界自相矛盾（那段早就写了 6-E/6-F 落地）；改成「有对象，缺真库那行与目测」 |
| 门槛 7 状态行 + 边界 | 「画像模块仍不存在，正面陈述无从验收」「`allowUserProfile` 全仓无读取方」 | 片 d 建了表、服务、界面与三道闸；正面一半现在有三条独立用例（候选不落库 / 状态过滤在库里 / `confirmedAt` 那个旋钮根本不存在），已把那三条逐条指到位 |
| 门槛 9 状态行 + 第 2 点 | 「`userModel` / `emotion` / `association` 三个键仍无人读取」「只有 `memory` 真有已注册模块」 | 今天只剩 `emotionEnabled` 无人读取；`registerCognitiveModule` 有三个生产调用方（`memory-module.ts:352-354`）。同时给上表补了四行真存在的闸门用例（画像路由、画像读侧、图路由两道），并把漂走的 `:242` / `manager.ts:48` 两处行号换成 `:299` / `:60` |
| 「下一步」第 4/5/6 条 | 「画像模块仍然不存在」「4.1 事件抽取今天不存在，12 类有 4 类生成不了」 | 分别被片 d 与片 i 取代：4.1 落地为「给已有事件起名」，12 类里 9 类有出处、3 类是**没有出处**而不是没做 |

同一片还改了：文档头的「基线 HEAD」与全量单测数字（`de70c83` + 81/1225 → `67127fb` + 97/1575），
策略面板文件头的「只剩关联一项没有消费者」与「七种情境各自六个控件」（现在是七个），
以及 `reflection-sweep.ts:452` 那条行号引用（今天读的是 `:454`）。

### 这一片的边界（含无法验收项）

- **界面这一半仍是无法验收**。项目没有组件测试、没有 jsdom，`memory-graph-panel.test.ts` 那 18 条和
  `cognitive-reflection-panel.test.ts` 那 20 条全是 `readFileSync` + `stripComments` 的静态断言：
  能证明「句子只有一个来源」「闸门句只看 `drawable`」「三个许可都有控件且都进脏检查」，
  不能证明真渲染出来读得通、点得动。**闸门打开后画布上到底少几根线、那句提示会不会和预算提示挤在一起**，
  需要他在服务上点开一次；11-05 那把真渲染的锁仍然要求他自己起服务。
- **真库上这条闸门今天是空转**：`MemoryItem` 两行、`MemoryRevision` 零行（11-05 实测，见「真库实况」），
  而那两行的情境都是 `GENERAL`——`GENERAL.allowAssociation` 默认是**开**的。
  也就是说他今天拨不动一个「真能挡住线」的例子，除非先把某个情境关掉或先攒出跨情境的记忆。
- **求值层**：路由那 5 条新用例跑在 `tests/unit/prisma-mock.ts` 的谓词求值器上，不是 SQL；
  `getMemoryPolicies` 在测试里是被 mock 的那一层，真库里那七行读不出来的形状（少行、字段漂移）没测过。
- **闸门只管派生图这一条路**。`allowAssociation` 今天仍然**不**管检索召回、不管洞察的共引用聚合本身
  （只管图上画不画那根线）。这不是漏，是范围：那一列在任务书里说的是「联想」，不是「引用」。
  如果他期望的是「关掉之后这条记忆不参与任何跨条推理」，那是另一个口径，需要他判。
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run` **97 文件 / 1575 用例**全绿
  （1575 − 1552 = 23，与上面「净新增 23 条」对得上；文件数不变，本片没建新测试文件）。
- **未做任何改动到他库上的事**：没跑迁移、没写任何行、没动他的八个开关和七行策略表、没起服务、没发模型请求。

## 片 k：第八个开关有了控件，而一屏用户看得见的假话先被用例钉住（11-06）

**零迁移、零新表、零模型调用、零新增环境变量。**净新增 11 条用例（面板 10 + 路由 1），新建一个测试文件。

### 一、这片不是从「加功能」开始的，是从「界面在撒谎」开始的

`memory-policy-panel.tsx` 尾段那一句（片 j 时代的 `:450-455`）写的是：
「策略表里的『关联』一列**至今没有运行时代码读它**，接口能保存但界面上不给控件」。
片 j 既给了它读者（`memory-graph.ts:97` 的关联池）又给了它控件（`memory-policy-panel.tsx:390`），
所以这句话在今天是他看得见的一段正文，不是注释——**注释可以只靠人记得改，正文必须有用例盯着**。
本片第一个动作因此是 `tests/unit/cognitive-policy-panel.test.ts` 头两组用例：一句过期话不许留下，
而且留下的位置必须换成今天的事实（三列各挡住什么，逐列说全）。

### 二、给控件之前先确认它真有读者——四条读者证据

`adaptiveMemoryEnabled` 是全仓最后一个「有代码读、没界面改」的开关，它的读者今天有四处，
每一条都对应界面上那句提示的一个分句，不是修辞：

| 读者 | 位置 | 关掉之后真的停掉的事 |
|---|---|---|
| 学习层闸门 | `policy-learner.ts:87`（读不出来当关） | 下面四处全部不走 |
| 三条永久删除链路的「记证据」 | `forgetting.ts:210`/`:243`、`:250`/`:279`、`:308`/`:326` | 同一个事务里不再写 `MemoryPolicySignal` |
| 拒绝一条待确认候选的「记证据」 | `memory-candidates.ts:296`（闸门读在 `:290`） | 同上：那句「不要记」不再攒成一次收紧 |
| 删除后的收紧 | `policy-learner.ts:129`（`learnAfterSignals` 早退 `[]`） | 不再有任何情境被改成「先问再记」 |
| 学习只做一件事 | `policy.ts:292`/`:295`（只置 `requireConfirmation: true` + `learnedAt`） | 关掉它不会让任何已放松的列变回去——**它本来就只往保守走** |

另外两件事是界面上那两句「不归学习层管」和「恢复默认会连证据一起清」的出处：
`manualOverrideAt` 只由用户亲手 PATCH 时写（`policy.ts:264-272`），学习层自己那次改动**明确不写这个标记**
（`policy.ts:281` 的注释就是这条立场）；`resetMemoryPolicy` 同时删策略行和它的证据行（`policy.ts:303-304`）。
**算证据的只有「永久删除」和「拒绝候选」两件事**这一句同样是抄代码不是抄口号：`purgeAllMemories`（`forgetting.ts:342`）里
一次 `recordPolicySignal` 都没有，撤回与编辑走的更不是这条链路，确认候选更不是——那是用户说「要记」。

### 三、加控件不加请求：两个全局值同一次 GET 带回

`loadEmotion()` 改名 `loadPreferences()`（`:212`），一次 `apiFetch` 同时取 `emotionTransparency` 和
`adaptiveMemoryEnabled`；写侧仍各 PATCH 各的键（`saveEmotion` / `saveLearning`，后者在 `:245`）。
这一屏本来就为了情绪标注发一次偏好读，再发第二次就是拿用户的网络往返换我自己的省事。

读失败时那个复选框是**死着的**（`disabled={learning === null || learningBusy}`，`:460`）并且跟一句
「这里不替你猜，因为它决定的是系统能不能自己改你的策略」。库里这一列默认 `false`，
但界面不拿默认值当实测值——它显示的状态必须是被读到的状态。

### 四、数字不许写死在文案里，而且「插值」本身也要被钉

策略接口此前只回 `learningThreshold`，本片补 `learningWindowDays`（`policies/route.ts:35-36`，
两个值都取自 `policy-learner.ts:36-37` 那对常量）。界面那句是
`{windowDays} 天内同一个情境攒到 {threshold} 次`（`:476-477`），整屏没有任何一处写着「3 次」或「30 天」。

第 10 条用例（「接口的两个常量真的被读进状态」）是探针 k-E 逼出来的：前 9 条只钉 JSX 里有没有插值，
**放过了一种真实的假话——loader 里写 `setWindowDays(30)`**，界面照样是 `{windowDays}`，
但服务端改了常量它不跟着改。这条用例逐字要求 `setWindowDays(data.learningWindowDays)`。

### 五、先红与变异探针

先红：`cognitive-policy-panel.test.ts` 9 条 + 路由 1 条，实测全红，红的理由都是功能不存在——
`expected undefined to be 30`（路由还没回窗口天数）、`expected '' not to be ''`（还没有 `loadPreferences`）、
`to contain 'preferences.adaptiveMemoryEnabled'`。第 10 条在实现之后补，但**当场用 k-E 证明它杀得动人**。

六道探针，各自杀各自那条，全部当场逐字回滚（这个仓库不用 `git checkout` / `git stash` 做回滚）：

| 探针 | 改哪里 | 杀它的用例 |
|---|---|---|
| k-A | 提示句写死「30 天内…3 次」 | 「阈值和窗口天数都跟着接口走」（1 红） |
| k-B | 去掉 `learning === null` 那道 `disabled` | 「开关状态没读到时代面不许猜，也不许点」（1 红） |
| k-C | loader 里为情绪再发一次 GET | 「读它不额外发一次请求」（1 红，`expected 2 to be 1`） |
| k-D | 尾段那句过期话放回 | 「尾段那句『关联一列至今没有运行时代码读它』必须消失」（1 红） |
| k-E | `setWindowDays(30)` | 「接口的两个常量真的被读进状态」（1 红） |
| k-F | PATCH 写成 `{ emotionEnabled: next }` | 「有控件…写的也只那一个键」+ 两处「不摆没人读的旋钮」（3 红） |

### 六、这一屏的文案逐字表（他 11-04 起授权「你说的文案都通过了」，这里留一份可核对的底）

| 位置 | 逐字 |
|---|---|
| 卡标题 `:449` | 自动收紧 |
| 卡说明 `:451` | 这一档管的是「系统能不能替你改策略」，和上面七张卡管「记不记、留多久」是两件事。 |
| 复选框 `:463` | 允许系统从你的删除和拒绝里学习 |
| 提示 `:466` | 关掉后，永久删除和拒绝候选不再攒学习证据；已经收紧过的情境保持现状，删除本身的派生清理一条都不少。 |
| 读不到时 `:470` | 开关状态没读到。这里不替你猜，因为它决定的是系统能不能自己改你的策略。 |
| 效果一 `:474` | 只有永久删除和拒绝候选算证据：撤回、编辑记忆、清空全部长期记忆、确认候选都不算。 |
| 效果二 `:476-477` | `{windowDays} 天内同一个情境攒到 {threshold} 次，才把那个情境改成「先问再记」；学习只会更保守，不会放松任何一列。 |
| 效果三 `:480` | 你手动改过的情境归你管，学习层不再碰它；点「恢复默认」会把这一行重新交给学习层，攒下的证据也一起清掉。 |
| 尾段 `:529-531` | 还没做的部分：偏好表里的情绪总开关至今没有运行时消费者，所以这一屏不给它控件，能用的情绪控件只有上面那三档标注。已经有读者的三列各挡住一件事：某个情境不放开反思，那个情境里的记忆就不出现在洞察里；不放开画像，它就不出现在画像候选里；不放开联想，它就不和别的记忆连关联线。 |

「派生清理一条都不少」那句是刻意写的：关掉这一档**不**减少删除该做的事（`forgetting.ts` 里
排除规则、演化边摘除、向量列清理与学习证据无关），只减少「系统下次替你改策略」的可能。

### 这一片的边界（含无法验收项）

- **界面这一半仍是无法验收**。10 条全是 `readFileSync` + `stripComments` 的静态断言：
  能证明「那句话没写过期的话」「控件读写的就是那一个键」「数字来自接口而不是文案」，
  不能证明这张卡真渲染出来读得通、点得动。**这一屏在情境卡列表和「情绪标注」之间又插了 43 行 JSX**
  （`memory-policy-panel.tsx:448-490`），七张情境卡 + 自动收紧 + 情绪标注同屏会不会太长、
  卡与卡之间的层级会不会看不出来——没量过，要他在服务上点开一次。11-05 片 g 那把真渲染的锁仍然要求他自己起服务。
- **真库上这条链路今天没有走过一次**（11-06 片 k 只读计数，见「真库实况」）：`MemoryPolicySignal` **0 行**、
  `MemoryPolicy` **0 行**、`MemoryItem` 2 行、`MemoryRevision` 0 行。两个后果分开说清：
  ① 「{windowDays} 天内攒到 {threshold} 次」这条规则在他的库里一次都没成立过，他今天能验收的只有
  「拨了开关之后仍然什么都不攒」；② 那七张情境卡现在显示的是**代码里的默认表**，不是库里的行——
  他第一次点「保存」才是这张表有第一行的那一下，而片 j 那句「关掉某个情境就挡住那根线」
  也要到那时才真的作用在他自己的行上。
- **`learningWindowDays` 这个新键只到路由那一层**：路由用例跑在 `tests/unit/prisma-mock.ts` 的内存替身上，
  真 HTTP + 真库那次 GET 的形状没测过；`adaptiveMemoryEnabled` 的 PATCH 走的是既有偏好路由，本片没改它。
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run tests/unit` **98 文件 / 1586 用例**全绿
  （1586 − 1575 = 11，与「净新增 11 条」对得上；文件数 +1，本片新建 `cognitive-policy-panel.test.ts`）。
- **未做任何改动到他库上的事**：没跑迁移、没写任何行、没动他八个开关的值、没动那七行策略表、没起服务、没发模型请求。




## 片L：记忆管理这一屏不查开关——把一条「看起来像漏掉的闸门」写成裁决（11-06）

### 一、为什么这一片有代码以外的活

「完全做完」的清单摊开以后，第一条要判的不是缺口而是疑点：`/api/account/cognitive/memories` 那七条路
（列表、单条、证据、改口、撤回、归档 / 恢复、三种永久删除）**一个开关都不读**，而任务书 1.1 写的是
「所有模块开关必须在服务端执行，不能只依赖前端状态」。单看这一行，它像 片 3 那次补闸门的漏网之鱼——
`changes` / `graph` / `timeline` / `reflections/[id]` / `profile-reads` 五处都查了 `memoryEnabled`，这里没查。

判词是**不是漏，是刻意**，三条理由：

1. 那五处是**派生视图**：它们把记忆原文二次呈现，属于「模块在运行」；这一屏没有模块在跑，
   只有用户在自己账号里看和删已经存下的行。
2. 补上闸门会把「关掉长期记忆」变成「看不见也删不掉已有记忆」。这正是 7.2 归档那一节反对的形状
   （「归档得有地方恢复，否则这个动作就是一扇进得去出不来的门」），也和任务书第七节结尾
   「用户始终拥有对这些记忆、推断和数据的查看、修改、暂停和删除权」直接相冲。
3. 补上它**买不到**任何隔离收益：正文只有 session 里这一个用户读得到，`userId` 只从 session 取；
   也补不上「关着还继续记」——写侧闸门在 `memory-module.ts:220`，开关关着时新的候选一行都不产生。

裁决落在两处：`src/app/api/account/cognitive/memories/route.ts:51-61` 的 GET 文档块（将来谁会想补闸门，
先在这段字前停下来），和本片新加的 5 条用例。

### 二、用例：八个开关全 false 时七条路照样通

`tests/unit/cognitive-memories-route.test.ts` 末尾新增一节「八个开关全关时，记忆管理的七条路一条都不设闸」，
覆盖 GET 列表 / GET 单条 / GET 证据 / PATCH 改口 / POST 撤回+归档+恢复 / DELETE 三种范围。
同一片给这个文件加了 `@/lib/cognitive/preferences` 的替身（`allFlagsOff`：八个 `*Enabled` 全 `false`、
`emotionTransparency: 'implicit'`、`memoryWritePaused: false`）。

**这个替身今天没人读**——七条路里没有一条 import preferences。它的作用是把用例的失败模式钉死：
将来若有人给这一屏补闸门，跑的会是这份全 false 的偏好而不是真库，所以那条用例红的时候
只可能是「裁决被推翻」，不会伪装成数据库连接错误。

### 三、变异探针：这条「守卫现有行为」的用例有没有牙齿

守卫型用例天生一次就绿，所以它的价值只能靠探针量。两支都是**在路由里插入一个假闸门**，跑，看红，按字面 Edit 回滚：

| 探针 | 插入 | 结果 |
|---|---|---|
| L-A | GET 里 `requireUser` 之后 `if (!preferences.memoryEnabled) return jsonError(403, …)` | 本片新节「列表和单条照常返回」**403 ≠ 200 红**；顺带把既有 GET 那一节 16 条一起打红 |
| L-B | 同一条闸门插在 DELETE 的 `requireUser` 之后 | 本片新节「三种永久删除照常删得掉，而且仍然走完审计」红（18 failed / 59 passed） |

两支都回滚后重跑：`git diff` 对这个路由只剩 11 行文档注释，代码一个字节没变。

**这两支探针同时说明另一件事**：L-A 打红的 16 条里有 片 3 之前那些「列表形状」用例，
也就是说这个文件里 GET 的既有断言其实也是同一条裁决的受益者——闸门一旦被人补上，
不只会红新用例，会把整屏的既有契约一起打断。这条不需要单独钉。

### 这一片的边界（含无法验收项）

- **用例跑在替身上，不是真 HTTP + 真库**。`listMemories` / `purge*` / `assessMemories` / `listAccessStats` 全是 mock，
  所以这条用例证明的是「路由自己那层不做开关判断」，不证明「关掉开关后整屏真的还打得开」——
  后者要他起一次服务。11-05 片 g 那把真渲染的锁仍然要求他自己起服务。
- **它不是一条「红→绿」的功能用例**，是守卫现有行为的用例；牙齿由上面两支探针提供，
  除此之外没有别的证据。把这一节当成「已验证的隔离性」读是错的：它验证的是**可达性**，
  隔离性由同文件里「查询串里的 userId 换不掉 session」那一类用例管。
- **`[id]/route.ts`、`retract`、`archive`、`restore`、`evidence` 五个文件本身没加文档注释**，
  裁决只写在主 `route.ts` 的 GET 块里。理由：那五个文件各自只有 40–70 行，且都从这一屏进入；
  把同一段话抄五遍只会让将来的修订漏改其中几处。**这条是判断，不是实测。**
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run tests/unit` **98 文件 / 1591 用例**全绿（1591 − 1586 = 5，与本片刻意新增的 5 条对得上）。
- **未做任何改动到他库上的事**：没跑迁移、没写任何行、没动他八个开关的值、没起服务、没发模型请求。

## 片M：「先问再记」不再空转——ASK_CONFIRM 有了自己的表、接口和一屏（11-06）

任务书 1.2 那七种写入动作里，ASK_CONFIRM 是唯一一种「系统不替用户决定」的。这片之前，它在代码里是一个假动作。

### 一、这片修的是一个静默吞掉

`planMemoryWrite` 早就判得出 ASK_CONFIRM（`cognitive-write-decision.test.ts:371` 管着七种情境），
写侧以前只有一句 `if (plan.decision !== 'WRITE' && plan.decision !== 'UPDATE') continue;`——
那句话既没记住，也没问过，直接消失。

**比「没实现」更糟的是它静默**：用户设了这一档，记忆屏上一个字都看不到，也没有任何一处告诉他
「有两句在等你答」。他还以为自己设的东西在生效。现在的分支在 `memory-module.ts:280`。

### 二、另开一张表，而不是给 MemoryItem 加一列 status

MemoryItem 已经有对话注入、时间线、变化、记忆网络、洞察、画像六条读路。加一列 `status`
就得每条读路都记得过滤——**漏一处的后果是「系统把自己的猜测当成用户说过的话带进提示词」**，
那正是任务书结尾禁止的事。表分开，这类错误按结构就不可能发生。

这条不是只写在 `migration.sql` 注释里的愿望，有用例钉着：
`cognitive-memory-candidates.test.ts:316`「这一屏之外的读路径看不见候选：记忆表一条新行都没写过」。

正文与 MemoryItem 同等对待：AES-256-GCM，AAD 是 `memory-candidate:v1:${userId}:${id}`
（`memory-candidates.ts:122`）——和记忆那一份 `memory:v1:…` 不同前缀，两种行的密文不能互解。
`contentHash` **复用排除规则那一份 HMAC**：「这句问过了吗」和「这句被删过吗」必须是同一个「这句」的定义，
两套归一化就会漂，漂的结果是用户永久删除过的一句话又被拿来问第二遍。
用例 `:167`「换标点空格算同一句：候选键和排除规则共用同一个归一化哈希」。

### 三、真库那一层：唯一约束不是替身给我的

19 支迁移在库里已是最新，`MemoryCandidate` 表真实存在（对照查询证明这个检查有牙齿：
查一个不存在的表会报 `The underlying table for model … does not exist`）。三条 `prisma db execute`：

| 探针 | SQL | 结果 |
|---|---|---|
| M-真1 正向对照 | `BEGIN;` 插一行 probe；`ROLLBACK;` | executed successfully（枚举字面量、列形状都对） |
| M-真2 唯一约束 | 同一 `(userId, contentHash)` 连插两行 | **`Error: P2002`** —— 真 SQL 挡下来的 |
| M-真3 没留痕迹 | `SELECT 1 / (COUNT(*) = 0)::int`（表里有行就除零报错） | executed successfully ⇒ 表里 0 行 |

M-真2 为什么必要：单测跑的是内存替身，`(userId, contentHash)` 那条唯一性是我自己写的求值器，
它「看起来对」不代表真库也这么判。理由和 7.2-h 那把回滚探针同一句。
三支都不落数据：前两支在事务里，第三支只读。

### 四、闸门盖住候选，但「问一句」不等于「落一行」

三种「落一行不该发生」的场合，「问一句」同样不该发生（`cognitive-memory-module.test.ts` 片M 那一节）：
总开关关着 `:342`、写入暂停着 `:350`、内容被永久删除过 `:360`；再加库里已有同一句 → 按重复陈述处理，不问 `:369`。

**一条容易写错的判据单独钉着**：落库和提问是**两个计数器**（`memory-module.ts:242` `written`、`:244` `proposed`）。
合并成一个听着更严（「一轮总共只动两次」），实际后果是这一轮一旦写满两行，
后面那些该问的句子一句都不问——策略回到空转，正是这片要修的那个毛病。
用例 `:393`「落库和问句各算各的额度：落了一行不挤掉问句的位置」，牙齿见下面 P8。

屏的可达性接片L 的裁决：这一屏**故意不吃 `memoryEnabled`**（`candidates/route.ts:12` 写着这条裁决），
只有「确认」挡闸门（`[id]/route.ts:45` → 409），「拒绝」不挡。
**理由是这两件事动的东西不同**：确认写一行 MemoryItem，所以它受长期记忆开关管；
拒绝说的是「以后别再拿这句烦我」，把它锁在开关后面等于逼用户先打开长期记忆才能说「不要记」。
用例：`cognitive-candidates-route.test.ts:241`（关着时拒绝照常允许、确认 409）、`:164`（关着时这一屏照样可达）。

### 五、三种忘记都扫候选，学习信号多了一个来源

`forgetting.ts:229`（单条）、`:269`（按会话）、`:319`（按主题）、`:353`（清空全部）。
后两处不走 chat 级联，所以服务层显式删；第四处带 `recordExclusions: false`——
清空全部不往排除表写，这和它不删画像、不删原会话是同一条口径。
候选排在「有没有记忆可删」那行之前，因为这一轮可能只问出两句还没答的话、一行记忆都没落地，
而用户忘记的是这次对话。

`learnAfterPurge` → **`learnAfterSignals`**（`policy-learner.ts:124`）：改名是因为现在有两个来源。
**算证据的只有「永久删除」和「拒绝候选」两件事**——确认不算（那是用户说「要记」），
撤回、编辑、清空全部都不算。学习闸门读在 `memory-candidates.ts:290`，
关掉之后拒绝照常生效但一句证据都不攒（用例 `:244`），这一条和门槛 9 原来的三处删除链路完全同形。

### 六、界面：记忆屏列表上方那两块 tab

`memory-panel.tsx:554` 把 `<MemoryCandidatesPanel onConfirmed={…} />` 放在记忆列表**上面**，且不跟着总开关消失。
两个动作只有「记住」和「不要记」，没有第三档「先放着」——那等于给同一个「不记」再发明一种说法。
两档过滤走同一条 GET 的查询串（`?status=rejected`），不开新端点。
截断那句走纯函数 `describeCandidateListCap`（`memory-display.ts:156`），数字是服务端 `capped` 带回来的实际条数，
界面不许自己写死 200（`MAX_PENDING_CANDIDATES` 和服务端列表上限是两个不同的数，写死迟早漂）。
加载完才渲染；两份列表都空时整块 `return null`；一次只许一个动作在飞（同一条双击会撞 409）。

### 七、先红与变异探针（8 支，全部当场字面回滚）

| 探针 | 改了什么 | 打红了什么 |
|---|---|---|
| M-1 先红 | 实现前整个候选表不存在 | 服务层 14 条全红 |
| M-P1 | 拒绝链路里去掉喂学习层那一步 | 2 红（路由 + 服务层各一条） |
| M-P2 | 给确认也加上喂学习层 | 1 红：`确认不跑学习` |
| M-P3 | 给拒绝也加上 `memoryEnabled` 闸门 | 2 红（`:241` 那条 + 服务层一条） |
| M-P4 | 往候选面板注入 `memoryEnabled` | 1 红：`整块代码里不许出现 memoryEnabled` |
| M-P5 | 淘汰顺序 `createdAt: 'asc'` → `'desc'` | 1 红：`待确认攒过上限只淘汰 PENDING` |
| M-P6 | 删掉按会话忘记时扫候选那一句 | 6 红（forgetting 那一节整块） |
| M-P7 | ASK_CONFIRM 分支改回「什么都不做」 | 3 红（写侧接线 + 时间口径 + 一轮上限） |
| M-P8 | 两个计数器合并（`proposed += 1` 之外再 `written += 1`） | 1 红：`:393` 那条，别的都不叫 |

M-P8 这支顺带把我自己写的一句假注释抓了出来：它一度声称候选和落库「共用同一个计数器」。
**那是错的**，`memory-module.ts:242`/`:244` 从片M 起就是两个，注释现在说的是真话。
这一支的用法是：先按错误的理解改了注释，再拿用例去验理解——用例红了才说明理解错的是我，
不是代码。回滚时手滑留下一行重复的 `continue;`，也在下一次 `sed` 核对里被看见并删掉了。

### 八、一次自己造成的返工，值得记进流程

这片中途我跑过一次 `npx prettier --write`，代价是：8 条钉死文案的用例当场变红、
五个已审计文件被整体重排（547/236/324/191/108 行 diff）、本文档四处行号引用集体错位。
证据说明这不是「格式化工具的口味」问题：仓库里**没有** `.prettierrc`、没有 `.editorconfig`、
`package.json` 里没有 prettier 配置、脚本里也没有 lint；HEAD 里的文件在 100/110/120 三种宽度下
都过不了 `prettier --check`。**这个仓库是手工排版的，prettier 不是它的工具。**
回滚方式：`git show HEAD:<path>` 逐个覆盖 + 逐条重新手打有意改动，两个新文件重写为仓库风格；
文档那四处行号已按还原后的真实行号重新核对（`:474`、`:476-477`、`:480`、`:529-531`）。
这里的格式化门禁只有两条：`npx tsc --noEmit` 和用例。

### 这一片的边界（含无法验收项）

- **JSX 没真渲染过一次**。vitest 跑在 node 环境、没有 jsdom，所以面板那 14 条是「读源码的静态断言 +
  纯函数用例」：它们能钉住文案、请求形状、闸门缺席、按钮禁用，**不能**证明这一屏在浏览器里排得对。
  这条锁和 11-05 片 g 那把是同一把——要他起一次服务，进设置 → 记忆，看那两块 tab。
- **替身求值不等于真 SQL**，但这一片两侧都验过：服务层与路由跑内存替身（唯一约束由我自己实现），
  真库那一层由上面 M-真1/2/3 三支补掉。没验的是 chat 级联删除——那要删一次真实会话，我没有动它。
- **`contentHash` 依赖 `APP_SECRET`**：轮换密钥会让既有候选的哈希全部对不上，
  「这句问过了」就查不出来，同一句话会被再问一遍。`rotate-keys` 那条脚本本来就是运维动作，
  这里只把后果写在纸面，不做「旧数据兼容」——那属于片S 的 AAD/schemaVersion 议题。
- **上限那两个数各管各的**：`MAX_PENDING_CANDIDATES = 200`（攒够了淘汰最旧的**未答**行）
  与服务端列表 `MEMORY_LIST_MAX_ROWS`（一屏列出多少条）。淘汰只碰 PENDING，
  已确认/已拒绝的行是用户答案的记录，留着才解释得清「为什么这句不再问了」。
- **门禁**：`npx tsc --noEmit` 干净；`npx vitest run` **101 文件 / 1659 用例**全绿
  （1659 − 1591 = 68，与片M 新增的 47 条新用例 + 既有用例的改写对得上）。
- **到他库上的事**：迁移 `20261108000000_memory_candidate` 已在库里（`prisma migrate status` 报 up to date，19 支）。
  三支真库探针全部在事务里或未提交，探针后表里 0 行。没动他八个开关的值、没起服务、没发模型请求、没打印任何 provider key。

## 片N / 片O：LINK 和 MemoryRelation 今天仍然不做——把解锁条件写在纸面上（11-06）

片M 刚修掉的那个毛病给了这件事一个新的判据，所以这一节不是重复 片 j 的裁决，是给它补一条更硬的理由。

### 一、片M 的教训正好是 LINK 不能现在加的原因

任务书 1.2 要求写入决策支持七种动作，代码里的联合是五种（`write-decision.ts:24`）。
片M 之前，ASK_CONFIRM 在这个联合里但**没有写目标**，结果就是那句被静默吞掉——
用户设了「先问再记」，那句话既没记住也没问过。

LINK 今天完全同一个形状：`RELATED_TO` 边没有可写的表（2a 判的，`cognitive-relations-calibration.test.ts:7-29`），
把 `'LINK'` 加进这个联合，就是**再造一个空转的动作**——它只会让 `continue` 多一种拼写。
所以这一片的正确产出是不写这段代码，并把解锁条件钉在这里。

### 二、2a 那条实测今天仍然成立，而且新代码没推翻它

当时的数字：45 组句式对里 20 组拿到分，区间 0.262～0.481；6 组真主题对全部拿到分，区间 0.192～0.412。
两区间互相盖住，0.00～1.00 扫不出一个能分开的阈值。**词法的天花板不因加了向量列而改变**——
5b/5d 落地的是「把正文送去 embedding、混合召回」，那条链路里没有给两条记忆打 RELATED_TO 分的东西，
所以那张表今天依然没有可信的产生路径。

那两条静态守卫照旧留着，不许为了本片把它们改松：`schema.prisma` 里不许出现 `model MemoryRelation`、
`src/` 里不许出现 `prisma.memoryRelation`（`cognitive-memory-graph.test.ts:484-500`）。

### 三、解锁条件（写在纸面上，不是待办里的模糊一句）

1. **打分器换成语义那一种**，即用 5b 那份向量算余弦，而不是 `tokenize` 的词法重合。
2. **有可测的语料**：他库里今天 2 行 MemoryItem、`embeddingCiphertext` 全为 NULL。
   两行记忆量不出任何阈值，这条不是拖延，是样本数为二。
3. **有标注的对照**：7.1 那 30 个故事管的是「召回对不对」，没有「这两条该不该连边」的标注对，
   所以第 1 条那个打分器即使写出来也没有东西判它对不对（片W/#229 补的是前者）。
4. 上面三条齐了，才有资格同时动 `MemoryRelation` 表和多跳检索，并且**默认关**（无实测收益的模块不得默认开启）。

**这条边界是「缺证据」，不是「已验收」。** DELETE 那一半不需要证据：任务书 7.2/7.3 把它写成用户点出来的动作，
词法猜出来的「这句推翻了那条」若直接变成永久删除，就是把系统的推断放到用户的表达之上——
这一条按裁决不做，不列进解锁条件。

## 片S：AAD 补上第四个坐标——以及「不能破坏旧密文」这条红线怎么被真库量了一次（11-06）

任务书 5.2 对 AAD 写的是四个字：`userId` / `recordId` / `fieldName` / `schemaVersion`。
这一片交付的是后两个，而它真正的难度不在「加上」，在「加上之后库里已有的行还得能读回来」。

### 一、先摸清现状，再决定动哪几处

逐处对过 `src/lib/cognitive/*.ts` 里每一个 AAD 构造器，事实是三种很不一样的样子：

| 家族 | 构造器 | 四个坐标 |
|---|---|---|
| decision / decision-outcome / reflection / user-profile | 7 个，分布在 6 个文件 | **齐全**，字段名一直在最后一段 |
| memory 一族（memory / -revision / -evidence / -exclusion / -candidate / -vector） | 6 个 | **缺 fieldName**；`v1` 字面量在，但没有名字 |
| —— | —— | 全仓没有 `schemaVersion` 这个标识符 |

最后一行要说清楚：全仓搜不到 `schemaVersion`，不等于没做。每条字符串里那个字面量 `v1`
干的就是版本号的活——它的位置、语义、将来要改的地方都和版本号一致。
所以这一片**没有再造第二个版本号**（一个东西配两个版本号，迟早互相不一致，那时候谁也不知道该信哪一个），
而是把那个已经在干活的字面量请出来，变成一个有名字的常量 `COGNITIVE_AAD_SCHEMA_VERSION`。
这是改名不是改行为，字符串一个字节都没变。

前一行才是本片的范围决定：那四家已经绑了字段名，把它们并进同一个 builder 是纯改名，
要为此重排 **25 处**已经正确的加解密调用点（`grep` 实数：decisions 10、reflection 系 9、user-profile 系 4、decision-module 2）。
风险收益不划算，所以不动。这条判断写进用例的注释里，也写在这里——将来有人觉得「怎么只改一半」，这里有问题可答。

### 二、形状与回退

新口径（`src/lib/cognitive/aad.ts:41`）：

```
${purpose}:v${COGNITIVE_AAD_SCHEMA_VERSION}:${userId}:${recordId}:${fieldName}
```

旧口径同一条字符串少最后一段。**段序是特意选的**：把 fieldName 放最后，
上面表里那四家的字节形状一个都不用改，回退函数也就是「截掉最后一段」这一件事。

写侧永远走新口径，读侧先试新口径、失败再试旧口径（`decryptCognitiveString` / `decryptCognitiveBuffer`）。
这个不对称是本片全部风险的来源，所以下一节拿真库去量它。

### 三、真库只读探针：回退不是保险，是承重墙

先跑了一个一次性的只读脚本（跑完即删，不在仓库里），把六列每一行都试两次解密，
**只打印计数和布尔，一行正文都不落地**：

| 列 | 行 | 非空 | 新口径可解 | 旧口径可解 | 两种都打不开 |
|---|---|---|---|---|---|
| MemoryItem.content | 2 | 2 | 0 | **2** | **0** |
| MemoryItem.embedding | 2 | 0 | — | — | — |
| MemoryRevision.reason | 0 | 0 | — | — | — |
| MemoryEvidence.note | 20 | 0 | — | — | — |
| MemoryExclusion.content | 1 | 1 | 0 | **1** | **0** |
| MemoryCandidate.content | 0 | 0 | — | — | — |
| 合计 | 25 | 3 | 0 | 3 | **0** |

两个结论，方向相反，都要留下：

- **好的一面**：改完之后仍然解不开的行是 0。这就是「绝不破坏既有密文」这条红线唯一有意义的证据形式——
  不是「我觉得回退写对了」，是把他库里每一行真的解一遍。
- **要留神的一面**：非空且需要读回来的 3 行，**全部**走的是回退那条路。也就是说回退不是备胎，
  它此刻正承着这库里全部能读的记忆正文和全部能读的排除规则。删掉回退 = 当场丢数据。
  另外 22 行是 `noteCiphertext` 为 NULL 的证据行，本来就没有可读的东西，别把「合计 25 行」
  读成「25 行都被验过能读」——被验过的是 3 行，另外 22 行的列是空的。
  样本量就是这么小，这一片能证的是「没弄坏现有的」，不能证「新口径在真实负载下没问题」。

### 四、五个变异探针，其中两个打的是我自己

| 探针 | 改动 | 结果 |
|---|---|---|
| S-P1 | 删掉读侧回退 | 8 个测试文件 34 处红。方向对：回退被钉住了 |
| S-P2 | 写侧丢掉 fieldName 那一段 | 红（形状断言拦住） |
| S-P3 | 写侧整体退回旧口径（记忆正文） | 3 处红 |
| S-P4 | 在 `reconsolidation.ts` 塞一个手写的 `memory-note:v1:...` | **一开始是绿的** |
| S-P5 | 向量写侧退回旧封口 | **一开始是绿的** |

S-P4 和 S-P5 这两个要按它们本来的样子记：**不是探针没用，是我的断言不够**。

S-P4 打的是我自己写的注释。那条静态守卫的注释里我写了「将来有人新开一张表随手手写一个
`memory-thing:v1` 会撞红」，可真塞进去一个 `memory-note:v1` 它没拦——因为我把正则写成了
逐个列举那六个已知用途。列举已知 = 断言「和我写测试那天想的一样」，那不是守卫，是快照。
改成 `memory(-[a-z]+)*:v\d:` 这一族的前缀形状之后，同一个探针立刻变红（`cognitive-aad.test.ts:105-115`）。

S-P5 打的是一类更常见的假绿：**读侧带兜底时，任何「往回写一封」的改动都会被读侧的宽容抹平**。
回退只该兜底「历史留下的旧行」，不该兜底「写侧偷偷退回旧口径」。
补上的用例不测「能不能读回来」，测「同一串字节认不认旧封口」——旧封口能打开它，就是写侧退步了：

```
expect(decryptBuffer(bytes, vectorAad('mem-1'))).toEqual(packVector(vector));
expect(() => decryptBuffer(bytes, legacyVectorAad('mem-1'))).toThrow();
```

`tests/unit/cognitive-embedding-client.test.ts:170-193` 一共三条：写侧封新、旧行仍读得回、换用户打不开。

### 五、诚实的边界

给这六个用途补 fieldName，**今天没有关上任何一个现实存在的漏洞**。每个用途都只有一列密文，
而 purpose 已经把跨表隔开——同一个人同一个 id 在两张表撞号并且两边都有密文，那种事不存在。
所以不能说「修复了一个跨字段混淆缺陷」。这一片买到的是另外三件：

1. 任务书 5.2 四个字面要求到位；
2. 「一个用途只有一个封口」这条不变式从此有了 builder 和守卫两处支撑，不再是散在六个文件里的六份手抄；
3. 从此加第二列密文（比如哪天真的给记忆分「正文 / 摘要」两列）时，跨列搬运会解不开而不是解出一堆乱码——
   这个场景今天是假设的，我把它写成假设，不写成收益。

### 六、顺手量到的另一件事：密钥轮换不覆盖认知表

读 `scripts/rotate-keys.ts` 是为了确认「重裹一遍旧行」这条路走不走得通（第五节说过，
只有重裹之后才有资格谈删除回退）。结果发现它今天不覆盖认知表：脚本的模型清单是
chat / message / aiProvider / attachment，**MemoryItem、MemoryRevision、MemoryEvidence、
MemoryExclusion、MemoryCandidate、DecisionRecord、ReflectionRecord、UserProfileEntry 一行都不重裹**，
而它的头注释写着 "re-encrypts every encrypted database field"。

今天不构成数据损坏：旧密钥留在 `MASTER_KEYRING` 里，所以那些行仍然解得开；
但轮换之后它们事实上还躺在旧密钥之下，注释也在撒谎。这一条不在片S 的范围里，
所以本片没有动它——它需要自己的先红用例（哪些模型必须在覆盖清单里）和自己的裁决
（重裹时要不要顺手把旧口径的行升成新口径，那正是「回退可以删了吗」的唯一入口）。

**这条边界是「本片只做了 AAD 口径」，不是「加密这一层已经全绿」。**
