# Vgent 架构方案

> 2026-09-17 第三版。基于 AI SDK 7.0.105、`@ai-sdk/harness` 1.0.115 的实际 API，以及对隔壁 `../freecode`（koma-next）的审查结论写成。

## 一句话

Vgent 是一个 **Web 优先**的本地 coding agent 工作台，底下可换引擎：现成的 Claude Code、Codex，以及我们自己用 AI SDK 造的引擎。终端入口用官方 `@ai-sdk/tui` 原样提供，不自研 TUI。

## 三个决策

**0. 主线只有三条边界清楚的路。** Claude Code 原生、Codex 原生、自研引擎（API key / Gateway / Codex 订阅）。每条路里循环、工具、模型属于同一方，不做跨方混搭。

**1. 壳只认 AI SDK 的 `Agent` 接口。** `ToolLoopAgent` 直接实现它；Claude Code / Codex 走官方 `HarnessV1` 适配器 + `HarnessAgent`，用官方文档那 20 行 session 闭包包成 `Agent`。自研引擎就是一个裸 `ToolLoopAgent`，**不包成 HarnessV1**。freecode 的 `tool-loop-adapter.ts` 为了对齐 harness 契约自己重写了整个循环，绕开了 SDK 的审批、prepareStep、子代理，是反面教材。

**2. UI 分三层，SDK 只给下两层。** 状态和协议层用 `@ai-sdk/react` 的 `useChat` / `Chat` / `DefaultChatTransport`；组件层用 AI Elements（官方 shadcn 式源码分发，React + Tailwind）；应用层（布局、侧栏、项目任务、设置、diff、切引擎、审批组织）自己写。终端用 `@ai-sdk/tui` 的 `runAgentTUI`，不改。

**3. 前后端分离，后端是长驻进程。** 本地 coding agent 要持有 session、sandbox、bridge 进程、worktree，这些不是 request-scoped 的，Next.js 路由处理器不合适。后端用独立 Node 服务（Hono，ESM 原生、轻，路由层几乎没有可从 freecode 复用的东西，不必为此选 Express），暴露 UI message stream 端点；前端 Vite + React。桌面壳（Tauri）后期再加，freecode 的 `backend.rs` 可以直接搬。

## 引擎层

### 本地 sandbox（套壳 Claude Code / Codex 的前提）

`HarnessAgent` 要求 `HarnessV1SandboxProvider`。官方只有 Vercel 云端和内存虚拟盘。**直接搬 freecode 的 `server/harness/local-sandbox.ts`**（296 行，进程组 SIGTERM→SIGKILL 升级、abort 全链路、输出字节上限、环境变量白名单），改中文错误文案，补一个 `HarnessV1SandboxProvider` 外壳。它不是安全边界，安全靠 `permissionMode` + `toolApproval`。换成 `createVercelSandbox` 就是云端模式，壳不改。

已查明的 bridge 细节（2026-09-17，harness-claude-code 1.0.119 / harness-codex 1.0.117）：
- `host: "0.0.0.0"` 硬编码在两个 bridge 的 `WebSocketServer` 构造里，没有配置项。我们**不改源码**：`sandbox-local` 的 `loopbackOnly` 选项给 spawn 出的进程注入 `NODE_OPTIONS=--import=<loopback-preload.js>`，预加载脚本 monkeypatch `net.Server.prototype.listen`，把 `0.0.0.0` / `::` 改写为 `127.0.0.1`。对 bridge 升级免疫，且只影响我们自己 spawn 的进程。同时向上游提 issue 要 bind 选项。
- adapter 把 bootstrap 装进 `<sandbox 默认工作目录>/.harness-bootstrap/<harness>/`（`pnpm install --frozen-lockfile`，只跑一次），session 数据写 `<默认工作目录>/.agent-runs/<id>/`。所以 **sandbox 的 cwd 必须是 `~/.vgent/harness/<harness>/`**，用户仓库通过 `sessionWorkDir` 单独传。freecode 是覆写 `getBootstrap` 用符号链接跳过安装，我们用官方 bootstrap 原样跑，只是给它一个持久目录。
- bridge 端口用 `port: 0` 让 bridge 自选，sandbox 开 `allowDynamicPorts`。
- 认证**不用** `auth: 'auto'`：那样 adapter 会自己读 macOS Keychain 的 "Claude Code-credentials"，把解析到的 OAuth token 当静态环境变量塞进 bridge（本地 sandbox 没有请求改写代理，只能裸转发），停在审批上的一轮吊着 bridge 时 token 会过期成 401。改成传一个显式的认证环境（见「阶段四进度」），bridge 里的 `claude` CLI 自己读钥匙串、自己刷新。

### 自研引擎 `@vgent/engine`

一个 `ToolLoopAgent`。SDK 负责循环、审批、子代理、裁剪、MCP、工具搜索、流协议；手写的只有工具执行体和产品逻辑。

| 能力 | 用什么 |
| --- | --- |
| 主循环 | `ToolLoopAgent`，`stopWhen: isLoopFinished()` 加 token 预算条件 |
| 内建工具 | 自写 `read/write/edit/bash/grep/glob/webSearch/askUserQuestions`，名字对齐 harness 公共工具名，全部通过 `experimental_sandbox` 操作。路径校验搬 freecode `server/tools.ts` 的 `resolveToolPath`（走到最近存在的祖先、审批后复验、拒绝悬空 symlink、写后再查） |
| 权限 | `toolApproval` 函数：`permissionMode` 映射 readonly 放行、edit 按模式、bash 按模式 + 白名单；后期可换 `@ai-sdk/policy-opa` |
| 子代理 | Explore（只读）/ Coder（可写）两个 `ToolLoopAgent` 包成 tool，async generator + `readUIMessageStream` 流式回传，`toModelOutput` 只给摘要。子代理内不能审批，所以只放安全工具或受主 agent 权限模式约束 |
| MCP | `@ai-sdk/mcp` + 全部 `deferLoading: true` + `toolSearch()` |
| Skills | 读项目 `.claude/skills` 等目录，`instructions` 里只放名称 + 描述索引，内容按需 `read`。**不要**像 freecode 那样每步全文拼进 instructions |
| 记忆 | 自定义 tool 落盘 `~/.vgent/memory/<project>/`；Claude 模型可换 `anthropic.tools.memory_20250818` |
| 压缩 | `prepareStep` 按估算 token 触发 `pruneMessages`；手动 /compact 用 `generateText` 摘要 |
| 模型 | 默认 AI Gateway `provider/model` 字串；也支持直连 `@ai-sdk/anthropic` / `@ai-sdk/openai` |
| 观测 | `@ai-sdk/otel`；开发期 `@ai-sdk/devtools` |

### 模型接入 `@vgent/providers`

自研引擎的模型来源分两类：

1. **API key / AI Gateway**：AI SDK 一方 provider（`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google` 等十几家，`@ai-sdk/openai-compatible` 兜底所有兼容接口）或 Gateway 的 `provider/model` 字串。零自研代码。
2. **订阅账号（用户的核心诉求）**：让自研引擎用订阅登录态。厂商态度不同，处理也不同：
   - **Codex / ChatGPT 订阅：做。** Codex CLI 开源且官方支持 ChatGPT 登录，第三方复用登录态的容忍度高。`createOpenAI({ baseURL: chatgpt.com/backend-api/codex, fetch })` 配注入 OAuth Bearer 的 fetch，token 读 `~/.codex/auth.json`（尊重 `CODEX_HOME`），刷新和过期判断用 `@ai-sdk/harness/utils` 的 `refreshOAuthAccessToken` / `isAccessTokenExpiringSoon`。独立包 `@vgent/providers`，默认关闭，UI 明示"非官方支持"。
   - **Claude 订阅：不做 token 直连。** Anthropic 条款把 Claude Code 的 OAuth 凭据限定在 Claude Code 内使用，2025 年有第三方 agent 因此被封的先例，用户判断风险过高。Claude 订阅**只通过 Claude Code harness 引擎原生使用**。
   - **不进主线的实验项：Claude Code 精简模式**（官方 harness + `inactiveTools` 关掉全部内建工具 + 挂我们的工具、skills、审批，等于借 Claude Code 当模型入口）。技术上只是一段配置，但它是两个系统的接缝：模型带着原生工具的先验会去调被关的工具白烧步数；宿主工具每次经 bridge 往返；Claude Code 自带的 compaction / todo / Task 子代理 / 权限提示与我们的机制撞车；且是 experimental 家族里被踩得最少的路。用户和我一致判断 bug 会多，**先不做**，留作将来有明确需求时的一两天实验。
   - 通用原则：引擎和 UI 只依赖 `LanguageModel` 类型；token 不落日志、不落我们自己的存储。

## 后端 `@vgent/server`（Hono）

- **端点**：`POST /chat/:threadId` 返回 UI message stream（`createAgentUIStreamResponse`）；`GET /chat/:threadId/stream` 续流；`GET /state` SSE 推项目、线程、审批、子代理状态；项目、线程、设置、worktree 的 REST。
- **可重放流**：搬 freecode `server/chat-stream.ts` 的思路，每轮一个 chunk hub，持久化消息和所有重连客户端都从它重建。
- **持久化**：`~/.vgent/` 下**一个线程一个文件** `threads/<id>.json` 加小索引，设置和项目单独存。**不做** freecode 那种整库单文件每 40ms 全量重写；写用 temp + rename 并 fsync 父目录；解析失败把坏文件改名 `.corrupt-<ts>` 后继续，不 exit。
- **错误**：typed error 带 `status`，HTTP 层按类型映射。**不用**正则匹错误文案判状态码。
- **状态**：所有 provider / 认证 / 目录配置通过 `createXxx(dataDir)` 注入，无模块级可变状态。
- **认证**：始终 mint token 写入 `connection.json`，不区分桌面与否。
- **任务运行**：run 的 finally 里先释放槽位再做可能抛错的清理，`run.done` 创建时就挂 catch。
- **worktree**：`packages/server/src/workspace.ts`，搬 freecode 的 snapshot / restore（销毁前复验所有权、前后 hash 清点、保护 index blob），阶段四已落地，见「阶段四进度」。
- **静态**：`packages/server/src/static.ts` 的 `registerStatic` 在 `/api` 之外兜底吐 `apps/web/dist`（SPA fallback），`--web-dist` / `VGENT_WEB_DIST` 指定目录，桌面壳和浏览器共用同一个 `#token=` 入口，不需要第二个前端服务。
- **模型目录**：`packages/server/src/models.ts` 的 `createModelCatalog`，`GET /api/engines/:engine/models` 按 engine 现查（Codex 在线接口 → 本地缓存 → 内置兜底，10 分钟缓存 `?refresh=1` 强刷），不写死清单。

## 前端 `@vgent/web`（Vite + React）

### 定位：编码工作台，不是聊天软件

freecode 的界面是通用聊天软件的皮（左侧聊天列表、右对齐气泡、底部输入框），看不出在写代码。用户对它的场景定位、视觉、信息架构、交互四方面都不满意。**Vgent 的 UI 不继承 freecode 任何视觉和布局，只搬 `taskChats.ts` 的线程状态逻辑。** **主参照物是 Cursor 3 Agents Window（2026-04 起）**：用户认为 Codex App 做得最好但太复杂，Cursor 在精简和完整之间取得了最好的平衡。对话是"工作日志"，文件变更和工具动作是一等公民。

Cursor 3 Agents Window 式具体指：
- 侧栏按项目（仓库）分组，可切按状态 / 更新时间；条目 = 状态图标 + 标题 + 环境标记（本机 / worktree / 云），运行中显示当前动作 + 耗时，完成显示时间 + `+N −M`；可缩成图标条。
- 工具调用是一行淡灰文字（读取 / 搜索 / 命令），不是带边框卡片；文件改动是 `file +N −M` chip；一轮结束折叠成"工作了 5m 38s" + 总结 / 测试 Markdown，带文件:行、terminal:行 引用链接。
- 用户消息是圆角盒子，滚动时粘顶；hover 可回退到该检查点。
- 上下文：`@` 内联 pill，`+` 按钮加文件 / 图片 / 终端输出，context ring 显示窗口占用；没有输入框上方的 chip 行。
- Composer 内：模式 chip（Agent / Plan / Ask）、模型 + 速度档、麦克风；权限模式在任务头，不在 composer。
- 改动收口 = composer 上方常驻 `审查 +N −M` pill + 运行位置切换；右栏 diffs 视图只有"还原此文件"没有"接受"（引擎直接写盘），可提交 / 开 PR。
- 右栏是工作区：变更、文件、终端、计划（带"构建"按钮和任务清单）、队列（审批 / 提问，Vgent 特有），图标 tab。
- 提问卡片：编号选项 + 跳过 / 继续 + 翻页。空状态有仓库 / 运行位置 / 分支三个 picker。
- 暂不做但布局留余地：多 agent 平铺（3.1）、侧聊 `/side`（3.11）、Projects（2026-09）。

### 信息架构

```
项目（一个仓库）
  └─ 任务（一个线程 = 一个目标，可绑定 worktree、引擎、模型、权限模式）
       └─ 轮次（用户输入 → agent 的工具调用序列 → 回复）
```

- 左栏（窄，可收起）：项目切换 + 该项目的任务列表，任务带状态（运行中 / 等审批 / 等回答 / 完成 / 失败）和改动文件数。
- 中栏（主体）：当前任务的工作日志。工具调用是一行文字（图标 + 动作 + 目标 + 耗时），diff 类工具卡片可展开看 diff；改动收口是 composer 上方常驻的审查 pill；用户输入是圆角盒子，滚动粘顶；reasoning 折叠。
- 右栏（默认收起）：本任务的**变更文件列表 + 完整 diff**、终端输出、计划 / 待办、待处理的审批和提问队列。中栏的收口和右栏是同一份数据两个入口。
- 任务头部：引擎、模型、权限模式、worktree 分支，都可就地切换。
- 设置是独立页面，不塞进侧栏。

### 视觉

- 开发者工具审美，深色优先，浅色跟随；等宽字体用于路径、命令、diff，正文无衬线。
- 第一周就把 design token（色板、间距、圆角、字号、阴影）定死在一个文件里，之后所有组件只能引用 token。freecode 在 Build 3 和 Build 20 之间整套风格换掉，就是没锁 token。
- 有一个固定的品牌标记和主色，出现在标题栏和空状态。
- 密度可调（舒适 / 紧凑），但默认比聊天软件紧。

### 交互

- 审批：就地出现在工具卡片上（允许 / 拒绝 / 本任务内一直允许），右栏队列同步；`useChat` 的 `addToolApprovalResponse` + `sendAutomaticallyWhen`。
- 提问（`askUserQuestions`）：就地表单，支持选项和自由输入。
- 运行中可插话（steering）、可停止、可切权限模式。
- 键盘优先：`⌘K` 命令面板（切任务、切引擎、切模型、/compact、新任务），`⌘N` 新任务，`⌘J` 收起右栏。
- 滚动：新内容到达时若用户在底部则跟随，否则显示"有新内容"浮标；进入任务直接定位末尾。
- 子代理：工具卡片内嵌进度流（`preliminary` 结果），不轮询。

### 实现

- 线程层抄 freecode `src/taskChats.ts`：一个任务一个官方 `Chat` + `DefaultChatTransport`，`prepareSendMessagesRequest` 区分建任务和后续轮次，`prepareReconnectToStreamRequest` 续流，`generation` 计数器让 dispose 后的 promise 失效。
- 消息区组件用 AI Elements 做底（Tool、Reasoning、CodeBlock、Terminal、FileTree、Plan、Task、Confirmation），`npx ai-elements add` 拉源码并保留 provenance；**外观全部通过 token 和调用层组合改写**，不保留默认 shadcn 观感。
- 状态拆 hook（`useThreadView` / `usePanelState` / `useComposerState`），传 `actions` 对象；不重演 App.tsx 782 行。
- 样式只用 Tailwind + token，不另写全局 CSS。
- 第二阶段先出低保真原型（HTML 或 Figma）定布局和 token，再写组件。

## 终端 `@vgent/cli`

`runAgentTUI` 原样：本地 `Agent` 直接传 `agent`；连远程 server 传 `DefaultChatTransport`。用途是开发调试和无头环境，不承担产品体验。

## 仓库结构（pnpm monorepo）

```
packages/
  sandbox-local/   HarnessV1SandboxProvider，跑在宿主机（搬 freecode）
  tools/           内建工具执行体，基于 Experimental_SandboxSession
  engine/          自研引擎：ToolLoopAgent + 工具 + 权限 + 子代理，本身是 Agent
  providers/       模型接入：Codex 订阅 provider（opt-in）+ API key / Gateway 工厂
  engines/         三种引擎统一注册为 Agent（HarnessAgent 闭包、ToolLoopAgent）
  server/          Hono 服务：chat stream、状态 SSE、持久化、worktree
apps/
  web/             Vite + React + useChat + AI Elements
  cli/             runAgentTUI 入口
  desktop/         Tauri 2 桌面壳，`src-tauri/` + `scripts/prepare-desktop.mjs`
docs/
  ai-sdk/          AI SDK 文档快照
```

## 分阶段

1. **地基**（完成）：monorepo、Node 22、ESM、TS、vitest；搬 `sandbox-local`；三条引擎路本地跑通，解决 bridge `0.0.0.0` 问题。
2. **Web MVP**（完成）：低保真原型定三栏布局和 design token；Hono server 出 UI message stream 和续流；前端 `useChat` + 三栏骨架 + 工具卡片 + 变更文件 / diff 面板；任务持久化按文件。
3. **自研引擎**（完成）：`engine` = ToolLoopAgent + 六个工具执行体 + 权限映射，接进同一个 server，三引擎在注册表里对齐。
4. **补齐**（完成）：Tauri 桌面壳、原生选文件夹、worktree 隔离、子代理 + MCP + tool search + skills、动态模型目录、`pnpm start`；见「阶段四进度」。
5. **UI 抛光 + 发布工程**（进行中）：右栏文件 / 终端 / 计划 tab、`@` 引用、context ring、「审查 +N −M」pill、reclaim/restore 与 MCP 设置 UI、记忆 + 手动 compact；按需再做签名 / 公证 / 自动更新 / Windows。

## 从 freecode 直接搬的

`server/harness/local-sandbox.ts`、`server/chat-stream.ts`、`server/workspace.ts`（snapshot / restore）、`server/tools.ts`（`resolveToolPath`）、`server/instance-lock.ts`、`src/taskChats.ts`、`src-tauri/src/backend.rs`、`scripts/prepare-desktop.mjs`、AI Elements 的 provenance 做法、真实二进制的 harness 测试写法。

## freecode 的坑，不重复

整库单文件持久化每 40ms 重写；`getState()` 每次广播深拷贝全库；坏文件直接 exit；bridge 源码 string replace；模块级全局 provider 状态；正则匹错误文案判 HTTP 状态；`runtime.ts` 761 行 / `App.tsx` 782 行 god file；skills 全文每步拼进 instructions；`tool-loop-adapter` 重写 agent 循环；`IMPLEMENTATION.md` append-only 180KB；测试用正则匹组件源码文本；根目录 `@ai-sdk/provider` 与内嵌版本错位。

## 已知风险

- harness 全家桶 experimental，patch 可能 break；`@ai-sdk/harness` 把 `ai` 锁精确版本，整条链锁版本一起升。
- 本地 sandbox 跑 Claude Code bridge 官方无先例，freecode 证明可行但用了脏办法，我们要找干净的。
- 自研引擎不走 HarnessV1，resume / compact / permissionMode 是自己的实现，和官方引擎语义可能有差；壳用统一配置抽象盖住。

## 当前状态（2026-09-18，阶段六完成）

三条引擎路全部本地跑通并有真实冒烟测试（`VGENT_SMOKE=1`）；桌面壳、worktree 隔离、子代理/MCP/skills、动态模型清单、`pnpm start` 全部落地。全仓构建绿，`pnpm test` 49 文件 / 376 测试通过（另 5 文件 / 12 测试是 `VGENT_SMOKE` 门控的真机冒烟，默认跳过）。

- `packages/sandbox-local`：freecode 移植，`createLocalSandboxProvider`，`loopbackOnly` 预加载已验证 bridge 只绑 127.0.0.1。
- `packages/engines`：`createClaudeCodeEngine` / `createCodexEngine` → `{ agent, session, dispose }`，`toTUIAgent`，共享逻辑在 `shared.ts`。仓库路径靠覆写 `doStart` 传 `sessionWorkDir`。Claude 保留真实 HOME 复用登录（副作用：`~/.claude/CLAUDE.md` 影响回复）；Codex 用隔离 `CODEX_HOME`（真实 `~/.codex/config.toml` 与 pinned SDK 不兼容），登录态走 env 转发不受影响。Codex 的 permissionMode 只能 `allow-all`，SDK 构造时自己抛错。
- `packages/providers`：`createCodexSubscriptionModel`（真跑通；接口只支持流式、无 content-type、`response.completed` 的 output 为空需从 `output_item.done` 拼；`originator: codex_cli_rs` 可配）、`createApiKeyModel`（Gateway）、`describeSubscriptionAuth`。无任何 Claude 凭据代码。
- `packages/tools`：`createCodingTools({ sandbox?, workDir })` → read/write/edit/bash/grep/glob。grep/glob 走宿主 fs（sandbox 接口没有目录列举）。
- `packages/engine`：`createVgentEngine({ model, repoPath, permissionMode, sessionFile })` → 裸 `ToolLoopAgent`。权限映射 `toolApproval`（bash 分段白名单），超预算 `pruneMessages`，`askUserQuestions` 无 execute（TUI 不支持，Web 用）。冒烟用 `codex-subscription:gpt-5.5` 通过。
- `apps/cli`：`vgent --engine claude-code|codex|vgent [--model] [--repo] [--permission] [--session]` → `runAgentTUI`。

### 阶段二进度

- 2026-09-17：Web 低保真原型完成，在 `docs/prototype/`（静态 HTML，零依赖，`python3 -m http.server --directory docs/prototype` 或 `.claude/launch.json` 的 `prototype` 配置打开；`tokens.html` 看 token，`index.html` 看工作台）。2026-09-17 晚按用户要求改为对齐 Cursor 3 Agents Window（第一版参照的是 2025 侧栏 Composer，已废弃），观察笔记在 `docs/prototype/cursor3-notes.md`。
- `docs/prototype/tokens.css` 是 design token **唯一来源**，按 Tailwind v4 `@theme` 命名空间命名，颜色分原始色阶 + 语义层，组件只许引用语义层；之后原样搬到 `apps/web/src/tokens.css`。accent 定为琥珀（oklch 0.80 0.155 72），全局唯一响亮色，用途限五处；深色默认，浅色单独调过；密度 comfortable / compact 两档。
- 已定布局：左栏 240 可收起、中栏自适应、右栏默认收起展开 380；顶部 36px 窗口条；中栏 = 粘顶任务头 + 滚动日志 + 粘底 composer，日志正文最大宽 860。
- token 相关的五个待拍板问题已于 2026-09-17 定稿，见 `docs/prototype/README.md` 的
  "已拍板（2026-09-17）"一节；状态点形状区分已落地到 `prototype.css`。
- 2026-09-17：`packages/server`（`@vgent/server`，Hono）落地，`node packages/server/dist/main.js` 或 `pnpm server` 起，只听 127.0.0.1，启动 mint token 写 `connection.json`(0600)，Host 非 loopback 一律 403，两个 SSE GET 额外接受 `?token=`。端点：`/api/health`、projects / threads / settings 的 REST、`POST /api/chat/:threadId`（UI message stream）、`GET /api/chat/:threadId/stream`（无活动 run 返回 204）、`POST /api/chat/:threadId/stop`、`GET /api/state`（SSE，50ms 去抖，一次序列化广播给所有客户端，15s keepalive）。
- 可重放流：一轮一个 chunk hub（`chunk-hub.ts`），append-only buffer + 订阅者集合，重放和实时 tail 同一条代码路径；服务端自己也订阅一份用 `readUIMessageStream` 重建助手消息，落盘和所有客户端因此共享同一份真相。`interrupt()` 把未终结的工具调用补成 `tool-output-error`、把开着的 text/reasoning 补 end。
- 持久化：`~/.vgent/`（`VGENT_DATA_DIR` 可覆盖）下 `projects.json`、`settings.json`、`threads/index.json` + 一任务一文件 `threads/<id>.json`；harness resume state 单独放 `threads/<id>.harness.json`(0600)，**永不出 HTTP/SSE**（可能含 bridge 凭据）。写一律 temp + fsync + rename + fsync 父目录，解析失败改名 `.corrupt-<ts>` 继续跑；同一线程的写走 per-id promise 链，中途节流保存（≥1s）不可能压过最终保存。索引丢了扫 `threads/*.json` 重建。
- resume 策略：线程 id 即 harness `sessionId`。**只有跑完的一轮**才 `session.stop()` 拿 resume state 落盘，下一轮 `createSession({ sessionId, resumeFrom })`。停在 `awaiting-approval` / `awaiting-input` 的一轮不能 stop：harness 对未完成的 turn 返回的是 continuation payload（里面是**活着的** bridge 的 port + token），而同一个 `stop()` 在 finally 里已经把那个 bridge 杀了，下次拿它 resume 会永久挂死。所以这种轮次把 `EngineRunner` 原地 **parked**（每线程一个，不写 `<id>.harness.json`）：下一轮如果转出来的最后一条是 `role: 'tool'`（审批回执 / 工具结果）就复用同一个 session 继续 `stream()`；如果是新的 user 提问就 `session.destroy()`、把历史里悬着的工具调用收成 `output-error`、再用上一次**跑完**的 resume state 起新 runner。一轮的完整消息数组原样交给 `HarnessAgent.stream()`——它自己取最后一条 user 消息，而审批续跑要靠数组里上一条 assistant 消息的 `tool-approval-request` 才能解出 approval id。run 在 finally 里先释放槽位再停引擎，同线程下一轮 start 前等这次清理结束；`stop()` / `stopAll()` 对 `run.done` 设 10s 超时（可配），引擎赖着不退也不会卡死槽位和 SIGTERM。
  - **resume 出来的 session 必须先转成 attach 态**（`packages/engines/src/claude-code.ts`）。`stop()` 落盘的 payload 里没有 bridge 坐标，adapter 拿它重启时走的是 *rerun* 分支（`rerunContinue: true`），而 rerun session 的每一次 `continueTurn`——包括审批续跑——都会先往 bridge 发一条 `{ type: 'start', prompt: 'Continue.', resumeSessionId }` 重开对话，Claude Code 于是把上一轮那个没回执的 `tool_use` 记成 `User rejected tool use`，审批 `approved: true` 白发。所以 `createSession({ resumeFrom })` 之后立刻 `session.detach()` 再用返回的（带 bridge 坐标的）payload 重建一次 session：走 attach 分支，`rerunContinue` 为 false，审批才按审批处理。只有**第一轮**（无 resume state）可以跳过这一步。
  - 落盘的消息数组里不会出现 `parts: []` 的 assistant 消息：一轮如果没产出任何可渲染 chunk（比如 hook 直接报错），就原样保留历史，不塞空壳。
- 引擎注册表只接了 Claude Code；`codex` / `vgent` 占位，`create` 抛 501 `NotImplementedError`。错误一律 typed（`status` + `code`），HTTP 层按 `instanceof` 映射，不匹文案。流里出现 `error` part 的一轮落盘为 `status: 'error'` + 错误文案（助手消息按已生成的原样保留）。
- 2026-09-17：`apps/web` 最初起的是一次性冒烟客户端（Vite + React，token 从 `#token=` 读一次存 sessionStorage、`useChat` + `DefaultChatTransport`），同日被下面的工作台替换。
- 真机副作用：sandbox 保留调用者的真实 `HOME`，所以用户全局 `~/.claude` 的 hooks 会作用在 Claude Code 引擎里——实测一次 Write 被用户自己的 hook 拦下，以 stream error 的形式冒到 UI。
- 2026-09-17：`apps/web` 换成**真正的工作台**（阶段二步骤 3a），冒烟客户端删除。Tailwind v4 + `src/tokens.css`（`cp` 自 `docs/prototype/tokens.css`，`tokens.test.ts` 逐字节比对）+ 一个 `index.css` 里的 `@theme inline`，把语义层映射成工具类（`bg-bg-elevated`、`h-row-tool`、`w-sidebar`…）。tokens.css 是无 layer 的，优先级高于 Tailwind 的 `@layer theme`，所以 `--color-bg: var(--color-bg)` 这种同名自引用不会死循环，`data-theme` / `data-density` 的运行时覆盖照常生效。同一个 `@theme inline` 还搭了一层 **shadcn token 桥**（`--color-background` / `--color-primary` / `--color-muted` …），取来的组件不改一行源码就长成 Vgent 的样子；注意 shadcn 的 `accent` 是「hover 表面」不是品牌色，所以它映到 `--color-bg-hover`，我们自己的品牌色叫 `brand`。
- AI Elements 走**注册表直取**，不用交互式 CLI：`apps/web/scripts/fetch-ai-elements.mjs`（零依赖 Node）拉 `conversation` / `message` / `reasoning` / `tool` / `code-block` / `shimmer` / `confirmation`，再按各自的 `registryDependencies` 递归拉 `new-york-v4` 的 shadcn 原语（button、button-group、tooltip、collapsible、badge、select、alert、separator），写进 `src/components/ai-elements/` 和 `src/components/ui/`，重写 `cn` / `@/registry/*` 导入到我们的 `@/` 别名，并把每个文件的 URL、注册表 JSON 的 sha256、本地 sha256 和补丁清单记进 `provenance.json`（`--check` 复查漂移）。`response` 没有独立的注册表条目，streamdown 渲染器是 `message` 里的 `MessageResponse`。四类补丁：`cn` 占位、registry 别名、缺失的 `import * as React`、两处 `exactOptionalPropertyTypes` 不兼容（reasoning 的 `onOpenChange`、shimmer 的 `style` 断言）。源码提交入库（source-distributed 是它的设计）。
- 线程层是 freecode `taskChats.ts` 的移植（`src/lib/threadChats.ts`）：一线程一个官方 `Chat`，懒建时拉 `GET /api/threads/:id` 灌历史；`observeThreads(summaries)` 对活线程 `resumeStream()`（有 `resuming` 去重），对结束的线程走 `refreshIfStale`——只在 `chat.status === 'ready'` 且 `summary.updatedAt` 变了时才重拉快照；`generation` 计数器 + `dispose()`；没有 rollback（服务端没有这个路由）。**`sendAutomaticallyWhen` 必须挂在 `Chat` 构造上而不是 `useChat` 上**——`useChat({ chat })` 只认 `chat`，不再传 `resume`：顺序是先把历史（`GET /api/threads/:id`）灌进去，`threadChats` 再自己调 `resumeStream()` 接上续流；挂错地方的症状是审批点了「允许」没有任何请求发出、线程永远停在 `awaiting-approval`。
  - **SDK 限制与规避**：`ai@7.0.105` 的 `Chat` 给 `trigger: 'resume-stream'` 建重放状态时是从空白消息起步的（`lastMessage: trigger === "resume-stream" ... ? void 0 : snapshot`，`ai/dist/index.js:21959`），所以重放一个**续接**上一条 assistant 消息的轮次（`start` 复用同一个 messageId，随后是 `tool-approval-response` / 工具输出 chunk）会因为找不到对应 part 抛出 `No tool invocation found for approval ID`，整轮跟着丢。规避在客户端 `src/lib/resumeChunks.ts`（`ResumableTransport` 里的 `withResumePrelude`）：续流时如果 `start` 之后第一个 chunk 指向一个这条流从未建过的 part，就先把已经 hydrate 到的那条尾部 assistant 消息重放成对应 chunk，再继续走真正的流。更干净的替代方案留到以后：让服务端 `GET /api/chat/:id/stream` 自己把重放做成自包含的（往 chunk hub 里预置那条尾部 assistant 消息的 chunk，类似 freecode 的 `snapshotChunks`）——这两种规避不能同时做。
- UI 按 `docs/prototype/` 落地：三栏 grid（240 / 自适应 / 380，⌘B 收成 48px 图标条、⌘J 开右栏）、36px 窗口条、粘顶任务头（引擎 / 模型 / 权限胶囊 + 停止 + 右栏角标）、`Conversation` 当滚动容器（自带跟随和回到底部按钮，取代原型手写的「有新内容」浮标）、用户消息圆角盒子且最近一条粘顶、工具调用一行 muted 文字（读取 / 搜索 / `$` / 写入 / 编辑 / 子代理，展开看 `CodeBlock` 输入和输出）、一轮结束折成 `查看 N 步`（没有计时数据，用步数）、就地审批卡片和 Cursor 式一问一页的提问卡片、composer（Enter 发送、自动长高、模型 chip）、空状态（仓库 picker + 大输入框）、右栏图标 tab（只有「队列」有内容）、⌘K 命令面板、toast。`App.tsx` 57 行，其余拆进 `src/app` / `src/features/{sidebar,worklog,composer,taskheader,rightpane,empty,cmdk}` / `src/lib`。
- 服务端小改动：一个还叫「新任务」的线程收到第一条 user 消息时，用它第一行非空文本（trim、≤60 字）自动命名（`deriveThreadTitle`，`runs.ts`）；显式起过名的线程不动。
- 401 统一处理（`src/lib/api.ts` 的 `reportUnauthorized`）：无论是普通请求还是 `useServerState` 的 SSE 探测（`EventSource` 拿不到状态码，靠 `probeToken` 额外探一次）撞上 401，都清掉存的 token、停掉 SSE 重连、把 UI 打回 token 输入屏；`App.tsx` 监听 `hashchange`，URL 里再出现 `#token=` 会重新读取。
- 真机副作用：一个 parked 在 awaiting-approval、晾了几分钟才去审批的线程，续跑时以 `HTTP 401: authentication_failed`（harness 记的原文是 `harness stream error: HTTP 401: authentication_failed`）失败；本地沙箱没有请求改写，adapter 是在 `spawn` 时把 Claude 的真实凭据一次性转发进 bridge 的环境变量（harness 为此警告 "Falling back to less secure credential forwarding"），bridge 晾得越久，转发进去的 token 就越可能过期。同一提问换个新 session 立刻就能跑通。记为已知风险，缓解方案待定（parked 会话加空闲超时 / 每轮重新读凭据）。
- 2026-09-18：右栏「变更」diff 面板（阶段二步骤 3b）落地。服务端：`packages/server/src/git.ts` 的 `createGit({ timeoutMs = 15s, maxDiffBytes = 1 MiB })`（`execFile('git')`，`GIT_OPTIONAL_LOCKS=0` / `LC_ALL=C` / `GIT_TERMINAL_PROMPT=0`），三个方法 `changes` / `fileDiff` / `revert`；路由 `GET /api/projects/:id/changes`（`{ repoPath, branch, files: ChangedFile[] }`，按路径排序）、`GET /api/projects/:id/changes/file?path=`（`{ path, status, oldPath?, binary, diff, truncated }`，原始 unified diff 文本）、`POST /api/projects/:id/changes/revert`（`{ path }`）。语义是**工作区对 HEAD**，暂存和未暂存合并看（引擎直接写盘，索引状态没意义），加上未跟踪文件（尊重 `.gitignore`）；状态 `modified | added | deleted | renamed | untracked`；`git status --porcelain=v2 -z` 取文件集，`git diff HEAD --numstat -z -M` 取加减行，未跟踪文件自己数行（前 8 KiB 含 NUL 视为二进制）；无提交的仓库（unborn HEAD）对空树 `4b825dc…` 比；diff 超 1 MiB 按行截断并标 `truncated`。路径校验在碰 git 之前：拒绝绝对路径、`..`、反斜杠、NUL、解析后不在仓库内的；再要求路径确实在当前变更列表里（否则 404 `file_not_changed`）。`revert`：HEAD 里有的 `git checkout HEAD -- path`（重命名同时删新路径、恢复旧路径），HEAD 里没有的（added / untracked）从索引移除再删文件，不删空目录。新增三个 typed error：`NotAGitRepoError`(409 `not_a_git_repo`)、`GitUnavailableError`(503 `git_unavailable`)、`GitError`(500 `git_failed`，带截断的 stderr)。测试 `git.test.ts` 用真实 `git` 建临时仓库（无 git 时整文件 skip）。
  - 变更是**按项目**（工作区）不是按任务的：多个任务共用一个仓库工作区，worktree 没做之前分不开；前端用线程的 `projectId` 去拉。
- 2026-09-18：前端：`apps/web/src/features/changes/`（`diff.ts` 解析 unified diff 成带新旧行号的行、`paths.ts` 目录分组和绝对路径转仓库相对、`useChanges.ts`、`ChangesPanel.tsx` + `DiffView.tsx`）。右栏改成受控：`useWorkbench` 的 `right: { open, tab, file }`，动作 `toggleRight` / `setRightTab` / `selectChange` / `openChanges(file?)`；日志里的文件 chip 点了走 `openChanges`，把工具输入里的绝对路径去掉项目 `repoPath` 前缀，不在仓库内就 toast；面板只在右栏开着且在「变更」tab 时拉数据，线程 `updatedAt` 变了自动重拉（引擎写盘时 server 会节流刷新 `updatedAt`），选中的文件 diff 随快照一起重拉；「还原此文件」两步确认（确认还原 / 取消），成功后重拉并清选中；二进制和截断有提示；tab 上有文件数角标。契约类型（`ChangeStatus` / `ChangedFile` / `ChangesSnapshot` / `FileDiff`）从 `@vgent/server` 只作类型 re-export，客户端不会漂移。真机验过：列表 / 计数 / 分支、展开 diff、还原未跟踪文件（磁盘上确实删了）、chip 跳转到对应文件。
- 2026-09-18：本轮踩到并修的 bug：**并行工具调用把审批续跑卡死**。Claude Code 一步里发 `edit` + `write` 两个工具，harness 在第一个的审批处暂停，第二个只到了 `tool-input-start` 停在 `input-streaming`。SDK 的 `lastAssistantMessageIsCompleteWithApprovalResponses` / `…WithToolCalls`（`ai/dist/index.js:22136+`）要求最后一步所有工具部件都已终结，`input-streaming` 挡住自动续发：点「允许」卡片消失、什么都没发、服务端永远 `awaiting-approval`。修法 `apps/web/src/lib/autoSend.ts` 的 `shouldSendAutomatically`：同样的两条规则，但先剔掉 `input-streaming` 部件；服务端不用改，`convertToModelMessages` 本来就跳过 `input-streaming`（`index.js:12046`），续跑消息照样以 `role: 'tool'` 结尾、parked runner 照常接。
- 2026-09-18：同一轮里的第二个 bug：**续跑后 `input-streaming` 部件变孤儿并重复**。审批通过后 harness 在新的 `step-start` 之后用**同一个 toolCallId** 重发 `write` 的 `tool-input-start`；SDK 的 `updateToolPart`（`index.js:7293`）只在当前 step 的部件里按 id 找，找不到就新建，于是落盘的助手消息里有两条 `tool-write`（旧的 `input-streaming` + 真跑的那条），UI 上多一行永远「运行中」；如果审批被拒，harness 不重发，孤儿就永远挂着。修法：服务端续跑时把喂给 `readUIMessageStream` 的尾部助手消息里的 `input-streaming` 部件剔掉（harness 会重发），一轮真正结束（`idle` / `error`）时把还剩的 `input-streaming` 封成 `output-error`「未执行」，parked 的轮次不动；客户端 `turns.ts` 渲染时按 `toolCallId` 去重只留最后一条，直播流里也不会出现旧行。
- 审批卡片上的「本任务内一直允许」仍是 disabled 占位（3a 就是）。

### 阶段三进度

- 2026-09-18：引擎注册表接完三引擎（`packages/server/src/engines/{claude-code,codex,vgent}.ts` + `registry.ts` 的 `createEngineRegistry`），`notImplemented` 501 没了。`EngineFactory.ensureAvailable?(ctx: { thread })` 是异步的，`runs.ts` 的 `start` 在校验消息之前先 `await` 它，不可用的引擎在起任何 run 之前就是个 typed error：新增 `EngineUnavailableError`（`errors.ts`，503 `engine_unavailable`）。三家各自的 `ensureAvailable`：Codex 没登录（`describeSubscriptionAuth()`，读 `~/.codex/auth.json`，尊重 `CODEX_HOME`）→ 503；`permissionMode !== 'allow-all'` 的 Codex 线程 → 400 `codex_permission_mode`（POST /api/threads 和 PATCH 都过 `assertEngineSupportsMode`，`app.ts`）；vgent：模型是 `codex-subscription:` 前缀走同一个登录检查，`provider/model` 形式的网关模型要求 `AI_GATEWAY_API_KEY` 或 `VERCEL_OIDC_TOKEN` 之一非空；Claude Code 没有 `ensureAvailable`（`auth: 'auto'` 可能读钥匙串，没有一个又便宜又诚实的探测法）。
- Codex 引擎（`packages/engines/src/codex.ts`）补了 `sessionId` / `resumeFrom` / `harnessAgent` / `stop()`，跟 Claude Code 对齐；孤儿 sandbox 清理逻辑挪进 `shared.ts` 的 `trackSandboxSessions(provider)`，两个引擎共用。resume 策略照抄 Claude Code：`stop()` → 落 `<id>.harness.json` → 下一轮 `createSession({ sessionId, resumeFrom })`。翻了 harness-codex 1.0.117 的 dist 确认它跟 Claude Code adapter 走同样的 attach（`data.bridge`）/ rerun（`rerunContinue`，`continueTurn` 时发合成的 "Continue." 提示）分支——但 Codex 报 `supportsBuiltinToolApprovals: false` 且这个引擎不传 host tools，一轮 Codex 永远不会停在审批处，`continueTurn` 根本走不到，Claude Code 那套「resume 后先 detach() 再重建 session」的把戏在 Codex 上不需要。Codex 线程从不 park。
- 自研引擎的 server runner（`packages/server/src/engines/vgent.ts`）：裸 `ToolLoopAgent`，`agent.stream({ messages, abortSignal })` → `result.stream`（v7 命名）；线程没指定模型时默认 `DEFAULT_VGENT_MODEL = codex-subscription:gpt-5.5`；没有 `sessionFile`（server 已经存了 UI 消息，每轮 `convertToModelMessages` 喂回去）；`hasUnfinishedTurn()` 恒 false；`finish()` 不写 harness 文件。审批纯粹是消息状态：重发的 assistant 消息转换后跟一条 `role: 'tool'` 消息（带 `tool-approval-response`），下一次 `stream()` 就会执行被批准的工具——新进程里起一个全新的 runner 照样能续上被 park 的一轮。`askUserQuestions` 没有 execute，停在 `input-available` 就是 `awaiting-input`。
- 无状态引擎扛得住重启：`EngineFactory.statelessTurns`（vgent 为 true）；parked map 现在存 `{ runner, stateless }`；`stopAll()` 对 stateless 的 parked runner 只是丢掉 map 条目再 `destroy()`，不碰线程状态；`recoverInterruptedThreads(threads, registry, log)` 对 stateless 引擎的 `awaiting-approval` / `awaiting-input` 不动（`running` 还是照样收成 `interrupted`）。harness 引擎不变（bridge 跟进程一起死）。
- `askUserQuestions` 在任何权限模式下都不再需要审批（`HUMAN_INPUT_TOOLS`，`packages/engine/src/permissions.ts`）：问问题没有副作用；之前 allow-reads / allow-edits 下问一句话都要先审批「我能不能问」。
- 自研引擎冒烟顺手挖出的 provider bug：`packages/providers/src/codex-model.ts` 现在用 `defaultSettingsMiddleware` 告诉 openai responses provider `store: false`。`createCodexFetch` 早就在请求体上强制 `store:false`，但 provider 不知道，回放上一轮 reasoning 时还是发 `item_reference` id，ChatGPT 后端直接拒（`Item with id 'rs_…' not found`）；告诉 provider 真相后它改成内联 `{type:'reasoning', encrypted_content}`，能扛过 UI 消息的往返。`codex-model.test.ts` 钉住。这个 bug 挡住了所有自研引擎的多轮对话。
- PATCH /api/threads/:id 接受 `engine`，只有线程零消息时才准换（409 `engine_locked`「已有对话的任务不能换引擎，请新建任务」）；harness 历史存在引擎自己的 session 里，中途换引擎会悄悄丢掉。
- Web：`TaskHeader` 的引擎胶囊解锁（Claude Code / Codex / Vgent（自研）），新增 `onSetEngine`；切成 Codex 会顺手把 `permissionMode` 设成 `allow-all`，权限胶囊锁住另外两档并提示「Codex 只支持 allow-all」；`EmptyState` 加了引擎胶囊（默认取 `settings.defaultEngine`），新建任务就用选的引擎起；`ModelPicker` 按引擎分表（claude-code：老的两个；codex：只有默认；vgent：默认 + `codex-subscription:gpt-5.5`）；`threadChats.ts` 的 `describeTransportError` 把失败的 POST /api/chat 响应体（SDK 的 `DefaultChatTransport` 把原始 body 塞进 `APICallError.message`）解出来，503 `engine_unavailable` 能在 toast 里看到服务端的中文错误。
- 验证：`pnpm build && pnpm test` → 32 文件 / 231 测试全绿；`VGENT_SMOKE=1` 的服务端冒烟（`server.smoke.test.ts`）：Claude Code 跑一轮 + 模拟重启续上，Codex 跑一轮 + 模拟重启续上（harness 文件被重写），自研引擎写文件卡在审批 → 重启 → 审批续跑真的写了文件，全程没有 harness 文件。浏览器实测（2026-09-18，dev server）：空状态选 vgent 引擎 + allow-reads 起任务，bash `date > now.txt` 停下等审批，刷新页面，点批准，3 步跑完并读回了文件内容；Codex 任务起时权限自动锁 allow-all，`cat hello.txt` 有回应，刷新后历史还在；给有消息的线程切引擎弹出 409 的中文提示。
- 已知未修：**shutdown 竞态**——一轮结束时最终状态先落盘，隔一拍才释放运行槽位、把引擎 park 起来，这个窗口期里如果撞上 `stopAll()`，一个本该继续等审批的无状态线程会被错误标成 `interrupted`（`runs.test.ts` 的 `waitForSlotReleased` 就是绕开它）。`NotImplementedError` 现在没人抛了，类还留着。`EmptyState` 的引擎默认值只在挂载时读一次，settings 如果之后才从 SSE 到达不会重新同步。

### 阶段四进度

- 2026-09-18：**Tauri 桌面壳 `apps/desktop`**（commit 257f818）。Tauri 2.11（`src-tauri/{Cargo.toml,tauri.conf.json,capabilities/main.json,src/main.rs,src/backend.rs}`），`pnpm desktop:build` → `apps/desktop/src-tauri/target/release/bundle/macos/Vgent.app`（约 173 MB，仅 macOS，ad-hoc 签名，无自动更新）。`scripts/prepare-desktop.mjs`：钉 Node 22.23.2（按架构 sha256 校验，缓存进 `apps/desktop/.local/node-runtime/`），sidecar `src-tauri/binaries/vgent-node-<triple>`，server 用 `pnpm deploy --legacy --node-linker=hoisted --filter @vgent/server --prod` 部署进 `src-tauri/resources/server/`（符号链接农场扛不住 tauri 的资源拷贝，改成 0 符号链接、35 MB 的实体拷贝），`apps/web/dist` → `resources/web/`，self-check 用 `--port 0` 拉起部署好的 server 等 connection.json。**`@anthropic-ai/claude-code` / `@openai/codex` 不在部署里**——harness 首次运行时自举（`~/.vgent/harness/<harness>/.harness-bootstrap` 下跑 `pnpm install`），所以首次运行需要联网、且 PATH 上要有 `pnpm`。`backend.rs`：拉起 `vgent-node --enable-source-maps <resources>/server/dist/main.js --port 0 --web-dist <resources>/web`，带 `VGENT_DESKTOP=1`，剥掉 `NODE_OPTIONS`/`NODE_PATH`，PATH 用登录 shell 探测（`$SHELL -lc 'printf %s "$PATH"'`）并把 node 目录前插（Finder 起的 app PATH 很短）；轮询 `~/.vgent/connection.json`（尊重 `VGENT_DATA_DIR`）直到 `pid` 等于子进程 pid（30s 超时），像 freecode 的 `validate_ready` 一样校验 url（http、127.0.0.1、端口、路径 `/`）和 token（32–128 位 `[A-Za-z0-9_-]`）；stderr 尾巴留给报错弹窗；看门狗线程在 server 死掉时弹原生对话框并退出。**没有 stdout/stdin 协议，没有 `initialization_script`，没有 Tauri IPC**：窗口就是 `WebviewUrl::External("<url>/#token=<token>")`，web 端现成的 `#token=` 启动逻辑接管；`on_navigation` 只放行 server 自己的 origin，其它 http(s) 转系统浏览器，弹窗一律拒绝。关闭：给子进程进程组发 SIGTERM，等 20s，SIGKILL，再等 2s；`RunEvent::Exit` 处理是**同步的**，因为 ⌘Q / AppleScript quit 走 `applicationWillTerminate`（detached 线程根本没机会跑——第一版就这么把 server 孤儿掉了）。dev 模式的妥协：`tauri dev` 没有 HMR（`frontendDist` 指到一行的 `placeholder/`），前端开发照旧用 `pnpm server` + `pnpm --filter @vgent/web dev`。图标 `apps/desktop/icon/vgent.svg`（1024²，neutral-900 圆角方块，amber-400 的 V）→ `tauri icon`。5 个 Rust 单元测试。README 在 `apps/desktop/README.md`。
  - server 侧配合：`packages/server/src/static.ts`（`--web-dist` / `VGENT_WEB_DIST`，`serveStatic` + SPA fallback，`/api` 排除在外，静态资源不需要 token），绑定端口从 `serve()` 回调里拿；以及 `main.ts` 里一个真 bug 修复：`server.close()` 在还挂着 SSE 客户端时永远不 resolve，关闭要拖到 ~21s 被 SIGKILL 且留下 `connection.json`——现在 `closeAllConnections()` 跟着一起跑，顺带修好了 web 模式下的 Ctrl-C。
- 2026-09-18：**原生选文件夹**（用户诉求「别让我自己输路径」）。`POST /api/projects/pick` → `packages/server/src/folder-picker.ts` 跑 `osascript -e 'tell me to activate' -e 'POSIX path of (choose folder …)'`（`execFile`，5 分钟超时；取消返回 `{path:null}`；非 darwin → 501 `picker_unavailable`）。桌面和浏览器走同一条路径，没有 Tauri dialog 插件/IPC。Web `components/ProjectPicker.tsx`：主选项「选择文件夹…」，文本输入只在 501 或失败时兜底。`apps/web/src/lib/api.ts` 的 `ApiError` 带上服务端的 `code`/`status`。
- 2026-09-18：**worktree 隔离**（commit b33b176）。`packages/server/src/workspace.ts`（约 470 行，从 freecode 移植裁剪）：`createWorktree`（`<dataDir>/worktrees/<threadId>`，分支 `vgent/<id8>` 从项目 HEAD 切出，所有权文件 `<dataDir>/workspaces/<threadId>.json` 在 `git worktree add` **之前**写，锚点 ref `refs/vgent/tasks/<id>`）、`verifyOwnership`（7 项检查：期望路径、所有权文件 vs 实时 store 的 projectPath、父目录 realpath、存在/是目录/非符号链接、commonDir、`git worktree list --porcelain`）、`inventory`（对排序后的条目+内容做 sha256，碰到特殊文件抛错）、`makeSnapshot`（拷贝文件 + 规范化 index + `git cat-file blob` 把每个已暂存对象写进 `objects/` + 拷贝后复验两份 inventory/index/HEAD，变了就中止「归档期间文件发生了变化」）、`reclaimWorktree`（复验 → 快照 → 再复验 → `git worktree remove --force`；分支和锚点 ref 保留）、`restoreWorktree`（分支 tip == 快照 head 且没被别处签出才复用，否则用 `vgent/<id8>-restored-<hex>`；`git hash-object -w` 重放 `objects/` 并断言 sha；最终 inventory 相等；失败留半成品目录等人工恢复）、`removeWorktree`（分支 tip == baseCommit 才删）。`locked`/busy-set 故意是模块级的。类型：`ThreadRecord.workspace` 上的 `ThreadWorkspace { mode:'worktree', path, branch, baseCommit, reclaimed?, snapshotPath? }`。路由：`POST /api/threads` 接受 `workspace: 'project'|'worktree'`（先建记录再建 worktree，失败回滚）；变更相关路由挪到 `/api/threads/:id/changes*`（按项目的旧路由删掉）；`POST /api/threads/:id/workspace/{reclaim,restore}`；DELETE 先删 worktree（所有权校验失败就中止删除）。`runs.ts` 把 `{ ...project, repoPath: workspace.path }` 传给引擎工厂；已回收的线程 → 409 `workspace_reclaimed`。Web：EmptyState 的「独立 worktree」/「主工作区」切换 pill，TaskHeader 的分支 pill（「已回收」态），变更面板改按线程取数据。测试 `workspace.test.ts`（6 个）+ app.test.ts 端到端。手动验证：worktree 里写的文件项目 `git status` 看不到，DELETE 清掉目录/分支/ref。回收/恢复还没有 UI。
- 2026-09-18：**自研引擎补齐**（commit e91b769）。`packages/engine/src/subagents.ts` —— `explore`（只有 read/grep/glob，`isStepCount(30)`）和 `coder`（除 askUserQuestions 外的全套编码工具，60 步），子代理从 `createCodingTools` 建；子代理工具没法审批，所以 `denyUnapproved` 包一层每个子工具的 `execute`，`decideApproval` 判定需要用户审批就抛「子代理不能执行需要审批的操作」（靠权限模式强制拒绝）；`explore`/`toolSearch` 加进 `READ_ONLY_TOOLS`，`coder` 加进 `EDIT_TOOLS`。`execute` 是文档里那种 async generator（`readUIMessageStream(toUIMessageStream({ stream: result.stream }))`），逐条把累积的子代理 `UIMessage` yield 出去（UI 通过 `part.preliminary` 显示「进行中…」），`toModelOutput` 只给父代理「最后一条文本，截 4000 字」。`onError` 传给 `toUIMessageStream`（SDK 默认会把错误全部掩盖成 "An error occurred."）。`toModelOutput` 只在 `convertToModelMessages(messages, { tools })` 时才生效——所以 `VgentEngine.tools` 对外暴露，`EngineRunner.tools?` 新增，`runs.ts` 在 `runner.stream` 之前用 runner 的 tools 再转一次（第一次转换时 runner 还没建出来）。`packages/engine/src/mcp.ts` —— `McpServerConfig`（`{name, command, args?, env?}` 走 stdio 的 `@ai-sdk/mcp/mcp-stdio` `Experimental_StdioMCPTransport`，或 `{name, url, transport?:'http'|'sse'}`），`prepareMcpTools` 给工具名加 `<name>__<tool>` 前缀并设 `deferLoading: true`，`connectMcpServers` 并行连接，失败只警告不中断；引擎只要有任意工具被 defer 就加 `toolSearch: toolSearch()`。`Settings.mcpServers`（PUT /api/settings 时校验，400 `invalid_mcp_servers`）；server 端 vgent runner 每轮读一次设置（`createSettingsStore(ctx.dataDir)`），建 run 时连 MCP，释放时关。`packages/engine/src/skills.ts` —— `loadSkillsIndex([repo/.claude/skills, ~/.vgent/skills])` 手写解析 `SKILL.md` frontmatter，instructions 里只放「可用技能」的名称 + 描述 + 路径，模型按需 `read` 文件。CLI 新增 `--mcp <file>`（JSON 文件路径）。`@vgent/engine` 加了 `@ai-sdk/mcp@2.0.52`。Web：`toolMeta.ts` 加 explore/coder 分支，`ToolRow.tsx` 的 `ChildTranscript`。测试 +18；真实冒烟（Codex 登录）观察到模型确实在调 `explore`。没有真实 MCP 往返测试（手头没有可用的 MCP server，只单测了 prep/parse + 连不上时只警告这条路径）。
- 2026-09-18：**模型清单动态获取**（commit a772d6c，用户诉求「别写死」）。`packages/server/src/models.ts` 的 `createModelCatalog` + `GET /api/engines/:engine/models`（10 分钟缓存，`?refresh=1` 强刷）。Codex：`GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>` 走 `createCodexFetch`（已确认：ETag 和 `~/.codex/models_cache.json` 一致；`client_version` 必传，取自缓存文件，兜底 `0.155.0`）→ 失败退回缓存文件（`visibility:'list'`，按 priority 排序）→ 再退回内置的 `gpt-5.5`；vgent = Codex 的 id 集合映射成 `codex-subscription:<slug>`，并集 `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` 有一个非空时 `gateway.getAvailableModels()`（`modelType==='language'`）的结果；claude-code = SDK 的三个别名 `sonnet`/`opus`/`haiku`（adapter 只认这三个类型）+ 设了 `ANTHROPIC_API_KEY` 时的 `GET https://api.anthropic.com/v1/models`（不发起任何 OAuth 请求）。`createCodexFetch` 现在从 `@vgent/providers` 导出。Web `ModelPicker` 挂载/切引擎时拉一次，「加载中…」→「默认」+ 条目列表，孤儿模型显示「当前：<id>」，footer 标来源（来自 Codex 在线目录 / 来自 Codex 缓存 / 来自 AI Gateway / 来自 Anthropic API / 内置清单）。`MODELS_BY_ENGINE` 删掉了。7 个单测。
- 2026-09-18：**`pnpm start`**（commit c57198c）。根 script 先全量 build 再 build web 再跑 `main.js`；server 在 `--web-dist` 没传时默认取 `apps/web/dist`（要有 `index.html`）；`--repo` 或 `INIT_CWD`/cwd 的 git toplevel 会被自动注册成一个项目（`app.projects` 挂在 `VgentApp` 上对外暴露）；`isTTY && !VGENT_DESKTOP && static` 时自动开浏览器（`--open`/`--no-open` 可控），打印 `web: http://127.0.0.1:<port>/#token=…`。`main.test.ts` 13 个测试；`isMainModule` 守卫防止被 import 时自动跑。
- 2026-09-18：**parked 的 Claude Code session 晾久了 401** 修了。根因是 `auth: 'auto'`：适配器在 `doStart` 里把订阅 OAuth token 解析一次，当成静态 `CLAUDE_CODE_OAUTH_TOKEN` 塞进 bridge 环境（本地 sandbox 没有 `addRequestTransformations`，走的是裸转发分支），停在审批上的一轮把那个 bridge 一直吊着，token 过期后续跑就是 401。改成显式传一个认证环境（`defaultClaudeCodeAuth()`，`packages/engines/src/claude-code.ts`）：只转发 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` / `VERCEL_OIDC_TOKEN`，**绝不转发 `CLAUDE_CODE_OAUTH_TOKEN`**；传了环境以后 `isHarnessAuthenticationEnvironment` 会短路掉订阅读取，bridge 里的 `claude` CLI 自己读 `~/.claude` / 钥匙串并自己刷新，跟人手跑一样。顺带发现 sandbox 环境白名单里缺 `USER`：钥匙串条目是按 `security … -a $USER` 找的，没有 `USER` 就是「Not logged in」，所以 `createLocalSandboxProvider` 的 `env` 补上了 `USER`。`auth` 现在是 `createClaudeCodeEngine` 的可选项，想退回 `'auto'` 也行。
- 2026-09-18：**harness 未跑完的一轮活过优雅重启**。`HarnessAgentSession.suspendTurn()` 冻结当前轮、留着 runtime / bridge / sandbox 不动，返回可 JSON 序列化的 `continueFrom`（带 `pendingToolApprovals`）。落地：`EngineRunner.suspend?()`（只有 Claude Code 实现，Codex 从不 park）；`HarnessState` 变成 `{ resumeFrom?, continueFrom? }`；`stopAll()` 对有状态的 parked runner 先试 `suspend()` → `saveHarnessState`，线程留在 `awaiting-approval`、工具部件不动，失败才退回原来的 destroy + `interrupted`；`recoverInterruptedThreads` 对带 `continueFrom` 的 `awaiting-*` 线程不动；下一轮 `start()` 里 `continuesTurn` 为真才拿 `continueFrom` 去 `createSession({ sessionId, continueFrom })`，并且第一次 `stream()` 改走 `agent.continueStream({ toolApprovalContinuations, toolResultContinuations })`（用 `collectHarnessAgentTool*Continuations` 从同一份 `ModelMessage[]` 里取）。attach 失败（bridge 真死了）是 typed error `TurnResumeFailedError`，线程收成 `interrupted`、悬着的调用写「服务重启后未能恢复这一轮，请重新发送」，并把 `continueFrom` 从 harness 文件里清掉；`finish()` 写 `resumeFrom` 时也自然把它顶掉。本地 sandbox 的 bridge 本来就是 `detached: true` 起的，实测服务器 SIGTERM 退出后 bridge 和 `claude` CLI 都还活着（stdout 是管道，但它没有在那之后写，没有 EPIPE）。
- 已知未修（阶段四）：阶段三就有的 shutdown 竞态还在；suspend 成功但 `saveHarnessState` 写盘失败会孤儿掉 bridge（只记日志）；suspend 和审批回执之间 bridge 死掉算 `interrupted`；没有真实 MCP 往返测试；`tauri dev` 没有 HMR；选文件夹只支持 macOS；桌面壳和 `pnpm server` 共用 `~/.vgent`（`connection.json` 会被覆盖，用 pid 匹配 shell）；直接 `kill` Tauri 进程会孤儿掉 server；`EmptyState` 的引擎默认值只在挂载时读一次 settings。
- 验证：`pnpm build && pnpm test` → 40 文件 / 289 测试通过（另 5 文件 / 12 测试是 `VGENT_SMOKE` 门控，默认跳过）；阶段四之前记录的 `@vgent/engines`（5 个）/ `@vgent/server`（84 个）真机冒烟、双进程重启验证（见上两条）依旧成立。新增桌面壳验证：`pnpm desktop:build` 产出的 `Vgent.app` 启动后 `connection.json` 的 `pid` 与子进程一致、`/` 返回 web 首页、⌘Q 约 2s 内退出（server 进程一起没了）、点「选择文件夹…」原生对话框前置弹出并可选中目录。

### 阶段五进度

- 2026-09-18：起点 `5261ee2`。五个切片各开独立 worktree 并行做完再合并；冲突几乎全是叠加型，只有一处要手工重排（`useChanges` 从 RightPane 提到 `useWorkbench` 之后 RightPane 的 props 集合）。第 7 条「记忆 + 手动 compact」没做。
- **右栏三个 tab 落地**。「文件」：`packages/server/src/files.ts` 的 `createFiles()`，`GET /api/threads/:id/files?q=&limit=`（`git ls-files -z --cached --others --exclude-standard` 减去 `--deleted`，从文件路径推导目录条目；无 `q` 全量排序、上限 5000 带 `truncated`；有 `q` 按 basename 前缀 > basename 包含 > 全路径子序列排名，默认 50、上限 200）和 `GET /api/threads/:id/files/content?path=`（拒绝绝对路径 / `..`、realpath 必须在根内、必须是普通文件、512 KiB 截断、前 8 KiB 含 NUL 视为二进制）；目录经 `repoPathOf` 解析，所以回收后的 workspace 自然 409。Web `features/files/FilesPanel.tsx`：折叠树（≤ 8 条时展开）、过滤框、点文件用 `CodeBlock` 只读查看。「终端」：`features/terminal/terminal.ts` 的 `collectTerminalEntries(messages)` 用 `toolMeta` 同一套分类挑出 shell 工具部件（vgent `bash` / Claude Code `Bash` / Codex shell），按时间顺序显示 `$ cmd` + 输出 + exit code，只在用户贴底时跟随。「计划」：`features/plan/plan.ts` 的 `latestPlan(messages)` 归一化 Claude Code `TodoWrite`、Codex `update_plan`、自研 `updatePlan` 三种输入形状取最后一次；自研引擎新增 `updatePlan` 工具（`packages/engine/src/update-plan.ts`，整体替换的待办清单，无副作用，进 `READ_ONLY_TOOLS`，instructions 加了一句）。翻 `@ai-sdk/harness-codex@1.0.117` 的 dist 确认 Codex 的计划目前**不会**以工具部件出现（只有内部 `todo_list` 事件，没转成 UI part），所以 Codex 分支现在是不可达的前向兼容代码。
- **Composer `@` 引用**。`features/composer/mention.ts`（`findMention` / `acceptMention` / `mentionSegments`，光标前匹配 `(^|\s)@([^\s@]*)$`）。Composer 新增 `completeFiles?: (q) => Promise<FileEntry[]>`（ThreadView 传 `client.listFiles(thread.id, { q, limit: 12 })`，EmptyState 不传所以 `@` 不动），120 ms 去抖 + 代数守卫丢弃过期响应；弹层在输入框上方最多 12 行，↑↓ / Enter / Tab / Esc，弹层开着时 Enter 不提交，mousedown 接受以保住焦点；接受后替换成 `@<path> `（目录带 `/`）。pill 视觉用镜像层：textarea 文字透明 + 同字体同内边距的 `<div aria-hidden>` 把 `@\S+` 渲染成 `bg-bg-inset` 圆角 span（`px-3xs` 配 `-mx-3xs` 抵消，避免字形位移和真实光标错位）。发出去的是纯文本，引擎自己读文件。
- **usage 落盘 + context ring**。`toUIMessageStream` 只在 `packages/server/src/runs.ts` 调一次，所以 `messageMetadata` 加在那里、三引擎同享：`finish-step` 的 `usage` 和 `finish` 的 `totalUsage` 写进 `UIMessage.metadata`（类型 `UsageInfo` / `ThreadMessageMetadata`，`types.ts`），`readUIMessageStream` 重建时自动落盘。harness 侧按协议核实（`HarnessV1` 定义了 `finish-step { usage }` / `finish { totalUsage }`，Claude Code bridge 把 `input + cache_creation + cache_read` 合成 `inputTokens`），但没真机跑 harness 验证。`models.ts` 透传 Codex 目录的 `context_window` 为 `ModelEntry.contextWindow`（Anthropic 接口没有这项）。Web `features/composer/contextUsage.ts`：`contextUsage(messages)` 取最后一条带 `metadata.usage.inputTokens` 的助手消息，否则按字符 / 4 估算；`ContextRing.tsx` 是 16 px SVG 环，放在审查栏右端，title 形如「上下文 3.8k / 200k（2%）」，估算加「（估算）」，窗口未知加「（窗口大小未知，按 200k 计）」（`DEFAULT_CONTEXT_WINDOW = 200_000` 是唯一常量；模型选「默认」或走 Claude Code / Gateway 时分母就是未知），≥ 80% 换 warning 色。
- **「审查 +N −M」pill**。`useChanges` 从 RightPane 提到 `useWorkbench`（返回 `changes: ChangesView`），线程 `updatedAt` 变了就拉一次快照，不再看右栏开没开；RightPane 改收 `changes` prop。pill 在审查栏 `本机` 右边，N / M 是各文件 additions / deletions 之和（`sumChanges`），0 个文件时隐藏，点击 `openChanges()`。
- **「本任务内一直允许」**。`ThreadRecord.alwaysAllow?: string[]`（工具名）；`PATCH /api/threads/:id` 接受它（非空字符串数组、去重、空数组即删字段，否则 400 `invalid_always_allow`；运行中只改这一个字段的 PATCH 不再 409）。自研引擎：`decideApproval` / `createToolApproval(mode, alwaysAllow)` 在 `allow-all` 之后、读写集合之前查名单返回 `not-applicable`，server 的 vgent runner 传 `ctx.thread.alwaysAllow`（parked 的 runner 续跑同一轮时闭包里还是旧名单，靠下面的客户端自动审批兜住）。harness 引擎不动，审批仍由 harness 发起；客户端 `lib/autoApprove.ts` 的 `pendingAutoApprovals(messages, alwaysAllow)` 在 ThreadView 里对名单内的 `approval-requested` 部件自动 `addToolApprovalResponse({ approved: true })`（`useRef<Set>` 按 approval id 去重），续跑仍走 `sendAutomaticallyWhen`，三引擎统一。ApprovalCard 第三个按钮标「本任务内一直允许 <toolTitle>」，点了先 PATCH 再批准当前这条；权限弹层多一行「一直允许：bash · 清除」。名单按裸工具名、不分引擎（线程有消息后不能换引擎，实际串不了）。
- **worktree 回收 / 恢复 UI**。TaskHeader 分支 pill 改成 Popover：路径、分支、基线 commit，「回收工作目录」（运行中禁用，提示「任务运行中」）/「恢复工作目录」；`api.ts` 新增 `reclaimWorkspace` / `restoreWorkspace`；toast「已回收，快照已保存」/「已恢复」/ 错误文案；状态靠 SSE 回流，无本地状态。
- **设置页**。侧栏齿轮 → `useWorkbench.settingsOpen`，Shell 中栏换成 `features/settings/SettingsView.tsx`（右栏隐藏，Esc / 返回 / 选线程关闭）：默认引擎、默认权限模式（Codex 锁 allow-all）、默认模型（复用 `ModelPicker`）、MCP 服务器列表（编辑 / 删除 / 添加；stdio 是可执行文件 + 参数每行一个 + 环境变量 `KEY=VALUE` 每行一个，http / sse 是 URL；`settings/mcpForm.ts` 的 `toForm` / `fromForm`），一个「保存」整体 `PUT /api/settings`，400 文案显示在 MCP 段下方。`lib/engineOptions.ts` 现在是引擎 / 权限模式清单的唯一来源（TaskHeader / EmptyState / 设置页共用）。可执行文件有「选择…」：`POST /api/projects/pick` 接受 `{ kind: 'folder' | 'file' }`（`folder-picker.ts` 的 `pickFile`，同样 osascript；非 darwin 501 时按钮隐藏，文本框兜底）。
- 顺手修：自研引擎的 `glob` 工具原来只返回文件（`packages/*` 得到空，模型据此断言「没有 packages 目录」），现在目录也返回并以 `/` 结尾（`packages/tools/src/walk.ts` 的 `walkEntries`，`grep` 仍走 `walkFiles` 只读文件）；顺带发现 Node 22 `fs.promises.glob` 的函数型 `exclude` 只在 `**` 递归路径上生效、浅层 `*` 直接跳过，改成模式字符串 `["**/node_modules", "**/.git"]` 两条路径都排除。
- 验证：`pnpm build && pnpm test` → 48 文件 / 359 测试通过（另 5 文件 / 12 测试 `VGENT_SMOKE` 门控默认跳过；含合并 main 的 `c208c9d` 之后）。浏览器实测（`node packages/server/dist/main.js --port 7477 --repo <本仓库>`，自研引擎 + allow-reads + 独立 worktree）：设置页改默认引擎并增删 MCP 条目落盘正确；任务里 `updatePlan` → bash 审批卡片 → 点「本任务内一直允许 命令」后 bash 直接跑（`alwaysAllow: ['bash']` 落盘，权限弹层显示名单）；审查 pill `+1 −0` 出现并能点开变更 tab；文件 tab 列出 worktree 树并查看 `now.txt`；终端 tab 有 `$ date > now.txt`；计划 tab 3 / 3 完成；输入 `@pack` 弹出补全、Tab 接受成 `@packages/` 且镜像层 span 带 pill 类；ring 的 title 是「上下文 3.8k / 200k（2%）（窗口大小未知，按 200k 计）」；回收后 pill 显示「已回收」、审查 pill 消失、worktree 目录删掉、快照留下；恢复后全部回来。每条助手消息的 `metadata.usage` / `totalUsage` 都落了盘。
- 2026-09-18：**阶段五 UI 并回思考等级分支**（`main` 的 `6fcaa14` 合进 `claude/quizzical-khorana-967dd9`）。8 个冲突文件全是叠加型，逐处两边都留：`models.ts` 的 `ModelEntry` 同时带 `reasoningLevels` / `defaultReasoningLevel` 和 `contextWindow`（Codex 目录的一条记录两样都读）；`app.ts` 的 `PATCH /api/threads/:id` 同时接 `reasoningEffort` 和 `alwaysAllow`；Composer 的 chip 行是 `+` · Agent · 模型 · 思考，审查栏是 本机 · 审查 pill · ring；EmptyState 的本地 `ENGINES` / `PERMISSIONS` 删掉改用 `lib/engineOptions.ts`（阶段五已把它立成唯一来源）。只有 `ModelPicker` 要手工重排：阶段五给 `ModelPicker` 加的 `onCatalog`（把目录递给 ring）和本分支提出去的 `useModelCatalog` hook（模型 picker 和思考 picker 共用一次加载）合成 `useModelCatalog(engine, onCatalog?)`，`onCatalog` 放 ref 里而不是进 effect 依赖，`ModelPicker` 只是把 prop 透传进去。
- 验证（合并后）：`pnpm build && pnpm test` → 48 文件 / 367 测试通过（另 5 文件 / 12 测试 `VGENT_SMOKE` 门控默认跳过），`pnpm --filter @vgent/web build` 绿。浏览器实测（`--data-dir` 指向临时目录，项目登记走 `POST /api/projects`）：传本仓库的 worktree 路径回 `note`「…是一个 git worktree，已归到主仓库 …」且项目落在主仓库；空状态五个 pill（仓库 / 本机 / 引擎 / 权限 / 主工作区）齐；Codex 任务选 `GPT-6-Astra` 后 composer 出「思考 低 ▾」，弹层列出 低 / 中 / 高 / 极高 / 最高 / 极致 六级（`/api/engines/codex/models` 同一条记录既有 `reasoningLevels` 也有 `contextWindow` 272000）；一次 `PATCH { reasoningEffort, alwaysAllow }` 两个字段一起落盘；右栏五个 tab 变更 / 文件 / 终端 / 计划 / 队列；worktree 任务改一个文件后审查 pill 显示 `+2 −0`、ring 的 title 是「上下文 0 / 200k（0%）（估算）（窗口大小未知，按 200k 计）」。
- 已知未修（阶段五）：模型选「默认」或模型不在目录里（换机器、旧清单）时思考 chip 整个不显示——不猜等级是有意的，但用户看不出为什么没有这个 chip；任务头的 pill 行不换行，窄窗口 + 右栏展开时分支 pill 被右栏盖住；ring 在模型「默认」时分母未知；harness 引擎的 usage 只按协议核实、没真机跑；`alwaysAllow` 不传给 explore / coder 子代理（它们遇到需审批的操作还是直接拒）；Codex 计划分支不可达；`RightPane` 的 `open` prop 现在没人用；阶段三、四列的已知未修都还在。

### 阶段六进度

- 2026-09-18：起点 `6fcaa14`。按「下一步」清单挑了前四条，实例锁没做（桌面壳用 `--port 0` + connection.json 里的 pid 握手，目前没有撞车场景）。两个切片各开 worktree 并行，叠加型合并，无冲突。
- **记忆（自研引擎）**。`packages/engine/src/memory.ts` 的 `createMemoryTool(memoryDir)`：一个 `memory` 工具，`action: list | read | write | delete`，条目是 `memoryDir` 下平铺的 `.md` 文件（一文件一事实，名字 kebab-case，首行一句摘要；`list` 列文件名 + 首个非空行）；名字含 `/`、`\`、以 `.` 开头一律拒绝，`.md` 自动补。`createVgentEngine({ memoryDir })` 给了才注册，不给 explore / coder 子代理；`buildInstructions` 多一段「记忆」：目录、现有条目清单（`readdirSync`，目录不存在视为空）、何时读何时写。进 `READ_ONLY_TOOLS`（只碰仓库外自己的目录，不审批）。server 端 `engines/vgent.ts` 的 `memoryDirOf(ctx)` = `<dataDir>/memory/<project.name>-<project.id 前 8 位>`（非 `[A-Za-z0-9._-]` 换成 `-`），按项目不按 worktree，同一项目的任务共享。
- **手动 compact（自研引擎）**。`POST /api/threads/:id/compact`：运行中 409 `thread_running`；非 vgent 引擎 400 `compact_unsupported`（harness 引擎的对话在 harness 自己的 session 里，存的消息不是唯一真相）；`awaiting-approval` / `awaiting-input` 409 `compact_pending`；不足 2 条 400 `compact_empty`；模型调用失败 502 `model_failed`（新 `UpstreamModelError`）。`packages/server/src/compact.ts` 的 `compactThread({ thread, model })`：`convertToModelMessages(..., { ignoreIncompleteToolCalls: true })` + `generateText({ model, instructions })` 出摘要（AI SDK v7 没有内建摘要压缩，只有规则式 `pruneMessages`），然后**整体替换**线程消息为两条：user「上下文已压缩，以下是之前对话的摘要：…」（`metadata.compacted = { before, at }`）+ assistant「已了解摘要，继续。」。选整体替换而不是记边界：runner 每轮只从盘上读 `thread.messages`、`mergeIncoming` 只并客户端最后一条，旧客户端复活不了历史；`threads.update` 抬 `updatedAt`，前端 `refreshIfStale` 自动重拉。模型用 `resolveModel(thread.model ?? DEFAULT_VGENT_MODEL)`，测试用 `CreateAppOptions.compactModel` 注入。Web：⌘K「压缩上下文」（仅 vgent 且非运行中）、输入框敲 `/compact`（只认这一条，没做通用斜杠命令）、成功 toast「已压缩：N 条消息 → 摘要」、工作日志在摘要消息上方一行灰字「上下文已压缩（原 N 条消息）」。
- **`alwaysAllow` 下沉子代理**。`createSubagentTools({ alwaysAllow })` → `denyUnapproved` 把名单传给 `decideApproval`；主 agent 批过「一直允许 bash」后 coder 子代理的 bash 不再被拒。
- **任务头换行**。TaskHeader 行拆成左组（标题 + pill，`flex min-w-0 flex-wrap`）和右组（停止 / 右栏按钮，`ml-auto flex-none`），窄窗口下 pill 折到第二行，按钮留在右上。
- **harness 引擎真机核实**。Claude Code：allow-reads 下 bash 审批卡片 → 点「本任务内一直允许 命令」→ 第二条 bash 自动放行（落盘 `alwaysAllow: ["bash"]`，两条 approval 都 `approved: true`），助手消息 `metadata.usage` / `totalUsage` 都在（含 `cachedInputTokens`）。Codex：`totalUsage` 正确，但每步 `usage` 全零（bridge 的 finish-step 不带 usage），ring 原本会显示 0，改成 `inputTokens` 为 0 视作未上报、回退到字符估算。`VGENT_SMOKE=1 pnpm --filter @vgent/engines test` 3 文件 / 5 测试过。
- 验证：`pnpm build && pnpm test` → 49 文件 / 376 测试通过。浏览器实测（`node packages/server/dist/main.js --port 7481 --repo <本仓库>`，`VGENT_DATA_DIR` 指临时目录；自研引擎 + allow-reads + 主工作区）：「记住用户偏好 pnpm」→ `memory/Vgent-2805cba3/user-prefers-pnpm.md` 落盘、`list` 返回 1 条、全程无审批；`/compact` 后消息变两条并带标记行；再问「刚才记住了什么」答对；⌘K 面板有「压缩上下文」；900 px 宽 + 右栏开时权限 pill 折到第二行、右栏按钮仍在右上。注意 `pnpm build` 只跑 `tsc -b`，实测前要单独 `pnpm --filter @vgent/web build`。
- 已知未修（阶段六）：compact 把整段历史换掉，UI 里看不到旧消息（磁盘上也没留快照）；compact 后 ring 到下一轮才有真实 usage；`memory` 工具不给子代理；记忆条目没有 UI 可查看 / 删除；Codex 每步 usage 为零是上游 bridge 行为；实例锁未做；阶段三到五的已知未修仍在。

### 明确未做（阶段六之后）

- **自研引擎的 session 管理**：server 把存好的 UI 消息喂回 agent（每轮 `convertToModelMessages` 重放），JSONL 的 `sessionFile` 路径现在只有 `apps/cli` 在用。
- `server` 未做：实例锁（`instance-lock.ts` 还没搬）。
- `askUserQuestions` 在 TUI 里不可用（需要 Web `useChat`）。
- `@ai-sdk/otel`。
- Web：checkpoint / 回退、麦克风、侧聊 `/side`、运行位置下拉（写死「本机」）、模式 chip（写死 `Agent`）、子代理的嵌套流、虚拟滚动、无障碍焦点管理、任务头换行。
- 桌面壳：Windows / Linux、签名与公证、自动更新、多窗口。

下一步：不再按阶段排路线图，以用户实际用 Vgent.app 的痛点为准，一次一小步。手边的候选：实例锁；compact 前留一份旧消息快照可回看；设置页查看 / 删除记忆条目；给上游提 Codex bridge finish-step 不带 usage 的 issue。发布工程（签名 / 公证、自动更新、Windows）只在有明确需求时再启动。
