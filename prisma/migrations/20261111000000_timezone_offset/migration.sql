-- 相对时间（昨天/去年/N天前）锚定用户墙钟：存浏览器时区偏移（分钟）。
-- 纯新增可空列：null = 没同步过，读侧按 UTC 处理，现存用户的行为不变。

ALTER TABLE "CognitivePreference"
  ADD COLUMN "timezoneOffsetMinutes" INTEGER;