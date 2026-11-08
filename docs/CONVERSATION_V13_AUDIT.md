# 对话智能层 v1.3 差距审计（附录 A/B/C 对照已交付 P0–P4）

- 基线：`main` HEAD `91a7c2a`（已 `git fetch`，本地与 origin 一致，无他人新提交）。
- 范围：v1.3 任务书附录 A（开源机制）、B（三账本）、C（低打扰自主）。主任务书 P0–P4 已在上一轮交付，本文只核实**新增**要求。
- 原则：以最新源码为唯一依据；已实现的不重复造；新增机制共用一个 DialogueState、零额外模型调用、默认 OFF、可降级、不建新表。

## 已实现（不重复）

| 要求 | 现状证据 |
|---|---|
| 评测按题动态 prompt + 真实多轮回放 | scripts/conversation-eval/run.ts:64,103-112 |
| 话题域 / 话语行为分离 | understanding/dialogue-act.ts:16-26,47-81 |
| 短生命周期 ConversationState | state/conversation-state.ts:8-40 |
| 单一 primaryResponseAct + 0-1 次动作 | planning/response-act.ts:16-67 |
| Lean Prompt 预算（核心>动作>示例>模式/知识） | prompts/prompt-builder.ts:38-64 |
| 3-5 轮多轮示例库 | style/style-examples.ts:100-145 |
| naturalness 进入 renderGlobalPolicy | core/conversation-policy.ts:46-50,72 |
| 偏好范围 TEMPORARY/TASK/CONTEXT/GLOBAL + 临时优先 | learning/preference-extractor.ts:34-68 |
| 反馈归因（机械原因区分） | learning/preference-extractor.ts:70-77 |
| 偏好元数据/恢复默认 | style/style-profile.ts:63-78 |
| Prompt 版本适用性筛选 | core/conversation-engine.ts:45 |
| engineVersion 两臂灰度 | cognitive-flags.ts:67-72 |

## 新增差距（本轮实施）

### 附录 B：三账本（核心，须共用一个 DialogueState）
- **B1 RepairLedger**：现 `recentCorrection:boolean`（state:30）只判"是否纠正"，不区分真纠正 vs 正常追问（"再深入点"不应记失败），无 type/误解陈述/正确期待/TTL/置信度。→ 新增 `repairLedger`。
- **B2 QuestionBudget**：现 `selectResponseAct` 仅凭 `openLoop` 防连环问（response-act.ts:39），无"缺关键事实/已知信息/信息增益/注意力成本/原因码"判定。→ 新增 `question-budget.ts`。
- **B3 Intent & Constraint Ledger**：现无 `activeConstraints`（scope/state/supersedes）与 `pendingIntent`；临时要求未与长期指令分账，无"察觉变更+落实遵守"。→ 扩展 state。

### 附录 A：示例与预算可观测
- **A.3**：现 `selectDialogueExamples` 取最多 2 组、无字符预算、无引用诊断（style-examples.ts:134-136）。→ 最多 1 组 + 200–350 字符预算 + 诊断{selectedId,reason,trimmed}。
- **A.5**：现 prompt-builder 有 parts/truncated 但无**截断原因**（prompt-builder.ts:66-70）；naturalness 只进文本，未影响**回应动作偏好/示例选择**。→ 补诊断与行为化。
- **A.4**：现 state 无 `topicStack`/`pendingQuestion.sinceTurn`/`lastUserCorrection.category`/`temporaryStyle`。→ 随 B 账本一并补。
- **A.6**：现评测仅 scripted 多轮，无 simulated（目标驱动模拟用户）与 dialogue_act_accuracy/move_fit/repair_success 等结构指标。→ 评测升级（结构指标先行，simulated 标注为可选）。

### 附录 C：低打扰自主（最高优先级体验约束）
- **C2 单一授权开关**：现 `learnConversationPreference` 只要 `conversationLayerEnabled` 就自动持久化 GLOBAL（messages/route.ts:194-195），无独立"自动学习表达偏好"授权。→ 新增 `autoLearnStyle`（默认关）。
- **C2 自然语言撤销**：现无"撤销之前的简短偏好/恢复原来的风格"的 NL 逆操作（仅有 UI 恢复默认）。→ 新增 NL 撤销解析 + 真正逆操作。
- **C3 AutonomyDecision**：现无统一自主决策接口（action/risk/scope/permission/canUndo/userInterruption/reasonCode）。→ 新增策略模块，reasonCode 存枚举不存隐私全文。
- **C4/C5**：requireConfirmation 保留（记忆模块已有）；沉默≠同意；新增打扰率/撤销成功率等验收指标。→ 评测升级。

## 不做（拒收清单对齐）
- 不引入 SillyTavern/RisuAI/Letta/Rasa/Pipecat 运行时；只借鉴方法自行实现。
- 不每轮新增意图/情绪/裁判模型三连调用；规则路径零额外调用。
- 不建人格分/亲密度/情感依赖；不编造真实经历/关系。
- 不建新表（复用 SystemConfig 按用户键）；不改 SSE/鉴权/密钥/记忆删除语义。
- 未经人评≥30 组+独立评委非劣，不宣称"真人感提升"，保持默认 OFF。