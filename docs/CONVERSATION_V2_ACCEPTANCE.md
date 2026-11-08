# 对话智能层 v2 验收报告

最终提交：`d46ba00`（P0 `a1054e7` → P1 `2e150cc` → P2 `74724f9` → P3 `1978007` → P4 `aece2ba` → 修正 `d46ba00`）。
基线审计见 `CONVERSATION_V2_AUDIT.md`；F-01~F-10 全部确认并修复。复现：`npx vitest run`（144 文件/2214 用例绿）、`npx next build` 成功、`npx tsx scripts/conversation-eval/run.ts --engine <legacy|dialogue-v2> --limit 4 --multi 3 --seed 7`。

## 1. 新状态机改善了哪些具体对话行为
- 意图≠主题：`今天一个Bug修了一天还没好` 判为 SHARE_PROGRESS/VENT → ACKNOWLEDGE_AND_EXPLORE（先承接，不直接排障）；`这个Bug为什么复现不了` 才进 EXPLAIN/诊断（跨轮断言测试覆盖）。
- 纠错：`不是，我只是想聊聊` → CORRECT_COURSE，下一轮不重复原错误路径、不推方案。
- 防连环追问：上轮已问且未答（openLoop）时本轮不再 ASK_ONE_CLARIFICATION。
- 单一回应动作：每轮只选 primaryResponseAct+0-1 次动作，不再累加 EXPLAIN+DEEPEN+REFLECT+CHALLENGE。

## 2. 从"任务式"变"互动式"的真实匿名成对样本（seed=7，deepseek-flash）
用户纠正场景（m02，用户说"不要给方案"后）：
- legacy 层：仍分析"没劲有两种…你是偏哪种？"并附加自己的判断（偏任务式）。
- v2 层："没劲这个状态有好几种质地…你现在更像哪一种？也可能说不清，那就不用非得归类。"（承接+允许不归类，不推方案）。
分享场景（m01，用户"算了先聊聊别的"）：
- v2 层："行，换个脑子也好。你想聊点什么，还是就随便扯两句？"（自然承接，不拉回排障）。
完整成对原文存 `scripts/conversation-eval/samples/<run>/`（本地、gitignore、不含真实用户数据）。

## 3. 单轮/真实多轮盲测结果
- 本轮 A/B 未启 judge/人评（n=0 盲测），仅程序指标：v2 templateFlagRate=0.00 vs 基线 0.14（模板症状下降，**不等于真人感提升**）。
- 旧版 8 子样本 5:3（基线胜）已标注"不足以判定提升/退化"（F-10）。
- 结论：尚无统计证据证明 v2 总体更优；**保持默认 OFF**，待人评≥30 组+独立评委非劣后再灰度。

## 4. 退化与已知限制
- 小样本（7 场景）置信区间宽；无人类评分；judge 同族有偏差。
- 规则式意图检测对话语行为反讽/隐含意图仍会误判；intentConfidence=low 时优先给初步回答而非追问。
- 多轮状态仅最近≤6 轮临时构建，不跨会话持久化（跨会话靠既有记忆/来源链）。
- v2 提示词略增 token（见下），P95 时延受模型波动影响大（14.6s 为单例）。

## 5. 每次请求增加的成本
- 额外模型调用：0（理解/状态/动作全规则）。仅生成调用本身。
- 输入 token：v2 臂 7 场景两臂合计入=11557/出=7341（含基线），单层增量约几百 token（原则+动作+0-2 示例）。
- 时延 P50≈2.0s、P95≈14.6s（小样本，模型波动主导）。

## 6. 用户如何打开/关闭/回滚/删除偏好
- 打开/关闭：后台「对话智能」总开关（默认 OFF）；引擎版本 legacy/dialogue-v2 选择=灰度/回滚；按用户键 `conversationEngineVersionUser:<id>` 小范围开启。
- 回滚提示词：后台版本列表激活旧版本；回滚引擎=切回 legacy。
- 删除/恢复长期偏好：设置「表达偏好」页"恢复默认"（DELETE /api/account/conversation-style）；临时反馈不写库。

## 7. 部署注意
- 不新增表/服务；偏好/版本存 SystemConfig 按用户键。`npm run build` 的 prisma generate 若报 EPERM 系运行中 dev server 占用 DLL，停服或直跑 `next build`。
- 降级优先级：状态失败→无状态、示例缺→无示例、风格失败→默认、对话层异常→基础聊天，均不造成无响应。