# 加密与密钥轮换

## 目标

数据库被拖库、上传目录被复制、备份文件泄露时，攻击者仍然拿不到聊天正文、标题、附件内容、附件名、提取文本或 AI API Key。主密钥不进入数据库、源码或聊天内容。

## 算法与格式

| 用途 | 算法 / 参数 | 说明 |
| --- | --- | --- |
| 密码 | Argon2id m=19456 KiB, t=2, p=1 | 独立随机盐，标准 PHC 字符串 |
| 会话 / CSRF | 32 字节 CSPRNG，SHA-256 存储 | 数据库泄露不能还原 token |
| 字段加密 | AES-256-GCM，12 字节随机 IV，16 字节 tag | 带 AAD，防记录搬移 |
| 文件加密 | AES-256-GCM + `FAC1` 容器 | 随机存储 key，原文件名也加密 |
| 验证码 | 6 位 CSPRNG，HMAC-SHA256 绑定 tokenId、purpose、email、code | 10 分钟、单次、最多 5 次错误 |
| 备份 | scrypt N=2^15 r=8 p=1 + AES-256-GCM | 独立备份口令 |
| 完整性 | SHA-256 | 附件与备份清单 |

字段密文格式：

```
enc:v1:<keyId>:<iv-b64url>:<tag-b64url>:<ciphertext-b64url>
```

AAD 绑定：

- `chat-title:<chatId>`、`message:<messageId>`
- `provider-key:<providerId>`
- `attachment-name:<attachmentId>`、`attachment-text:<attachmentId>`、`attachment-chunks:<attachmentId>`
- 文件内容：`file:<attachmentId>`

把一条记录的密文复制到另一条记录会导致 GCM 认证失败，而不是静默解密。

文件容器：

```
magic "FAC1" (4) | keyIdLen (1) | keyId (1..16) | IV (12) | tag (16) | ciphertext
```

备份容器：

```
magic "FACBACKUP1" (10) | salt (16) | IV (12) | tag (16) | AES-GCM(gzip tar)
```

备份内部：`manifest.json`（含 db.dump / uploads.tar.gz 的 SHA-256、字节数、创建时间）+ `db.dump`（pg_dump custom）+ `uploads.tar.gz`。

## 主密钥与 keyring

```env
MASTER_KEY_ID=k1
MASTER_KEY=<openssl rand -base64 32>
# 轮换期间保留旧 key，JSON：
MASTER_KEYRING={"k1":"<old base64>"}
```

- 密钥为 32 字节；`MASTER_KEY_ID` 1–16 位字母/数字/`_`/`-`。
- `.env` 权限应为 `0600`，仅服务账号可读；不要提交到 Git。
- 数据库、备份、镜像内均不含主密钥。Docker 构建使用的是无意义占位值，运行时由 `.env`/secret 注入覆盖。
- 主密钥丢失 = 聊天/附件永久不可恢复；请放入密码管理器并保留离线副本。
- 旧 key 只应在轮换过渡期存在；确认所有数据与备份策略后再移除。

## 在线轮换（已实测）

```bash
# 1. 先做一次加密备份并验证可下载
npm run backup

# 2. 生成新 key 并重加密所有数据（不修改 .env）
npm run rotate-keys -- --new-key-id k2

# 3. 从 BACKUP_DIR/key-rotation/<新 key id>.env 取值写入 .env 或密钥管理服务
#    然后重启应用
#    4. 登录，打开历史聊天、下载附件、调用一次模型，确认正常
#    5. 观察一个备份周期后，才可从 keyring 移除 k1
```

脚本会：

- 逐条重加密 Chat 标题、Message 正文、AiProvider Key、Attachment 名称/提取文本/分块；
- 解密每个 `FAC1` 文件并用新 key 原子重写（同一目录临时文件 + rename）；
- 跳过已在新 key 上的记录/文件；无法识别的文件格式会告警并跳过，不再中断整轮轮换；
- **在改动任何数据之前**把新密钥写入 `ROTATE_KEY_DIR`（默认 `BACKUP_DIR/key-rotation`，文件已存在则拒绝覆盖）：轮换中途失败时，已改成新密钥的那部分数据仍然解得开；
- 只打印文件路径，不把密钥打印到 stdout（stdout 会进 journald 与 SSH 会话记录），也**不会**自动改 `.env`，避免误覆盖；
- 支持 `--dry-run` 预估数量；`--new-key` 可指定已有 key。

Windows 上文件权限从目录继承，`0o600` 不起作用：把 `key-rotation` 目录单独收紧到当前用户，例如
`icacls "D:\\FamilyAIChat\\backups\\key-rotation" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`。

测试证据：集成测试在隔离数据库中执行了真实轮换（k1 → it2），确认所有 Chat 标题前缀为 `enc:v1:it2:`，重启后聊天、消息、附件仍可解密；单元测试覆盖篡改密文/tag/AAD、旧 key 解密、未知 key id 失败。

## 备份加密

`BACKUP_PASSPHRASE` 与主密钥独立。备份口令至少 12 字符，建议 24+ 随机字符，放在与主密钥不同的密码管理器条目中。

- 备份文件即使泄露，没有口令无法解密；
- 恢复前会校验 magic、GCM tag、manifest 中的 SHA-256；
- `npm run backup` 默认只保留最新 30 份 `.facbackup`（`BACKUP_KEEP`，`--keep 0` 关闭），只删除自己命名的备份文件，其它文件不碰；
- `pg_dump` / `pg_restore` 的数据库口令通过 `PGPASSWORD` 环境变量传给子进程，不出现在命令行上（本机上任何进程都能读到 argv）；
- 恢复旧备份时，应用必须拥有该备份中密文对应的 key id（通常需要保留历史 `MASTER_KEYRING`）。如果已经删除旧 key，旧备份中的聊天字段将无法解密。

## 密钥存放建议

1. **单机家庭部署**：`.env` 由服务账号持有，`chmod 600`，磁盘加密（LUKS）可选；离线备份主密钥。
2. **systemd**：可用 `LoadCredential=` 把密钥文件挂到 `$CREDENTIALS_DIRECTORY`，再由启动脚本导出为环境变量；注意不要写入日志。
3. **Docker**：可用 Compose secrets / 外部 secret manager 注入环境变量；不要把密钥写进镜像、compose 文件或 Git。
4. **更高隔离**：接入 KMS/HSM 需要改造 `keyFor()` 为远程解包/加密调用；当前版本未集成，文档不宣称具备该能力。

## 不应做的事

- 不要把主密钥、备份口令、Provider Key 粘贴到聊天、工单、截图或提交历史。
- 不要在未验证新 key 可读全部数据前删除旧 key。
- 不要用同一个口令作为登录密码、主密钥、备份口令。
- 不要手动编辑密文列；任何格式错误都会导致该条记录不可读。
