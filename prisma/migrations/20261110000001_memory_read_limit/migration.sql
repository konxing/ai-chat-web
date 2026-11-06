-- 任务书 8.3 的「记忆检索设置」：每轮最多注入几条记忆。
-- 纯新增列，默认 8 = 加这一列之前写死的条数；现存用户的行为不变。

ALTER TABLE "CognitivePreference"
  ADD COLUMN "memoryReadLimit" INTEGER NOT NULL DEFAULT 8;
