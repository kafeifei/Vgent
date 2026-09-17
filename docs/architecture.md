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
- 认证 `auth: 'auto'`：adapter 自己读 macOS Keychain 的 "Claude Code-credentials"，复用本机已登录的 Claude 订阅；本地 sandbox 没有请求改写代理，adapter 会把真实凭据直接放进 bridge 环境变量并打一条 warning，这是预期行为。

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
- **worktree**：搬 freecode `server/workspace.ts` 的 snapshot / restore（销毁前复验所有权、前后 hash 清点、保护 index blob）。

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
docs/
  ai-sdk/          AI SDK 文档快照
```

## 分阶段

1. **地基**：monorepo、Node 22、ESM、TS、vitest；搬 `sandbox-local`；`HarnessAgent + harness-claude-code` 用 `runAgentTUI` 在本地仓库跑通，再接 Codex。解决 bridge `0.0.0.0` 问题。这是最大不确定性，先验证。
2. **Web MVP**：先出低保真原型定三栏布局和 design token；Hono server 出 UI message stream 和续流；前端 `useChat` + 三栏骨架 + 工具卡片 + 变更文件 / diff 面板；任务持久化按文件；先只挂 Claude Code 引擎。
3. **自研引擎**：`engine` = ToolLoopAgent + 六个工具执行体 + 权限映射，接进同一个 server。
4. **补齐**：子代理、MCP + tool search、skills、记忆、压缩、worktree、diff 视图、切引擎。
5. **桌面**：Tauri 壳，搬 freecode `backend.rs` 和 `prepare-desktop.mjs` 的 Node pin + hash 校验。

## 从 freecode 直接搬的

`server/harness/local-sandbox.ts`、`server/chat-stream.ts`、`server/workspace.ts`（snapshot / restore）、`server/tools.ts`（`resolveToolPath`）、`server/instance-lock.ts`、`src/taskChats.ts`、`src-tauri/src/backend.rs`、`scripts/prepare-desktop.mjs`、AI Elements 的 provenance 做法、真实二进制的 harness 测试写法。

## freecode 的坑，不重复

整库单文件持久化每 40ms 重写；`getState()` 每次广播深拷贝全库；坏文件直接 exit；bridge 源码 string replace；模块级全局 provider 状态；正则匹错误文案判 HTTP 状态；`runtime.ts` 761 行 / `App.tsx` 782 行 god file；skills 全文每步拼进 instructions；`tool-loop-adapter` 重写 agent 循环；`IMPLEMENTATION.md` append-only 180KB；测试用正则匹组件源码文本；根目录 `@ai-sdk/provider` 与内嵌版本错位。

## 已知风险

- harness 全家桶 experimental，patch 可能 break；`@ai-sdk/harness` 把 `ai` 锁精确版本，整条链锁版本一起升。
- 本地 sandbox 跑 Claude Code bridge 官方无先例，freecode 证明可行但用了脏办法，我们要找干净的。
- 自研引擎不走 HarnessV1，resume / compact / permissionMode 是自己的实现，和官方引擎语义可能有差；壳用统一配置抽象盖住。

## 当前状态（2026-09-18，阶段三完成）

三条引擎路全部本地跑通并有真实冒烟测试（`VGENT_SMOKE=1`）。全仓构建绿，约 150 测试。

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

### 明确未做（阶段三之后）

- **自研引擎的 session 管理**：server 把存好的 UI 消息喂回 agent（每轮 `convertToModelMessages` 重放），JSONL 的 `sessionFile` 路径现在只有 `apps/cli` 在用。
- `server` 未做：实例锁（`instance-lock.ts` 还没搬）、harness 引擎用 `detach()` 代替 `stop()` 保温 sandbox、worktree。
- **未跑完的一轮活不过重启（harness 引擎）**：parked session 只在本进程内存里，重启后 bridge 已死。所以 shutdown 和启动恢复都把 `running`（以及 harness 引擎的 `awaiting-approval` / `awaiting-input`）的线程收成 `interrupted`，并把悬着的工具调用写成 `output-error`「服务已重启，请重新发送」——否则客户端会对一个不存在的 turn 提交审批（无状态引擎已经绕开这条，见阶段三进度）。用 `detach()` + `continueStream()` 做跨进程续跑是后续工作。
- `askUserQuestions` 在 TUI 里不可用（需要 Web `useChat`）。
- 子代理、MCP + toolSearch、skills 索引、记忆、手动 compact、`@ai-sdk/otel`。
- Web 已做出工作台骨架（见上），**明确留到后面的**：右栏的文件 / 终端 / 计划三个 tab（现在是「下一步接入」占位）、`@` 引用、context ring、composer 上方的「审查 +N −M」pill、checkpoint / 回退、麦克风、侧聊 `/side`、worktree pill、运行位置下拉（写死「本机」）、模式 chip（写死 `Agent`）、子代理的嵌套流、虚拟滚动、无障碍焦点管理。

下一步：阶段四——排序是 (1) 先做 Tauri 桌面壳（搬 freecode `backend.rs` 和 `prepare-desktop.mjs` 的 Node pin + hash 校验），让工作台变成一个能双击打开、用户愿意日常挂着的 app；(2) 每个任务一个 worktree 的隔离；(3) 给自研引擎补子代理 / MCP + tool search / skills；然后才是 UI 抛光清单：右栏的文件 / 终端 / 计划三个 tab、`@` 引用、context ring、composer 上方的「审查 +N −M」pill、「本任务内一直允许」。顺路修两个已知 bug：parked 的 Claude Code session 晾久了凭据过期（401，见阶段二真机副作用）、harness 的未跑完一轮活不过重启（`detach()` + `continueStream()`）。
