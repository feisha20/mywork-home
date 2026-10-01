# 我的工作台

个人工作台：读取本机 Codex、Claude Code 会话，使用 DeepSeek Harness 与火山 Coding Plan 整理工作事项。自动工作记录按来源消息的原始日期（北京时间）直接进入日志，不需要人工完成；手工待办和禅道任务完成后进入日志。日期显示在“工作日志”标题后面，主面板显示今日日志。点击标题右侧的日历图标并选择日期，即可在弹窗查看该日记录；弹窗支持关闭按钮、Esc 和点击遮罩关闭。

## Docker Compose 部署（推荐）

需要 Docker Desktop 与 Docker Compose v2。本项目复用现有 PostgreSQL，不启动另一套数据库。本机当前 PostgreSQL 位于 `localhost:5432`；容器通过 `host.docker.internal:5432` 访问。

首次初始化：

```bash
bash scripts/setup.sh
```

按隐藏输入提示填写管理员连接和火山 Coding Plan 密钥。管理员连接示例格式：`postgresql://postgres:经过URL编码的管理员密码@host.docker.internal:5432/postgres`。初始化只创建工作台数据库 `mywork_home` 和用户 `mywork_home_app`，随机生成专属密码，写入权限为 `600` 的 `.env`；后续正常服务使用专属账号。重新初始化沿用已有密码和密钥，不自动重置已有用户。

```bash
bash scripts/start.sh
# 或在初始化后运行：
docker compose up -d --build workbench
```

打开 [本机工作台](http://127.0.0.1:8787)。容器启动后自动扫描最近 7 天的消息，然后每 10 分钟增量同步。初次扫描可能需要多轮模型请求；页面核心区域会显示进度、新增数量和需要重试的记录。

Compose 只读挂载以下目录，路径可在 `.env` 修改：

| 配置 | 默认目录 |
|---|---|
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` |
| `CODEX_ARCHIVE_DIR` | `~/.codex/archived_sessions` |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` |

挂载目录必须存在；首次运行可创建缺失的空目录。Docker Desktop 需要能够读取这些目录。容器保留会话中原始项目路径，无需挂载项目源码。Harness 运行数据保存在独立卷 `harness-runtime`。

### 运行管理

```bash
docker compose ps
docker compose logs --tail=100 workbench
docker compose restart workbench
docker compose stop workbench
docker compose down
```

升级代码后运行 `docker compose up -d --build workbench`；数据库迁移在启动时自动执行，使用数据库锁避免并发迁移。停止服务会关闭模型子进程并保存同步状态，下次启动从数据库进度恢复。`docker compose down` 保留运行卷和外部 PostgreSQL 数据。

`WORKBENCH_PORT` 修改宿主机访问端口，默认 `8787`。若数据库部署在其他位置，修改 `WORKBENCH_DB_HOST` 和 `WORKBENCH_DB_PORT`；本机直接运行使用 `DATABASE_URL`。默认端口只对本机开放。

### 数据备份与恢复

当前本机 PostgreSQL 容器名是 `postgres18`，其他环境请替换成实际名称。备份覆盖工作台 schema，包括任务、游标、抽取批次与迁移版本。

```bash
mkdir -p .runtime/backups
docker exec postgres18 pg_dump -U postgres -d mywork_home -Fc --schema=workbench > .runtime/backups/workbench.dump
```

恢复会覆盖该工作台 schema，操作前保留当前备份并停止工作台：

```bash
docker compose stop workbench
docker exec -i postgres18 pg_restore -U postgres -d mywork_home --clean --if-exists --exit-on-error < .runtime/backups/workbench.dump
docker compose up -d workbench
```

同时妥善保留本机 `.env`，它不包含在镜像或数据库备份中。恢复到新 PostgreSQL 时先运行初始化程序创建同名专属用户及数据库，再恢复工作台备份。

## 本机开发

需要 Node.js 24 与 npm。

```bash
npm ci
# 若尚未初始化，设置临时 WORKBENCH_ADMIN_DATABASE_URL 后：
npm run db:init
npm run dev:server
```

另一个终端运行：

```bash
npm run dev
```

前端使用 `http://127.0.0.1:5173`，API 代理到 `http://127.0.0.1:8787`。生产构建与本机运行：

```bash
npm run build
npm start
```

浏览器旧记录属于原站点地址。首次升级时，通过原来的 `http://127.0.0.1:5173` 打开一次页面，将原 localStorage 中的手工事项迁移到数据库；示例不导入。迁移保留原 ID、创建时间和完成日期，重复导入不会覆盖服务器状态，旧缓存仍保留。

## 模型与同步规则

- DeepSeek Harness、SDK、模型适配器固定为 `0.2.0-rc.2`。
- 火山 **Coding Plan** 地址为 `https://ark.cn-beijing.volces.com/api/coding/v3`，协议为 OpenAI Chat Completions，套餐模型名称为 `glm-5.3-flash`。
- 使用工作台独立 Harness home，不改写本机 `~/.dsh` 配置；关闭 Shell、额外会话上传及插件清单上传，只向模型发送脱敏后的会话文字。
- 不读取认证文件，过滤工具输出和内部推理；在本机数据库写入前隐藏密钥、口令、授权信息。模型子进程仅接收模型密钥，不接收数据库凭证。
- 会话结束不代表工作完成。模型必须引用真实消息证据，没有明确完成证据时保留为待办。卡片可展开查看来源。
- 自动抽取的标题使用日报式工作项简介，通常20～40字，最多60字，突出工作对象、行动和目标或结果。文件名、代码参数及实现细节保留在来源证据，不堆进标题；不编造收益或完成状态。
- Codex、Claude Code、WorkBuddy 工作记录直接归档；归档时间单独保存，不会把进行中的工作伪装成已完成。当前 WorkBuddy 尚未接入采集，接入后遵循同一归档规则。
- 只有手工待办和禅道任务提供完成、恢复待办按钮，芯片右侧统计为今日日志数量。
- 首次回溯起点写入数据库，后续按文件字节游标读取增量。每轮仍遍历目录并检查文件状态，未变化文件不读取内容；文件替换、截断或归档移动可能重读，通过消息标识去重，不会再次抽取成功处理的消息。
- 模型只处理未抽取消息（新增及失败重试），每批允许携带最多 6 条历史上下文；成功批次不可重新启动。消息入库与游标推进、抽取结果与成功标记分别通过事务保存，同一事项按 ID 更新。
- 每批串行抽取，低推理档位，最长 180 秒；格式无效最多修复一次。同一数据库同时只运行一次同步。
- 修改 `SYNC_INTERVAL_MS` 可以调整同步间隔；`SYNC_ENABLED=false` 关闭启动及定时同步，手动同步仍可运行。界面默认文案按 10 分钟展示。
- 禅道和 WorkBuddy 暂未接入；本阶段只采集 Codex、Claude Code。

已有自动抽取事项可单独整理简介，日期、状态、来源证据与同步进度均保留。手工事项和手工修改过状态的事项跳过，原简介备份在 `.runtime/summary-titles-*.json`。整理时占用同步锁，避免与抽取重叠：

```bash
docker compose stop workbench
docker compose run --rm --no-deps workbench node dist-server/server/summarize.js
docker compose up -d workbench
# 本机开发环境也可运行 npm run tasks:summarize
```

## 接口

| 接口 | 行为 |
|---|---|
| `GET /api/health` | 数据库就绪检查 |
| `GET /api/workbench` | 待办、日报、执行状态及来源状态 |
| `POST /api/tasks` | 创建手工事项，输入 `{ "title": "事项" }` |
| `PATCH /api/tasks/:id` | 修改手工或禅道任务状态，输入 `{ "completed": true }` 或 `false`；自动工作记录返回 409 |
| `POST /api/tasks/import` | 批量幂等导入旧手工记录 |
| `POST /api/sync` | 启动后台同步；运行中返回同一执行记录 |
| `GET /api/sync/:id` | 获取执行进度及结果 |

写接口接收 JSON；日期为 ISO 格式，日报按北京时间归档。服务连接失败时保留页面已加载记录，新增失败保留输入，恢复后可重试。

## 验证

```bash
npm test
npm run build
npm run test:harness
```

普通测试不连接数据库或外部模型。`test:harness` 启动真实 SDK 子进程与本地模型请求桩，验证模型协议、低推理参数、无工具调用及凭证脱敏。

数据库集成测试使用临时隔离数据库，结束后自动删除。通过临时环境变量 `WORKBENCH_ADMIN_DATABASE_URL` 提供管理员连接，再运行：

```bash
npm run test:integration
```

也可提供名称包含 `_test` 的 `TEST_DATABASE_URL`，测试仅使用该测试库。覆盖任务持久化、旧缓存迁移、状态保护、事务回滚、失败重试及并发同步。测试不会启动浏览器。

## 代码结构

- `server/`：接口、数据库迁移、记录适配、同步调度及 Harness 执行器。
- `shared/`：前后端数据类型。
- `src/`：工作台页面、待办、日报、来源证据与归档动效。
- `scripts/`：Compose 初始化、启动及隔离数据库测试入口。
- `compose.yaml`、`Dockerfile`：多阶段镜像与本机 Compose 部署。

`.env`、`.runtime`、构建产物和日志均不进入 Git 或 Docker 构建上下文。代码备注、界面文案、日志和更新说明使用中文。
