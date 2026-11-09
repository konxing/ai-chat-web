# 对话智能层对照评测报告（引擎=legacy）

- 代码版本：见 git HEAD；开关：对话层仅实验臂启用（生产默认 OFF）；引擎臂=legacy；Prompt 版本：默认。
- 模型：deepseek-flash（deepseek-flash）；评委：独立模型 nvd（nvidia/nemotron-3.5-super-vl:free，异族辅助，仍需人评）；种子=7。
- 样本：单轮 6 + 真实多轮 3 = 9。旧版 8 子样本 5:3 结果**不足以判定提升/退化**（F-10）。
- 盲测：层 1 / 基线 8 / 平 0（n=9，小样本，置信区间宽，不作上线依据）。
- templateFlagRate：基线 0.11 / 层 0.00（仅模板症状，非真人感）。
- humanNaturalness：留空，待双人盲评 ≥30 组。
- 时延 P50=3488ms P95=15341ms；Token 入=13505 出=8915。

## 分场景
| 场景 | n | 层胜 | 基线胜 | 平 |
|---|---|---|---|---|
| 普通聊天 | 5 | 1 | 4 | 0 |
| 观点讨论 | 1 | 0 | 1 | 0 |
| 分享承接 | 1 | 0 | 1 | 0 |
| 用户纠正 | 1 | 0 | 1 | 0 |
| 技术深入 | 1 | 0 | 1 | 0 |

## 引擎诊断（匿名聚合，v1.3）
- 每轮实际回应动作：ACKNOWLEDGE_AND_EXPLORE=3，ASK_ONE_CLARIFICATION=4，ANSWER=6，OFFER_PERSPECTIVE=1，CORRECT_COURSE=1
- 追问预算原因码：SHARING=4，ESSENTIAL=4，LOW_VALUE=4，ALREADY_KNOWN=2，n/a=1
- 多轮示例命中 0/15 轮（每轮最多 1 组，200–350 字符预算）；平均注入 947 字符；截断 0 轮（原因见样本层诊断）。
- 约束注入与修复账本随轮生效，样本层诊断记录 constraints/repair，不含用户正文。

匿名成对样本存 scripts/conversation-eval/samples/（本地，不含真实用户数据）。人评与独立评委为上线前必需。