# CLAUDE.md

此文件为 Claude Code 在本仓库中的开发与维护提供说明。

## 常用命令

### 本机开发与构建
- **前端开发服务**：`npm run dev`（Vite，监听 `http://127.0.0.1:5173`，API 代理至 `:8787`）
- **后端服务开发**：`npm run dev:server`（`tsx watch server/main.ts`，监听 `http://127.0.0.1:8787`）
- **完整构建**：`npm run build`（按序执行 `npm run build:web` 和 `npm run build:server`）
  - 前端构建：`npm run build:web`（`tsc -b && vite build`，产物位于 `dist/`）
  - 后端构建：`npm run build:server`（`tsc -p tsconfig.server.json`，产物位于 `dist-server/`）
- **生产环境启动**：`npm start`（`node dist-server/server/main.js`）
- **数据库初始化与迁移**：`npm run db:init`（`tsx server/bootstrap.ts`，需配置 `DATABASE_URL`）
- **整理既有事项简介**：`npm run tasks:summarize`（`tsx server/summarize.ts`）

### 测试命令
- **运行单元测试**：`npm test`（`vitest run`）
- **运行单个测试文件**：`npm test -- <path/to/test.ts>` 或 `npx vitest run <path/to/test.ts>`
- **按名称匹配单项测试**：`npx vitest run -t "<test-name>"`
- **Harness 集成测试**：`npm run test:harness`（`RUN_HARNESS_TESTS=true vitest run server/harness.integration.test.ts`，启动真实 SDK 与本地桩验证模型交互与脱敏）
- **本机 PostgreSQL 隔离测试**：`npm run test:integration:local`（默认复用 `postgres18`，自动创建并清理独立测试库与角色，不访问业务数据库）
- **PostgreSQL 数据库集成测试**：`npm run test:integration`（`node scripts/integration.mjs`，需提供 `WORKBENCH_ADMIN_DATABASE_URL` 创建临时测试库或提供包含 `_test` 的 `TEST_DATABASE_URL`）

### Docker Compose
- **初始化环境配置**：`bash scripts/setup.sh`
- **构建并后台启动容器**：`bash scripts/start.sh` 或 `docker compose up -d --build workbench`
- **容器运维管理**：`docker compose ps` / `docker compose logs --tail=100 workbench` / `docker compose restart workbench` / `docker compose down`

---

## 核心架构与业务流程

本项目为个人工作台（“我的工作台”），核心能力为：自动采集本机多通道 AI 会话（Codex、Claude Code、WorkBuddy、Zcode SQLite 数据库、Gemini CLI JSONL 及通用 JSON/JSONL），通过 DeepSeek Harness 接入兼容 OpenAI 协议的模型提取工作事项，持久化至 PostgreSQL，展示在 React 前端看板，并支持日报增量整理、周月报数据库归档及日历日志查看。

### 模块结构
- **`server/`（后端服务）**
  - `main.ts` & `app.ts`：Fastify 服务入口，注册 `/api/workbench`、`/api/settings`、`/api/daily-reports`、`/api/tasks`、`/api/sync` 等接口，托管静态文件，接管优雅停机（SIGINT/SIGTERM）。
  - `store.ts` & `migrations.ts`：PostgreSQL `workbench` schema 数据库访问层，管理自动迁移、事项持久化、日报与周月报存储、报告任务检查点和租约、执行记录及游标推进。使用 `pg_try_advisory_lock` 确保同步互斥。
  - `sync.ts`：后台同步核心调度服务。调度多来源扫描、差异比对、消息分批（有界长度截断）、模型抽取，并在事务中推进文件游标与事项入库。
  - `periodicReport.ts` & `reportAutomation.ts`：周月报保持原版日报优先、去重与三段结构，仅接通数据库归档；不自动补生成日报。自动任务按检查点补跑、失败退避重试，并使用数据库租约恢复中断任务。
  - `settings.ts`：工作台配置服务，持久化存储于 `.runtime/settings/workbench.json`（权限 `0600`/`0700`，原子重命名保存）；负责模型密钥脱敏（接口禁止回传明文）、版本冲突检测（`revision`）。
  - `records.ts`、`zcode.ts`、`gemini.ts`、`compatibleRecords.ts`、`sourcePaths.ts`：多渠道采集适配层。过滤工具调用、中间思考、系统提示与附件；Codex/Claude/WorkBuddy 维护字节游标增量，Zcode 监听 SQLite 更新时间，Gemini 重建历史、原消息版本及完整快照撤回；来源变更时失效旧证据，抽取提交核对消息版本；负责本机路径与 Docker 容器路径映射及自动识别通用记录格式。兼容识别缓存写入游标，未变化文件不再次采样；积压消息使用 500 条有界分页。
  - `harness.ts`：DeepSeek Harness 集成（`@deepseek-ai/dsh-sdk-client`）。禁用 bash/pty/mcp 等外部工具，挂载 OpenAI 兼容模型驱动，低推理档位，注入严格 JSON Schema 校验（`resultSchema`），调用 `redact.ts` 脱敏凭据并校验引用消息 ID。
  - `dailyReport.ts`：日报生成与增量整理。按项目与目标归类，生成 30～80 字简报，对超标项单条重新概括而非机械截断。
- **`shared/`（前后端公共契约）**
  - `contracts.ts`：定义 `Task`、`Evidence`、`DailyReport`、`SyncRun`、`WorkbenchSnapshot` 等前后端通信类型。
  - `settings.ts`：使用 Zod 定义模型配置、采集渠道、路径校验及通用字段映射校验规则。
  - `dailyReports.ts`：日报数据结构与文本格式化辅助函数。
- **`src/`（前端界面）**
  - 技术栈：React 19 + TypeScript + Motion + Vite。
  - `src/domain/`：纯领域逻辑，包括工作台状态计算、渠道状态分类、日历算法与自适应轮询逻辑。
  - `src/data/`：数据持久层，`apiRepository.ts` 封装后端接口请求，`localRepository.ts` 负责旧版 localStorage 手工数据迁移，`legacyPeriodicReports.ts` 读取旧版周月报迁移正文，正式周月报以数据库为准。
  - `src/components/`：工作台看板、设置弹窗（支持键盘导航的自定义下拉选择器）、日报弹窗、日志日历、任务面板、`PersonalSpace.tsx` 原版周月报展示、按需加载来源证据及 SVG 电路脉冲动效。

---

## 编码与设计约定

- **语言规范**：代码注释、提交说明、界面文案与文档统一使用中文。
- **安全与脱敏**：任何认证文件、密钥、完整本地绝对路径及工具内部推理严禁传给外部模型；设置接口对外不暴露明文 API Key。
- **并发与版本保护**：
  - 同步服务通过 PostgreSQL 咨询锁（Advisory Lock）防止跨进程并发执行。
  - 设置更新、日报与周月报保存使用 `revision` 乐观锁机制，过期版本返回 409 避免覆盖。
- **查询与预览**：首页只获取当日及手工待办摘要，历史查询分页，证据按需加载；周月报保留原版三段结构，编辑正文保存到数据库。
- **容错设计**：损坏的 JSONL 文件或超大半行在连续失败 2 次后自动跳过并记入数据库，避免阻塞整体同步流程。
