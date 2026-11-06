-- 任务书 6.6 :722「建议对同一主题建立去重键，并设置可配置的冷却规则」的后一半。
-- 去重键早就在了（ReflectionRecord.dedupKey + 库层 @@unique([userId, dedupKey])），缺的是「可配置」：
-- 扫描节奏一直写死在代码里的 24 小时。这一列把它交给用户。
--
-- 为什么是三档枚举而不是一个小时数：这一列的取值域必须和它的语义一样窄。后台那趟扫描每次都要
-- 把整个记忆池重新聚类一遍（O(n²)），冷却下限本来就是任务书给的一天；放开成整数就等于允许有人
-- 把自己的记忆池重算频率调到每分钟一次，而那既会拖垮这台机器，也不会多产出任何洞察。
--
-- 默认 DAILY 不等于「新加一个默认值」，等于「加上这一列之前那 24 小时」。现存的那些行会直接被
-- 填成 DAILY，所以这次改动对所有已有用户的行为差别为零——它只是让节奏从此可改。

-- CreateEnum
CREATE TYPE "ReflectionCooldown" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "CognitivePreference" ADD COLUMN     "reflectionCooldown" "ReflectionCooldown" NOT NULL DEFAULT 'DAILY';
