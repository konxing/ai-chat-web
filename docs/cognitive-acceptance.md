# 认知层验收清单（任务书 7.4 十条门槛）

这份文档只回答一个问题：**每条门槛今天真被哪个测试守着、守到哪一层、边界在哪。**
它不是通过率报告。十条里有四条**无对象可验**（对应功能还没实现），其余每一条的证据都止于内存替身——没有一条认知单测走过真实数据库。
把这些写清楚比凑一个「10/10」有用——下一次争论「这个增强要不要上」时，这里是共同的事实基线。

核对时间：2026-11-03，基线 HEAD `ef69464` 加上本片（B：出站请求体字节的回环断言）。全量单测 53 个文件 650 条用例通过（`npx vitest run`）。

## 先说清证据的分层

本仓库**没有任何认知单测走真实数据库**。`vitest.config.ts:10` 只收 `tests/unit/**/*.test.ts`，
这些文件对数据库与网络边界的处理分五类，本文每条证据都会标是哪一类：

| 层 | 含义 | 换不来什么 |
|---|---|---|
| **纯** | 纯函数 / fixture，无 mock | 换不来任何 I/O 行为 |
| **服务** | service 层真代码 + `vi.mock('@/lib/prisma')`（内存 Map 冒充表，加密走真 `@/lib/crypto`） | 换不来 SQL：`where` 由测试里手写的求值器解释。遗忘那套（`tests/unit/cognitive-forgetting.test.ts:31-45`）只认顶层相等、`in`、`null`，没有 `lte`/`OR`/关联/类型转换；队列、worker 与本片的**路由层**用例共用另一套（`tests/unit/prisma-mock.ts`，多了 `lt`/`lte`/`gt`/`gte`、`notIn`、顶层 `AND`/`OR`、`orderBy`、`groupBy`、`findUnique`、列默认值），**两套都是替身，不是 PostgreSQL** |
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
| `tests/unit/cognitive-forgetting.test.ts:323` `别人的 id 删不动，返回 0，一行都没少` | 服务 |
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
| `tests/unit/cognitive-forgetting.test.ts:299` `指向它的演化边被摘开，活着的新版本保住「这是改口来的」这个事实` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:311` `它自己作为新版本产生的边随外键一起消失` | 服务（cascade 由测试里的数组 filter 手工模拟） |
| `tests/unit/cognitive-forgetting.test.ts:338` `摘边、删行和建排除在同一个事务里，不走事务外的连接` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:358` `删一条就记一条排除，存的是哈希和密文，不是明文` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:456` `只清自己的，别人的记忆和演化边一行不动` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:217` `删一条记忆 ⇒ 它来源那次对话的欠账一起撤，且在同一个事务里` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:229` `别人那次对话的欠账一条都不动（同 chatId 也不行，得连 userId 一起对）` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:239` `记忆不是从对话里来的（chatId 为空）⇒ 什么都不撤：不带 chatId 是按用户全撤` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:264` `那次对话还没产出记忆（欠账还压在队列里）⇒ 撤账不能因为「没东西可删」就跳过` | 服务 |
| `tests/unit/cognitive-forgetting.test.ts:274` `清空全部 ⇒ 按用户撤干净，别人的欠账一行不动，而且这条也走事务` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:553` `命中排除表的候选既不新增也不演化` | 服务 |
| `tests/run-integration.sh:427` `作废的任务不留在库里：这张表只装还欠着的活` | 真库（**本片区未跑过**） |

**边界（四条，都得记住）**：
- Embedding、图关系、时间线派生、反思候选、决策关联都还没落地，「所有派生数据」今天的分母就是上面三种。
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

**状态：已验收（服务层）。**

| 证据 | 层 |
|---|---|
| `tests/unit/cognitive-memories.test.ts:276` `时间精度不够就不许写成精确日期` | 服务 |
| `tests/unit/cognitive-memories.test.ts:422` `存进去的时间精度原样回带，展示层才不会把它说得更精确` | 服务 |
| `tests/unit/cognitive-memories.test.ts:293` `失效时间必须晚于生效时间` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:195` `开关打开后，技术项目的亲口陈述按「用户明说」落库，且不编造时间` | 服务 |
| `tests/unit/cognitive-memory-module.test.ts:383` `精度未知时不显示时间，精度是年时只显示年` | 服务 |

**边界**：`validPrecision` 的取值由抽取层给出，抽取的测试是纯函数层（`tests/unit/cognitive-memory-extractor.test.ts`，11 条）。
「用户说了个模糊时间 → 落库为精度不足」这一段的**判断**有测，落库之后的 SQL 默认值没有。

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
| `tests/unit/cognitive-forgetting.test.ts:536` `开关关了就不学：删一条不攒证据，但删除本身的派生清理一条都不少` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:196` `开关关掉 ⇒ 不跑写、删行、留下作废的痕迹` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:220` `偏好读不出来 ⇒ 行留着退避重试，不删（一次数据库抖动不能清空用户排队的活）` | 服务 |
| `tests/unit/cognitive-task-worker.test.ts:232` `开关打开 ⇒ 写这一轮跑一次，截止用的是后台的宽期限` | 服务 |

**这一条今天有两个必须写清的事实**：

1. **第八个开关 `adaptiveMemoryEnabled` 在这之前全仓无人读取。**
   `manager.ts:44` 的 `MODULE_SWITCH` 只映射七个模块键，`src/app` / `src/components` 里零命中，
   而策略学习曾在删除链路上无条件执行（`memories/[id]/route.ts:94`、`memories/route.ts:79`、`:87`）——
   门槛 9 对这一层**当时并不成立**。`4a15160` 补上闸门：`policyLearningEnabled()`（`policy-learner.ts:85`）
   读偏好、读不出来当关；`learnAfterPurge` 开头加闸（`policy-learner.ts:127`，一处盖住三条删除链路，route 不用各自记得问），
   `purgeMemory` / `purgeMemoriesByChat` 在事务前读一次（`forgetting.ts:84`、`:104`），关掉就跳过记证据。
   **排除规则和摘演化边照常执行**——那是删除本身的派生清理（门槛 2），和「学不学」是两件事。
   上面那两条新测试是先写先红的（6 条新用例在实现前全部失败），不是补的。
2. **七个模块键里只有 `memory` 真有已注册模块**：`registerCognitiveModule` 的生产调用方只有
   `memory-module.ts:242` 一处。其余六个开关「关了不执行」是**平凡成立**——本来就没有东西在跑，
   不是被测出来的。等模块实现时，这条门槛才第一次真正吃紧。
3. **后台任务这一侧的闸门是三值的，不是开关/关闭两值**：`on` 正常跑、`off` 删行作废、**读偏好失败当 `unknown`，只退避不删行**
   （`tests/unit/cognitive-task-worker.test.ts:220`）。这条是给数据库抖动留的——一次读不出来就把用户排队的活清空，
   比多跑一次严重得多。真库上「默认全关 → 欠账被作废删行」这条出口写进了集成断言（`tests/run-integration.sh:409-427`），
   但**没有「先开后关」的对照**：那片区域没有注入点能让真库跑到「开关打开、记忆真的写进 `MemoryItem`」那一步，
   所以「闸门开着会继续执行」这一半只有单测证据（`cognitive-task-worker.test.ts:232`）。

界面只暴露 `memoryEnabled` 一个开关（`src/components/settings/memory-panel.tsx:121-138`），
`adaptiveMemoryEnabled` 只能走 `/api/account/cognitive` 改。
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
3. **内存替身不是 PostgreSQL**。读侧那段真实谓词（`supersededAt: null`、`origin.notIn`、`validFrom/validTo` 的双 `OR`）由 `tests/unit/prisma-mock.ts`
   的求值器解释，真库上这条端到端链路零覆盖——「其余认知表在真库仍零覆盖」那句天花板对这里同样成立。

**「后台任务永不阻塞对话」今天有两层证据**：请求侧只剩一次 `await enqueueCognitiveTask`（`tests/unit/chat-message-route-side-effects.test.ts:431`
断言路由真的等到落库才写审计，`:460` 断言失败的轮次不欠账），执行侧跑在请求之外的轮询里，写侧失败只进日志和退避。
入队之所以敢 `await`，是因为 `enqueueCognitiveTask` 自己不 reject（`task-queue.ts:42-58`），而且它在 `controller.close()` 之后。

**这一条曾经缺的东西**（`0e5b89e` 起写在这里，现在补上了）：读侧证据真调的是 `buildConversation` 而不是 route handler，
而真调 route 的那个文件当时只管失败收尾与欠账，对**读**侧不做任何断言——两边没接上，所以把 `manager.ts` 的闸门整段删掉，全仓仍然一片绿。

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
上不上向量 Embedding 这个决定，现在有一手的标注语料可以据以做了。

## 下一步（按性价比排序）

1. **先在有 `jq` 和建库权限的机器上跑一次 `npm run test:integration`**——门槛 2/9/10 新写的那批真库断言（`tests/run-integration.sh:385-479`）
   从 `0e5b89e` 起一次都没完整跑过。这一步不产生新代码，但它是目前**唯一把「worker 随服务进程活着」从推断变成观测**的机会。
   本片加的预检（`:130-177`）只保证「缺什么工具/权限」在第一秒就说清楚，它替不了这一跑。
2. 出站字节的最后一寸：**真 TLS 出口与真模型服务**。本地回环已经验过序列化保真（`tests/unit/ai-outbound-request-body.test.ts:105`），
   剩下的是让集成链上的 `tests/mock-ai.mjs` 把收到的 body 落盘再断一次——但那需要真库里的「闸门打开 + 有一行记忆」的注入点，成本比这片高。
3. 门槛 2/3 共同的天花板：`onDelete: Cascade`（`prisma/schema.prisma:465-466`）真实外键行为零覆盖。
   `CognitiveTask` 的三个外键这轮只在真库上验了「行插得进去、约束在库上」，级联删的行为同样没测。
4. 门槛 4/5/7/8 随 Phase 5/6 的模块实现一起转正；在那之前本文档对它们的判定是「无对象可验」。
5. 界面暴露更多开关之前，先让那个开关真的有消费者——第八个开关这次的顺序就该反过来：先有代码读它，再谈要不要给它一个控件。

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
