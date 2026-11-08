# 澄境长期记忆四期升级：运行、权限与人工验收

基线为 GitHub main 的 36a53e7322f0b41773f7bb8e5e3f37bcbaa05328，保留原有
「检索与整理增强」和「上下文增强」两个后台开关，未覆盖最近提交。

## 第一期：记忆可信状态

新增 MemoryVerification，记录用户选择的 UNVERIFIED / VERIFIED / DISPUTED / REFUTED、
LOW / MEDIUM / HIGH 易变性、核验时间及有效期。被争议、证伪或过期的记忆
不再作为普通记忆注入对话。原始聊天和现有 MemoryItem 不作覆盖修改。

PATCH /api/account/cognitive/memories/:id/verification
body: { status, volatility, expiresAt? }。
这里的 VERIFIED 代表用户进行了核验操作，并不证明客观世界的事实真伪。
对价格、库存、版本、运行状态等高易变信息，回答前还应重新查询权威来源。

## 第二期：Dreaming

DreamingRun 提供按用户持久化的租约及约 24 小时复核冷却；
worker 每约 10 分钟从启用了记忆的用户中轮换取一个用户，避免无新消息时
会话总结永远不运行。一次最多处理 32 条过久未核验的中/高易变项目，
高易变核验时效 1 天、中易变 90 天；超期后降为未验证并暂停召回。
它复用会话总结的独立后台设置，不会无条件调用大模型。
Dreaming 依赖现有「检索与整理增强」总开关，不增加新后台开关。
它不自动把模型推断晋升为用户确认的长期目标。

## 第三期：主题 Wiki 和少量按需上下文

KnowledgePage + KnowledgeCitation：主题页面保留加密标题和对记忆 ID 的引用，
不保存一份无来源的私人原文副本。只有用户确认的 CONFIRMED 页能够被对话使用。
草稿可由后台整理或用户主动构建：需要开启长期记忆和用户画像。
读侧会在主题相关时引用实际仍有效的原始记忆，最多约 650 字符。
来源删除时关联自动级联；最后一条引用删除后页面由 PostgreSQL 触发器清理。
数据库索引不是搜索的替代品：超过 200 条的历史检索和同义改写仍需后续性能验证。

GET /api/account/cognitive/wiki
POST /api/account/cognitive/wiki/build
GET/PATCH/DELETE /api/account/cognitive/wiki/:id
页面确认与改名使用 version 乐观锁。设置 → 主题知识库。

## 第四期：经验和认知评测

ExperienceNote 可以选择一条当前有效的个人记忆，或一项已完成的训练建议作为来源。
草稿必须具有用户录入的验证依据，方能由用户设置为 VERIFIED。
经验可被标为 REFUTED，且只有 VERIFIED 并与当前有效来源相连的经验可用于对话。
经验正文加密，按用户和源记录的复合外键隔离，来源删除时级联清理。

GET/POST /api/account/cognitive/experience
GET /api/account/cognitive/experience/sources
PATCH/DELETE /api/account/cognitive/experience/:id
设置 → 实践经验库。

原有 npm run eval:cognitive 不变。新增 npm run eval:cognitive:reliability，
在虚构数据上比较 stateless / legacy / strict 三种检索，并做错误记忆阻断检查。
这只评估检索策略，不评估实际模型回复和离线 Dreaming 的长期收益。

## 部署

先备份数据库。依次部署已有的 capability migration 和本轮三个新增迁移，
使用 npm run db:migrate、npm run db:generate，再 npm run build 并重启网站。
本轮尚未在你的 Windows/PostgreSQL 环境执行迁移、类型检查或业务验收。
建议人工覆盖跨账户授权、用户删除、密钥轮换、并发、慢模型及后台失败恢复。

回滚代码时保留新增数据表，不要直接 drop 迁移以免造成记忆丢失。
若需要暂时关闭增强，优先在后台关闭「检索与整理增强」，
但记忆核验状态对普通召回仍会生效。可以先将相关记录标回 UNVERIFIED 并清除 expiresAt。

## 风险与限制

- 新增模块还没有完成实机测试，不得视为生产认证。
- Dreaming 当前是保守的规则核验调度与已有总结复用，并不是任意自主推理或自动纠错。
- Wiki 当前按情境组织主题索引，不是自由生成且可编辑的多层百科全文。
- 经验的「已验证」表示用户确认有依据，不代替独立外部验证。
- 现有记忆最近 200 条的候选池和固定 1 秒认知读取预算仍可能成为瓶颈。
- 增加新密文列时必须同步检查加密列注册、密钥轮换脚本和删除传播。

## 自动整理的补充安全边界

会话总结只能自动修订先前由 AI 生成、尚未经用户确认、且仍然有效的推断性摘要。
它不得覆盖用户亲口陈述或明确确认的记忆。涉及明确用户事实的“改口”建议将跳过自动替换，
并且被跳过的原始片段不会被归档。模型若在修订时发生竞态失败，也不会自行新建第二条替代记忆。
对应的纯函数测试已添加，但仍按用户要求等待后续测试运行。
