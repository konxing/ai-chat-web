# 第三轮：个人能力成长层（A / B / C）

## 功能与人工授权

- 能力维度由用户主动建立；没有自动从聊天中推断智力、人格或心理状态。
- 证据支持 `TASK_RESULT` 和 `SELF_REPORT`，只有带有 0–1 分数的 TASK_RESULT 参与平均值。
- 任务评分至少 3 条才输出平均表现，至少 6 条才计算前后半段均值差；这是简单描述统计，不是能力诊断。
- `confidence` 仅为样本量充分度指示，不代表具有统计意义的置信区间。
- 快照仅由用户主动创建；实时展示会重新从当前证据计算，避免依赖过期快照。
- 只有点击“AI 生成一项练习建议”时，才发送本维度的标题、目标、最近证据和最多 6 条历史练习反馈给配置的模型提供商。
- AI 不能自己采纳、执行或完成建议。用户必须手动采纳并登记完成反馈。
- 生成新建议时会参考先前已完成练习的效果，避免无条件重复低效建议。

## 数据与安全

Prisma 迁移：`20261112000000_capability_model`，只新增四张表：
`CapabilityDimension` / `CapabilityEvidence` / `CapabilitySnapshot` / `InterventionRecord`。
所有文本列经 AES-GCM 加密，使用认知字段 AAD 绑定 userId / 记录 ID / 字段名；
密文列已登记至 `encrypted-columns.ts`，供密钥轮换使用。
所有 API 均需已登录用户，各层数据库读取以 userId 和对象归属限制。
维度删除会由数据库级联删除所有证据、快照、建议和效果反馈。
证据删除会清理该维度缓存快照。
已关联原消息的证据在原消息删除时级联删除；经网站服务端删除聊天时，同时清除相关能力维度的缓存快照。
用户账号注销时四张表均按外键级联清理。

## API

- `GET/POST /api/account/cognitive/capabilities`
- `PATCH/DELETE /api/account/cognitive/capabilities/:id`
- `GET/POST /api/account/cognitive/capabilities/:id/evidence`
- `DELETE /api/account/cognitive/capabilities/:id/evidence/:evidenceId`
- `GET/POST /api/account/cognitive/capabilities/:id/analysis`
- `POST /api/account/cognitive/capabilities/:id/suggest`
- `GET /api/account/cognitive/capabilities/:id/interventions`
- `PATCH/DELETE /api/account/cognitive/capabilities/:id/interventions/:interventionId`

前端：设置 → 能力成长。

可选聊天上下文：同时满足用户打开画像、当前问题涉及个人情况、该能力维度开启，且服务端配置 `COGNITIVE_CAPABILITY_CONTEXT=1` 时，才向模型注入最多两项匹配能力的任务表现摘要。默认关闭，不发送原始能力证据正文。

## 部署与验证说明

新表需要先部署应用代码并执行 `npx prisma migrate deploy`，再重启服务。
代码依赖 `prisma generate` 生成的新客户端。部署前应正常备份数据库。
回退应用代码前须注意：四张新增表和迁移版本已存在，不能直接回滚迁移来删除用户数据。
如果撤回功能，应首先让 API 停止写入，保留新表并恢复旧版本应用。

本次按用户要求不执行 TypeScript、单元、集成或端到端测试。
建议上线后人工验证：新增维度、删除维度、禁用、录入证据、证据不足、
评分统计、AI 建议、采纳、完成反馈、跨账号访问拒绝、密钥轮换、删除清理。

## 已知限制

- 没有自动采集训练结果；只有用户主动录入的信息会进入能力模型。
- 任务评分不同难度不具有可直接比较性，均值仅用于相同量尺的观察。
- 画像与长期记忆的核心模型不被自动写入能力评分，避免系统把推断误当事实。
- 网站的会话删除路径已额外清理关联能力的历史快照；若有绕过服务接口直接执行的数据库级删除，
  仍应在运维中手动检查相关派生快照是否需要重建或清除。
- 尚未运行测试或做生产性能评测。
