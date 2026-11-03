# 认知层验收清单（任务书 7.4 十条门槛）

这份文档只回答一个问题：**每条门槛今天真被哪个测试守着、守到哪一层、边界在哪。**
它不是通过率报告。十条里有四条**无对象可验**（对应功能还没实现），其余每一条的证据都止于内存替身——没有一条认知单测走过真实数据库。
把这些写清楚比凑一个「10/10」有用——下一次争论「这个增强要不要上」时，这里是共同的事实基线。

核对时间：2026-11-03（最后一次随「Phase 4 第四片」那片更新），基线 HEAD `53f6967` 加上尚未提交的界面改动
（`src/components/settings/timeline-panel.tsx`，只多两个内联动作区，不碰本文任何服务层证据）。
全量单测 **58 个文件 734 条用例**通过（`npx vitest run`），`npx tsc --noEmit` exit 0。
从 `c8069dd`（那份文档初稿的基线）到这里多出 3 个测试文件：`cognitive-timeline.test.ts` 13 条、`cognitive-timeline-route.test.ts` 9 条、
`cognitive-temporal.test.ts` 9 条，另有写侧与遗忘两组在原文件里加的用例。
**Phase 4 第四片的界面那一半一条测试都没加**——这个项目没有组件测试，那句话在下面的第四片边界表里单独写着。

## 先说清证据的分层

本仓库**没有任何认知单测走真实数据库**。`vitest.config.ts:10` 只收 `tests/unit/**/*.test.ts`，
这些文件对数据库与网络边界的处理分五类，本文每条证据都会标是哪一类（下面引用的 `cognitive-forgetting.test.ts` 行号已随 Phase 4 第四片重排，全部按 11-03 现号复核过）：

| 层 | 含义 | 换不来什么 |
|---|---|---|
| **纯** | 纯函数 / fixture，无 mock | 换不来任何 I/O 行为 |
| **服务** | service 层真代码 + `vi.mock('@/lib/prisma')`（内存 Map 冒充表，加密走真 `@/lib/crypto`） | 换不来 SQL：`where` 由测试里手写的求值器解释。遗忘那套（`tests/unit/cognitive-forgetting.test.ts:31-46`）只认顶层相等、`in`、`null`，没有 `lte`/`OR`/关联/类型转换；队列、worker 与本片的**路由层**用例共用另一套（`tests/unit/prisma-mock.ts`，多了 `lt`/`lte`/`gt`/`gte`、`notIn`、顶层 `AND`/`OR`、`orderBy`、`groupBy`、`findUnique`、列默认值），**两套都是替身，不是 PostgreSQL** |
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
| `tests/unit/cognitive-memories.test.ts:238` `AAD 绑住 userId：同一行密文换个用户解不开` | 服务（真加密） |
| `tests/unit/cognitive-memories.test.ts:373` `换情境或换类型的过滤条件不影响隔离，别人的记忆读不到` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:330` `别人的 id 删不动，返回 0，一行都没少` | 服务 |
| `tests/unit/cognitive-exclusions.test.ts:226` `撤销别人的排除返回 false，一行不动` | 服务 |
| `tests/unit/cognitive-evidence.test.ts:266` `别人的证据不会抬 high 自己的记忆` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:280` `会话属于别人 ⇒ 就当没有：Message 行没有 userId，隔离锚点是 Chat.userId` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:295` `消息挂在别的会话里 ⇒ 取不到：只认 id 就会把别人会话的话记到本用户头上` | 服务 |
| `tests/unit/cognitive-memories-route.test.ts:263` `列表只按 session 用户查，查询串里的 userId 换不掉它` | 路由 |

**边界**：隔离靠的是「每条查询的 where 里带 userId」这句代码事实，而 where 的求值在测试里是那份手写匹配器。
求值器若与 Prisma 语义不一致，这类测试会一起错。加密那一层（AAD 绑 userId）是真算法，不受此限。

### 2. 敏感数据删除：所有派生数据按策略清理

**状态：已验收（限当前存在的三种派生数据）。**

当前派生数据有三种：演化边 `MemoryRevision`、来源排除规则 `MemoryExclusion`、以及还没跑的认知欠账 `CognitiveTask`。

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-forgetting.test.ts:305` `指向它的演化边被摘开，活着的新版本保住「这是改口来的」这个事实` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:317` `它自己作为新版本产生的边随外键一起消失，它折叠的旧版本也不再留着` | 服务（cascade 由测试里的数组 filter 手工模拟） |
| `tests/unit/cognitive-forgetting.test.ts:369` `删除一条事件＝连它的旧版本一起删`（整组 8 条：三版链、每版各一条排除、删中间版、孤行、别人的边不引路、成环终止、按情境记证据、单事务） | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:345` `摘边、删行和建排除在同一个事务里，不走事务外的连接` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:473` `删一条就记一条排除，存的是哈希和密文，不是明文` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:571` `只清自己的，别人的记忆和演化边一行不动` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:223` `删一条记忆 ⇒ 它来源那次对话的欠账一起撤，且在同一个事务里` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:235` `别人那次对话的欠账一条都不动（同 chatId 也不行，得连 userId 一起对）` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:245` `记忆不是从对话里来的（chatId 为空）⇒ 什么都不撤：不带 chatId 是按用户全撤` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:270` `那次对话还没产出记忆（欠账还压在队列里）⇒ 撤账不能因为「没东西可删」就跳过` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:280` `清空全部 ⇒ 按用户撤干净，别人的欠账一行不动，而且这条也走事务` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:553` `命中排除表的候选既不新增也不演化` | 服务 |
| `tests/run-integration.sh:427` `作废的任务不留在库里：这张表只装还欠着的活` | 真库（**本片区未跑过**） |

**边界（四条，都得记住）**：
- Embedding、图关系、反思候选、决策关联都还没落地，「所有派生数据」今天的分母就是上面三种。
  时间线派生（`src/lib/cognitive/timeline.ts`）已经落地，但它是**读时投影、不落库**，所以不进这个分母：
  删掉一行记忆，时间线上那条事件就跟着消失，没有第二份东西需要清理。
  **这句在 11-03 之前是半真话**：只删当前版本时，链上带 `supersededAt` 的旧行会作为孤立事件回到时间线上。
  「Phase 4 第四片」把 `purgeMemory` 改成沿版本链整条删之后，它才是全真（`src/lib/cognitive/forgetting.ts:95`、`:113`）。
- **撤销欠账只覆盖「还没被领走的行」**。租约还在、worker 正在跑的那一条撤不掉——它会在 20 秒截止内跑完并把记忆写回来。单测里 `attempts` 的领取语义有测，这个窗口没有测试，也没有对策（任务书 §6 只要「撤销还没跑的」）。
- `MemoryItem.chatId` 的 `onDelete: Cascade`（`prisma/schema.prisma:465`，`:466` sourceMessage 同）**没有任何测试断言**——
  「删会话连带删记忆」这条方向目前只由 schema 声明保证，无人验证。`CognitiveTask` 的三个外键同理，只是它的级联在真库上形状验过（`tests/run-integration.sh:438` 的插入依赖 `chatId`/`sourceMessageId` 真实存在）。
- 「回答之后写记忆」这条链路现在是两段：路由欠账（`src/app/api/chats/[id]/messages/route.ts:158` 起，`await enqueueCognitiveTask`）+ worker 执行（`src/lib/cognitive/task-worker.ts`）。
  两段的单元证据各自都在（见门槛 10 与下面这张表），真库上「一段接一段跑通」的断言写好了但没跑过。

### 3. 每条持久化记忆可追溯来源

**状态：已验收（服务层），写侧端到端缺一条。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:649` `创建记忆时留下一条支持证据，来源就是那句话所在的消息` | 服务 |
| `tests/unit/cognitive-memories.test.ts:485` `演化边记下谁取代谁、改因，以及触发它的那句话` | 服务 |
| `tests/unit/cognitive-memories.test.ts:263` `用户亲口说和确认过的必须有确认时间，推断和观察不许冒充确认` | 服务 |
| `tests/unit/cognitive-exclusions.test.ts:176` `带上来源会话和来源消息，方便日后追查这条排除是哪来的` | 服务 |
| `tests/unit/cognitive-memories-route.test.ts:273` `列表同时带回这些记忆来自哪次对话的标题，归属仍按 session 用户查` | 路由 |
| `tests/unit/cognitive-memories-route.test.ts:325` `origin 由服务端定成「用户已确认」，请求体里传什么都进不来` | 路由 |

**边界**：`sourceMessageId` 指向的 `Message` 是 `onDelete: Cascade`（`prisma/schema.prisma:447`）。
删掉原消息会把来源指针一起带走，这条行为没人测；同时手工更正的新版本继承旧 `chatId`，
「来源」在演化链上是**上一版的来源**而不是本次动作的来源——这是设计如此，但界面没说破。
再加一条：上表 `:485` 那条用例喂的是**近乎同句**的两行，而自动取代在这份**中文 fixture 语料**（虚构评测故事，不是真实用户语料）上实测 **0/36**（见「Phase 4 第三片」那一节），
所以演化边今天的实际来源主要是设置页的手工更正那条路（`src/app/api/account/cognitive/memories/[id]/route.ts:50`），不是对话里的改口。

### 4. 反思结论可追溯支持与反对证据

**状态：无法验收——反思模块不存在。**

`src/lib/cognitive/` 共 19 个文件，没有 reflection / insight 的实现（唯一沾「decision」字样的是
`write-decision.ts`，那是写入决策的纯函数，不是决策记忆模块）。
证据账本本身的通用能力是有测试的（`tests/unit/cognitive-evidence.test.ts:125`、`:146`、`:153`，服务层），
但**没有反思产物可被追溯**，所以这条门槛今天既不可能失败，也不可能通过。
依赖 Phase 6。**不为它写一条假装满足的测试。**

### 5. 高置信度洞察不允许出现无来源的确定性事实

**状态：部分验收——机制已验收，「洞察」无对象。**

置信度与来源的关系是真代码，并且是**读时算**，不是写入时盖一个章就不管：

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-confidence.test.ts:54` `观察、推断、假设逐级降低，都在低档——推断永远不等于用户说过` | 纯 |
| `tests/unit/cognitive-confidence.test.ts:63` `非用户确认的来源，即使带确认时间也不给那 0.05` | 纯 |
| `tests/unit/cognitive-evidence.test.ts:229` `没有证据的记忆按来源基线给分` | 服务 |
| `tests/unit/cognitive-evidence.test.ts:255` `有反对证据就压在低档` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:769` `低档位的记忆带上「不得以确定性语气使用」` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:802` `算不出置信度时按低档位处理，宁可多标一句也不冒充确定` | 服务 |

**边界**：门槛说的是「洞察」，而洞察由反思产生——反思不存在（见门槛 4）。
今天被验的是它的**前置机制**：任何注入给模型的记忆都带档位，低档位强制带禁用确定语气的标注。

### 6. 模糊时间不得被伪造为确定日期

**状态：已验收（服务层 + 时间线派生层 + 时间解析层）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:276` `时间精度不够就不许写成精确日期` | 服务 |
| `tests/unit/cognitive-memories.test.ts:422` `存进去的时间精度原样回带，展示层才不会把它说得更精确` | 服务 |
| `tests/unit/cognitive-memories.test.ts:293` `失效时间必须晚于生效时间` | 服务 |
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
| `tests/unit/cognitive-timeline-route.test.ts:168` `事件只带派生层算出来的那几列：没有密文，也没有演化理由` | 路由 |

**边界**：`validPrecision` 的取值不再由抽取层给出——抽取只管类型和正文，时间这一栏归
`src/lib/cognitive/temporal.ts`（Phase 4 第二片，见下文）。
「用户说了个模糊时间 → 落库为精度不足」这一段的**判断**有测，落库之后的 SQL 默认值没有。
时间线这一屏把「退到记录时间」显示成 `发生时间未知`（`src/components/settings/timeline-panel.tsx:279`），
这句文案本身没有测试守着——项目没有组件测试，能验的是它上游的 `timeSource` 字段算得对。

### 7. 未确认洞察不得写入已确认画像

**状态：无法验收——画像模块不存在。**

最接近的两条真代码事实：写入决策层明确禁止不持久化内容进入画像/反思/关联
（`tests/unit/cognitive-write-decision.test.ts:168`，纯函数），
以及 origin 不许被推断冒充确认（`tests/unit/cognitive-memories.test.ts:263`，服务层）。
策略表里的 `allowUserProfile` 字段存在于 schema 与 `policy.ts`，**全仓无读取方**。
依赖 Phase 5/6。

### 8. 未确认决策不得建立正式记录

**状态：无法验收——决策记忆模块不存在；但「决策情境先问再记」已验收。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memory-policy.test.ts:123` `决策情境默认落库但必须先经用户确认` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:100` `决策情境允许落库，但必须先经用户确认` | 纯 |
| `tests/unit/cognitive-memory-module.test.ts:215` `决策情境默认要先问用户确认，这一片不假装确认过：不落库` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:217` `UPDATE 不能插队：要先确认或本来不落库的情境，即使撞上旧记忆也不动历史` | 纯 |

**边界**：门槛 8 说的是「决策**记录**」（decisionMemory 模块的正式档案），那东西不存在。
今天守住的是它的**前置**：分类为 decisionMaking 的内容在用户确认前一行都不落库。

### 9. 关闭功能后不得继续执行对应模块

**状态：已验收（八个开关全部有消费者）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-preferences.test.ts:55` `库里没有记录时，八个开关都算关着` | 服务 |
| `tests/unit/cognitive-preferences-route.test.ts:90` `GET 返回全部八个开关，库里没记录时全是默认关闭` | 路由 |
| `tests/unit/cognitive-manager.test.ts:52` `开关没打开的模块根本不会被调用` | 服务 |
| `tests/unit/cognitive-write-decision.test.ts:371` `关掉长期记忆后，七种情境没有任何一种产生持久化写入` | 纯 |
| `tests/unit/cognitive-policy-learner.test.ts:330` `关掉之后 learnAfterPurge 返回空，证据够了也不收紧策略` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:651` `开关关了就不学：删一条不攒证据，但删除本身的派生清理一条都不少` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:196` `开关关掉 ⇒ 不跑写、删行、留下作废的痕迹` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:220` `偏好读不出来 ⇒ 行留着退避重试，不删（一次数据库抖动不能清空用户排队的活）` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:232` `开关打开 ⇒ 写这一轮跑一次，截止用的是后台的宽期限` | 服务 |
| `tests/unit/cognitive-timeline-route.test.ts:117` `timelineEnabled 关着时返回 MODULE_DISABLED，一次记忆查询都不发` | 路由 |
| `tests/unit/cognitive-timeline-route.test.ts:130` `开关读不出来时按关闭处理：拿不准就不读用户的记忆` | 路由 |

**这一条今天有两个必须写清的事实**：

1. **第八个开关 `adaptiveMemoryEnabled` 在这之前全仓无人读取。**
   `manager.ts:44` 的 `MODULE_SWITCH` 只映射七个模块键，`src/app` / `src/components` 里零命中，
   而策略学习曾在删除链路上无条件执行（`memories/[id]/route.ts:94`、`memories/route.ts:79`、`:87`）——
   门槛 9 对这一层**当时并不成立**。`4a15160` 补上闸门：`policyLearningEnabled()`（`policy-learner.ts:85`）
   读偏好、读不出来当关；`learnAfterPurge` 开头加闸（`policy-learner.ts:127`，一处盖住三条删除链路，route 不用各自记得问），
   `purgeMemory` / `purgeMemoriesByChat` 在事务前读一次（`forgetting.ts:115`、`:141`），关掉就跳过记证据。
   **排除规则和摘演化边照常执行**——那是删除本身的派生清理（门槛 2），和「学不学」是两件事。
   上面那两条新测试是先写先红的（6 条新用例在实现前全部失败），不是补的。
2. **七个模块键里只有 `memory` 真有已注册模块**：`registerCognitiveModule` 的生产调用方只有
   `memory-module.ts:242` 一处。其余六个开关「关了不执行」在 4-T1 之前是**平凡成立**——本来就没有东西在跑，
   不是被测出来的。现在 `timeline` 不再是那六个之一：`src/app/api/account/cognitive/timeline/route.ts:29`
   在捞记忆行**之前**读 `timelineEnabled`，读不出来当关，这条有两条新用例钉着（上面那两行）。
   注意它**不走 `manager.ts` 的注册表**——时间线是对话之外的只读接口，不参与上下文注入，所以那道闸门和
   `MODULE_SWITCH` 是两处独立代码，口径相同（读不出来 = 关）但不会互相提醒。剩下五个键
   （`userModel` / `emotion` / `association` / `reflection` / `decisionMemory`）仍是平凡成立，等模块实现才真正吃紧。
3. **后台任务这一侧的闸门是三值的，不是开关/关闭两值**：`on` 正常跑、`off` 删行作废、**读偏好失败当 `unknown`，只退避不删行**
   （`tests/unit/cognitive-task-worker.test.ts:220`）。这条是给数据库抖动留的——一次读不出来就把用户排队的活清空，
   比多跑一次严重得多。真库上「默认全关 → 欠账被作废删行」这条出口写进了集成断言（`tests/run-integration.sh:409-427`），
   但**没有「先开后关」的对照**：那片区域没有注入点能让真库跑到「开关打开、记忆真的写进 `MemoryItem`」那一步，
   所以「闸门开着会继续执行」这一半只有单测证据（`cognitive-task-worker.test.ts:232`）。

界面暴露两个开关：`memoryEnabled`（`src/components/settings/memory-panel.tsx:121-138`）和
`timelineEnabled`（`src/components/settings/timeline-panel.tsx:84-115`，控件渲染在 `:199`）——后者是 4-T1 才有的，
因为开关得先真有消费者，才轮得到它有一个控件。`adaptiveMemoryEnabled` 只能走 `/api/account/cognitive` 改。
这不是遗漏：`memory-policy-panel.tsx:24-26` 写明了立场——不做没人消费的控件，也不做用户拨了没反应的旋钮。

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
| `tests/unit/cognitive-task-worker.test.ts:373` `一次 tick 把领到的任务一个个跑完，绝不重叠` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:420` `上一轮还没跑完时，下一个 tick 不重入` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:489` `领取这一步自己炸了也不 reject：一次数据库抖动不能变成 unhandledRejection` | 服务 |
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
| 真库数据 | `MemoryItem` 与 `MemoryRevision` **各 0 行**（11-03 实测 `p.memoryItem.count()` / `p.memoryRevision.count()`）。你打开这一屏看到的是空态：开关从关拨到开、空态文案、关着不发请求这三件可验；事件排布、折叠计数、来源跳转**无法验收**，要等写侧真落库 |
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
| 真库 | `MemoryItem` 仍是 **0 行**（11-03 实测）。写侧接线跑在 mock 的 `createMemory` 上，落库后的 `validFrom` 列长什么样、时间线那一屏上「发生时间未知」少了几条，全部**无法验收** |
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
| 真库 | `MemoryItem` 仍是 **0 行**，所以「线上到底会不会命中」这一层**无法验收**；本片全部数字来自 fixture 重放 |
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
- **实现**：`src/lib/cognitive/forgetting.ts:95` 的 `eventChainIds` 沿 `MemoryRevision.previousId` 从被点那一行往回走
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
| 真库 | `MemoryItem` 与 `MemoryRevision` 仍各 **0 行**（11-03 实测）。「在时间线上点一次永久删除，链真的整条消失」这一层**无法验收**——上表全部数字来自 `tests/unit/cognitive-forgetting.test.ts:31-46` 那套文件内自带的内存替身，不是 SQL |
| 界面 | 项目没有组件测试：两个按钮、三种警示、预填、「一次只开一个动作区」这些形状**一条断言都没有**。而且我**没在浏览器里验证过**——按规矩我不启动你的服务，这一屏渲染归你 |
| 「纠正」的边界 | 更正只改得了说法，**改不了时间**：PATCH 的请求体只有 `{content, reason}`（`src/lib/validation.ts:163-166`），`validFrom` / `precision` 没有任何写入口。所以 4.4 的「纠正错误事件」今天**不含纠正时间**——时间记错了只能删了重说 |
| 排序口径 | `eventChainIds` 那句 `orderBy: { createdAt: 'asc' }` 在测试替身上**不真排序**：这个文件自带的 `memoryRevision.findFirst`（`tests/unit/cognitive-forgetting.test.ts:133`）只按数组插入顺序取第一条，`orderBy` 参数根本没被读——它和 `prisma-mock.ts` 是两套，后者才实现 `orderBy`。一行只有一条后继边时两种取法等价；真库上「同一版挂着多条后继边」时跟着哪一条走**无法验收** |
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
上不上向量 Embedding 这个决定，现在有一手的标注语料可以据以做了——**已经做了，结论是 no-go**：
这 44 条逐条分类后 **44/44 都是「与查询零共同词」**（0 条被池子/保留期挡掉，0 条被名额挤掉），
更便宜的松匹配改法实测能捞回 11 条（Recall@8 0.7274 → 0.7975）但会打破 `update` 守卫（违禁 0 → 1）；
剩下的靶子只有 33 条，而本机没有 pgvector、没有 embedding 端点、Prisma 6.11 的 `Unsupported("vector")` 列
对 client 不可见。分类判据、成本实测、未决红线和再评估触发条件全部写在
**[docs/vector-retrieval-go-no-go.md](vector-retrieval-go-no-go.md)**。

## 下一步（按性价比排序）

1. **先在有 `jq` 和建库权限的机器上跑一次 `npm run test:integration`**——门槛 2/9/10 新写的那批真库断言（`tests/run-integration.sh:385-479`）
   从 `0e5b89e` 起一次都没完整跑过。这一步不产生新代码，但它是目前**唯一把「worker 随服务进程活着」从推断变成观测**的机会。
   本片加的预检（`:130-177`）只保证「缺什么工具/权限」在第一秒就说清楚，它替不了这一跑。
   **11-03 实测过一次变异探针**（临时把 `forgetting.ts:175-176` 的 `userId` 过滤整个去掉，跑完立即还原，改动没进提交；那是 `purgeAllMemories` 的 `deleteMany` 与撤欠账两行）：
   上表 `:280`（别人的欠账一行不动）与 `:571`（别人的记忆和演化边一行不动）**同时**转红，其余 30 条照样绿（那次跑的是第四片之前的 32 条文件）——
   这两行不是空断言，`purgeAllMemories` 的用户隔离在 mock 层真的守着。真库那一半仍然要靠集成 `:418`。
2. 出站字节的最后一寸：**真 TLS 出口与真模型服务**。本地回环已经验过序列化保真（`tests/unit/ai-outbound-request-body.test.ts:105`），
   剩下的是让集成链上的 `tests/mock-ai.mjs` 把收到的 body 落盘再断一次——但那需要真库里的「闸门打开 + 有一行记忆」的注入点，成本比这片高。
3. 门槛 2/3 共同的天花板：`onDelete: Cascade`（`prisma/schema.prisma:465-466`）真实外键行为零覆盖。
   `CognitiveTask` 的三个外键这轮只在真库上验了「行插得进去、约束在库上」，级联删的行为同样没测。
4. 门槛 4/5/7/8 随 Phase 5/6 的模块实现一起转正；在那之前本文档对它们的判定是「无对象可验」。
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
