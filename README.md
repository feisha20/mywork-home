# 我的工作台

个人工作台：读取本机 Codex、Claude Code、WorkBuddy、Zcode 和 Gemini CLI 会话，使用 DeepSeek Harness 与火山 Coding Plan 整理工作事项。自动工作记录按来源消息的原始日期（北京时间）直接进入日志，不需要人工完成；手工待办和禅道任务完成后进入日志。日期显示在“工作日志”标题后面，主面板显示今日日志。点击标题右侧的日历图标并选择日期，即可在弹窗查看该日记录；弹窗支持关闭按钮、Esc 和点击遮罩关闭。

点击工作日志右上角的“生成日报”，即可总结当前日期的日志。生成时先按项目、交付成果或主要工作目标归类，再为每类撰写一句简洁总结；同一项目的功能开发、修复、验证和优化合并汇报，通常整理为3～6点，每点建议30～60个字符、最多80个字符，英文每个字母、空格与标点也计入长度，省略测试数量、技术参数及构建部署等过程细节。超长摘要仅对不合格项重新概括，保留已合格的其他条目，完成校验后再保存；不会机械截断内容。独立项目较多时可增加条目。日报只读取日志简介、项目名和状态，不读取会话证据，也不向模型发送本机完整项目路径。

生成的日报与整理标记按日期保存在数据库，刷新页面和重启服务后仍保留。已有日报时入口变为“查看日报”，再次打开直接读取保存内容，不自动重新生成。日志卡片显示“已整理”或“待整理”；新增日志或已整理日志的简介、状态发生变化后，点击“补充整理”即可只处理这些待整理记录，相关进展并入原分类，未涉及的条目保留。保存失败时原日报与整理标记保留，保存版本检查避免并发覆盖。点击“一键复制”可复制包含日期和编号条目的纯文本。历史日志也支持以上操作。日报生成独立于后台同步，不修改原日志、任务状态和同步进度。

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
| `WORKBUDDY_PROJECTS_DIR` | `~/.workbuddy/projects` |
| `ZCODE_DB_DIR` | `~/.zcode/cli/db` |
| `GEMINI_SESSIONS_DIR` | `~/.gemini/tmp` |

挂载目录必须存在；首次运行可创建缺失的空目录。Docker Desktop 需要能够读取这些目录。容器保留会话中原始项目路径，无需挂载项目源码。Harness 运行数据保存在独立卷 `harness-runtime`。

Zcode 使用正式会话数据库 `db.sqlite`，整个数据库目录以只读方式挂载，包含 `db.sqlite-wal` 与 `db.sqlite-shm`，可读取正在使用中的会话。仅提取可见的用户文字和已结束的助手回复，过滤工具结果、推理、系统合成提醒及压缩摘要。按消息及文字片段的更新时间增量读取，以稳定消息标识去重；流式回复结束后再抽取，原始项目路径、父会话及消息时间均保留。目录可通过 `ZCODE_DB_DIR` 自定义，无需读取 Zcode 认证配置。

Gemini CLI 只扫描 `tmp/<项目>/chats` 下的正式 `.jsonl` 或旧版 `.json` 会话，通过 `.project_root` 保留本机项目路径。按[官方会话格式](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)恢复完整历史快照、正文补丁和回退，过滤工具结果、内部思考、系统提示与附件，优先保留用户实际显示的正文。未变化的文件不重读；变化后重建可见历史，按会话、消息及正文版本去重，消息日期仍使用原始时间。嵌套子会话关联父会话。只读挂载会话临时目录，不读取 Gemini 登录凭证或设置，路径可通过 `GEMINI_SESSIONS_DIR` 自定义。

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
- Codex、Claude Code、WorkBuddy、Zcode、Gemini CLI 工作记录直接归档；归档时间单独保存，不会把进行中的工作伪装成已完成。
- 只有手工待办和禅道任务提供完成、恢复待办按钮，芯片右侧统计为今日日志数量。
- 首次回溯起点写入数据库，后续 Codex、Claude Code、WorkBuddy 来源按文件字节游标读取增量，Gemini 在文件变化后恢复可见历史并按消息正文版本去重，Zcode 按数据库记录更新时间读取增量。每轮仍遍历目录并检查文件状态，未变化文件不读取内容；针对工具日志和中间推理提供行级快速预过滤（无需 JSON 反序列化）；文件替换、截断或归档移动可能重读，通过消息标识去重，不会再次抽取成功处理的消息。
- JSONL 文件读取失败、内容无法入库或末尾超大半行连续失败两次后自动忽略同一份文件内容，失败次数写入数据库，重启后仍保留；文件替换、修改或追加后重新尝试。已越过的损坏、超大行仅计为跳过记录，详情显示忽略与跳过数量，不再列入待重试提示。数据库连接故障和模型抽取失败仍保留进度重试。
- 模型只处理未抽取消息（新增及失败重试），每批允许携带最多 6 条历史上下文；成功批次不可重新启动。消息入库与游标推进、抽取结果与成功标记分别通过事务保存，同一事项按 ID 更新。
- 会话组内严格按上下文依赖串行抽取，跨独立会话组支持有限并发（由 `WORKBENCH_SYNC_CONCURRENCY` 控制，默认 3），低推理档位，最长 180 秒；格式无效最多修复一次。同一数据库同时只运行一次同步。
- 修改 `SYNC_INTERVAL_MS` 可以调整同步间隔；`SYNC_ENABLED=false` 关闭启动及定时同步，手动同步仍可运行。界面默认文案按 10 分钟展示。
- 禅道暂未接入；本阶段采集 Codex、Claude Code、WorkBuddy、Zcode、Gemini CLI。

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
| `GET /api/daily-reports/:day` | 读取已保存日报；尚未生成时返回 `null` |
| `POST /api/daily-reports` | 输入 `{ "day": "2026-10-01" }`，已有日报直接返回；输入 `"mode": "append"` 时仅整理新增或更新日志，并保存合并后的日报及整理标记 |
| `POST /api/tasks` | 创建手工事项，输入 `{ "title": "事项" }` |
| `DELETE /api/tasks/:id` | 删除手动新增且未完成的待办；保留删除标记，避免旧缓存重复导入后恢复 |
| `PATCH /api/tasks/:id` | 修改手工或禅道任务状态，输入 `{ "completed": true }` 或 `false`；自动工作记录返回 409 |
| `POST /api/tasks/import` | 批量幂等导入旧手工记录 |
| `POST /api/sync` | 启动后台同步；运行中返回同一执行记录 |
| `GET /api/sync/:id` | 获取执行进度及结果 |

写接口接收 JSON；日期为 ISO 格式，日报按北京时间归档。服务连接失败时保留页面已加载记录，新增失败保留输入，恢复后可重试。

手动待办卡片提供删除按钮，请求失败时保留原记录。核心下方的采集渠道使用固定高度的单排 Logo、短名称和状态点，最多显示五个入口；当前六个渠道中的 Zcode 和 Gemini 收进“更多 +2”，点击即可查看渠道详情；超过五个时前四个保留，第五个以“更多 +N”收纳其余渠道，不再增加卡片行数。绿色表示已接入、橙色表示正在采集、灰色表示待接入或等待扫描、琥珀色表示对应来源存在读取提示。悬停可查看简要状态，点击 Logo、接入数量或同步状态打开详情弹窗，查看全部渠道、会话数量、最近同步结果和合并后的提示；弹窗支持关闭按钮、Esc 和遮罩关闭，并恢复入口焦点。

顶部 QA 标识和站点图标使用橙色主色调；“本机工作台”的绿色状态点表示服务已连接，连接中断时显示橙色“服务未连接”。

底部合并为紧凑同步栏，只显示最近同步时间与结果、必要的提示入口和“立即同步”按钮；新增、更新及读取消息数量在详情中完整保留，不再常驻“工作流就绪，等待下一次推进”等重复文案。渠道图标保存在本机，不依赖外部图片请求。

采集流向始终为「采集源 → 芯片」。同步返回实际新增或改变的记录后，按归属播放一次「芯片 → 待办」或「芯片 → 工作日志」：未完成的禅道任务进入待办，Codex、Claude Code、WorkBuddy、Zcode、Gemini CLI 的工作记录进入来源日期的日志。首次加载、无变化轮询和失败请求不播放分发流光，同批记录按目的地合并，后台停止播放。背景左右连线保留静态轨迹，不再随采集循环播放「待办 → 日志」；只有用户点击完成待办时才播放这条归档路径。

采集连线从单排渠道入口顶部的连接点出发，按入口顺序接入芯片底部的实际引脚。折线在芯片与渠道之间错开收拢，保持同序且不穿过 Logo；中等窗口的横向布局从渠道上方绕到芯片下方。“更多”入口共用一个连接点与引脚，隐藏渠道采集时同步高亮该入口及线路。空闲时绿色装饰流光每 16 秒走完一轮，工作时加快为 4 秒，当前渠道用橙色高亮并加快为 2 秒。空闲流光每秒更新 10 次、工作流光每秒更新 20 次，后台及减少动态效果模式停止播放，尺寸只在窗口或元素尺寸变化时重新测量。未接入渠道的装饰线路不代表真实采集。坐标以 SVG 自身视口测量，渠道组和状态区域尺寸变化时重新对齐。

芯片外圈使用 SVG 圆角方框。工作时橙色虚线与一段高亮光弧沿方框顺时针绕行，每 6 秒一圈、每秒更新 20 次；空闲时恢复静态绿色虚线，后台或减少动态效果模式停止动画。

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

`.env`、`.runtime`、会话 SQLite 数据库及 WAL/SHM 文件、构建产物和日志均不进入 Git 或 Docker 构建上下文。代码备注、界面文案、日志和更新说明使用中文。
