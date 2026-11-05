-- AlterTable
-- 任务书 7.3 的「暂停长期记忆写入」。默认 false：既有行一条都不动，
-- 而「库里没有这一行」等于没暂停——和这张表其余开关的「没配过就是不动作」同构。
-- 它不进那八个模块开关：模块开关管「这个模块要不要工作」，关掉后读侧也不注入；
-- 这一列只管「还记不记新东西」，已存的记忆照常带入对话。
ALTER TABLE "CognitivePreference" ADD COLUMN     "memoryWritePaused" BOOLEAN NOT NULL DEFAULT false;
