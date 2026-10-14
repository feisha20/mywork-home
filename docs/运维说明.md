# 运维说明

## 部署结构与数据位置

本项目通过 `compose.yaml` 运行 `workbench` 服务，连接现有的外部 PostgreSQL，不负责启动或备份整个 PostgreSQL 实例。默认仅监听本机 `127.0.0.1:8787`。

| 数据 | 位置 | 备份方式 |
|---|---|---|
| 待办、日志、来源证据、同步游标、抽取批次、日报、周月报、计划任务、MCP 客户端与迁移记录 | PostgreSQL 的 `workbench` schema | 脚本生成自定义格式逻辑转储 |
| 模型密钥、禅道凭据、采集路径、自定义渠道及 Logo、自动化设置 | `harness-runtime` 卷的 `/app/.runtime/settings` | 脚本复制整个设置目录 |
| 数据库凭据、挂载路径、端口 | 项目 `.env` | 脚本复制为 `environment.env`，恢复时不自动覆盖目标 `.env` |
| Harness 临时运行文件、提示词、诊断文件 | 运行卷中的其他目录 | 不备份，运行时重新生成 |
| Codex、Claude、WorkBuddy、Zcode、Gemini 等原始会话 | 宿主机只读挂载目录 | 不在本脚本范围内，需单独备份 |
| 浏览器通知权限、旧版 localStorage 等 | 使用中的浏览器 | 不在服务端备份范围内 |

备份目录包含业务资料与明文凭据。默认保存在项目 `backups/`，目录权限为 `700`，备份文件权限为 `600`，已排除 Git 和 Docker 构建上下文。请复制到受控的异地存储并加密；SHA-256 校验用于发现损坏，不能证明备份来源可信。脚本不会自动删除旧备份。

## 准备条件

- Node.js 24、Docker 与 Compose v2，已完成初始化且创建过 `workbench` 容器。
- 优先使用宿主机 `PATH` 中的 `pg_dump`、`pg_restore`；若缺少，自动复用本机已有的 `postgres:18` 镜像，不下载、不构建。其他版本可通过 `--client-image postgres:版本` 指定本机已有镜像。客户端建议与数据库主版本一致，`pg_dump` 不能备份比自身更新的服务端。
- macOS 可使用 Homebrew 安装 PostgreSQL 客户端，例如 `brew install libpq`，再执行 `export PATH="$(brew --prefix libpq)/bin:$PATH"`。此命令需由运维人员执行，仓库脚本不会自动安装软件。
- 宿主机可连接数据库，应用专属账号拥有 `workbench` schema 及对象。不要使用管理员账号恢复整个共享数据库。
- 操作期间禁止其他工作台实例、开发服务或外部程序写入同一数据库，也不要同时编辑 `.env`、更新容器或修改设置。

脚本从当前容器配置中读取实际数据库连接，不依赖固定的 PostgreSQL 容器名称。容器地址 `host.docker.internal` 会转换为宿主机 `127.0.0.1`。其他地址保持原样；如果是仅容器网络可解析的名称，使用 `--db-host` 指定宿主机可访问的同一数据库地址。端口沿用容器连接配置，不支持改变端口映射。URL 中的 TLS 参数仅支持 `sslmode`、`sslrootcert`、`sslcert`、`sslkey`；证书路径需在宿主机有效；使用证书文件时必须使用本机客户端。Docker 客户端访问本机数据库时会将 localhost 转为 host.docker.internal。

本脚本适用于当前仓库标准 Compose 部署，不适用于多实例、本机直接启动的服务或自定义运行目录。恢复时设置所有者按当前镜像的 `node` 用户 UID/GID `1000:1000` 处理。

## 一键备份

在项目目录执行：

```bash
bash scripts/backup.sh
# 保存到其他磁盘（目录可包含空格）
bash scripts/backup.sh --output /Volumes/Backup/mywork-home
# 容器内数据库名称无法在宿主机解析时
bash scripts/backup.sh --db-host 127.0.0.1
```

脚本检查依赖和运行卷，获取项目互斥锁，停止工作台（最多等待 120 秒），备份 `workbench` schema、设置目录与 `.env`，检查转储目录和文件哈希，再生成正式备份目录。原本运行的工作台会重新启动；原本停止的保持停止。停止期间网页和后台同步暂不可用。

成功时输出完整目录，例如 `backups/backup-2026-10-14T12-00-00.000Z-ab12cd34/`。时间戳使用 UTC，避免跨机器时区歧义。目录结构：

```text
manifest.json          # 备份版本、时间、源镜像 ID、源数据库名和 SHA-256
database.dump         # workbench schema 逻辑转储
settings/             # 服务器设置
environment.env       # 源环境配置；原环境没有 .env 时不生成
```

失败退出码非零；`.partial-*` 是未完成备份，不可用于恢复。失败时保留这些文件以便排查，可在核实后手工清理。成功只表示备份文件生成且通过本地校验，仍需定期隔离恢复演练。

## 一键恢复

恢复将覆盖目标数据库中的 `workbench` schema 及工作台设置。应使用与备份相同的代码版本和镜像；升级后的 schema 可能包含备份中不存在的对象，此时不要强行清理共享数据库。脚本不恢复角色、不创建数据库、不自动切换镜像。

```bash
bash scripts/restore.sh /绝对路径/backup-2026-10-14T12-00-00.000Z-ab12cd34 --yes
# 将恢复前保护备份存到另一目录
bash scripts/restore.sh /绝对路径/backup-目录 --yes --output /Volumes/Backup/mywork-home
```

恢复流程：

1. 校验清单、全部文件哈希及转储格式，拒绝缺失文件、额外文件、符号链接和特殊文件；未传 `--yes` 不执行恢复。
2. 停止当前工作台，生成 `before-restore-*` 保护备份。保护备份失败则不执行数据覆盖。
3. 用 `pg_restore --clean --if-exists --single-transaction --no-owner --no-privileges` 恢复。数据库恢复遇错回滚，其他 schema 不在恢复范围内。
4. 将设置复制回运行卷，使用当前镜像启动无网络临时容器替换设置并修正权限。不会拉取新镜像或构建镜像。
5. 全部成功后，原本运行的工作台重新启动；原本停止的仍保持停止。任一恢复步骤失败，保持停机并返回非零状态。

`.env` 不自动覆盖：原机通常无需改动；新机器需手工核对数据库地址、密码、端口和会话挂载目录。备份中 `environment.env` 仅供受控恢复配置使用，切勿原样覆盖新环境连接。设置中的模型和禅道密钥会恢复，采集路径也会恢复；启动前应确认这些服务和路径适用于目标环境。

恢复到新机器时，先准备代码和同版本镜像，运行初始化流程创建专属数据库与账号，确认 `.env`，创建一次标准容器及运行卷，再执行恢复。脚本需要目标容器的数据库连接及已有设置才能生成保护备份；全新环境需先完成一次正常启动，然后停止。首次启动会执行自动迁移及已启用的同步，隔离演练时不要提供真实模型密钥、业务会话目录或外部服务访问能力。

数据库恢复成功而设置替换失败时，数据库与设置可能不一致。修正磁盘空间、权限等原因后，使用此前的 `before-restore-*` 目录运行恢复脚本回退；若保护备份功能因环境损坏仍失败，先由运维人员修复环境，不要绕过保护后直接启动服务。

## 日常运行和检查

```bash
docker compose ps
docker compose logs --tail=100 workbench
curl --fail http://127.0.0.1:8787/api/health
docker compose restart workbench
docker compose stop workbench
docker compose start workbench
```

`/api/health` 返回 `{"status":"ok"}` 表示 API 和数据库可连通，不能证明模型、禅道或会话采集正常。恢复后由使用者核对任务、日志、历史日报、计划任务、设置和采集目录；需要时再手动验证模型及禅道连接。恢复的 MCP 客户端令牌状态来自备份，备份之后撤销的令牌可能重新有效，请按需重新撤销。恢复旧计划记录后，调度器可能补齐停机期间事项。

备份脚本完成后的启动动作不等待健康检查。请运行上述 `ps`、日志和健康检查，确认启动完成；自定义端口时将 `8787` 替换为 `.env` 的 `WORKBENCH_PORT`。

## 更新与回退

1. 先运行备份脚本，记下备份目录和当前 Git 提交；保护好当前镜像。
2. 更新代码，按需要人工执行 `docker compose up -d --build workbench`。本说明和脚本不会自动构建镜像。
3. 检查容器、健康接口及业务数据。启动会自动执行迁移；保留更新前备份直到业务验收通过。
4. 回退时先停止服务，恢复旧代码和兼容镜像，再用更新前备份恢复数据与设置。不要让旧代码直接连接已经升级的数据库。

不要使用 `docker compose down -v`，它会删除包含设置和密钥的运行卷；外部 PostgreSQL 不随 Compose 停止或删除。不要通过复制正在运行的 PostgreSQL 数据目录代替逻辑备份。

## 定时备份与故障处理

可在 macOS `launchd` 或定时任务中调用备份脚本。调度环境应提供完整 `PATH`，确保 Docker Desktop 已启动、Mac 未休眠，并把退出码纳入监控。每次备份会有短暂停机，安排在空闲时间。示例（路径和运行时安装位置按实际修改）：

```bash
cd /Users/linjt/Documents/projects/mywork-home
PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:/usr/local/bin:/usr/bin:/bin" bash scripts/backup.sh --output /Volumes/Backup/mywork-home
```

- 提示客户端执行失败：先检查本机客户端或指定客户端镜像的版本、数据库版本、网络和账号权限。脚本显示具体错误，并隐藏已知口令及数据库连接 URL。
- 找不到容器或运行卷：检查是否在当前项目完成部署，以及是否修改 Compose 项目名或目录结构。
- `.maintenance.lock` 存在：核实没有运行中的脚本，再手工删除锁目录。异常终止、关机或强制杀进程可能留下锁，也可能让工作台保持停机，需先确认数据状态。
- 文件校验失败：使用完整的可信备份副本，不要修改清单绕过校验。
- 保留策略：按容量和业务要求定期人工清理旧备份，至少保留最近一次成功恢复演练的副本及更新前备份，重要副本放到不同物理设备。

## 脚本验证

```bash
node --test scripts/data-maintenance.test.mjs
bash -n scripts/backup.sh scripts/restore.sh
```

自动检查使用模拟命令，不连接业务数据库、不启动浏览器、不启动或重建 Docker 服务。正式使用前，应在隔离环境中进行一次真实备份与恢复演练，确认 PostgreSQL 客户端兼容、设置权限和恢复后的业务数据。
