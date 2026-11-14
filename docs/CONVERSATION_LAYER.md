# 对话智能层（Conversational Intelligence Layer）设计与审计

> 配套《对话智能层实施计划书》。本文件记录 Phase 0 审计结论、模块职责、提示词优先级、
> 成本控制与评测口径，随各阶段更新。原则：复用现有链路，不新增独立服务/数据库/运行环境。

## Phase 0 审计结论（不改业务代码）

### 现有聊天调用链
- 入口：`src/app/api/chats/[id]/messages/route.ts` → `buildConversation()`（`src/lib/chats.ts:378`）
  → `streamChatCompletion()`（`src/lib/ai.ts:133`）。流式 SSE 保持不变。
- System Prompt 现状：`chats.ts:402-411` 一段硬编码字符串（可靠温和助手 + 语言 + Markdown/LaTeX + 文档优先 + 不声称看到未提供文件）。
- 认知块：`chats.ts:415-424` `runCognitiveReads()` 产出若干 `system` 块，排在历史之前；`citedMemoryIds` 只记真进提示词的记忆 id。
- 历史窗口：`chats.ts:396-436` 最近 `CONTEXT_MESSAGE_LIMIT` 条、字符预算 40_000，ERROR 行排除、PARTIAL 保留。
- Token 统计：`ai.ts:120-127` `parseUsage()` 读 `prompt_tokens/completion_tokens`，messages 路由落库 `inputTokens/outputTokens`。
- Provider 适配：`capabilitiesOf()` + `providerParams()`（`ai.ts:146-151`），BYOK/平台统一 API 不变。
- 错误隔离：认知模块有截止时间与失败隔离（`cognitiveFailed`），读不出等于没加，对话照旧。

### 改造方案（集成点唯一）
在 `buildConversation()` 内、base system 之后、认知块之前，插入由 **Prompt Builder** 组合的
对话智能块（全局交流原则 + 用户风格 + 当前模式 + 示例 + 知识策略）。不改动流式、模型切换、BYOK。
新增目录 `src/lib/cognitive/conversation/`，全部为纯函数/轻量服务端模块，默认不增加模型调用。

### 提示词优先级（高→低，低不得覆盖高）
1. System Rules（安全/事实/不编造）——保留现有 base system。
2. Global Conversation Policy（全局交流原则）。
3. User Style Profile（用户表达偏好，严格隔离）。
4. Conversation Mode（当前模式说明）。
5. Knowledge/Reasoning Policy。
6. Example Dialogues（仅当前模式少量示例）。
7. Relevant Personal Context（认知块，现有）。
8. Conversation History + Current Message（现有）。

### 成本控制（强制）
- 默认单次生成：模式检测/策略规划/风格/质量检查全部为**程序规则**，不调模型。
- 仅复杂任务可选独立规划/强质量检查，且默认关闭、需开关。
- Token 预算：对话智能块单独设上限（当前 `CONVERSATION_PROMPT_MAX_CHARS=1600`），示例 v2 每轮最多 1 组、200–350 字符、预算不足可不注入。
- 统计：prompt-builder 输出各部分字符数、预算与截断原因（`truncationReasons`），换算近似 token，供 Inspector/成本页。

## 模块职责（src/lib/cognitive/conversation/）
- core/conversation-policy.ts：全局默认风格 + 5 条跨场景语言原则（纯常量/渲染）。
- mode/conversation-mode.ts + mode-detector.ts：8 模式定义 + 规则检测（含当前会话明确要求优先）。
- planning/response-planner.ts：轻量策略组合（9 策略），输出内部 plan，不展示。
- style/style-profile.ts + style-examples.ts：用户偏好（按用户隔离存储）+ 审核过的示例库。
- knowledge/knowledge-synthesis.ts：跨领域/因果/多视角/整合 + 证据约束（提示词级）。
- learning/preference-extractor.ts：明确反馈→偏好候选（global/task/context/temporary）。
- quality/response-quality.ts：程序化轻量检查；复杂才可选强检查。
- prompts/prompt-builder.ts + prompt-registry.ts + prompt-version.ts：统一组合 + 版本化 + 回滚。

## 评测口径（Phase 8）
固定测试集 + 匿名成对盲测 + LLM-as-judge + 人工抽查；训练/验证/测试分离；
候选 prompt 必须过独立验证集才替换生效版本；不得仅凭 LLM 自评宣称提升。
## v1.3 增量（低打扰自主 + 三账本）
- state/dialogue-ledgers.ts：RepairLedger（真纠正 vs 正常追问、TTL、correctedExpectation）、
  ActiveConstraint（THIS_TURN/TOPIC/SESSION/GLOBAL_CONFIRMED，state/supersedes，撤销/改口）、
  ConversationalIntent、topicStack；全部从最近 ≤6 轮现场重建，不持久化、不建新表。
- planning/question-budget.ts：追问价值预算（SHARING/ESSENTIAL/ALREADY_KNOWN/LOW_VALUE），
  分享不强制追问、已知不重复索取、缺关键事实只问一个、可安全默认直接完成。
- learning/autonomy.ts：AutonomyDecision（action/risk/scope/permission/canUndo/userInterruption/reasonCode）。
- 单一授权开关 `autoLearnStyle`（默认关）：明确长期风格才自动持久化；未授权仅会话遵守、不弹窗；沉默≠同意。
- 自然语言撤销：`detectStyleUndo` + `performStyleUndo` 真正逆操作（full/length/structure/depth）。
- A.3/A.5：`selectDialogueExampleFor`（最多 1 组/预算/诊断）+ prompt-builder 截断原因；naturalness 影响动作与示例。
- 评测：`structural.ts`（零模型结构指标）；run.ts 记录每轮匿名诊断（动作/追问/示例/预算/截断）。
