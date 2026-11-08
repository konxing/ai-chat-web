# 对话智能层 v2 现状审计清单

基线：main HEAD `55b60d1`（执行前已 `git fetch`，HEAD==origin/main，无更新提交；工作区除既有验收报告外干净）。
以下逐项核实《对话智能层重构实施任务书》F-01~F-10，均**确认存在**，无一项已被新提交修复，故全部纳入本次重构。

| 编号 | 发现 | 现状证据（文件:行） | 结论 |
|---|---|---|---|
| F-01 | 评测循环外静态复用提示词 | scripts/conversation-eval/run.ts:64-65（`buildConversationIntelligence({currentContent:''})` 一次，82 行共用 layerSystem） | 确认，P0 修 |
| F-02 | 多轮退化为单条 user | run.ts:77（`m.turns.join('\n')`）、38（单 role:'user'） | 确认，P0 修 |
| F-03 | naturalness 未接入生成 | core/conversation-policy.ts:12,27（仅定义/默认，renderGlobalPolicy 不读）；planner 不读 | 确认，P2 修 |
| F-04 | 自然度=表面模板指标 | quality/response-quality.ts（仅模板/重复/总结/列点扣分） | 确认，P0 改名+P2 |
| F-05 | 主题词当意图 | mode/mode-detector.ts（关键词正则映射模式） | 确认，P1 修 |
| F-06 | 规划只看本轮字符串 | planning/response-planner.ts（字数/问号/关键词） | 确认，P1 修 |
| F-07 | 预算挤掉示例 | prompts/prompt-builder.ts（顺序塞入、超预算丢后段） | 确认，P2 修 |
| F-08 | 偏好规则遮盖/范围误判 | learning/preference-extractor.ts:37(GLOBAL 不要列点) 先于 :38(TEMPORARY 这次) | 确认，P3 修 |
| F-09 | 版本适用条件未生效 | prompts/prompt-version.ts:20-21,49（getActive 不按 mode/provider 筛）；engine:32 不传 | 确认，P3 修 |
| F-10 | 旧盲测不足以定论 | docs/CONVERSATION_EVAL_REPORT.md（8 子样本、同族 judge、5:3） | 确认，P0 标注 |

## 保留不变（任务书 §10）
主链 messages route → buildConversation() → streamChatCompletion()；SSE/附件/视觉/Provider/BYOK/授权/加密/窗口不变；
认知块为数据非 System 命令；总开关默认 OFF；降级优先级：状态失败→无状态、示例缺→无示例、风格失败→默认、对话层异常→基础聊天。

## 实施顺序
P0 评测基线 → P1 理解/状态 → P2 回应动作/简洁 Prompt → P3 偏好范围/版本适用 → P4 灰度/A/B/验收。每阶段独立 commit。