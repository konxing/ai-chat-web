# 架构与请求链路

## 总览

```
浏览器
  │  HTTPS / HTTP(301)
  ▼
① 云安全组（可选，最外层）        只放行 80/443，来源=家庭 IP
  ▼
② nftables（可选，主机层）        默认丢弃 80/443，直连 3000 丢弃
  ▼
③ Nginx                           TLS1.2/1.3、HSTS、限速、日志
  │   auth_request /_ip_gate ──►  App /api/health（走 App 的 IP 网关）
  │   非 2xx = 拒绝（fail closed）
  ▼
④ 自定义 Node 网关 server.js      IP 白名单（PostgreSQL，默认拒绝）
  │   校验可信代理、剥离伪造头、写访问日志、注入 nonce
  ▼
⑤ Next.js App Router              CSP、页面、API
  │   requireUser → 会话 + CSRF + Origin
  │   requireOwner → 角色
  │   requireOwnerPassword → 敏感操作二次验证
  ▼
⑥ PostgreSQL + 本地磁盘           加密字段 / FAC1 加密文件
```

四层网络防护都可以独立生效。即使 Nginx 配置被绕过，`server.js` 仍会拒绝未授权 IP；即使有人直接访问 3000，nftables/绑定地址/白名单仍拦。App 层永远默认拒绝。

## 关键请求流程

### 首次访问

1. `server.js` 在 Next 之前运行 `guard(req,res)`。它从 TCP 连接取 peer IP；只有当 peer 属于 `TRUSTED_PROXY_CIDRS` 时才读取 `X-Real-IP`，随后删除 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`，写入可信的 `x-real-ip` / `x-client-ip` 和随机 CSP nonce。
2. 白名单规则从数据库加载，由后台定时器按 `IP_CACHE_MS`（默认 1000ms）刷新，请求路径不等待 SQL（仅冷启动首次加载会等）；数据库故障超过 5 秒时返回 503（fail closed，而不是放行）。
3. 未命中规则：403 品牌页，并写 `IpAccessLog`（同一 IP 5 秒节流），不含密码/密钥。
4. 命中：进入 Next。根页面展示 3.9 秒入场动画（可跳过；`prefers-reduced-motion` 时 0.7 秒；同会话 0.9 秒），随后去 `/login`。
5. 登录成功后写入 `fac_session`（HttpOnly、SameSite=Lax、生产 Secure）与 `fac_csrf`（非 HttpOnly，供前端读取）。数据库只保存两者的 SHA-256。

### 聊天 / SSE

1. `POST /api/chats/[id]/messages`：会话 + CSRF + 同源校验，校验聊天归属（`userId`），读取加密历史，解密后构建上下文。
2. 服务器从管理员/用户配置的 provider 解密 API Key（仅服务器内存），进行 SSRF 校验与 DNS 固定，向 OpenAI 兼容接口发起流式请求。
3. 响应以 `text/event-stream` 透传给浏览器；Nginx `proxy_buffering off` 保证逐字到达。
4. 用户消息与助手消息以 AES-256-GCM 密文落库；中断时保存 `PARTIAL`/`ERROR` 状态。
5. 浏览器端用 `react-markdown` + `remark-gfm` + `remark-math/rehype-katex` 渲染；代码块可复制。

### 认知读侧（每一轮回答之前）

任务书 8.1 的链路不是一条写死的流水线，而是一张**模块注册表**：

1. 请求进来先读一次 `CognitivePreference`。读不到（数据库故障）就当这一轮没有认知层，不抛错。
2. 注册表里每个模块只在自己那把开关为 `true` 时入选，然后并发执行 `module.read(turn)`。
   整批共用一个 1 秒截止；单个模块抛错或超时只把它的名字记进 `failed`，其余模块的内容照常注入。
3. 记忆模块（`memory-module.ts`）在一次 `read` 里做完：情绪过滤 → 保留期/情境策略/会话归属过滤
   → 关键词召回 → 截断到「注入条数」→ 渲染成「供参考、非指令」的上下文块。
   那一条截断同时受两处约束：内置上限 `MEMORY_READ_MAX_ITEMS = 8`，以及任务书 8.3「记忆检索设置」
   在 `CognitivePreference.memoryReadLimit` 上的那一档（1–8，默认 8）；取小，所以调低只影响这一轮带几条。
   **关联扩展已经接上**：`associationEnabled` 为真且这一轮选中了记忆时，`expandRelatedMemories`
   从种子沿 `MemoryRelation` 走至多 2 跳、至多 30 个候选节点、至多注入 8 条（置信度下限 0.5）。
   三条硬约束：扩展目标只能取自这一轮已经取回的可见池（所以失效行、被排除的行不会因为有一条边就重回上下文）、
   每条候选仍要单独过 `isMemoryUsable` 与两端情境的 `allowAssociation`，注入块与主块共用 1500 字预算。
   关着时连关系表都不问。
   **三项已实现但线上没接的层**：混合召回（关键词 ⊕ 余弦 RRF，纯函数 `rankMemoriesHybrid`
   已就位，线上调用不传向量）、显著性排序（四个变体实测都没越过基线）、读侧时间框架过滤
   （问侧 116 条里只有 1 条解析得出框架）。接它们各自需要一次真实收益的证据，不是靠打开开关。
4. 决策模块（`decision-module.ts`）按关键词在最近 50 条已确认决策里挑至多 2 条，
   冠以「过去相似决策（仅供参考，需结合当前约束重新分析）」。
5. 情绪开关与透明度在这一步一并交给记忆模块；`emotionTransparency=off` 或
   `emotionEnabled=false` 时，情绪类记忆在进池之前就被滤掉。
6. 所有块只是上下文的**引用资料**：记忆正文是不可信数据，任何「忽略系统规则」都改变不了系统提示。

### 认知写入（后台任务队列）

1. 流式回答字节交付完、`controller.close()` 之后，请求处理只做一件事：往 `CognitiveTask` 欠一行 id（`userId` / `chatId` / `sourceMessageId` / `kind`）。`await` 它，但入队函数自己永不抛错，所以这一步既不会拖慢响应也不会让已关闭的流出问题。
2. 表里没有任何正文。Worker 领取后按 `sourceMessageId` 取 Message 行、用 `decryptMessage` 重建这一轮，先校验会话归属（`Chat.userId`）再取消息，内容与请求体一字不差。
3. `src/instrumentation.ts` 的 `register()` 在 Node runtime 下拉起 worker（进程内轮询 2 秒，`unref` 的定时器）。它吞掉全部异常：`server.js` 直接 `await app.prepare()`，`register()` 抛错会让端口根本不监听。
4. 领取靠一条条件 UPDATE 原子完成，`leaseOwner` 同时是 fencing token；租约 60 秒，超时未收口的行由下一轮 tick 回收——用满 3 次尝试的判 `DEAD`，否则回 `PENDING`。进程被杀不需要优雅退出，租约过期就是恢复机制。
5. 单条任务内并发为 1（tick 之间用 `running` 标志互不重叠），模块级截止 20 秒。每个模块先过服务端偏好闸门：`on` 正常跑、`off` 删行并记 `cognitive.task_discarded`、读偏好失败只退避不删行。成功和作废都删行——这张表只装欠着的活。
6. 用户点「忘记这次对话」时，还没跑的欠账在同一个事务里被 `cancelCognitiveTasks` 撤销，不会被 worker 事后重新记回来。

后台任务永不阻塞对话：它跑在 HTTP 请求之外的独立轮询里，写侧失败只进日志和退避，读侧（构建上下文时召回记忆）另有 1 秒截止，超时就当没有。

**AI 记忆审核（默认关）**：后台「系统配置 → 记忆审核」打开（DB 未配这一行时回落 env `COGNITIVE_AI_MEMORY=1`）后，**每个有实质内容的用户轮次**都交给审核模型判一次「值不值得长期记」（`memory-extractor-ai.ts` 的 `reviewTurnWithAI`，30s 截止，失败重试一次）。它的结论就是最终候选清单：列出什么记什么，规则初筛命中但它判为一次性的句子会被剔除，它按原话补上的规则漏抓说法（含健康/生活经历这类情景记忆）会被补进来；返回空数组＝这一轮不值得长期记，一条都不落库。三条边界：一是正文必须是用户原话里的完整分句（`filterVerbatimCandidates` 逐字校验，忽略标点与空白差异，改写的一律丢，否则 `origin=explicit` 失真；若它挑的每一条都不是原话，整趟结论作废、回退规则——那是没按格式出牌，不是判「都不值得记」）；二是用户当面下的命令（`extractMemoryDirectives`：句首「记住…/记下…/请帮我记住…」）不过这道闸门，判断题可以给模型，用户明确的指令不行；三是它会看到最近 20 条活跃记忆（连 id），改口时可以用 `replaces` 点名推翻哪一条——词面近重复（阈值 0.8）认不出「我不跑步了」推翻「我每天跑步三公里」，这类语义取代只有看着旧说法才判得出来，指认的 id 必须仍在活跃集合里才生效，落库走既有的演化（新版本 + `EVOLVES_FROM`）。带取代目标的候选排在额度前面，免得每轮两条的落库额度把改口的新说法挤掉。「好的」「嗯嗯」这类零信息应答由 `isReviewWorthwhile` 前置跳过，**纯知识/翻译/数学题也一并跳过**（复用读侧 `routeMemoryRetrieval` 判 `none` 的同一套判据，规则候选与「记住…」命令不受影响），一次模型都不调、连配置都不读。模型不可用/超时/输出解析不出数组时回退规则候选（审核环节坏掉不该清空用户记忆）。判定结果只有条数进日志（`cognitive.ai_review_nothing_worth_keeping` / `cognitive.ai_review_supersede`），正文不进。最终保存决策仍由 `write-decision` 按用户策略裁决，AI 不凌驾用户策略——**但「先问再记」在审核开着时由模型代为判断**：审核已经认可的不再转成待确认候选去问用户（用户明确要求「别让我来判断」），策略的类型/持久化硬闸仍在前；审核关着时决定权回到用户，照旧进待确认。审核模型默认用该用户的默认聊天模型；同一区块可选一个独立审核模型（存 SystemConfig 的 `cognitiveAiMemoryEnabled` / `cognitiveExtractionProviderId`，DB 未配时回落 env `COGNITIVE_AI_MEMORY` / `COGNITIVE_AI_MEMORY_PROVIDER`）。

**AI 提取成本计数（Phase 7，§9.6）**：`memory-extractor-ai.ts` 暴露 `aiExtractionCallCountValue()`，数「真的发起了模型调用」的轮次（含失败，成本已发生）；默认关恒为 0。召回/精确率/MRR/事实更新等基线与阈值由既有评测账本（cognitive-eval-snapshot / -thresholds / -salience / -temporal-calibration）守护，A–E 基线对照复用这套 fixture。

**记忆巩固（Phase 3，默认关）**：env `COGNITIVE_MEMORY_CONSOLIDATION=1` 开启后，后台 worker 每轮对活跃用户跑 `memory-consolidator.ts`：同 type+同 context、bigram 相似度 ≥0.85 的冗余记忆聚成簇，保留最新一条为活跃主记忆，其余**可逆归档**并写 `PART_OF` 边连到主记忆作为证据。不删除、不覆盖原文，跨类型/跨情境/换值（我住北京↔我住上海）绝不合并。幂等：归档后下一轮聚不出簇。这一版不做 LLM 综合摘要。

### 上传 / 语音

1. `POST /api/upload`（multipart）限制大小与字段；根据魔数识别类型，仅允许图片、PDF、DOCX、TXT/MD/CSV、常见音频。
2. 文件名清洗（防路径穿越/XSS），SHA-256 记录；文本类解析（PDF/DOCX/TXT）后按 3000 字符、200 重叠分块，分块与提取文本加密。
3. 文件内容用 `FAC1` 容器加密写盘，数据库只存随机 `storageKey`。下载时校验附件归属，解密后以安全头返回。
4. 语音优先浏览器原生语音识别；若不支持且配置了音频模型，则 `MediaRecorder` 录音并调用 `/api/stt` 转写。

### 管理后台

- `/admin` 页面一次性拉取概览、用户、IP、日志、模型、存储、服务状态；所有变更请求必须带 CSRF。
- 所有管理员写操作（用户、IP、模型、配置、备份、恢复）都调用 `requireOwnerPassword`，要求当前管理员密码；前端有 Reauth 对话框。
- 审计写入 `AuditLog`，敏感字段经过 `audit.ts` 脱敏；普通用户没有任何读取审计的 API。
- IP 规则变更后 `edge-sync.ts` 异步重写可选的 Nginx allowlist 文件并可执行 reload，用于静态 include 方案；Compose 使用 `auth_request`，无需 reload 即生效。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `server.js` | 网络层 IP 网关、可信代理、TLS、安全头、访问日志、优雅退出 |
| `src/middleware.ts` | CSP nonce、安全响应头、未登录页面快速重定向 |
| `src/lib/auth.ts` | `requireUser` / `requireOwner` / 二次密码校验 |
| `src/lib/session.ts` | 不透明会话 token、CSRF、过期/撤销 |
| `src/lib/password.ts` | Argon2id 哈希与密码策略 |
| `src/lib/crypto.ts` | AES-256-GCM、keyring、FAC1、SHA-256/HMAC |
| `src/lib/ip.ts` | IPv4/IPv6/CIDR 规范化与匹配 |
| `src/lib/ssrf.ts` | URL 校验、DNS pinning、重定向阻断 |
| `src/lib/ai.ts` / `providers.ts` | OpenAI 兼容流式调用、能力与参数 |
| `src/lib/files.ts` | 魔数、解析、分块、加密存储 |
| `src/lib/backups.ts` | 备份列表、下载完整性、恢复调用 |
| `src/lib/admin.ts` | 管理后台业务与审计 |
| `src/lib/cognitive/preferences.ts` / `policy.ts` | 八个模块开关、检索条数上限与七情境写入策略，服务端强制 |
| `src/lib/cognitive/manager.ts` | 认知模块注册表：闸门、错误隔离、读/写两侧的截止 |
| `src/lib/cognitive/task-queue.ts` | 欠账落库：入队、原子领取、租约回收、退避重试、作废 |
| `src/lib/cognitive/task-worker.ts` | 进程内轮询执行器：重建这一轮、跑写侧、收口；由 `instrumentation.ts` 拉起 |
| `src/lib/cognitive/memories.ts` / `retrieval.ts` | 记忆读写、双时间有效性、关键词召回与上下文注入 |
| `src/lib/cognitive/retrieval-router.ts` | 按需召回路由（Phase 4，默认开）：纯知识/翻译/数学问题判 none、读侧连记忆池都不读；涉及「我」的召回，综合分析判 complex；拿不准保守召回 |
| `src/lib/cognitive/memory-source-dive.ts` | 记忆溯源展开：措辞明确要细节（具体/详细/展开/有哪些…）时，按命中记忆的 `sourceMessageId` 回原始用户消息取原文，作为第二个注入块交给模型（限本人名下、去重、最多 2 条、8000 字封顶，取不到/解密失败静默跳过，不拖垮记忆块）。普通轮次一条都不多读 |
| `src/lib/cognitive/memory-session-summary.ts` | 会话结束总结（默认关，后台开关 `cognitiveSessionSummaryEnabled`）：对话闲置 ≥20 分钟且仍有 ≥3 条活跃碎片时，把这一场的碎片交给审核模型收拢成 ≤6 条要点；同时与其它已存记忆比对，重复的填 `duplicateOf` 不落库、有差别的填 `updates` 走演化取代。要点 `origin=inferred`、`chatId=null`（避免同场重复总结），被合并的碎片可逆归档并挂同主题边；只在 worker 扫描里跑，一轮最多一场 |
| `src/lib/cognitive/pending-confirmation-sweep.ts` | 待确认自动裁决（默认开，开关 `cognitiveAutoConfirmEnabled`）：记忆候选（PENDING）、决策记录（PENDING_CONFIRM）、画像建议超过 24 小时未处理时，一次模型调用逐条判 keep/drop——保留走用户点「记住」的同一条链路，丢弃则拒绝或进入画像忽略名单；模型失败不改任何状态，条目继续等。进程内同一用户每小时至多重试一次 |
| `src/lib/cognitive/profile-dismissed.ts` | 画像建议的「已忽略」名单（按用户存在 SystemConfig 键里，不建表）：AI 判丢弃的画像建议记在这里，画像读侧据此不再摆出；名单丢失最坏只是旧建议重新露出 |
| `src/lib/cognitive/memory-consolidator.ts` | 后台巩固（Phase 3，默认关）：同 type+context 高相似度冗余记忆聚簇，最新为主、其余可逆归档 + PART_OF 证据边 |
| `src/lib/cognitive/memory-decay.ts` | 衰减优先级（Phase 5，默认关）：由新近度+确认+类型稳定派生，只降召回优先级不删历史。**实测降召回（Recall@8 0.7274→0.7181），按「无实测收益不默认启用」关闭**，env COGNITIVE_MEMORY_DECAY=1 才接进读侧 |
| `src/lib/cognitive/memory-display.ts`（五类记忆） | 六个 `MemoryType` 之上的功能分类：情景（project/decision/emotion）、语义（fact/长期 goal）、程序（preference）、前瞻（带未来说法的 goal）；working 是会话层不入库。纯函数派生，不另存列 |
| `src/lib/cognitive/forgetting.ts` / `exclusions.ts` | 永久删除（含派生数据与欠账撤销）、来源排除规则 |
| `src/lib/cognitive/decisions.ts` / `decision-module.ts` | 决策读写、用户确认、结果链接、相似决策召回 |
| `src/lib/cognitive/reflections.ts` / `reflection-sweep.ts` | 洞察状态机与后台扫描（反证搜索、去重、冷却） |
| `src/lib/cognitive/timeline.ts` / `event-extractor.ts` / `change-detector.ts` | 时间线与变化检测的派生层（只从记忆派生，不编经历） |
| `src/lib/cognitive/memory-graph.ts` | 记忆网络的可视化派生（有证据的关系行 + 演化 / 同场 / 引用三种既成关系） |
| `src/lib/cognitive/relations.ts` | `MemoryRelation` 的读写：只写带证据的两种边，读侧两跳扩展（深度 / 候选 / 注入 / 置信度四道上限） |
| `src/lib/cognitive/user-profile.ts` / `profile-reads.ts` | 画像条目：只存用户确认过的，候选只读不写 |
| `src/lib/cognitive/policy-learner.ts` | 从明确的用户操作学习策略，先出候选、达阈值才生效 |
| `src/lib/cognitive/overview.ts` | 认知中心门厅：只数数、不读正文；关着时也不报错 |
| `src/lib/cognitive/encrypted-columns.ts` / `aad.ts` | 二十五个密文列的 AAD 口径唯一出处，写侧与轮换脚本共用 |

## 技术栈

- Next.js 15.5 App Router、React 19、TypeScript 5.8（strict）、Tailwind CSS 3.4
- Node.js 22 自定义服务器（在 Next 之前拦截全部路径）
- PostgreSQL 14+、Prisma 6（迁移、事务、级联删除）
- Nginx（TLS、`auth_request`、限速、SSE 关闭缓冲）
- Docker Compose 或 systemd 裸机部署
- Vitest 单元测试 + Bash/curl 隔离式 E2E

## 设计取舍

- **不透明会话而非 JWT**：可即时撤销、数据库只存哈希、无签名密钥轮换负担。
- **整字段加密而非透明列加密**：密钥不进入数据库，备份即使泄露也需独立主密钥；代价是无法对标题/正文做数据库全文检索（当前不需要）。
- **Nginx auth_request 而不是静态 allow 文件**：IP 变化立即生效，不需要 reload；代价是每个请求多一次内部健康检查（应用层本来也要检查，缓存后开销很小）。
- **默认拒绝 + 无默认密码**：部署多一步 bootstrap，但避免“默认口令被扫到”的常见事故。
- **认知写作用数据库欠账而非请求尾部的 fire-and-forget**：进程被杀不丢记忆，失败可重试，用户撤销时能作废还没跑的活；代价是租约/重试这套机制要维护，且多副本部署时每个实例都会起 worker（条件 UPDATE 保证同一行只被执行一次，抢输的一方白刷一次 `attempts`）。
- **进程内轮询而不是外部队列服务**：单实例自托管，不为此引入 Redis/消息中间件；代价是最长一个轮询周期（2 秒）的写入延迟，以及冷启动要等第一次 tick。
