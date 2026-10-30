# 备份、恢复与灾难恢复

## 备份内容

`npm run backup` / 管理后台“创建备份”会生成一个 `.facbackup` 文件，包含：

- `manifest.json`：格式版本、创建时间、db.dump / uploads.tar.gz 的 SHA-256 与大小；
- `db.dump`：`pg_dump --format=custom --no-owner --no-privileges`；
- `uploads.tar.gz`：整个上传目录（含 FAC1 加密文件）。

整个 tar 包用备份口令派生的密钥加密：

```
"FACBACKUP1" (10) | salt (16) | IV (12) | tag (16) | AES-256-GCM(gzip tar)
scrypt(N=2^15, r=8, p=1)
```

备份文件权限 0600，同时生成 `.json` 元数据 sidecar（含整体 SHA-256）。备份**不包含** `.env`、主密钥、TLS 私钥；恢复时需要原来的主密钥才能解密聊天/附件字段。这是有意的：备份泄露不等于数据泄露，但主密钥遗失也无法恢复。

## 创建

```bash
# 本机/systemd
npm run backup
# 指定目录
node scripts/backup.mjs --out /secure/backups

# Docker
docker compose exec app npm run backup
# 文件在 backups 卷；下载：
docker compose cp app:/app/backups/family-chat-YYYYMMDD-HHMMSS.facbackup ./
```

管理后台“存储与备份”也可以创建并下载；创建需要二次密码，写审计。并发创建会被拒绝（`BACKUP_RUNNING`），超时 15 分钟。

## 校验

```bash
sha256sum family-chat-*.facbackup
cat family-chat-*.facbackup.json       # sidecar 中的 sha256 必须一致
```

恢复脚本还会在解密后校验 manifest 内的 SHA-256，任何篡改/损坏都会在覆盖现有数据前失败。

## 恢复（CLI）

**先停应用**，避免恢复过程中继续写入：

```bash
# Compose
docker compose stop app
docker compose run --rm --no-deps app node scripts/restore.mjs \
  /app/backups/family-chat-YYYYMMDD-HHMMSS.facbackup --yes
docker compose up -d app

# systemd / 本机
sudo systemctl stop family-ai-chat
npm run restore -- backups/family-chat-YYYYMMDD-HHMMSS.facbackup --yes
sudo systemctl start family-ai-chat
```

- 恢复前默认自动做一次当前状态的“安全备份”；若空间不足可加 `--skip-pre-backup`（不推荐）。
- `--db-only` 只恢复数据库；`--uploads-only` 只恢复附件。
- 数据库用 `pg_restore --clean --if-exists --single-transaction` 重建；失败会回滚。
- 附件目录先重命名为 `uploads.pre-restore-<时间戳>`，成功后再切换；失败会尽量恢复原目录。
- 恢复后所有旧会话仍指向旧数据库中的 session 记录；恢复点之后创建的会话会失效，重新登录即可。

Docker 中恢复的注意点：

- `docker compose run` 会启动 db 依赖；`app` 的入口会先 `migrate deploy`，然后执行恢复命令。若恢复的是旧 schema 备份，先确认迁移版本兼容。
- 备份文件必须在 `backups` 卷内，或先 `docker compose cp` 进容器。
- 不要在 `app` 容器运行中直接恢复；先 `stop app`。

## 灾难场景

### 数据库损坏/误删

1. 停应用。
2. 取最近一份 `.facbackup` 与其 `.json`，校验 SHA-256。
3. 确认 `.env` 的 `MASTER_KEY`/`MASTER_KEYRING` 与备份时期匹配。
4. 执行恢复；启动后检查历史聊天、附件下载、登录。
5. 如果备份来自轮换前，确保 keyring 仍有对应旧 key。

### 上传目录丢失

`--uploads-only` 恢复；数据库中的附件记录会重新指向解密后的文件。若文件在备份之后新增，会丢失该部分。

### 主密钥丢失

无法恢复聊天/附件/Provider Key。只能从数据库重建账号与元数据，但密文不可读。务必把主密钥离线保存在与备份不同的位置。

### 备份口令丢失

无法解密 `.facbackup`；数据库/上传文件本身若还在，可继续运行，但无法从该备份恢复。不要尝试暴力破解自己的备份。

### 服务器整机丢失

在新机器上：

1. 安装同版本代码/依赖，准备 PostgreSQL；
2. 恢复 `.env`（主密钥/APP_SECRET/备份口令）与证书；
3. `prisma migrate deploy`；
4. `npm run restore -- <备份> --yes`（或 `--db-only` + 手动上传目录）；
5. 重新配置 Nginx/nftables/云安全组；
6. 先只允许管理 IP，验证后再逐步放行家庭 IP。

## 保留策略

- 每日自动备份（systemd timer 03:30，随机延迟 30 分钟）保留 7 份；
- 每月一份冷备份，保留 12 个月；
- 至少一份离线/异机副本（不同云账号/移动硬盘）；
- 定期做恢复演练（建议每季度）：在隔离数据库恢复并抽查聊天/附件；
- 备份目录与上传目录不要放在同一块故障盘；备份卷单独挂载更好。

## 测试证据

集成测试实际执行了：

- 创建加密备份并下载；
- 校验 SHA-256 与 sidecar 一致；
- 将备份恢复到独立测试数据库（`family_chat_test_restore`），确认用户/聊天可读；
- 篡改备份字节后恢复失败（GCM/清单校验）；
- 主密钥轮换后重启仍可解密历史聊天与附件；
- 恢复脚本的 `--db-only` 路径由脚本参数与单元/集成流程覆盖（完整双恢复未重复执行）。

未覆盖：真实生产规模（数十 GB 上传）下的恢复时长与磁盘峰值；请按自己的数据量预留至少 2 倍空间。
