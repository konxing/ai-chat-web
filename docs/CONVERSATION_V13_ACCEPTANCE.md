# 对话智能层 v1.3 验收报告（低打扰自主交互版）

- 依据：`docs/澄境AI_对话智能层重构实施任务书_v1.3_低打扰自主交互版.docx`（附录 A/B/C）。
- 基线：`main` HEAD 起于 `91a7c2a`（v1.0 P0–P4 已交付）；本轮分阶段独立提交，见文末 SHA。
- 模型：deepseek-flash（deepseek-flash）；种子=7；评委：未启用；未做双人盲评（如实说明）。
- 开关：对话层总开关默认 **OFF**；`engineVersion` 两臂可灰度；`autoLearnStyle` 默认 **OFF**。
- 原则：只追加可验证机制；共用一个 DialogueState；零额外模型调用；不建新表；不改 SSE/鉴权/密钥/记忆删除语义。

## 1. 改善了哪些具体对话行为

| 机制 | 具体行为改善 | 证据 |
|---|---|---|
| B1 修复账本 | 真纠正后回应动作改为修复并承接"下一步正确期待"；"再深入点"不记为失败；纠正后 TTL 内持续抑制重犯错 | `state/dialogue-ledgers.ts`/`response-act.ts`；用例 r1/r2 + 连续性测试 |
| B2 追问预算 | 分享/倾诉不强制追问；已问未答不重复索取；缺关键事实只问一个；信息齐全不因表面模糊再问 | `planning/question-budget.ts`；用例 q1–q4 |
| B3 意图/约束账本 | "这次不要列点"仅本轮、跨主题过期；"以后技术问题先讲原理"持续遵守；改口/换话题正确结束旧约束 | `state/dialogue-ledgers.ts`；用例 c1/c2 |
| A.4 话题栈 + 状态提示 | 用户明确换话题时关闭旧话题、不强行拉回；v2 注入极简【对话状态】（当前话题/上轮已问，防重复追问） | `renderStateBrief`；连续性测试 |
| A.3/A.5 示例与预算 | 每轮最多 1 组、200–350 字符、可完全不注入；按"动作+话题"择优并记录命中/原因/截断；naturalness 影响动作与示例 | `style-examples.ts`/`prompt-builder.ts`；真模型诊断 |
| C 低打扰自主 | 长期偏好须 `autoLearnStyle` 授权才自动保存；未授权仅会话遵守、不弹窗；自然语言撤销执行真正逆操作 | `learning/autonomy.ts`；用例 u1 |

## 2. 结构化评测（零模型/零数据库，可复现）

来源：`docs/CONVERSATION_V13_METRICS.md`（`npx tsx scripts/conversation-eval/structural.ts`）。

| 指标 | 结果 | 说明 |
|---|---|---|
| repair_success | 100%（1/1） | 小样本，仅代表性用例 |
| repair_false_positive | 0 | 正常追问未误判为纠正 |
| unnecessary_question_rate | 0%（0/1） | 分享轮未强制追问 |
| essential_clarification_recall | 100%（1/1） | 缺日期任务只问一个 |
| repeat_question_rate | 0%（0/2） | 已知信息未再索取 |
| constraint_enforcement | 100%（2/2） | 临时仅本轮、长期持续 |
| undo_success_rate | 100%（1/1） | 撤销解析正确且为可执行逆操作 |

限制：这是**规则决策层**的结构分，不等于真人自然度；覆盖句式有限，不能外推任意表达。

## 3. 真模型两臂 A/B（单轮 6 + 真实多轮 3，种子 7；独立评委 nvd）

| 项 | dialogue-v2 | legacy |
|---|---|---|
| templateFlagRate（基线/层） | 0.11 / 0.11 | 0.11 / 0.11 |
| 独立评委胜负（层/基线/平，n=9） | 2 / 7 / 0 | 1 / 8 / 0 |
| 多轮示例命中 | 5/15 轮（按动作+话题） | 0/15（仅单轮模式示例） |
| 平均注入字符 | 790 | 947 |
| Token 入/出 | 12520 / 12470 | 13460 / 12839 |
| 时延 P50/P95 | 3752ms / 21613ms | 2442ms / 21226ms |

匿名成对样本（本地 `scripts/conversation-eval/samples/`，不含真实用户数据）：

- 分享承接 m01：基线输出四条方向清单；v2 用连贯话语承接（"换换脑子挺好…我这没什么议程"）。
- 用户纠正 m02：v2 本轮 `CORRECT_COURSE`，随后 TTL 内继续带"不再推送排障"提示；legacy 无此账本。
- 示例择优：同一 `SHARE_PROGRESS` 下，与"拖了很久的报告"更近的 d6 被选中（诊断 `act+topic`）。

**结论（如实）：** 独立评委对**两臂都偏好基线**（v2 2:7、legacy 1:8），说明该免费评委很可能系统性偏向更长/更详细的回答（评委偏差），而非证明 v2 更差；同批样本上 v2 相对 legacy 略好（2 vs 1 胜），但 **n=9，不足以判定提升**。程序上 v2 注入更省、示例按话题命中。**保持默认 OFF，不得宣称"真人感"提升。**

## 3.1 模拟多轮（目标驱动，同族辅助）

来源：`docs/CONVERSATION_V13_SIMULATED.md`。3 个目标 × 最多 4 轮（分享/技术诊断/纠正后转聊）。

| 指标 | 平均 |
|---|---|
| final_intent_completion | 0.95 |
| intent_drift（越低越好） | 0.07 |
| continuity | 0.97 |
| unnecessary_question（越低越好） | 0.13 |

限制：模拟用户与评委同族，可能过于配合；仅辅助，不证明真人自然度。transcript 只存本地 gitignored。

## 4. 已知限制

- 未完成双人盲评 ≥30 组与独立（异族）评委；上线门槛未达。
- 真模型 A/B 样本小、置信区间宽；未覆盖弱/强模型分别报告。
- Simulated（目标驱动模拟用户）已实现并小规模运行（3 目标），但模拟用户与评委同族，可能过于配合；仅辅助。
- 独立评委 nvd（免费模型）对两臂都偏好基线，疑似偏好长答/详细答的评分偏差；单评委不可作为上线依据。
- 规则识别对句式敏感（槽位任务、纠正句式）；可能漏判/误判。
- 自然语言撤销为规则解析，同义表达覆盖有限。

## 5. 用户如何打开/关闭/回滚/删除长期偏好

- 打开对话层：后台「系统配置 → 对话智能」总开关（`conversationLayerEnabled`）。
- 选引擎：`engineVersion=legacy|dialogue-v2`；按用户覆盖键 `conversationEngineVersionUser:<userId>` 小范围灰度。
- 自动学习长期风格：同一面板 `autoLearnStyle` 开关（默认关）。
- 撤销长期偏好：对话里直接说"恢复原来的风格 / 撤销之前的简短偏好"，执行真正逆操作；或「表达偏好」页恢复默认。
- 回滚：切回 `legacy` 或关闭总开关；关闭 `autoLearnStyle` 即停止长期写入（不影响当前会话遵守）。

## 6. 每次请求的额外成本与模型调用

- 额外模型调用：**0**（全部规则路径；歧义模型的受控实验未启用）。
- 额外输入：仅注入对话块；本轮两臂平均 790（v2）/947（legacy）字符（近似，非精确 token）；截断 0 轮。
- 时延：无额外网络往返；P95 受上游抖动影响（本批 19s/25s）。

## 7. 复现与验证

- 结构评测：`npx tsx scripts/conversation-eval/structural.ts`
- 真模型两臂（含独立评委）：`npx tsx scripts/conversation-eval/run.ts --engine dialogue-v2 --limit 6 --multi 3 --seed 7 --judge`（legacy 同参数）
- 模拟多轮：`npx tsx scripts/conversation-eval/simulated.ts --goals 3 --turns 4`
- 单测/类型：`npx vitest run`、`npx tsc --noEmit`
- 结果：全量 147 文件 / 2255 测试通过；tsc 通过。

## 8. 提交链

- `d7c01f5` 审计 → `6d70b4f` B1+B3 统一账本 → `39c3c8a` B2 追问预算 → `13c43b1` C 低打扰自主 → `90a4adb` A.3/A.5 示例与预算 → 本次评测升级+本报告（以 `git log -1` 为准）。

## 9. 未满足的上线门槛（明确记录）

1. 双人盲评 ≥30 组（分享/倾诉、观点冲突、技术深入、纠错四类）。
2. 异族独立评委非劣。
3. 弱模型与强模型分别报告。
4. 上述满足前，`dialogue-v2` 与 `autoLearnStyle` 保持默认关闭。
