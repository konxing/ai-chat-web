# 对话智能层 v1.3 模拟多轮评测（目标驱动，辅助）

- 模型：deepseek-flash（deepseek-flash）；模拟用户与评委同族，**仅辅助，不代表真人**。
- 目标数=3，每目标最多 4 轮；transcript 只存本地 samples/（gitignored），不写公共日志。
- 平均：final_intent_completion=0.95，intent_drift=0.07（越低越好），continuity=0.97，unnecessary_question=0.13（越低越好）。

| 目标 | completion | drift | continuity | unnecessaryQ |
|---|---|---|---|---|
| g1 | 0.9 | 0.1 | 0.95 | 0.2 |
| g2 | 1 | 0 | 1 | 0 |
| g3 | 0.95 | 0.1 | 0.95 | 0.2 |

限制：模拟用户由同族模型生成，可能过于配合或偏离；不得用本表证明真人自然度；上线仍需双人盲评 ≥30 组 + 异族评委。
复现：`npx tsx scripts/conversation-eval/simulated.ts --goals 3 --turns 4`