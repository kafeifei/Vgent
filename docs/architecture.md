# Vgent 架构方案

> 2026-09-17 第三版。基于 AI SDK 7.0.105、`@ai-sdk/harness` 1.0.115 的实际 API，以及对隔壁 `../freecode`（koma-next）的审查结论写成。

## 一句话

Vgent 是一个 **Web 优先**的本地 coding agent 工作台，底下可换引擎：现成的 Claude Code、Codex，以及我们自己用 AI SDK 造的引擎。终端入口用官方 `@ai-sdk/tui` 原样提供，不自研 TUI。

### 桌面签名与升级（2026-09-29）

桌面交付使用固定的 `dev.vgent.desktop` 和 Developer ID Application（团队 `UVZM439VGU`）。之前的 ad-hoc 签名以每次变化的 `cdhash` 作为 designated requirement，系统授权不能稳定跨版本沿用。`install-app.mjs` 在替换前校验完整签名、bundle ID、Apple 证书链、Developer ID 类型和团队；缺少正式签名就拒绝安装。仍在使用的旧包放到 `/Applications/.Vgent.app.old-<时间>/Vgent.app`，保留有效的 bundle 名称；兼容清理旧命名的包，按启动时间及显式备份路径识别在用进程。正式发布经 Apple 公证；自动更新尚未实现。

### 内置工作台与可选引擎安装（2026-10-08）

App 包含 Rust/Tauri 可执行文件、初始化页、签名保护下的 `bootstrap.json` 和完整的 `workbench.tar.gz`（Node、服务端、Web、pnpm）。工作台必须随安装包交付，首次打开不下载工作台。构建脚本产出两个固定提交的 companion archive：Node + standalone server + Web 工作台，以及独立的 Codex vendor tree；全部 Mach-O 在归档前以同一 Developer ID 签名。可选 Codex 资产发布在 `runtime-<gitSha>` Release，清单固定 HTTPS URL、架构、SHA-256 和大小，不使用 latest 指针。

Rust 在后台线程安装工作台环境到 `<dataDir>/desktop-runtime/<target>-<sha256>`，不阻塞窗口；直接读取 App 内的压缩工作台，使用系统 shasum / tar 校验和解压，全程不联网；校验和解压期间退出会终止并回收子进程。大小、摘要和 Node 签名通过后才原子发布目录，完成标记与启动文件同时存在才算缓存命中。安装命令仅授权本地初始化页面；HTTP 工作台沿用原有 capability，不获得安装 IPC。

服务端首次使用原生 Codex 时按 `server/codex-runtime.json` 将签名的 vendor tree 安装到 `<dataDir>/native-codex/<sha256>`。同一进程并发请求共享安装，失败清理临时目录并允许重试，完整缓存离线复用；启动 native binary 保留进程组退出清理。源码与 CLI 使用 npm 依赖的原有路径。新旧环境按摘要隔离，不替换运行中的旧版本；旧缓存暂不自动删除。

### 下载与更新（2026-10-08）

设置提供独立的「下载与更新」入口，汇总应用发布版本、工作台环境、安装工具、原生 Codex、Claude Code 和 OpenCode。应用检查固定 GitHub 仓库的已发布资产，按数字版本和当前架构选择安装包，明确区分预览版；下载后仍需用户替换应用并重新打开。工作台和原生 Codex 按应用清单固定版本，不单独追踪 npm latest。

pnpm 固定项目的 packageManager 版本，在构建时下载官方 npm 包并验证 SHA-512，放入随 App 内置的工作台 archive，与 Node 一起安装；Rust 将它加入后端 PATH 并设置 VGENT_PNPM_DIR，harness 不依赖用户额外安装 pnpm。Claude Code / OpenCode 的首次安装由服务端采用官方 bootstrap recipe，在临时目录冻结安装、验证 CLI、改写 pnpm 绝对路径、原子发布后写入官方 marker；手动安装和首次任务共享 promise。状态、错误及中断意图由原有运行时管理器维护，升级和回退继续拒绝正在使用的引擎。所有安装与检查操作放在 /api/runtimes 下，远程会话只能读状态。

## 三个决策

**0. 主线只有三条边界清楚的路。** Claude Code 原生、Codex 原生、自研引擎（API key / Gateway / Codex 订阅）。每条路里循环、工具、模型属于同一方，不做跨方混搭。

**1. 壳只认 AI SDK 的 `Agent` 接口。** `ToolLoopAgent` 直接实现它；Claude Code / OpenCode 走官方 `HarnessV1` 适配器 + `HarnessAgent`，用官方文档那 20 行 session 闭包包成 `Agent`（Codex 后来在 server 里改走原生 `codex app-server`，harness 版只留给 CLI）。自研引擎就是一个裸 `ToolLoopAgent`，**不包成 HarnessV1**。freecode 的 `tool-loop-adapter.ts` 为了对齐 harness 契约自己重写了整个循环，绕开了 SDK 的审批、prepareStep、子代理，是反面教材。

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

### OpenCode 引擎（2026-09-30）

用户想拿 OpenCode 替掉自研引擎当默认，先接进来比。走 AI SDK 官方的 `@ai-sdk/harness-opencode`（钉 1.0.123，它依赖的 harness / provider-utils 正好是现在钉的那两个；它把 `ws` 钉死在 8.21.0，workspace 用 `'@ai-sdk/harness-opencode>ws'` 统一到 8.21.3，否则会多出一份 harness）。bridge 在 `~/.vgent/harness/opencode/` 装 `opencode-ai` 并起 `opencode serve`，用 OpenCode 自己的 SDK 驱动。会话、恢复、挂起、审批续接全照 Claude Code 那条路（`packages/engines/src/opencode.ts`、`packages/server/src/engines/opencode.ts`）。

- **登录不用 OpenCode 自己的**：每轮给 bridge 设 `OPENCODE_AUTH_CONTENT`——OpenCode 见到它就不读 `auth.json`。Codex 账号的模型（`codex-subscription:<slug>`，可带 `@<账号>:`）放那个账号的 ChatGPT token（`refresh: "host-managed"`，OpenCode 不自己刷新；每轮新起 bridge，token 每轮现取），模型写成 OpenCode 的 `openai/<slug>`；其余情况放 `{}`。所以用户在 OpenCode 里登过什么都不影响 Vgent，Claude 订阅也不会借道 OpenCode。沙箱保留真实 HOME 和用户的 PATH、SHELL：OpenCode 的全局配置照读，bash 工具找得到 brew 装的命令。
- **窗口**：Codex 订阅的窗口（272K）和 API 的不一样，OpenCode 只认后者。模型目录里的窗口经 `openCodeConfig.provider.openai.models[slug].limit.context` 告诉它，它就按这个自动压缩；它不认识的 slug（gpt-6-sol）也就此有了定义。
- **提供商**：`PROVIDER_AGENTS` 多了 `opencode`。它跟自研引擎用同一个 AI SDK 包、同一个地址，目录和自定义提供商都照 `vgent` 那份给；老提供商在模型表 OpenCode 列点开时复用 `vgent` 的地址。任务跑时 `openCodeProviderConfig`（`@vgent/providers`）把提供商翻成 OpenCode 的 `provider` 配置：命名空间 `vgent-<id>`（不和 OpenCode 自带的合并），`npm` + `options` 与 `sdkProviderFor` 同一套（第三方 Anthropic 用 `authToken`、输出上限 16000，OpenAI 兼容带 `includeUsage`）。有思考等级的模型标 `reasoning: true`，OpenCode 按包和 id 自己算出 variant，任务的等级作为 `reasoningVariant` 传进去；「不指定」什么都不传。
- **指令**：OpenCode 自己读仓库的 AGENTS.md；我们只补 `~/.agents/AGENTS.md` 和计划模式的附加说明。计划回合只开 `read / grep / glob / ls / todowrite`，其余内建工具由 harness 宿主一律拒绝。
- **没做的**：手动压缩（适配器只能在两轮之间压，结果要到下一轮的流里才出现）；MCP / skills / 记忆、Computer Use；插话只报「已接收」（OpenCode 没有「某一步取走了这条消息」的事件）；OpenCode 在「下载与更新」里与 Claude Code 共用安装、升级和回退管理，升级时 CLI 与 SDK 保持同版本并更新安装脚本放行名单。
- **补丁**：见 `patches/README.md` 的「OpenCode permission order」。
- **用量**：OpenCode 的 `tokens.input` 只含未缓存输入，bridge 补丁把读取缓存、写入缓存补回 AI SDK 的输入总数，并保留分项；步骤、累计、会话差分共用这个映射。`message-usage.ts` 兼容旧 bridge 的续接流和历史记录，以当轮 `run.engine` 识别来源，每个 usage 写 `inputTokensIncludeCache` 防止二次相加。旧记录读出即修正，下一次正常保存时落盘，不因读取改变任务活动时间；其它引擎按 SDK 原有口径。详见 `patches/README.md` 的「OpenCode input usage」。

### 自研引擎 `@vgent/engine`

一个 `ToolLoopAgent` 驱动模型与工具循环。Vgent 提供工具实现、审批策略、上下文构造和产品状态；服务端 `RunManager` / `ThreadStore` 继续负责会话生命周期与持久化。

2026-09-26：主代理与子代理通过 `packages/engine/src/agent-setup.ts` 的 `createAgentSetup()` 组装。该函数不持有会话状态，只创建工具、按当前模式筛选、绑定审批策略，然后生成指令。角色、预算和结果处理留在各自调用方。

| 能力 | 实现与归属 |
| --- | --- |
| 主循环 | `ToolLoopAgent`，步数上限、最后一步收尾、取消信号保持现有机制 |
| 内建工具 | `@vgent/tools` 的 `createCodingTools()`；同一份有效路径配置用于执行校验和工具描述。文件工具支持工作目录及额外配置的根目录，Shell 默认运行在宿主机，cwd 检查不构成系统沙箱。`write` / `edit` 在任何模式下都拒绝 `.git`（目录或 linked worktree 的 `.git` 文件）里的路径（`index.ts` 的 `refuseGitMetadata` + `paths.ts` 的 `isInsideGitMetadata`，按真实路径、在 `mkdir` 之前），名字经 `foldFileName` 折叠后比较（去掉零宽字符、NFKC、大小写按 Unicode 来回折，`.GIT`、全角、夹零宽字符的写法都算）；`grep` / `glob` 的模式不许绝对路径或 `..`，`walkEntries` 再丢掉落到根外的结果，内置 grep 只打开真实路径在搜索根里的文件，调 rg 时路径前加 `--`；`local-runner.ts` 每个输出流最多落盘 64 MiB，超了终止进程组并在 stderr 末尾注明 |
| 权限 | `permissions.ts` 的 `createApprovalPolicy()` 同时提供审批函数与说明，使用相同的模式、允许列表和调用分类。主代理触发审批；子代理拒绝需要审批的调用并报告给父代理。`allow-edits` 下 `write` / `edit` 写 `.vgent/worktrees.json` 或 `.cursor/worktrees.json` 要审批（setup 脚本以后无人看管地跑），工具在「一直允许」里或全自动时不问；路径先按字面消掉 `.` / `..` 再对最后两段做 `foldFileName`。已知限制：只看写入路径本身，经符号链接写到 setup 配置抓不到。这两道守卫（含上一行的 `.git`）只管自研工具，Claude Code、Codex、OpenCode 的原生写入工具不经过它们。Claude Code 的 Computer Use 宿主工具也用这份策略：bridge 对宿主工具一律放行、`permissionMode` 只管内建工具，所以 `server/engines/claude-code.ts` 的 `hostToolApproval` 按 `decideApproval` 给每个 cua 工具定 `toolApproval`（看的免审，动的要问，全自动和「一直允许」不问） |
| 指令 | `buildInstructions()` 只组合通用行为、工作区事实、选中的工具、审批说明、项目规则与 Skills。工具用法放在工具定义中，删除工具即不再向模型发送它的能力说明。仓库里（含子目录）的 `AGENTS.md` 是指向仓库外的符号链接时不读（`agent-instructions.ts` 的 `staysWithin`），`~/.agents/AGENTS.md` 不受此限 |
| 子代理 | Explore / Coder 使用同一组装函数；Explore 仅开放读取工具，Coder 继承项目路径及权限。返回状态、摘要和可用的完整报告引用 |
| MCP | `@ai-sdk/mcp`，延迟加载工具通过 `toolSearch()` 发现；计划模式过滤后不保留这些工具及其说明。每个服务连接加列工具最多等 30 秒（`connectMcpServers` 的 `timeoutMs`），超时或失败就跳过、本地 stdio 进程被关掉，不算回合失败。`settings.json` 里手改的对象形式 `mcpServers`（`{ "github": { … } }`，`type` 当 transport）由 `store/settings.ts` 的 `readStoredMcpServers` 读成同一张数组，认不出的条目丢掉并记一条警告，自研引擎、OpenCode 和远程脱敏读到的都是规整的服务器 |
| Skills / 记忆 | Skills 按需读取，符号链接装进来的 skill 目录照样认；记忆工具拥有存储位置和使用说明，条目由模型 `list` 查看。计划模式不开放记忆写入 |
| 压缩与恢复 | 保留原有 `prepareStep` 预算核算、历史压缩、缓存及服务端恢复实现；本次组装重构不引入第二套会话状态或执行循环。`fitContext` 先在用户消息处切；一轮自己就放不下（第一轮连读几份大文件）时在这一轮的步骤之间切：切在 assistant 消息前，工具调用和结果不拆开，这一轮的原始请求原样放在摘要前面。图片按约 2K token 估，不按 base64 字节（一张截图按字节算是 15 万） |

文件协调、输入持久化、结束原因、任务续接与恢复契约见 [engine-reliability.md](./engine-reliability.md)。

#### 自研引擎请求缓存

- `prompt-caching.ts` 直接使用 AI SDK 的 `providerOptions.openai.promptCacheKey`：服务端取稳定 `thread.id`，子代理取持久 `taskId`（恢复沿用，不和主代理共用）；CLI 有 session 文件时取绝对路径的 SHA-256，无会话标识时使用本引擎实例的 UUID。仅 Codex 订阅额外传 `session-id`；不改 `store:false`、推理强度、摘要或服务档位。
- 一条规矩（2026-09-30，取 Pi 的做法）：请求开头只放整个任务都不变的东西，新信息只追加在末尾。工具定义、instructions 每步每轮都一样，历史只往后长，所有协议同一条路径。具体落点：
  - 计划只在 `updatePlan` 自己的调用和结果里，不再每步把续接状态塞进 instructions 或尾部 system 快照；子代理拿到的父任务计划跟在交给它的任务消息里，续跑时附上当时的计划。
  - 记忆工具描述不列现有条目（写一条就会改工具定义），模型先 `list`；用户约定按原话在本任务用户消息里查找，消息 ID 由工具记下，不再把最近 20 条用户消息塞给模型。
  - 交互式代理的权限说明是一段固定文字，不列运行模式和长期允许清单；需要审批的调用照常停下等审批，拒绝作为结果返回。子代理一次跑完，仍列具体清单。
  - 子目录的 `AGENTS.md` 跟着第一次读到该目录的 `read` 结果一起返回（`instructions` 字段），不改 instructions。
  - 收尾预算提示仍只在最后一步改 instructions，一个任务至多一次。
- `context-cache.ts` 只为压缩服务：历史被压缩（或从上次的压缩恢复）后，把 SDK 的 `initialMessages + responseMessages` 对应到压缩后的历史存下，下一轮从存储的记录转换出来时按原始前缀校验换回，读到同一份摘要、命中同一段缓存。没压缩就不写。插话不在 SDK 的原始消息里，插过话的轮次不覆盖上一次的对应；编辑历史时校验失败即回退。旧版本存下的尾部 system 快照照原样恢复（Responses 上它就是上次的前缀），不支持中途 system 消息的协议去掉。缓存写入失败不阻断执行；含 URL / 二进制等不能无损 JSON 保存的前缀不复用、不保存，附件本身仍原样发送。
- 回归测试：`packages/server/src/cache-prefix.test.ts` 用假模型走完整服务端链路（计划、记忆、子目录规则、子代理、插话、切运行模式、审批续跑、压缩），每个请求和同一会话的上一个比，工具定义、instructions、已有消息任何一处变了就失败；压缩只允许压缩那一步变一次。`cache-prefix.smoke.test.ts`（`VGENT_SMOKE=1`）用真实 Codex 请求比对线上请求体并打印命中率。
- 参考 [Codex 的会话缓存亲和性](https://github.com/openai/codex/blob/8ffd91e42aa001b7e897bea812b02f89264f9fa0/codex-rs/core/src/client.rs#L575-L596) 和 [OpenCode 的会话 cache key](https://github.com/anomalyco/opencode/blob/f66b86ceec1a497417f750b88a06cf6923c5c75f/packages/opencode/src/provider/transform.ts#L1323-L1335)。官方 harness 的原生会话、压缩和登录链路不动。
- 工具发现复用 SDK 的 `openai.tools.toolSearch()` 和 `providerOptions.openai.deferLoading`：已核实的 GPT-5.4 / GPT-5.5 / GPT-6-astra，在内置 Codex 订阅或配置地址确为 `https://api.openai.com/v1` 的 Responses 接入上启用。未知型号、第三方端点和其它协议仍走 SDK 通用搜索。候选工具表保持不变，搜索加载的 schema 随消息追加；MCP 工具按名称排序，不随并发连接完成顺序变化。候选目录不预占模型上下文，实际加载的 schema 在历史中参与预算核算。
- 原生搜索名为 `tool_search`，通用搜索仍叫 `toolSearch`；不复用同名，避免 SDK 将旧会话的普通函数记录误编码成原生搜索协议。搜索不执行 MCP 工具，实际调用仍受原有审批、取消与预算守卫控制；计划模式过滤后没有搜索工具。`tool-search-stream.test.ts` 通过真实 SSE parser 验证 Codex `store:false`、官方 API 默认 `store:true`、旧历史续聊、JSON 保存后重建和审批允许/拒绝。
- `prompt-caching.smoke.test.ts` 在 `VGENT_SMOKE=1` 时验证真实订阅请求：三个无工具回合，以及两轮「搜索 → 本地工具 → 依赖结果的第二个工具 → 回答」，后者携带旧通用搜索历史并在轮间 JSON 保存、重建引擎。`VGENT_SMOKE_CODEX_MODEL` 选模型。只输出 SDK `onStepEnd` 的逐请求用量与结构校验结果，同时核对 key、header、请求设置、工具表、历史前缀和 `store:false`。缓存命中由后端决定，不作为易波动的测试断言，也不存原始请求或凭据。

### 模型接入 `@vgent/providers`

自研引擎的模型来源分两类：

1. **API key / AI Gateway**：AI SDK 一方 provider（`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google` 等十几家，`@ai-sdk/openai-compatible` 兜底所有兼容接口）或 Gateway 的 `provider/model` 字串。零自研代码。
2. **订阅账号（用户的核心诉求）**：让自研引擎用订阅登录态。厂商态度不同，处理也不同：
   - **Codex / ChatGPT 订阅：做。** Codex CLI 开源且官方支持 ChatGPT 登录，第三方复用登录态的容忍度高。`createOpenAI({ baseURL: chatgpt.com/backend-api/codex, fetch })` 配注入 OAuth Bearer 的 fetch，token 读 `~/.codex/auth.json`（尊重 `CODEX_HOME`），刷新和过期判断用 `@ai-sdk/harness/utils` 的 `refreshOAuthAccessToken` / `isAccessTokenExpiringSoon`。独立包 `@vgent/providers`，默认关闭，UI 明示"非官方支持"。
   - **Claude 订阅：不做 token 直连。** Anthropic 条款把 Claude Code 的 OAuth 凭据限定在 Claude Code 内使用，2025 年有第三方 agent 因此被封的先例，用户判断风险过高。Claude 订阅**只通过 Claude Code harness 引擎原生使用**。
   - **不进主线的实验项：Claude Code 精简模式**（官方 harness + `inactiveTools` 关掉全部内建工具 + 挂我们的工具、skills、审批，等于借 Claude Code 当模型入口）。技术上只是一段配置，但它是两个系统的接缝：模型带着原生工具的先验会去调被关的工具白烧步数；宿主工具每次经 bridge 往返；Claude Code 自带的 compaction / todo / Task 子代理 / 权限提示与我们的机制撞车；且是 experimental 家族里被踩得最少的路。用户和我一致判断 bug 会多，**先不做**，留作将来有明确需求时的一两天实验。
   - 通用原则：引擎和 UI 只依赖 `LanguageModel` 类型；订阅登录的 token 不落日志、不落我们自己的存储。
3. **用户接入的提供商（2026-09-19）**：设置页「模型提供商」。数据模型在 `packages/providers/src/provider-config.ts`（零依赖，子路径 `@vgent/providers/config`）：`ProviderConfig { id, name, presetId?, apiKey?, agents: { vgent?, "claude-code"?, codex? } }`，每个 agent 一份 `{ baseURL, protocol, models[] }`——「每个 agent 用哪些模型」就是这个字段，没有第二张表。
   - **注册表**：`model-registry.ts` 的 `createModelRegistry({ providers })` 用 AI SDK 的 provider 管理搭：`createProviderRegistry`（分隔符 `:`）里放 gateway 和每个提供商一个 `customProvider`（`languageModels` = 勾选的模型，`fallbackProvider` = 提供商本身，没勾的 id 也能解析）。OpenAI 兼容走 `@ai-sdk/openai-compatible`（`includeUsage: true`，否则流式没有用量、context ring 没数）；Anthropic 兼容走 `@ai-sdk/anthropic`，baseURL 按 `claude` CLI 的写法存（不带 `/v1`），给 SDK 时补上；第三方端点用 Bearer（`authToken`），并用 `wrapProvider` + `defaultSettingsMiddleware` 把 `maxOutputTokens` 定到 16000——SDK 对不认识的模型 id 会悄悄限到 4096。Codex 订阅不进 SDK 注册表（它是一个个包好的模型，不是 provider 对象），在 `languageModel()` 里直接解析。
   - **模型标识三种写法**，由 `describeModelSpec` 一处判定，引擎的 `resolveModel`、server 的前置检查、`/compact` 都读它：`codex-subscription:<id>`、`<提供商 id>:<id>`、`creator/model`（或 `gateway:creator/model`）。提供商 id 不能占用 `codex-subscription` / `gateway`。
   - **接法不止两种**：`ProviderProtocol` 是 15 个值，`SDK_KINDS` 一张表写明每种对应哪个官方包、默认地址、模型清单怎么要：`openai-compatible`、`anthropic`、`openai`（Responses API）、`google`、`xai`、`mistral`、`groq`、`deepinfra`、`cerebras`、`togetherai`、`cohere`、`perplexity`、`azure`、`amazon-bedrock`（region 从地址里读）、`gateway`。`sdkProviderFor` 按它建对应包的 provider。当前自研引擎使用 `ai@7.0.111`，`@ai-sdk/provider@4.0.17` / `provider-utils@5.0.45`；workspace override 将兼容的 SDK 依赖统一到一份 `provider-utils`，避免原生工具 schema 类型分裂。没带的：`@ai-sdk/google-vertex`（要 Google Cloud 凭据，不是一把 key 的事）、`@ai-sdk/vercel`（没有与这组核心对齐的版本）、各种第三方适配包。
   - **提供商目录不是我们写的**：`catalog.ts` 把 https://models.dev/api.json（AI SDK 生态的公开目录，Koma / opencode 用的也是它）规整成 `CatalogProvider[]`：目录的 `npm` 字段 → 我们的 protocol；没有 `api` 就用官方包的默认地址；地址里带 `${…}` 或者压根没有默认值的（Azure、Bedrock、Cloudflare…）标成「要用户填」；模型只留 `tool_call: true`、出文本、没退役的，按发布日期倒序；这版接不了的（第三方包、GitHub Copilot、Vertex）照样留在目录里并写明原因。Claude Code 要的 Anthropic 协议地址 models.dev 不单列：目录里本来就是 `@ai-sdk/anthropic` 的直接用同一个地址，其余按**主机名**去对 Cindy 的预设（`presets.ts`，仍从 Cindy 公开目录生成），对上了就带上它的 Anthropic 地址。models.dev 不列本机服务，`ollama` 是我们补的一条。
   - **目录缓存**：`server/src/store/catalog.ts`，`<dataDir>/cache/provider-catalog.json`（规整后的，约 0.9 MB）。新鲜期 24 小时；过期的先给旧的、后台刷新；从没拉到过就现拉，拉不到退回 `builtinCatalog()`（Cindy 那十家 + Ollama），页面上说明并给「重试」。`CreateAppOptions.catalogFetch` 供测试顶替。`POPULAR_PROVIDER_IDS`（八个 id）仍在目录接口里，设置页已不再有「热门」一栏。
   - **拉模型清单**（`discover.ts`）按 `SDK_KINDS[protocol].listing`：OpenAI 系 `GET <baseURL>/models`（DeepInfra 在 `/openai/models`）带 Bearer；Anthropic `GET <baseURL>/v1/models`；Gemini `GET <baseURL>/models` 带 `x-goog-api-key`、id 去掉 `models/` 前缀、只要能 `generateContent` 的；Cohere、Perplexity、Azure、Bedrock、Gateway 没有一把 key 能读的清单，直接说没有。厂商拒了 key（401/403）是单独的错误码 `provider_key_rejected`，连接弹窗只在这一种失败上停下，别的（404、超时）照常连上。
   - **key 存哪**：`<dataDir>/providers.json`，0600、原子写、读改写全在一条 promise 链里。它不放进 `settings.json`，因为 settings 会整个走状态 SSE 广播。出进程的只有 `redactProvider()` 之后的形态（`hasKey: boolean`）；编辑时不带 `apiKey` = 保留，`""` = 清掉。这一条改掉了原先「凭据一律不落我们的存储」的原则：订阅 token 仍然不存，用户自己填的 API key 存在本机这一个文件里。
   - **三个引擎怎么用上**：自研引擎每轮读一次 provider 存储，把 `providers` 传给 `createVgentEngine`；Claude Code 的任务模型若是 `<提供商 id>:<id>`，`server/engines/claude-code.ts` 的 `providerRoute` 把它变成 `auth`（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）、裸模型 id 和一组 CLI 环境变量（`ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` / 三个 `ANTHROPIC_DEFAULT_*_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 全指向选中的模型，否则 CLI 会拿 Anthropic 的模型名去问第三方端点）。例外是 Anthropic 自己的 API（地址的主机名是 `api.anthropic.com`）：它不认 Bearer，所以 key 走 `ANTHROPIC_API_KEY`（`x-api-key`），也不钉别名——钉了会把 CLI 后台的便宜调用全打到选中的贵模型上；Codex 的任务模型若是 `<提供商 id>:<id>`，`server/engines/codex.ts` 的 `codexProviderRoute` 把它变成认证环境 `{ OPENAI_BASE_URL, OPENAI_API_KEY }`（`engines` 包的 `codexProviderEnv`）和裸模型 id：适配器拿到显式环境就不读订阅登录，它的 bridge 见到 `OPENAI_BASE_URL` 会自己生成一条 `model_providers.agent_bridge_openai`（`wire_api = "responses"`、`env_key = CODEX_API_KEY`）——不需要 Cindy 那样的转发代理。所以 Codex 能接的只有说 Responses 协议的端点：目录里 npm 是 `@ai-sdk/openai` 的条目自动带 `codex` 地址，自定义提供商由用户点「Codex 也用它」声明；`agents.codex.protocol` 恒为 `openai`。没 key 的本机服务也给一个占位 key，因为 bridge 只在有 key 时才建那条 provider。提供商清单里有 `contextWindow` 的模型，通过 `codexConfig.model_context_window` 告诉 Codex（它只认识 OpenAI 自家模型的元数据）。`ensureAvailable` 对提供商模型跳过 Codex 登录检查。OpenCode 见上面「OpenCode 引擎」。四个引擎的能力表现在都是 `customProviders: true`。
   - **接口**：`GET /api/providers`（已连接的）、`GET /api/providers/catalog`（目录，不带模型；`?refresh=1` 重新下载）、`GET /api/providers/catalog/:id`（一家的模型和各 agent 的地址）、`POST`、`PATCH /:id`、`DELETE /:id`、`POST /api/providers/discover`（表单里有 key 用表单的，没有就用存着的；存着的 key 只发往它保存时的地址，按 scheme、host、path 比，地址换了回 400 `provider_key_needs_reentry`、要重新输入 key）。`GET /api/engines/:engine/models` 每次请求把该引擎可用的提供商模型并进去（`ModelEntry.provider` = 提供商名），不进 10 分钟缓存。
   - **订阅也是提供商**（`packages/server/src/subscriptions.ts`）：Claude 订阅和 Codex 订阅在设置页跟用 key 的提供商排在一起，但走另一条数据路——没有 key、不进 `providers.json`、我们不登录也不存 token，只报告状态。Codex 的状态来自 `describeSubscriptionAuth()`（读 `~/.codex/auth.json` 或钥匙串；账号邮箱和套餐从 `id_token` 的 claims 里解出来，只解码不落盘）；Claude 的状态来自 `claude auth status --json`（PATH 上的 CLI，约 0.1 秒；桌面壳已经把登录 shell 的 PATH 传给 server），这样本进程完全不碰 Anthropic 的凭据；没装 CLI 就是「查不到」，`loggedIn` 字段缺省，不猜。每个订阅服务哪些 agent 写死在这个模块里：Claude 订阅只给 `claude-code`（条款所限，见上），Codex 订阅给 `vgent` 和 `codex`。Claude Code 的清单 = 三个别名 + 提供商目录（models.dev）里 `anthropic` 那家的全部模型（`createModelCatalog` 的 `anthropicModels` 选项；设了 `ANTHROPIC_API_KEY` 时账号自己的列表优先、去重），不带目录里的 contextWindow——那是 API 的能力，Claude Code 实际用多大窗口是它自己的事，ring 不能拿错的分母。Codex 订阅的清单就是后端 `GET /models` 里 `visibility: list` 的那些：实测对清单外的型号后端回 400「not supported when using Codex with a ChatGPT account」。模型行来自 `createModelCatalog` 各引擎自己的清单（Codex 的两个引擎按 slug 合成一行，自研那格的模型 id 带 `codex-subscription:` 前缀；网关模型不算订阅的）。开关存在 `settings.json` 的 `hiddenModels`（按引擎的关闭清单，存的是任务 `model` 用的那个 id）：订阅的模型默认全开，所以存「关掉的」，老的设置文件不用迁移。`GET /api/engines/:engine/models` 不把关掉的模型删掉，而是标 `hidden: true`——「默认」指向它、或者任务已经在用它时，chip 的名字、思考等级、ring 的分母还得查得到；`ModelPicker` 只是不再列它。连点开关不丢：`SettingsStore.mutate(fn)` 在同一个同步段里读旧值、算补丁、换新值（`get()` 再 `update()` 会让两次点击从同一份清单出发）。接口：`GET /api/subscriptions`（`?refresh=1` 重拉模型清单）、`PUT /api/subscriptions/:id/models`（`{ agent, models: 行 id[], enabled }`，回这个订阅现在的模型行；行 id 到各引擎模型 id 的换算在 server，web 不拼前缀）。`claude-subscription` 加进了 `RESERVED_PROVIDER_IDS`。界面：`SubscriptionTable` 和 `ModelTable` 共用 `ModelTableHeader / ModelTableRow`；`ProvidersPage` 里登录了的在「已添加」，没登录的在「添加」菜单最上面（Codex 在前），「登录」弹窗给出要跑的命令和「重新检查」。
   - **界面**（`apps/web/src/features/settings/`）：设置页是左侧分栏（`SettingsView` 里的 `TABS`），页面由 `layout.tsx` 的 `SettingsPage / SettingsGroup / SettingsRow / Switch / Dialog` 拼；`ProvidersPage` = 已添加 + 一个「添加」菜单（`CascadeLevel`：没登录的订阅、GitHub Copilot、自定义、「更多 N 个提供商」子菜单带搜索，接不了的不列）；GitHub 在这里弹窗走和远程访问同一个设备登录；连接是一个弹窗两步：填 key → 刚建好的提供商的 `ModelTable`。`ModelTable` 一行一个模型、一列一个 agent，开关点了就 `PATCH`；连点时每次从最新状态算请求、先改界面、只认最新一次请求的回包，存失败就把开关拨回 server 上的样子。`ModelsPage` 把每个已连接提供商的表排在一页。逻辑在 `providerModels.ts`（带测试）。⌘, 在 `useWorkbench` 里，开和关是同一个键。
   - **没做的**：Codex 接自定义端点（要一个 Responses 协议的转发代理，Cindy 就是这么绕的）；用 Cindy 账号自动换 key（现在是自己贴地址和 key）；子代理单独配模型；provider 级的推理 / 思考等级；key 放钥匙串。

## 后端 `@vgent/server`（Hono）

- **端点**：`POST /chat/:threadId` 返回 UI message stream（`createAgentUIStreamResponse`）；`GET /chat/:threadId/stream` 续流；`GET /state` SSE 推项目、线程、审批、子代理状态；项目、线程、设置、worktree 的 REST。
- **可重放流**：搬 freecode `server/chat-stream.ts` 的思路，每轮一个 chunk hub，持久化消息和所有重连客户端都从它重建。
- **持久化**：`~/.vgent/` 下**一个线程一个文件** `threads/<id>.json` 加小索引，设置和项目单独存。**不做** freecode 那种整库单文件每 40ms 全量重写；写用 temp + rename 并 fsync 父目录；解析失败把坏文件改名 `.corrupt-<ts>` 后继续，不 exit。线程 id 会成为文件名（`threads/<id>.json`、`plans/<id>.md`、`attachments/<id>`），只认 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`（`store/threads.ts` 的 `isThreadId`）：Hono 会把路由参数里的 `%2F` 解码，所以 `app.ts` 在 `/api/threads/:id*`、`/api/chat/:threadId*` 前面挂了中间件，`threads` / `plans` store 自己也 `assertThreadId`，不合格的当作不存在，回 404 `thread_not_found`。删任务时 `outputs/<id>` 一起删。
- **错误**：typed error 带 `status`，HTTP 层按类型映射。**不用**正则匹错误文案判状态码。
- **状态**：所有 provider / 认证 / 目录配置通过 `createXxx(dataDir)` 注入，无模块级可变状态。
- **认证**：始终 mint token 写入 `connection.json`，不区分桌面与否。
- **远程会话**：远程网关转发的请求带 `x-vgent-remote`，`app.ts` 排在所有路由前的中间件按 `remote/policy.ts` 处理：`isHostOnly` 判出的主机专属操作回 403 `remote_forbidden`（`/api/remote`、`/api/projects/pick`、`/api/computer-use`、`/api/settings/allowlist`、`/api/settings/engine-options`、`/api/accounts/*` 读写都拒；`/api/providers`、`/api/subscriptions`、`/api/runtimes`、`/api/accounts` 只许读；`PUT /api/settings` 只许默认引擎、默认模型、默认运行位置、主题、密度五个字段）；设置路由的回包换成 `redactSettingsForRemote` 的失败即关视图；状态 SSE 的客户端分本机、远程两类，各建各的 payload、各自失败；读文件的四个路由和远程添加项目经 `createHostStores` 拒绝数据目录（任务区除外）、`~/.vgent/harness`、Codex home、Claude 的 `.credentials.json` 和 OpenCode 的 `auth.json`。细节见 `docs/remote-control.md` 的「边界」。
- **任务运行**：run 的 finally 里先释放槽位再做可能抛错的清理，`run.done` 创建时就挂 catch。
- **停止与开始**（2026-10-01，`runs.ts`）：一条消息从到达到成为 run 之间（等新 worktree 的 setup、等上一轮收尾、解析模型、打快照）是一个 `PendingStart`，`isRunning` 把它算作运行中，所以归档、回收、改模式、压缩、「发送」、运行时升级都按运行中拒绝（回收也和归档一样挡住停在审批上的任务）。`stop()` 先 `cancelStarts`：还没 commit（`running` 还没写）的开始直接放弃，长等待都经 `untilAborted` 让路，发起方收到 409 `turn_start_cancelled`，什么都不落盘；任务基线（`recordBaseline`）也挪到 `running` 写下之后才钉。排队派发的那条放回队首，`holdQueue` 用带 `{ status: "idle" }` 守卫的条件写（`threads.update` 的第三个参数，不符回 409 `thread_changed`，期间开跑的回合不被盖掉）把任务改成 `interrupted`、队列停住。被取消的开始正等着上一轮收尾时，`spareFinishing` 让上一轮按它本来的结束记录（计划照存），只置 `queuePaused`、不再派发。回合的正常结束在写锁里、写入那一刻再看一次 `run.stopped`，停止不会被「空闲」盖掉；新用户消息落在停在审批上的回合时，开跑那次写就把旧审批收成「该轮已被新的提问取代」。后台压缩用 `claimCompaction` 同步占住任务：期间新的开始 409 `thread_compacting`，排队派发和自动继续都等它放手。`stopAll` 不等还没 commit 的开始，放弃它们（409 `server_stopping`），用户消息经 `keepForNextLaunch` 挪回队首、下次启动由 `dispatchQueuesAtBoot` 发。web 的 `lib/threadChats.ts` 把 `turn_start_cancelled` 变成交给 `Chat` 的 `AbortError`：回到 ready、不报错，也不会因 `sendAutomaticallyWhen` 把审批回答再发一遍；文字留在输入框。
- **异常恢复**：启动以任务文件而非索引中的状态为准，关闭意外退出残留的运行轮次并持久化 `restartRecovery`；在 worktree 回收前，经每任务启动锁和 store 的原子 token 认领派发新提示轮次。手动停止及生命周期变化取消恢复；等待审批/回答不自动派发。原生引擎收到有上限的原目标和最近历史快照，自研引擎沿用完整历史；未确认的工具结果不当成成功，要求先核实副作用。恢复准备失败保留 token 并显示错误，不在后台循环重试。桌面父进程消失触发 `shutdown({ recoverRunning: true })`，在 abort 前落盘恢复意图；普通 SIGINT/SIGTERM 仍按主动退出处理。
- **worktree**：`packages/server/src/workspace.ts`，搬 freecode 的 snapshot / restore（销毁前复验所有权、前后 hash 清点、保护 index blob），阶段四已落地，见「阶段四进度」。
- **收口的并发与路径**（2026-10-01）：交给 git 的路径一律经 `git.ts` 的 `literalPathspec()` 写成 `:(literal)<path>`（`[id].tsx` 不再顺带匹配 `i.tsx`）；不用 `GIT_LITERAL_PATHSPECS`，它会传进用户的 git hook，hook 里自己的 `-- '*.ts'` 就什么都匹配不到、静默放行。带回、撤销带回、提交、按文件还原、恢复到此处都进 `integrate.ts` 的 `oneAtATime`：每个检出一条进程内队列（不可重入），谁也不会写到别人的半成品上。`checkpoints.ts` 的 `snapshotTree` 改用 `add -A --ignore-errors`：读不出的文件、没提交过的嵌套仓库不进树，也不让快照失败（别的错误照抛）。各动作自己的安全网写在下文 M1 和「对照 Cursor 之后的一批」的收口条目里。
- **静态**：`packages/server/src/static.ts` 的 `registerStatic` 在 `/api` 之外兜底吐 `apps/web/dist`（SPA fallback），`--web-dist` / `VGENT_WEB_DIST` 指定目录，桌面壳和浏览器共用同一个 `#token=` 入口，不需要第二个前端服务。启动时把整个目录读进内存（约 26 MB），之后只从内存吐：装新 Vgent.app 会把 bundle 换到正在跑的实例底下，已打开的页面还按旧哈希要按需加载的 chunk（Shiki 语法、Streamdown 的高亮），以前每次请求读磁盘，拿到的是新包的 `index.html`，`import()` 失败、整窗空白（2026-09-23 build 125 装上后实际发生）。`/assets/` 下找不到的文件回 404，不再回 `index.html`。改了 `apps/web/dist` 要重启 server 才生效。web 根上有 `CrashScreen`（`apps/web/src/app/CrashScreen.tsx`），任何渲染错误显示错误信息和「重新加载」，不再卸掉整棵树。
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
- 提问卡片：编号选项 + 跳过 / 下一题 / 继续 + 翻页；没到最后一题又没全答完时主按钮是「下一题」，只翻页不提交。空状态有仓库 / 运行位置 / 分支三个 picker。
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

## 当前状态（2026-09-18，阶段六完成；之后按 `docs/product.md` 的里程碑推进，M1–M5 已落地）

三条引擎路全部本地跑通并有真实冒烟测试（`VGENT_SMOKE=1`）；桌面壳、worktree 隔离、子代理/MCP/skills、动态模型清单、`pnpm start` 全部落地。全仓构建绿，`pnpm test` 74 文件 / 705 测试通过（另 5 文件 / 13 测试是 `VGENT_SMOKE` 门控的真机冒烟，默认跳过；2026-09-19 Codex 能接说 Responses 协议的提供商之后）。Codex 走提供商这条路验证到哪：`codex exec` 加 bridge 生成的同一套配置，对着本机的假 Responses 服务跑通（请求发到 `<地址>/responses`、带 key、裸模型 id、回复正常渲染）；**经由 harness 的整轮没有跑过**（临时实例不能跑 harness 引擎），也没有对着真实厂商的 key 跑过。

- `packages/sandbox-local`：freecode 移植，`createLocalSandboxProvider`，`loopbackOnly` 预加载已验证 bridge 只绑 127.0.0.1。
- `packages/engines`：`createClaudeCodeEngine` / `createCodexEngine` → `{ agent, session, dispose }`，`toTUIAgent`，共享逻辑在 `shared.ts`。仓库路径靠覆写 `doStart` 传 `sessionWorkDir`。Claude 保留真实 HOME 复用登录；它自己不读 AGENTS.md，全局和仓库的 AGENTS.md 由 server 读出来经 harness 的 `instructions` 注入（仓库那份是指向仓库外的符号链接时不读，同自研引擎）；Codex 用隔离 `CODEX_HOME`（真实 `~/.codex/config.toml` 与 pinned SDK 不兼容），登录态走 env 转发，用户的 `~/.codex/AGENTS.md` 链进隔离目录，全局规则照样生效。Codex 的 permissionMode 只能 `allow-all`，SDK 构造时自己抛错。
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
- 真机副作用：一个 parked 在 awaiting-approval、晾了几分钟才去审批的线程，续跑时以 `HTTP 401: authentication_failed`（harness 记的原文是 `harness stream error: HTTP 401: authentication_failed`）失败；本地沙箱没有请求改写，adapter 是在 `spawn` 时把 Claude 的真实凭据一次性转发进 bridge 的环境变量（harness 为此警告 "Falling back to less secure credential forwarding"），bridge 晾得越久，转发进去的 token 就越可能过期。同一提问换个新 session 立刻就能跑通。记为已知风险，缓解方案待定（parked 会话加空闲超时 / 每轮重新读凭据）。（2026-09-18 已修：改为显式认证环境，bridge 里的 CLI 自己刷新钥匙串登录，见下文同日条目。）
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
- 已知未修（阶段四）：阶段三就有的 shutdown 竞态还在；suspend 成功但 `saveHarnessState` 写盘失败会孤儿掉 bridge（只记日志）；suspend 和审批回执之间 bridge 死掉算 `interrupted`；没有真实 MCP 往返测试；`tauri dev` 没有 HMR；选文件夹只支持 macOS；桌面壳和 `pnpm server` 共用 `~/.vgent`（`connection.json` 会被覆盖，用 pid 匹配 shell）；直接 `kill` Tauri 进程会孤儿掉 server（已在阶段六「实例锁」的父进程死亡自退修掉）；`EmptyState` 的引擎默认值只在挂载时读一次 settings。
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
- 已知未修（阶段五）：模型选「默认」或模型不在目录里（换机器、旧清单）时思考 chip 整个不显示——不猜等级是有意的，但用户看不出为什么没有这个 chip；ring 在模型「默认」时分母未知；harness 引擎的 usage 只按协议核实、没真机跑；Codex 计划分支不可达；`RightPane` 的 `open` prop 现在没人用；阶段三、四列的已知未修都还在。

### 阶段六进度

- 2026-09-18：起点 `6fcaa14`。按「下一步」清单挑了前四条，实例锁当时没做——理由「没有撞车场景」事后核实不成立：数据目录默认 `~/.vgent`，`pnpm start` 和 `/Applications/Vgent.app` 默认撞同一个（`packages/server/src/paths.ts` 的 `resolveDataDir`，桌面壳 `main.rs` 复刻同一逻辑）；桌面壳的 pid 握手只让壳认领自己的子进程，不检测目录已被占用，后起的直接覆盖 `connection.json`；threads 索引、projects、settings 三个 store 都是「内存缓存全量 + 整份回写」，双进程并存时后写者静默抹掉前写者的改动。已在本节下面补上（见「实例锁」）。两个切片各开 worktree 并行，叠加型合并，无冲突。
- **记忆（自研引擎）**。`packages/engine/src/memory.ts` 的 `createMemoryTool(memoryDir)`：一个 `memory` 工具，`action: list | read | write | delete`，条目是 `memoryDir` 下平铺的 `.md` 文件（一文件一事实，名字 kebab-case，首行一句摘要；`list` 列文件名 + 首个非空行）；名字含 `/`、`\`、以 `.` 开头一律拒绝，`.md` 自动补。`createVgentEngine({ memoryDir })` 给了才注册，不给 explore / coder 子代理；`buildInstructions` 多一段「记忆」：目录、现有条目清单（`readdirSync`，目录不存在视为空）、何时读何时写。进 `READ_ONLY_TOOLS`（只碰仓库外自己的目录，不审批）。server 端 `engines/vgent.ts` 的 `memoryDirOf(ctx)` = `<dataDir>/memory/<project.name>-<project.id 前 8 位>`（非 `[A-Za-z0-9._-]` 换成 `-`），按项目不按 worktree，同一项目的任务共享。
- **手动 compact（自研引擎）**。`POST /api/threads/:id/compact`：运行中 409 `thread_running`；非 vgent 引擎 400 `compact_unsupported`（harness 引擎的对话在 harness 自己的 session 里，存的消息不是唯一真相）；`awaiting-approval` / `awaiting-input` 409 `compact_pending`；不足 2 条 400 `compact_empty`；模型调用失败 502 `model_failed`（新 `UpstreamModelError`）。`packages/server/src/compact.ts` 的 `compactThread({ thread, model })`：`convertToModelMessages(..., { ignoreIncompleteToolCalls: true })` + `generateText({ model, instructions })` 出摘要（AI SDK v7 没有内建摘要压缩，只有规则式 `pruneMessages`），然后**整体替换**线程消息为两条：user「上下文已压缩，以下是之前对话的摘要：…」（`metadata.compacted = { before, at }`）+ assistant「已了解摘要，继续。」。选整体替换而不是记边界：runner 每轮只从盘上读 `thread.messages`、`mergeIncoming` 只并客户端最后一条，旧客户端复活不了历史；`threads.update` 抬 `updatedAt`，前端 `refreshIfStale` 自动重拉。模型用 `resolveModel(thread.model ?? DEFAULT_VGENT_MODEL)`，测试用 `CreateAppOptions.compactModel` 注入。Web：⌘K「压缩上下文」（仅 vgent 且非运行中）、输入框敲 `/compact`（只认这一条，没做通用斜杠命令）、成功 toast「已压缩：N 条消息 → 摘要」、工作日志在摘要消息上方一行灰字「上下文已压缩（原 N 条消息）」。
- **`alwaysAllow` 下沉子代理**。`createSubagentTools({ alwaysAllow })` → `denyUnapproved` 把名单传给 `decideApproval`；主 agent 批过「一直允许 bash」后 coder 子代理的 bash 不再被拒。
- **任务头换行**。TaskHeader 行拆成左组（标题 + pill，`flex min-w-0 flex-wrap`）和右组（停止 / 右栏按钮，`ml-auto flex-none`），窄窗口下 pill 折到第二行，按钮留在右上。
- **harness 引擎真机核实**。Claude Code：allow-reads 下 bash 审批卡片 → 点「本任务内一直允许 命令」→ 第二条 bash 自动放行（落盘 `alwaysAllow: ["bash"]`，两条 approval 都 `approved: true`），助手消息 `metadata.usage` / `totalUsage` 都在（含 `cachedInputTokens`）。Codex：`totalUsage` 正确，但每步 `usage` 全零（bridge 的 finish-step 不带 usage），ring 原本会显示 0，改成 `inputTokens` 为 0 视作未上报、回退到字符估算。`VGENT_SMOKE=1 pnpm --filter @vgent/engines test` 3 文件 / 5 测试过。
- 验证：`pnpm build && pnpm test` → 51 文件 / 385 测试通过。浏览器实测（`node packages/server/dist/main.js --port 7481 --repo <本仓库>`，`VGENT_DATA_DIR` 指临时目录；自研引擎 + allow-reads + 主工作区）：「记住用户偏好 pnpm」→ `memory/Vgent-2805cba3/user-prefers-pnpm.md` 落盘、`list` 返回 1 条、全程无审批；`/compact` 后消息变两条并带标记行；再问「刚才记住了什么」答对；⌘K 面板有「压缩上下文」；900 px 宽 + 右栏开时权限 pill 折到第二行、右栏按钮仍在右上。注意 `pnpm build` 只跑 `tsc -b`，实测前要单独 `pnpm --filter @vgent/web build`。
- 收尾三项（同日下午，用户用 app 时反馈）。**build 编号**：`apps/web/vite.config.ts` 构建时从 git 取 `<rev-list --count>.<短 sha>`（脏树带 `+`，没 git 就是 `dev`），`define` 成 `__VGENT_BUILD__`，`lib/build.ts` 导出 `BUILD_ID`，侧栏左下「本机」下面一行 `build 49.1c398b0`；rail 模式不显示。**原生选择器**：桌面壳里「选择文件夹 / 可执行文件」原来走 server 的 `osascript`，`tell me to activate` 一步就要 2 秒；现在 `capabilities/main.json` 给远端页面（`remote.urls: ["http://127.0.0.1:*"]`）只开 `dialog:allow-open` 一条权限，`tauri.conf.json` 开 `withGlobalTauri`，web 的 `lib/nativePicker.ts` 先试 `window.__TAURI__.dialog.open`，没有再回退 `POST /api/projects/pick`（浏览器模式不变）。init script 对远端页面也注入，按 tauri 2.11.5 源码核实过，但没在真机 webview 里观测过 `window.__TAURI__`，用户点一下就知道。**旧 worktree 项目记录**：`projects.json` 里阶段五之前注册进去的 `.claude/worktrees/*` 条目会一直显示；`store/projects.ts` 加载时跑一次 `migrateWorktreeEntries`，`<dataDir>/worktrees/*` 直接丢，linked worktree 并入主仓库（主仓库已存在就丢、否则改路径保留 id），有变动才重写文件并打一行日志。
- **「默认」模型解析**（用户对照 Cursor 3 指出空状态和任务里的聊天框不一致）。两处本来就是同一个 `Composer`，差在任务没指定模型时前端不知道「默认」是谁，思考等级 chip 查不到清单就藏了、ring 分母也未知。现在 `GET /api/models/:engine` 的 `ModelCatalog.defaultModel` 报出该引擎实际回退的模型（`settings.defaultModel`，自研引擎再回退 `DEFAULT_VGENT_MODEL`；harness 引擎没设就留空，不编造），web 的 `effectiveModel(model, catalog)` 统一解析：模型 chip / 任务头 pill 显示真名并带「默认模型（在设置里改）」提示，`ReasoningPicker` 按它列等级，ring 用它的 `contextWindow`。任务本身仍不写死模型（`model` 保持 undefined，选择器里「默认」行仍是选中态），改设置就跟着变。浏览器核对：自研引擎空状态和未指定模型的任务两边都是 `codex-subscription:gpt-5.5` + 「思考 中」，ring「上下文 3.1k / 272k」。
- 事故记录：替换 `/Applications/Vgent.app` 时把旧包目录删了而 app 没重启，旧进程的 node server 和网页挂在被删文件上，表现为「Cannot connect to API」、点 session 页面乱滚、最后黑屏。同一模型在正常 server 上一次就通，同一份数据在浏览器里也正常，所以是进程问题不是代码问题。规矩：app 在跑就把旧包留成 `Vgent.app.old`，等用户重启后再清。
- **实例锁**。`packages/server/src/instance-lock.ts`，从 freecode 的 `server/instance-lock.ts` 搬来：`<dataDir>/server.lock` 用 `open(path, "wx", 0o600)` 独占创建，内容 `{ pid, nonce, createdAt }`；已存在时 `process.kill(pid, 0)` 探活，活着（含 EPERM）抛 `InstanceLockedError`（带 `pid`、`lockPath`），只有 ESRCH 才算已死并接管；接管用 `mkdir server.lock.recovery` 当互斥防两个接管者互踩，重读确认 pid + nonce 没变才 unlink 重建；release 只在锁仍是自己的（pid + nonce 相同）时删。`main.ts`：`mkdir(dataDir)` 之后、`createApp` 之前拿锁（store 加载会跑迁移并可能回写，必须先有锁）；被占用时 stderr 打一行「Vgent 已在运行（进程 N），数据目录 … 已被占用…确认没有 Vgent 在跑时可以删除锁文件…」，以 `INSTANCE_LOCKED_EXIT_CODE = 75`（EX_TEMPFAIL）退出，**不写 connection.json**；`stop()` 里删完 connection.json 后释放锁；拿锁之后的启动失败也释放。崩溃 / SIGKILL 留下的陈旧锁靠「持有者已死就接管」兜底。已知局限：只按 pid 探活，陈旧锁的 pid 被无关进程复用时会误判为占用，错误信息里给了锁文件路径供手动删除。
  - 父进程死亡自退（修掉阶段四已知未修「直接 kill Tauri 进程会孤儿掉 server」——孤儿会一直占着锁）：仅桌面模式（`VGENT_DESKTOP=1`），`watchParentExit` 每 1s 轮询 `process.ppid`（定时器 `unref`），变了就走和 SIGTERM 同一个 `stop()`；初始 ppid 已是 1 视为已成孤儿、直接退出（已有测试覆盖）。选轮询而不是 stdin 管道，是因为 `backend.rs` 用 `Command::new(node)` 直接起 node、没有 shell 包一层，ppid 就是壳。
  - 桌面壳：`tauri-plugin-single-instance`（2.4.x）作为第一个插件注册，第二次启动时回调里对 label `main` 的窗口 `unminimize` + `show` + `set_focus`（窗口还没建出来就什么都不做），第二个实例自己退出、不再起第二个 server；该插件没有前端命令，不需要 capability 条目。`backend.rs` 镜像同一个退出码常量（两边注释互指），启动等待循环里子进程以 75 退出就立刻返回 `SpawnError::AlreadyRunning`（不等 30s），`main.rs` 的原生弹窗标题「Vgent 已在运行」，正文说明数据目录已被另一个 Vgent（可能是 `pnpm start` 起的服务）占用、请先退出它，并附 server 的 stderr 尾部。注意：装了实例锁之后，旧实例不退出新实例就起不来，这是预期行为；build 53 及更早的包不持锁，从它们升级的那一次要先 ⌘Q 旧的再开新的。
- **compact 前留旧消息快照**。`POST /api/threads/:id/compact` 现在的顺序：出摘要 → `threads.snapshotBeforeCompact(id, messages)` → 成功后才 `threads.update`。快照在 `<dataDir>/threads/<id>.pre-compact.<ts>.json`（`<ts>` 是 ISO 时间把 `:` 和 `.` 换成 `-`，撞名加 `-1`、`-2`… 后缀，多次 compact 各留一份），内容 `{ version: 1, threadId, createdAt, messages }`，走 `writeJsonAtomic`；写失败 500 `snapshot_failed`、线程消息不变；`remove()` 连带删该线程的全部快照；`rebuildIndex()` 扫 `threads/*.json` 时跳过含 `.pre-compact.` 的文件（否则会被 `readJsonOrQuarantine` 当坏线程隔离掉）。没做回看界面。
- **压缩不再替换历史，改到后台跑**（2026-09-30，取代上面两条的做法）。用户实测：压完聊天记录没了、按钮点了没反应、所有任务卡死。卡死是因为一次摘要要几十秒，请求一直挂着，连点 5 次就是 5 个挂着的连接，加上事件流，把浏览器对同一服务端的 6 个连接占满，别的任务的请求全在排队。现在自研引擎的 `POST /api/threads/:id/compact` 只做检查、在记录上写 `compaction: { startedAt }` 就回 202，摘要在后台写；同一任务同时只一个（再点 409 `compact_running`）；压缩中开新一轮 409 `thread_compacting`，排队派发跳过，前端把这时发的消息放进队列，压完自动发。失败写 `compaction.error`，下一次压缩或下一轮开始时清掉；服务重启时还在压的标成中断。历史一条不动：摘要是追加在末尾的一条 user 标记（`metadata.compacted = { before, at, keptFrom }`，`keptFrom` 是原样保留的最近几轮的第一条），`compact.ts` 的 `sinceCompaction` 让模型从最近的标记读起：摘要、保留的几轮、之后的消息，摘要后面紧跟 user 时补一句「已了解摘要，继续。」；老版本整体替换留下的记录读法一样。日志里标记是一行「上下文已压缩」（照 Cursor 的 Chat context summarized 状态行），点它在右栏 `summary` 页看摘要；压缩中是「正在压缩上下文…」，失败是「上下文压缩失败：原因」。上下文环在压完、下一轮还没跑时按「摘要 + 保留的几轮」估算。不再写 `.pre-compact.` 快照，磁盘上已有的照旧跳过、随任务删除。
- 从「明确未做」里去掉「自研引擎的 session 管理」：server 存 UI 消息 + 每轮 `convertToModelMessages` 重放就是 Web 的会话模型，有 `pruneMessages` 保护，不是缺口。
- 验证：`pnpm build && pnpm test` → 52 文件 / 399 测试通过（另 5 文件 / 12 测试 `VGENT_SMOKE` 门控默认跳过；含合并 main 的 `28505af`（M2 在哪跑）之后是 53 文件 / 408 测试）；实例锁用临时 `--data-dir` 实测：预放一个活持有者的锁 → stderr 一行提示、退出码 75、没写 connection.json、锁原样；正常启动 → 锁里是 server 的 pid，SIGTERM 后 connection.json 和 server.lock 都删掉；`VGENT_DESKTOP=1` 下 `kill -9` 父进程 → server 5 秒内自退且两个文件都不留；`cargo test` 6 个通过（含新的 `a_locked_data_directory_fails_fast_as_already_running`）。没有启动桌面 GUI 验证 single-instance 回调（用户的旧版 app 正在 `~/.vgent` 上运行，不做实验），只到 `cargo check` / `cargo test`。
- 已知未修（阶段六）：UI 里仍看不到旧消息（盘上已有 `pre-compact` 快照，没做回看界面）；compact 后 ring 到下一轮才有真实 usage；`memory` 工具不给子代理；记忆条目没有 UI 可查看 / 删除；Codex 每步 usage 为零是上游 bridge 行为；阶段三到五的已知未修仍在。

### 里程碑进度（`docs/product.md` 的 M1–M5）

2026-09-18 起不再按阶段排，做什么以 `docs/product.md` 为准，这里只记怎么实现的。

- **M1 收口**（`5584b61`）。
  - 任务基线：`git.ts` 的 `changes / fileDiff / revert` 多一个可选 `base`。tracked 走 `git diff <base> --name-status -z -M`，untracked 走 `git ls-files --others --exclude-standard`，两种基线一条代码路径（porcelain v2 解析删了）。worktree 任务的 `base` 是 `workspace.baseCommit`，主目录任务是 `HEAD`；`app.ts` 的 `targetOf` 统一给出 `{ cwd, base }`。
  - `packages/server/src/integrate.ts`：`createIntegrator({ exec? })`。`GET /api/threads/:id/integration` → `{ mode, branch?, commitsAhead, dirty, canCommit, canApply, canDiscardAll, pr: { available, reason? } }`；`POST /api/threads/:id/integrate { action: "commit" | "pr" | "apply" | "discard", message? }` → `ThreadRecord`（409 `thread_running` / `apply_conflict` / `workspace_reclaimed`，400 `nothing_to_commit` 等，502 `tool_failed` 是 push / gh 失败）。
  - 带回主目录：用临时 `GIT_INDEX_FILE` 把 worktree 的全部内容（含未提交、未跟踪）写成一棵 tree，不动 worktree 自己的 index；`git diff --binary <base> <tree>` 出补丁写临时文件，主检出先 `git apply --check`，过了才真 apply。主检出 HEAD 不动，改动以未提交状态出现；冲突时整体不动并回冲突文件清单。
  - 开 PR：push 分支后 `gh pr create --fill`；没有 origin 或没装 / 没登录 gh 时按钮不出现，动作条写明原因。全部丢弃只对 worktree 任务：`reset --hard <base>` + `clean -fd`（不带 `-x`，被忽略的 `node_modules` 留着）。2026-10-01 起丢弃前先把任务现场（含它的提交）打成 `refs/vgent/checkpoints/<id>/discard/<n>` 快照，打不成就 500 `checkpoint_failed`、不丢；worktree 已不在任务自己的分支上（agent 切了分支、HEAD 游离）时 409 `discard_wrong_branch`，免得 `reset --hard` 动了别的分支。
  - `ThreadRecord.outcome`（`committed` 带 sha / `pr` 带 url / `applied` / `discarded`，新一轮开始时清掉）、`changeStats { files, additions, deletions }`（回合结束时写）、`archivedAt`。`PATCH { archived }`：归档顺带回收 worktree（留快照），取消归档恢复。
  - Web：`ChangesPanel` 底部动作条、`components/OutcomeBadge.tsx`（任务头 / 侧栏行 / 动作条共用）、`sidebar/grouping.ts` 五组（进行中 / 待处理 / 待验收 / 已完成 / 已归档，已归档默认折叠；`interrupted`、`error` 归待处理）、`TaskItem` 行菜单（`…` 和右键：归档 / 取消归档 / 删除任务…，删除二次确认）和 `+N −M`。
- **M2 在哪跑**（`28505af`）。
  - 空状态一个「运行位置」选择器（本机 · 主目录 / 本机 · worktree，各带一句说明），聊天框上方的位置 chip 显示真实位置（`worktree · vgent/<id8>`）。
  - `packages/server/src/worktree-setup.ts`：配置发现顺序 `.vgent/worktrees.json` → `.cursor/worktrees.json`，键 `setup-worktree-unix` 优先于 `setup-worktree`，按键逐个回落；值是数组 = 命令列表，是字符串 = 相对配置文件的脚本路径（Cursor 的 schema）。cwd 是新 worktree，环境变量 `ROOT_WORKTREE_PATH` 指主检出。异步跑，`workspace.setup { status, startedAt, finishedAt?, exitCode?, error? }` 落盘，`runs.start` 先 `await whenSetupSettled`；日志 `<dataDir>/workspaces/<threadId>.setup.log` 是脚本输出，每条命令前回显一行 `$ 命令`（照 Cursor 的 `[worktree-setup] [i] $ …`，约 1 MB 截断），`GET /api/threads/:id/workspace/setup-log`。对话里照 Cursor：第一条消息下面两行「创建 worktree」「运行 setup 脚本」，跑的时候闪光加秒表，完了是「已创建 worktree 用时 2s」；创建的起止记在 `workspace.created`。准备期间不显示「思考中…」，那两行就是在动的东西（Cursor 在有 worktree setup 时藏掉 planning 状态）。成功不露任何输出，终端 tab 也不收它；失败那行变红，下面是 `error`（「setup 脚本失败，退出码 N」）和输出末尾 2048 字符。worktree 本身建不出来（`workspaceState: failed`）时，`runs.start` 拒掉回合之前把这条首消息存进任务并据此起标题，输入框换成锁住的「worktree 创建失败」，前端也不再把它塞回草稿。失败不拦回合；取消归档恢复工作目录后会重跑 setup。server 重启时把还在 `running` 的 setup 标成失败。
  - `packages/server/src/worktree-limit.ts`：`Settings.worktreeMaxCount`（默认 25，`PUT /api/settings` 校验），建新 worktree 后和启动时（都是 detached）回收最旧的非运行任务的 worktree，走和手动回收同一条留快照的路。
  - 假按钮：「+」在光标处插入 `@` 并打开文件补全（空状态没有补全来源，不显示）；「规划一个想法」「打开编辑器」删掉；运行中按 Enter 只 toast「运行中，先停止或等它结束」，草稿不动；模型 chip 运行中不可改。
  - 本仓库自带 `.vgent/worktrees.json`（`pnpm install --frozen-lockfile`）。
- **M3 模型在前，运行模式全局化**（`a64474d`，验收补丁 `d38ea46`）。
  - 能力表：`packages/server/src/engines/capabilities.ts` 的 `EngineCapabilities { approvals, askUser, planMode, compact, knownDefaultModel, extensions }` 和 `EngineDescriptor { id, label, capabilities }`，每个引擎工厂自带 descriptor（单一来源，测试替身继承真引擎的），`GET /api/engines` 下发；`app.ts` 的引擎 id 清单从 registry 派生。web 在 `useWorkbench` 里加载一次，`apps/web/src` 里不再有按引擎名的判断，`lib/engineOptions.ts` 删掉。
  - 运行模式：`Settings.runMode`（读时迁移 `runMode ?? defaultPermissionMode ?? "allow-reads"`，不再写旧字段）+ `Settings.allowlist`。`effectivePermission(caps, settings)`：`caps.approvals ? runMode : "allow-all"`；在 `runs.ts` 每轮开始时解析，放进 `EngineContext.permissionMode / alwaysAllow`，三个引擎工厂读 context 不读线程。`ThreadRecord.permissionMode / alwaysAllow` 从类型里去掉（旧 JSON 里的残留字段无害），`assertEngineSupportsMode` 和 codex 里的重复检查删掉。compact 路由看 `capabilities.compact`，模型清单的 `defaultModel` 回退看 `knownDefaultModel`；`settings.defaultModel` 只对 `settings.defaultEngine` 生效。
  - allowlist 按命令：条目是工具名或 `bash(<head>)`。`packages/engine/src/allowlist.ts`（零依赖，子路径导出 `@vgent/engine/allowlist`）一份解析器两处用：自研引擎的 `decideApproval`（子代理的 `denyUnapproved` 走同一条）和浏览器的 `lib/autoApprove.ts`（读 `part.input.command`，给 harness 引擎自动点批准）。一条命令的每一段的 head 都在名单或内置安全清单里才免审；子 shell、`$()`、反引号、重定向、引号、glob、`FOO=1` 前缀、`sudo` / `env` / `xargs` / `sh` 这类包装一律算读不懂，不免审也不给「一直允许」（2026-10-01 包装名单补上 `timeout`、`nice`、`stdbuf`、`setsid`、`flock`、`parallel`、`busybox`、`dash` 等）。内置安全清单 2026-10-01 收紧：去掉 `pnpm test` / `npm test`（它跑 agent 刚写的代码），清单里的命令带了写文件或执行程序的选项也不免审——git 子命令后的 `--out*` / `--ext*` / `--textc*`（按前缀，挡住缩写）、rg 的 `--pre` / `--hostname-bin` / `--search-zip` 和任何含 `z` 的单横线词（`-nz`、`-0z` 这种簇）、find 的 `-fls` / `-fprint0` 和原有的 `-exec` / `-delete` 等。审批卡按钮写「一直允许 mkdir、touch」（只列这次调用里还没放行的 head），逐个 `POST /api/settings/allowlist`（串行，避免并发读改写互相覆盖）；移除走 `DELETE /api/settings/allowlist/:tool`，现在由设置页「通用 → 一直允许」逐条调用（2026-10-01；路由不再二次解码，`bash(date +%Y)` 这种带 `%` 的条目也删得掉）。旧文件里裸的 `bash` 继续按原意生效，可在设置里撤销（现在的「一直允许」组照原样列出 `bash`）。
  - 模型选择器：`components/ModelPicker.tsx` 重写成唯一的分组选择器，并行拉每个引擎的清单（一个失败不挡别的），组标题是引擎 label，没有审批能力的组标「只能全自动」，每组第一行「默认」，回调给 `(engine, model)`；有对话的任务里别的组收起并写「已有对话的任务不能跨引擎换模型」（`PATCH` 一次带 `engine` + `model`，server 仍有 409 `engine_locked`）。chip 用清单里的 label；自研组的 Codex 订阅模型 label 复用 Codex 的显示名。`ReasoningPicker` 不再吃 `settings.defaultModel`。
  - 界面：空状态一行只剩项目 · 运行位置；任务头去掉引擎 / 模型 / 权限三个 pill 和每任务的放行名单；聊天框顶行在「引擎不支持审批且运行模式不是全自动」时写一句「Codex 不支持审批，这个任务会全自动运行」；设置页依次是运行模式三档、一直允许的工具、默认模型（分组选择器，写 `defaultEngine` + `defaultModel`）、worktree 上限、MCP。
  - 浏览器实测（临时 `--data-dir`，Claude Code 真跑）：旧格式 `settings.json`（`defaultPermissionMode`）启动后 `runMode` 迁移正确、旧字段保存时丢掉；带 `permissionMode` 的旧任务记录正常打开；空状态四个选择；三组模型；选 Codex 的 GPT-5.5 出提示；询问模式下 `mkdir -p tmpdir && touch tmpdir/a.txt` 出卡片「一直允许 mkdir、touch」，点后落盘 `["bash(mkdir)","bash(touch)"]`，同一轮里第二条同类命令不再问。
- **M4 Plan 模式**（`0ea7299`）。
  - `ThreadRecord.mode?: "plan"`（缺省 = agent），`POST /api/threads` 和 `PATCH` 接受 `mode`；进行中 409，引擎 `capabilities.planMode` 为 false 时 400 `plan_unsupported`（换模型把 mode + engine 这一对弄坏也算）。
  - 只读是**强制**的，不是靠提示词：自研引擎的 plan 回合工具集里根本没有 `write` / `edit` / `bash` / `coder` / `memory` / MCP，只剩 `read`、`grep`、`glob`、`explore`、`askUserQuestions`、`updatePlan`（`packages/engine/src/engine.ts` 的 `PLAN_TOOL_NAMES`）；Claude Code 走 harness 的 `HarnessAgent({ activeTools })`，适配器把补集作为 `disallowedTools` 传给 CLI，bridge 的权限层也会拒掉不在名单里的原生工具，不需要 server 兜底拒绝。提示词一份两用：`packages/engine/src/instructions.ts` 的 `planModeInstructions({ askTool })`，Claude Code 通过 harness 已有的 `instructions` 选项注入。`EngineContext.planMode` 每轮带下去。
  - 计划文档：`packages/server/src/store/plans.ts`，`<dataDir>/plans/<threadId>.md`（0600，原子写，上限 256 KB）。plan 回合正常回到 `idle` 时，`runs.ts` 的 `savePlanFrom` 把最后一条助手消息的正文写进去；停在提问、被中断、出错都不写。`GET / PUT /api/threads/:id/plan`（进行中不许 PUT，超限 413），删任务时一起删。
  - Web：聊天框的模式 chip 是 Agent / Plan 弹层，⇧Tab 切换（只在能切的时候 `preventDefault`）；选了不支持 Plan 的模型时 chip 置灰、`title` 写「Codex 不支持 Plan 模式」，已在 Plan 时选这种模型会退回 Agent 并 toast 说明；进行中不能切。`features/plan/PlanDocument.tsx`：渲染 Markdown、编辑、⌘S / 失焦 / 按钮保存、未保存标记、外部更新时「有新版本 · 载入」、Build（保存 → `PATCH mode: agent` → 发一条「按下面的计划执行。」+ 文档全文的用户消息）。plan 回合结束时右栏自动翻到「计划」一次。
  - 浏览器实测（Claude Code，主目录任务）：⇧Tab 把 chip 从 Agent 切到 Plan；plan 回合后仓库 `git status` 和之前一字不差、计划文档生成；在「计划」tab 把步骤里的小节标题手改成「用法（Kumquat）」并保存；点 Build 后 chip 回到 Agent，agent 写进 README 的标题正是「## 用法（Kumquat）」。Coder 另用自研引擎走了同一遍，并做了对抗测试（plan 回合里要求直接写文件 → 只有一次 `read`，仓库没动）。
  - 顺手：`apps/desktop/scripts/prepare-desktop.mjs` 在 `pnpm -w build` 之前先跑 `pnpm install --frozen-lockfile`（build 56 第一次打包就是死在主目录没装新依赖上）。
- **M5 的 checkpoint 一半**（`56b615d`）。
  - `packages/server/src/checkpoints.ts`：`snapshotTree(repoPath)` 用临时 `GIT_INDEX_FILE`（先拷一份真 index 进去复用 stat 数据，大仓库不用每轮重算哈希）`git add -A` + `write-tree`，不碰用户的暂存区；`integrate.ts` 的带回主目录改用同一个 helper，`exec.ts` 是两边共用的 `runCommand`。`createCheckpoint`：`commit-tree -p HEAD`（作者固定 `Vgent <vgent@localhost>`，没 HEAD 就不带 `-p`）+ `update-ref refs/vgent/checkpoints/<threadId>/<n>`；每个任务留最新 50 个，删任务时清掉；不是 git 仓库返回 `undefined`；任何 git 失败只记 warning，绝不拦回合。本仓库实测一次 checkpoint 约 0.1s。
  - `runs.ts` 的 `start()`：只有新用户消息开始的回合才打（审批 / 回答的续跑不打），在 `whenSetupSettled` 之后、引擎开跑之前；结果挂在**那条用户消息**的 `metadata.checkpoint { commit, ref, at }` 上（`ThreadMessageMetadata` 里唯一属于用户消息的字段）。
  - `POST /api/threads/:id/checkpoints/restore`，`{ messageId }` 或 `{ commit }` 二选一 → `{ restored, undo, changeStats? }`；进行中（含停在审批 / 提问）409，commit 不在该任务的 checkpoint refs 下 404（不允许恢复任意 sha），worktree 已回收 409。恢复前先把当前状态打成 `…/undo-<n>`，所以可撤销。`restoreCheckpoint` 拿目标树和当前树做 `diff --name-status`：只在当前树里的路径删掉，其余从临时 index `checkout-index -f` 写回；真 index、HEAD、被忽略的文件都不动。
  - Web：`worklog/Turn.tsx` 的用户消息块在 hover / 键盘焦点时露出「恢复到此处」，两步确认沿用「全部丢弃」的样式，主目录任务多一句「包括你自己在这之后改的文件」；成功后 toast「已恢复到此处」带「撤销」（`lib/toast.tsx` 新增可选 action，带 action 时停留 8s），并刷新变更面板和审查 pill。
  - 浏览器实测（主目录任务，仓库里本来就有未提交改动，Claude Code 真跑两轮）：恢复到第二条 → `ck-a.txt` 回到 one、`ck-b.txt` 消失，原有的未提交改动和暂存区原样；恢复到第一条 → 两个文件都没了；恢复后立刻点撤销 → 回到恢复前；审查 pill 的数字每次都跟着变；两条消息始终在日志里。
- **M5 的排队一半**（`a1e3364`）。
  - `ThreadRecord.queue?: { id, text, createdAt }[]`（空了就删字段，不存 `[]`），随 `/api/state` 下发。`packages/server/src/queue.ts`：上限 20 条 / 每条 32 KB，`createQueueStore` 用每任务一条 promise 链当锁，`append / edit / remove / take / putBack`。路由都回整条 `ThreadRecord`：`POST /api/threads/:id/queue`、`PATCH …/queue/:itemId`、`DELETE …/queue/:itemId`、`POST …/queue/:itemId/send`（进行中 409，暂停的队列靠它手动续上）。
  - 派发在 run manager 里：`start()` 的主体抽成 `startTurn`，server 自己发的回合和 HTTP 发的走同一条路（checkpoint、plan 模式、等 setup 都有）。回合的 `finally` 释放槽位后 `setTimeout(0)` 调度 `dispatchQueue`，它重读记录，只在 `idle` + 未归档 + 队列非空时取队首。不重复派发靠四层：取队首是在锁里先删后发；每任务一个 `dispatching` 标记；不在 `finally` 里内联调用；和客户端 POST 抢跑时以 `start()` 的 409 为准，输的一方把条目放回队首。等审批 / 等回答、出错、被停止都不派发；启动时 `idle` 且有队列的任务补派一次，恢复成 `interrupted` 的不派。
  - 偏离任务书的一处：往**空闲**任务排队会立刻派发，堵住「客户端以为还在跑、POST 到的时候回合刚结束」的缝；所以空闲任务不会挂着队列，「发送」只出现在真暂停的队列上。
  - Web：运行中回车 → POST（2026-09-21 起聊天框里没有「排队」按钮了：回车就是排队，运行时那一格只留「停止」，同 Cursor），成功才清草稿；聊天框框内上方是 `composer/QueueStrip.tsx`（「排队 N」、行内编辑 Enter 存 Esc 取消、删除、暂停原因「已停止，排队暂停」等、队首「发送」）。`lib/drafts.ts`：`vgent.draft.<threadId>` / `vgent.draft.new`，每次访问 try/catch，任务没了就清。`lib/threadChats.ts` 的 `attach()`：任务变成进行中而本客户端没发过消息时，先重载历史再续流，server 自己追加的用户消息才会出现。右栏「队列」tab 改名「待处理」。
  - 浏览器实测（Claude Code 真跑，全自动）：`sleep 20` 的回合里排两条，把第二条改成写 `two`，中途刷新页面；两条按顺序自己跑完，`q1.txt` 是 1、`q2.txt` 是 two，三条用户消息各带一个 checkpoint，刷新后的页面日志齐全；再起一轮排一条后点停止 → 「排队 1 · 已停止，排队暂停」，点「发送」跑完；草稿切任务回来还在，刷新后还在。
- **主目录任务的任务基线**（`551d62e`，自查走偏时发现的 M1 缺陷）。原来主目录任务对 `HEAD` 算改动、「提交」是 `git add -A`：仓库里有用户自己的未提交改动时，新任务一出来就「审查 +N」，提交会把用户的半成品一起提交。现在：第一轮的 checkpoint 同时钉成 `refs/vgent/checkpoints/<threadId>/base`（不参与 50 个上限的清理，删任务时一起删），sha 记在 `ThreadRecord.baselineCommit`（不挂在消息上，`/compact` 丢不了）。`git.ts` 的 `DiffBase = string | { tree } | { none: true }`：checkpoint 基线走**树对树**（`snapshotTree` 取当前状态再 `git diff <base> <tree>`），用户本来就未跟踪的文件不会被算成任务新增；没跑过的任务是 `{ none }` = 没有改动；基线功能之前建的任务仍对 `HEAD`，`GET …/integration` 带一句 `note` 说明。按文件还原用 `git restore --source <base> --worktree`，不碰真 index。提交只 stage + commit 任务动过的路径（`--pathspec-from-file`，2026-10-01 起每条都是 `:(literal)`），提交后把基线重新钉到提交后的快照；2026-10-01 起提交前 `committable` 先筛掉 git 不认识、又被 `.gitignore` 盖住的路径和只曾未跟踪、已被任务删掉的路径（否则整条 `add` / `commit` 失败或半途而废），`add` 或 `commit`（含 hook 拒绝）失败时把真 index 按字节和 mtime 原样放回（`keepIndex`）；按文件还原先把整个目录打成 `…/revert/<n>` 快照，打不成就 500 `checkpoint_failed`、不还原；`integration.commitFiles` 给动作条写「提交 N 个文件」。顺带修了 `snapshotTree` 的一个竞态：临时 index 要保留真 index 的 mtime，否则同一秒内写入、大小不变的文件会被 git 当成没变，快照里留的是旧内容。
  - 浏览器实测（验收仓库里事先留了：改过的 README、改过的 `src/greet.js`、一个已暂存的新文件、若干未跟踪文件）：新主目录任务开跑前没有审查 pill；回合后「审查 +2 −0」只列任务动过的两个文件，`greet.js` 只算任务加的那一行；提交后 `git show --stat` 只有这两个文件，用户的 README 改动、暂存的文件、未跟踪文件原样。边界：`greet.js` 是用户之前就改过的文件，提交按整个文件走，用户那一行也进了提交。所以 `integration.commitFilesWithOwnEdits`（任务路径里基线内容和 `HEAD` 不同的个数，`42ae9bf`）不为 0 时，动作条写「提交 N 个文件，其中 M 个含你之前未提交的改动，会一起提交」。
- 验证：`pnpm build && pnpm test` → 61 文件 / 507 测试通过（另 5 文件 / 12 测试 `VGENT_SMOKE` 门控默认跳过；含合并 main 的实例锁之后）。浏览器实测（临时 `--data-dir` + 一个临时 git 仓库，Claude Code 真跑）：worktree 任务里 agent 改一个文件、新建一个文件、自己 `git commit` 一次、再留一个未跟踪文件，合并 M1 之前「审查」只剩 `+1 −0`，之后是 `+3 −0`、面板列全三个文件并标「领先基线 1 个提交」；带回主目录后主检出 HEAD 不动、出现同样三处未提交改动（当时主检出已比任务基线多一个提交，补丁照样干净应用）；再点一次给出三个冲突文件、主检出不动；提交后任务头 / 侧栏行 / 动作条都是「已提交 <sha>」且文件清单仍是全量；全部丢弃二次确认后 worktree 干净、被忽略的 setup 产物还在；归档后 worktree 目录消失、留快照、任务进折叠的「已归档」，取消归档后提交和未跟踪文件都回来；删除任务后 worktree、记录、空分支都没了。setup：字符串值指向不存在的脚本 → 退出码 127 的警告、任务照跑；数组值含 `sleep 3` → 期间显示「正在准备工作目录…」，回合等它结束才开始，标记文件里的 `ROOT_WORKTREE_PATH` 是主检出。M2 验收标准：本仓库的克隆登记成项目，新 worktree 任务 setup 2.4s 装完依赖，在该 worktree 里 `pnpm build && pnpm test` 全绿。
- M1 验收补丁（`f8693c3`）：启动时（detached，排在上限回收之后）给没有 `changeStats` 的旧任务补算，否则它们会错落在「已完成」；`GET /api/threads/:id/changes` 顺手把过期的统计改正并落盘（用户在 Vgent 外面提交 / 改文件后侧栏跟着变，不多跑 git）；停在等审批 / 等回答的任务也算进行中，收口和归档回 409 `thread_running`，动作条和行菜单的「归档」禁用并用 `title` 说明，删除不受影响。三条都在浏览器里实测过。
- **拒绝审批后卡在「进行中」**（`907aa64`，不是回归，harness 引擎接上那天起就有）。根因：`convertToModelMessages` 把 `approval: { approved: false }` 转成尾部 `role: "tool"` 消息里的两个 part，一个 `tool-approval-response`，外加一个合成的 `tool-result`（`output: { type: "execution-denied" }`）；harness 的 `collectHarnessAgentToolApprovalContinuations` 见到该调用已有 tool result 就当它了结、跳过审批回应，于是 `submitToolApproval({ approved: false })` 永远不被调用，bridge 的 `canUseTool` 一直挂着。批准不受影响（不合成结果）。修法：`packages/server/src/engines/harness-messages.ts` 的 `stripDeniedApprovalResults` 在交给 harness 前去掉被拒调用的合成结果，Claude Code 的 `stream` / `continueStream` 两条路都过一遍（Codex 同样处理，但它不会停在审批上，等于空操作）；自研引擎必须保留那条合成结果，那是模型知道被拒的唯一途径。真机冒烟（`VGENT_SMOKE=1`，`server.smoke.test.ts`）：修之前挂 11 分钟以上，修之后 9.5s 结束并回一句「命令被拒了」。值得给上游提 issue。
- 已知未修：上限回收只有单测、没在界面里实测。（PR 链接消失和 `bash(git)` 放行 push 两条已在下一节修掉。）

### 对照 Cursor 之后的一批（2026-09-19，依据 `docs/cursor-compare.md`）

读了装在本机的 Cursor 3.19.7 的真实行为之后，按任务一生的七步逐点对照，挑出来做的几项。第 1 条（模型选择器去掉引擎分组）没做：同一天另一个会话把模型这块按「每个 agent 勾自己的模型」重做了，方向相反且更新。第 8 条（默认运行模式改成自动改文件）撤回，原因见下。

- **收口**（`apply.ts` 新增）。带回主目录从「整棵树出补丁再 `git apply`」改成逐文件三方合并：base = worktree 的 `baseCommit` 树，theirs = `snapshotTree(worktree)`，ours = 项目里磁盘上的文件。先计划后写入两遍，所以「有冲突整体不动」是一个决定而不是回滚。base / theirs 经 `checkout-index` 落到临时目录（二进制安全、保留模式和符号链接），`git merge-file` 原地合并，干净的结果用 scratch `GIT_INDEX_FILE` 写回，用户的 index 和 HEAD 全程不动。规则：任务删了且 ours==base 就删，否则冲突；任务新增且 ours 不存在就写；ours==base 整个取 theirs（只改了模式也走这条）；二进制、符号链接只有 ours==base 才取 theirs；子模块一律冲突；重命名按删加增。`POST .../integrate` 多了 `conflicts: "markers"`（文本冲突写标准标记，标签「你的改动 / 任务的改动」；删改、二进制、符号链接冲突只跳过并列出）和 action `undo-apply`。撤销点是带回前给项目打的一个快照，存在 `refs/vgent/checkpoints/<id>/apply/`（`listRefs` 看不见它，所以不会出现在「恢复到此处」里，`deleteCheckpoints` 照样清），`ThreadRecord.applyUndo` 记快照和每个文件带回后的 sha256；撤销只还原指纹还对得上的文件（`restoreCheckpoint` 新增 `paths` 过滤），你之后动过的留着并列出来。归档清掉 `applyUndo`。依赖一个前提：`git worktree add` 出来的 worktree 和项目共用对象库。2026-10-01 收紧（`typeClash`、`sameFilePairs`）：任务要写文件的地方在主目录是目录、或任务把目录换成文件 / 文件换成目录，路径中间有符号链接（不顺着它写也不顺着它删），都是冲突；只改大小写或 Unicode 写法的改名在不分大小写的盘上是同一个文件（按 inode 认），按「删旧名 + 写新名」一对处理，主目录改过就两边都报冲突；任务目录里没提交过的嵌套仓库和读不出的文件（快照收不进来）也列为冲突，默认整次带回不动。计划里每一步记下当时主目录文件的指纹，`runApplyPlan` 写之前逐条复核，变了的跳过并列为「写入前这个文件又变了，没有动它」；所有删除先于写入。撤销带回先给主目录打 `apply/undo-<n>` 快照，打不成就不撤；`partitionUndo` 把那之后变成目录、或父路径变成文件 / 链接的路径算作用户的，不还原。
- **开 PR 不靠 `gh`**。有任何 remote 就给按钮（优先 origin）：有没提交的先提交，`git push -u`，GitHub 远端返回 `/compare/<default>...<branch>?expand=1` 由 web 新开窗口（桌面壳把新窗口交给系统浏览器），非 GitHub 只推分支、`outcome.kind = "pushed"` 加一句说明。`ThreadRecord.pr` 单独存、新一轮不清；`GET .../integration` 带 `pr.path` / `pr.hint` 和 `canUndoApply`；错误体多了可选的 `error.details`（目前只有冲突清单）。
- **allowlist 细到子命令**。`@vgent/engine/allowlist` 的条目从「命令头」变成「命令」：内置一张复合命令表，表里的命令记「头 + 紧跟的裸词」，只有两词形式。导出随语义改名：`segmentCommand` / `commandsToAllow` / `unlistedCommands` / `bashEntryCommand`，新增 `isVoidedBashEntry`（旧的 `bash(git)` 不迁移、不放行，设置页标已失效；2026-10-01 的「一直允许」组不再标，照原样列出、可移除）。仍然零依赖，server（`decideApproval`）和浏览器（`pendingAutoApprovals`、审批卡）共用同一份判断。
- **默认运行模式没改**。Claude Code 的 harness 桥接层（`@ai-sdk/harness-claude-code` 的 `bridge/index.ts`）在 `allow-edits` 下等于 CLI 的 `acceptEdits` 加只对 Bash 类工具的 ask 规则，`canUseTool` 对所有编辑类工具直接 allow、不看路径；`ClaudeCodeHarnessSettings` 里也没有 hooks 或 settings 透传。所以「目录外写入会问」只对自研引擎成立（`packages/tools/src/paths.ts`）。要补这个缺口，得让 harness 跑在 `allow-reads`、由我们在 server 端自动批准工作目录内的编辑；现在 harness 引擎的自动批准只在浏览器里发生，做不了。
- **草稿和界面偏好上 server**。桌面壳用 `--port 0` 起后端、`WebviewUrl::External` 指过去，端口是源的一部分，`localStorage` 每次启动都是空的。新增 `store/drafts.ts`（一份 `<dataDir>/drafts.json`，key 是 threadId 或 `new`，写空即删，64 KB 上限）和 `GET/PUT /api/drafts/:key`，删线程顺带删草稿；`Settings` 加可选 `theme` / `density`。web 的 `lib/drafts.ts` 变成 `DraftSync` + `useDraft`：server 为准，`localStorage` 只是首帧缓存；300 毫秒防抖、2 秒封顶，切任务、卸载、`pagehide` / `visibilitychange` 都 flush（`keepalive`）。`ThreadChats.send` 改成在聊天 POST 的响应上结算「是否被接受」，被拒时撤回乐观加进日志的那条、文字留在框里；`useWorkbench.send` / `startThread` 返回布尔。
- **未读和系统通知**。`ThreadRecord.unread`；`runs.ts` 的 `marksUnread` 决定哪些落点标（idle / error / awaiting-approval / awaiting-input，停止和中断不算）；`PATCH /api/threads/:id` 对「只改 unread」放行运行中的线程（排队会在清未读的同一刻开新回合）。web 在任务被选中且 `!document.hidden && document.hasFocus()` 时清掉；手动「标为未读」在切走之前不被自动清。`apps/web/src/features/notify/`：`notify.ts` 纯判断加内存账本（每次状态转移只发一条），`host.ts` 投递（桌面查权限走 `window.__TAURI__.notification`、发送走壳自己的 `notify_task`，浏览器走 Web Notification，只在用户打开设置开关那一下申请权限），每发一条 `console.info("[通知] ...")`。点通知打开对应任务：插件在桌面上收不到点击，所以 `apps/desktop/src-tauri/src/notify.rs` 直接用它底下的 `mac-notification-sys` 发，每条开一个线程等点击（点了或从通知中心清掉才结束），点了就拉起窗口、在页面上派发 `vgent:open-task`；浏览器的 `onclick` 派发同一个事件，`useNotifications` 收到后选中任务（已删的任务只拉起窗口）。桌面加了 `tauri-plugin-notification`，`capabilities/main.json` 只多给 `is-permission-granted` / `request-permission` 两个插件命令和 `allow-notify-task`（`build.rs` 的 app manifest 声明，远端页面调应用命令也要过 ACL）。`Settings.systemNotifications` 缺省即开。
- **打断并发送**。`POST .../queue/:itemId/send` 接受 `{ interrupt: true }`：任务还活着时先按「停止」的路子停掉当前这轮（等审批、等回答的也算），再发这条；条目 id 不存在先回 404，不会白白停掉正在跑的回合；不带 `interrupt` 照旧 409。
- **界面骨架**（对照文档第 10 条，只做了聊天框和侧栏顶部两处）。`apps/web/src/features/composer/ComposerStatusBar.tsx` 是聊天框下面那条常驻行：分支、运行位置、「审查 +N −M」（从框上方挪下来）、上下文环（从框里挪出来）。`location.ts`（带测试）决定显示哪个分支和目录：worktree 任务用 `workspace`，主目录任务回退到变更快照里的当前分支。空状态还没有任务、读不到快照，所以新增 `GET /api/projects/:id/branch`（`Git.branch()`）。`Composer` 的 `location` 变成 ReactNode 插槽，空状态塞选择器、任务里塞静态标签，仍然只有一个 composer。框内从左到右：「+」、模式 chip（只在非 Agent 时出现，带 ×）、模型、思考、排队、发送或停止；「+」是个小菜单：引用文件 @ 和模式（Plan 在引擎不支持时置灰并写原因）。侧栏顶部两个入口加「任务」小标题和筛选图标；标题栏去掉了密度、主题、⌘K。`AppearanceSection.tsx` 里主题和密度点了就生效并存 server，`SettingsView` 的 `withoutAppearance()` 把这两个字段排除在脏检查和「保存」的请求之外，修掉了「保存会把打开页面那一刻的主题写回去」。没动的：右栏竖排、标题栏前进后退、回复下方的动作行；任务头里的分支 pill 还在，所以 worktree 任务的分支现在出现两次。
- **checkpoint 收窄**（`restore.ts` 新增）。每个回合现在有一个编号和最多两个 ref：`<n>`（开跑前）和 `after-<n>`（结束时，提交在开跑前那个之上），恢复前的保险快照是 `undo-<n>`；保留期按回合数算，仍是 50 个回合，一个回合的两个 ref 一起清。结束快照在回合的 `finally` 里打：排在用户看得见的状态更新之后、`scheduleDispatch` 之前，停在审批上的回合不打（由它的续跑来打）；上一轮没有结束快照时，借下一轮的开跑快照补上。一轮动过的文件 = 两个快照之间 `git diff --name-only --no-renames` 的结果。恢复到第 k 条消息之前，只写回从 k 到当前位置各轮动过文件的并集（复用收口那次给 `restoreCheckpoint` 加的 `paths` 过滤），往前走（点灰掉的消息，或「回到最新」）是同一条规则；某一段没有结束快照（老任务、崩过、快照过期）就退回整目录，确认文案明说。`POST …/checkpoints/restore` 的入参改成 `{messageId}` 或 `{latest:true}`，新增 `GET …/checkpoints/preview` 先算出会动几个文件。线程记 `restoredTo: { messageId, undoCommit }`（再次恢复时 `undoCommit` 保持第一次的，所以「回到最新」回的是真正的最新）；web 去掉了 8 秒的撤销提示，改成恢复点上的常驻横幅（`RestoredBar.tsx`）和其后消息 45% 透明度。从恢复点发新消息会清掉标记，并只在那一轮的模型输入里加一句「工作目录已恢复到某条消息之前」（`withRestoreNote` 加在转换后的最后一条 user 消息上，三个引擎通用，不进存下来的对话）。`git.ts` 的 `DiffBase` 多了 `{from,to}`（树对树，不看工作目录），`/changes` 和 `/changes/file` 接受 `?scope=last-turn`，`/changes` 的响应带 `lastTurn`；`ScopeToggle.tsx` 是面板顶部的「全部改动 / 上一轮」，至少两轮且最后一轮跑完了才出现，「上一轮」里不给按文件还原和动作条。已知的不精确：回合运行期间你自己改的文件会算到那一轮头上。
- 验证：全量 70 文件 / 612 测试（另 5 文件 / 13 测试门控跳过）。浏览器实测（临时 `--data-dir`，带脏改动的验收仓库，Claude Code 真跑）：草稿、浅色、紧凑在 7491 写下，换到 7492（新的源）起同一个数据目录后都还在；`sleep 45` 的回合里排一条点「打断并发送」，回合停下、那条发出并得到回复；跑完的任务带未读点、按状态落在「待处理」；存着旧的 `bash(git)` 时 `git stash list && git remote -v` 仍然询问，审批卡给「一直允许 git stash、git remote」，点了写进 `bash(git stash)` / `bash(git remote)` 后回合继续；worktree 任务改了用户在主目录也改过的 README 并新建 LICENSE.txt，默认带回被拒并写明「README.md 两边改了同一段」、主检出一字未动，「带冲突标记合并」后标记和新文件都在，「撤销带回」后用户的改动原样、新文件消失，三步前后 `git ls-files -s` 的哈希一致。没验：系统通知真的弹出来（要装好的桌面包）、`gh` 和真 GitHub 远端、真 WebView 里的草稿。
- 这一批最后的验证：全量 71 文件 / 632 测试（另 5 文件 / 13 测试门控跳过）。checkpoint 的浏览器实测（同一套临时环境，Claude Code 真跑，主目录任务）：第一轮新建 `cp-a.txt`，排队的第二轮把它改掉并新建 `cp-b.txt`；之后我手改了无关的 `NOTES.md`；在第一条消息上点「恢复到此处」，确认文案写「会还原任务动过的 2 个文件；你自己改的其它文件不动……」，确认后两个文件消失、`NOTES.md` 那一行还在、README 的未提交改动和暂存区（`git ls-files -s` 哈希）不变，出现横幅、后面的消息变灰；「回到最新」后两个文件回到第二轮结束时的内容，横幅消失；变更面板里「上一轮」只列第二轮（`cp-a.txt` 改、`cp-b.txt` 新增），显示「只看不改」，动作条隐藏。界面骨架也在同一环境里看过：空状态和任务里聊天框下方都有分支、运行位置、审查、上下文环；Plan chip 只在 Plan 时出现，× 回 Agent。没验：worktree 任务的恢复、Codex 和自研引擎收到那句恢复说明。

### 对着 Cursor 真窗口量出来的一轮（2026-09-19）

依据不再是印象：只截 Cursor 3.19.7 Agents 窗口（1512×874，2x）逐像素量，配色和字号体系从它的 `workbench.glass.main.js` 里取。

- **它的数值体系**。token 是 11/12/13/14px、行高 22px、行 28px、圆角 2/4/6/8/12/14/16/18，Agents 窗口自带约 1.1 倍缩放（Electron zoomLevel 0.5），所以屏上量到的是 12/13/14/15px、行高 24px、行 30px。Vgent 取屏上值（默认密度），紧凑密度取它的原始 token。配色只有四个底色 `base / chrome / editor / sidebar`（深 `#F0F0F0 #141414 #181818 #181818`，浅 `#141414 #F5F5F5 #FCFCFC #ECECED`），文字 100/74/60/36%、描边 20/12/8/4%、选中行 6% 都是 base 按百分比混出来的。`tokens.css` 的语义层改成同一套：主题只改四个底色，其余派生；新增 `--color-bg-sidebar / --color-bg-strong / --color-fg-secondary`。
- **布局**（量到的 → 落地）。左栏 260、右栏列表态 260、会话列 760 居中、顶条 35、左栏行 30 间隔 1、行内距 7、任务标题缩进 30、用户消息框 y=39 高 41 圆角 12 内距 12、composer 单行高 40 圆角 20、其下一行高 30。没有单独的窗口条了：三栏通到顶，各自顶上 35px 就是标题栏（`TitleBar.tsx` 删除，`components/TopStrip.tsx` 给中栏、空状态、设置页共用）。项目切换 / 添加挪到左栏「工作区」标题右边的文件夹图标，连接断开写在左下角。
- **左栏**。任务行从两行改成 Cursor 的一行：标题 + worktree 记号 + `5m / 3h / 2d`（`shortTime`），状态点和未读点放在标题左边的缩进里，hover 时时间让位给「…」菜单；运行中的当前动作降为 hover 文字。⌘B 不再收成 48px 图标条而是整个收起，展开按钮出现在中栏顶条。
- **会话**。工具行、折叠行、思考行都是会话字号（15px）的一行灰字，箭头在行尾、hover 才出现；`查看 N 步 ▸` 改成 `共 N 步 ⌄`；回复下面多了一个安静的复制按钮。
- **composer**。任务里是一行药丸：`+`、输入、模式 chip（仅 Plan）、模型、思考、发送；文字换行时向上长。空状态保留高的那一版（输入在上，控件一行在下）。发送键从琥珀色改成前景色实心圆（Cursor 是黑 / 白圆）。琥珀色只剩运行中呼吸点、角标、Plan chip。
- **右栏**。默认以列表态打开：「在 <项目>」+ 变更 / 文件 / 终端 / 计划 / 待处理，一行 28，和窗口同底、无描边；点一项才变成 420 宽的工具面板（顶上是图标 tab，左边 `‹` 回列表）。没有任务时不显示。
- **桌面壳**。macOS 用 `TitleBarStyle::Overlay` + `hidden_title`，红绿灯压在左栏顶条上（左栏收起时压在中栏顶条，留 76px）；`capabilities/main.json` 多开一条 `core:window:allow-start-dragging`，顶条带 `data-tauri-drag-region`。
- 没对的：Cursor 的 Automations / Customize 两个入口、前进后退箭头、麦克风、回复下的赞踩和 fork、`IDE ↗`——Vgent 没有对应功能，不摆空壳。思考等级 Cursor 没有独立控件，Vgent 留在模型旁边。空状态没拿到 Cursor 的真图，只换了字号和控件样式。

### composer 四项（2026-09-19 晚，用户在 build 68 上的反馈）

- **推理强度**。chip 不再写「思考」，只显示选中的档位（`高 ⌄`），浮层标题「推理强度」。Claude Code 原来给的是 harness 的 `thinking` 三态（关 / 自适应 / 开），换成它的 `effort` 五档 `low … max`（`claudeCodeEffort`），thinking 固定 adaptive + summarized；老线程里存的 `adaptive / enabled` 当作没选，`disabled` 仍然关思考。三个引擎没选档位时一律按「高」跑（`packages/server/src/reasoning.ts`）：目录里 `defaultReasoningLevel` 在模型有 `high` 时报 `high`，没有才用来源自己声明的；引擎侧 `effectiveReasoningLevel` 真的把 high 传下去，不是只改显示。
- **Fast**。不写死：Codex 自己的模型目录每行带 `service_tiers: [{ id: "priority", name: "Fast", description }]`，`ModelEntry.serviceTiers` 原样带出来（Codex 引擎和自研引擎的 `codex-subscription:*` 都有，网关 / 自定义提供商没声明就没有开关）。线程多一个 `serviceTier` 字段，链路同 `reasoningEffort`。Codex 引擎写进 `codexConfig.service_tier`（CLI 按模型声明的 id 校验，不支持的自己丢掉并告警）；自研引擎走 `providerOptions.openai.serviceTier`，只给 `usesOpenAIReasoning` 认得的模型。composer 里是模型右边一个 ⚡ 开关，换到不支持的模型时自动清掉。Cursor 没有独立的 fast 控件，它的每模型参数全由服务端声明——这里同理，只是声明来自 Codex 目录。
- **模式走 `/`**。「+」菜单里的 Agent / Plan 拿掉。输入 `/`（行首、空白或 `(` 之后，规则同 Cursor 的 `recognizeSlash`）出菜单：模式两行在前（当前的打勾，进不去的灰掉并写原因），后面是调用方给的命令——任务里是 `/compact`（别名 `summarize`）和 `/new`。选中后把 `/xxx` 从草稿里删掉再执行。⇧Tab 和 Plan chip 的 × 不变。`features/composer/slash.ts`。
- **「+」= 选文件，支持粘贴和拖入**。附件作为普通 `file` part（data URL）跟着用户消息走，所以日志里能画缩略图。单个 10MB 上限；进草稿（2026-09-23 起，见当日节）；运行中带附件会排队到下一回合（2026-09-29 补齐，见「附件排队」节）。引擎拿到的不一样，在 `packages/server/src/attachments.ts`：Claude Code / Codex 两个 harness 适配器遇到非文本的用户 part 直接抛 `HarnessCapabilityUnsupportedError`，所以落盘到 `<dataDir>/attachments/<threadId>/` 并把 part 换成一句带绝对路径的话，CLI 用自己的读文件工具看（两个都能看图）；自研引擎直连模型，图片和 PDF 保留为 file part，文本类文件解码后内联（20 万字符截断），其它二进制给一句「读不了」——它的工具出不了工作目录，给路径没用。删线程时清掉那个目录。没验：真发一条带图消息给三个引擎（会花订阅额度），转换逻辑有单测。

### 引擎运行时：Claude Code / Codex 的 CLI 升级（2026-09-20）

- **三层，别混**。harness 引擎下面是：AI SDK 的适配器（`@ai-sdk/harness-claude-code` / `-codex`，随 app 打包）→ 厂商自己的 SDK（Anthropic 的 `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`）→ 厂商的 CLI。后两层由适配器第一次运行时装进 `~/.vgent/harness/<id>/.harness-bootstrap/<id>/`（一个 pnpm 项目，`--frozen-lockfile`），和用户终端里自己装的 `claude` / `codex` 无关，只共用登录态。
- **为什么要自己升**。适配器把这一对钉死，而且钉得很旧：2026-09-20 最新的适配器（1.0.121 / 1.0.119）仍然钉 Claude Code 2.1.245 和 Codex SDK 0.149.1，上游已经是 2.1.278 和 0.155.1。升适配器拿不到新 CLI。配对关系是数据：Agent SDK 的 npm 元数据里有 `claudeCodeVersion`，Codex SDK 依赖同版本号的 `@openai/codex`。
- **怎么升**（`packages/server/src/harness-runtime.ts`）。该引擎有任务在跑或停在审批时拒绝；把 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 复制到临时目录，`pnpm add --save-exact` 装配对的最新版，替换前后都让 CLI 报 `--version`。`pnpm-workspace.yaml` 的安装脚本放行版本也要同步，否则新版 Claude Code 的原生二进制装不上。Codex 的 CLI 是 SDK 的传递依赖，按 pnpm 布局从 SDK 的真实目录旁边找。适配器自己的 `.bootstrap-<hash>.ok` 标记不动；但 hash 包含 bridge 脚本，app 补丁变更会让适配器想重装旧 CLI。因此启动时的 `recover` 先比较新 recipe：运行时不比已装的新、其它依赖完全相同时，只更新 bridge 和标记，保留 CLI；否则由适配器安装。标记按 `@ai-sdk/harness` 的 `hashHarnessBootstrap` 重算，不匹配时退回适配器自己的安装流程。
- **连续升级与回退**（2026-10-01）。先在同卷临时目录用 pnpm 下载并验证，再用 rename 替换 `node_modules`，失败恢复安装前的版本。A → B 后 B 没跑过也能继续升 C：`.vgent-previous` 继续保留 A，本次事务的 B 单独放在候选目录的 `.vgent-replaced`；安装失败或中断恢复 B，C 运行失败或用户点击回退则恢复 A。`upgrading` 记录 `stage` 和 `preservePrevious`，状态通过原子写持久化，恢复按记录选择备份；提交状态成功前保留事务目录。运行结果不能在安装期间释放或验证另一版的备份。
- **自动升级**。不靠 semver 猜（Codex 每次发版都涨 minor）。装完 CLI 必须自己报出新版本号；后台保留 `unverified`，成功运行后释放回退备份，但这个标记不阻止后续升级。如果升级后的一轮在产生任何输出之前就挂了，自动退回保留的版本并把失败版记为 bad，自动升级不再装它。运行结果由 `createRunManager` 的 `onTurnSettled` 回报，用户手动停止的不算。设置 `autoUpgradeRuntimes`（缺省为开）；启动一分钟后查一次，之后每 6 小时；只有拥有默认数据目录的实例才自动升（`--data-dir` 起的临时实例看不到正式实例的任务）。
- **界面**。设置 → 引擎 →「引擎运行时」：自动升级开关、每个引擎一行（已装 / 最新 / 上次失败原因）、升级到 X、回退到 Y、检查更新。不再展示「待验证」，有任务在跑时说明暂不可升级；安装、回退期间其它安装按钮禁用。页面可见时每 3 秒刷新本机状态，回到前台立即刷新，不重复查询 npm。路由 `GET /api/runtimes`、`POST /api/runtimes/check`、`POST /api/runtimes/:engine/{upgrade,rollback}`。
- 验过：2026-10-01 在隔离目录用真实 pnpm 和 Codex 包跑通 0.159.0 → 0.159.2 → 0.159.3 → 回退到 0.159.0，CLI 的版本检查通过，中间未运行模型任务。单测覆盖手动和自动连续升级、安装前后失败、替换前/两次 rename 之间/替换后中断恢复、迟到的运行结果和成功后的新回退基线。新版 SDK 与 bridge 的真实模型回合兼容性仍由运行时验证；Claude Code 的安装使用假 pnpm 测试。
- **build 70 当天就出的事故**（2026-09-20）：用户装上后两个引擎的安装目录都成了半截——新版已下进 `.pnpm`，顶层包链接被拆掉，`package.json` 没改完，状态文件里没有任何失败记录，界面显示「还没安装」。说明升级进程是中途没了的（多半是下载途中 app 被退出），而第一版完全没考虑这一点；桌面壳又不留 server 日志，事后查不到原因。修法：动手前先在状态文件里记 `upgrading`（含 pid），下次启动或任何操作前发现写它的进程已经不在，就把备份放回去按 lockfile 重装（走本地 store，不用联网），不把目标版本记为 bad；同一版本被打断两次后自动升级不再碰它，手动仍可；所有事件连同 pnpm 的输出追加到 `<harness dir>/.vgent-runtime.log`；状态文件的读改写按引擎串行并且每次重读，避免「检查更新」把过期的 `upgrading` 写回去；一次成功的检查只清「检查失败」的报错，不清回退 / 修复的说明；界面区分「正在安装」「安装不完整」「还没安装」。
- 顺带：输入框发送后保持焦点（点发送键、`/` 命令清空草稿、从空状态进任务都一样）。

### 明确未做

- `askUserQuestions` 在 TUI 里不可用（需要 Web `useChat`）。
- `@ai-sdk/otel`。
- Web：麦克风、侧聊 `/side`、harness 引擎的子代理嵌套流（自研引擎已是实时嵌套流；Claude Code 的 Task 目前是一行 spinner + 结束后原始 JSON）、虚拟滚动、无障碍焦点管理。
- 桌面壳：Windows / Linux、签名与公证、自动更新、多窗口。

下一步：五个里程碑都已落地，先停止加功能。`docs/product.md`「现状对照」里记的缺口按需修，然后等用户在真 app 里把七步走一遍、给 Cursor 对应界面的截图做一轮对齐；每个里程碑落 main 后打包装到 /Applications。发布工程（签名 / 公证、自动更新、Windows）只在有明确需求时再启动。

## 2026-09-20：模型菜单、推理强度的归属、分叉

**模型菜单只剩三样**：灰色的 agent 名、（有的话）灰色的提供商名、模型。清单来源那一行、「只能全自动」、「已有对话的任务不能跨引擎换模型」都拿掉；已有对话的任务干脆只显示自己那个引擎的一组。只有「模型列表加载失败」还会占一行，因为那是用户需要知道的。

**推理强度为什么又丢了一次，以及现在归谁管**。等级原来是「每个清单来源各自往模型条目上贴」：Codex 目录贴它声明的，Claude Code 一律贴五档，网关只给 `openai/*` 贴。提供商的模型是在路由里每次请求现并进去的，绕过了所有这些来源，所以没有等级，聊天框里那个 chip 就消失了。现在由 `reasoning.ts` 的 `reasoningFor(engine, known)` 一处决定，提供商模型并入目录的地方和 Claude Code 自己的清单都调它。

**每个模型的档位不一样**（用户当天第二次纠正：「每个模型不一定都一样的」——我第一版是按引擎发一套，错的）。`known` 是按模型查出来的：models.dev 每个模型带 `reasoning_options: [{ type: "effort", values: [...] }]`，`catalog.ts` 读成 `reasoningLevels`（空数组＝目录认识这个模型、它没有可调的强度），`createReasoningIndex()` 按模型名的最后一段建索引——公司网关的 `anthropic-claude/claude-opus-5` 查到的就是 Anthropic 自己那条。厂商自己的条目（id 不带 `/`）优先于聚合商转卖的同名条目，否则 OpenRouter 会盖掉 DeepSeek 自己写的档位。查到的列表再按**引擎带得过去的**裁一刀：Claude Code 的 `effort` 五档，Codex 的 `model_reasoning_effort`，自研引擎发的是 AI SDK v7 的顶层 `reasoning`（各家 provider 包自己翻译成 `reasoning_effort`、Anthropic 的 `effort` 等，见包内文档 `03-ai-sdk-core/26-reasoning.mdx`；它没有 `max`）。裁完是空的就不出 chip（Haiku 4.5）。默认是「高」，模型没有「高」就取它最高的一档。只有目录从没见过的模型才用引擎的通用档位，自研引擎那套里多一个「不指定」（`provider-default`，什么都不发）：对一个一无所知的端点，必须留一条它拒收这个参数时的退路。Claude Code 的别名（`opus`）取同族最新那个模型的档位。目录缓存文件版本升到 2：旧缓存没有档位，会重拉。`portableReasoning()` 只对 `<提供商>:<模型>` 这种 id 生效，订阅和网关的模型还走原来的 `providerOptions.openai`。

**没验证的**：还没有对着真端点跑过一轮带 `reasoning` 的请求；公司网关（LiteLLM）对不认这个参数的模型是丢弃还是 400，不知道——400 的话选「不指定」。

**红点**：侧栏左边那个位置表示「需要你看一眼」。在跑、等审批、等回答，状态持续多久就显示多久；已经停下的（完成、失败、中断）只在未读期间显示，失败的是红点。原来 `error` / `interrupted` 不管读没读都画红点，而状态要到下一轮才会变，所以永远消不掉。

**分叉**：按钮在回复下面的动作行里（用户当天纠正：不在用户消息上，位置照 Cursor），含义是「从这条回复之后分叉」。`fork.ts`（`planFork` 取到这一轮结束为止的历史、去掉源任务的 checkpoint 元数据、换新 id；`forkNote` 给有自己会话的引擎拼一次性的文字记录），路由 `POST /api/threads/:id/fork`，`messageId` 是开始这一轮的那条用户消息。记录上的 `forkedFrom.pending` 在新任务第一轮开跑时清掉。恢复相关的 server 代码（`restore.ts`、checkpoints 路由）没删：快照还在给任务基线和「上一轮」用，「回到最新」也还要它。


## 2026-09-20：模型菜单改成三级（模型 → 选项 → 取值）

用户画的层级，缩进就是菜单层级：第一级一行一个**模型**（带来源图标），第二级是 引擎 / 上下文 / 推理强度 / Fast，第三级是取值。原来按引擎分组、同一个 GPT 在 Codex 组和 Vgent 组各出现一次的做法到此为止——引擎变成模型下面的一个选项，这也是 product.md 里记了很久的「只选模型只做到一半」那一条。

- **同一个模型怎么认**：server 给每个条目一个 `modelKey`（Codex 登录的模型不管哪个引擎报上来都是 `codex-subscription/<slug>`，提供商的是 `<提供商 id>/<模型 id>`），和一个 `source`（谁的模型，外加目录里的 logo id）。前端 `modelChoices.ts` 按 `modelKey` 合并成行，来源按首次出现排序、同一来源的排在一起；引擎子菜单里 Vgent 在前（用户图上的顺序）。直接点一行＝按「任务当前引擎能跑就留在当前引擎，否则取第一个」选中；已有对话的任务不能换引擎，别的引擎才有的模型不列出来。
- **图标**：models.dev 每个提供商有一个 logo（`/logos/<id>.svg`），用 CSS mask 画，跟着文字颜色走，深浅主题都对。目录里没有的来源（公司网关）和没网的时候用首字母。
- **上下文**是任务的新字段 `contextWindow`（token 数）。可选值 `contextOptions` 不是写死的：引擎自己报的窗口（Codex 目录说 272K）和提供商目录里这个模型的窗口（models.dev 说 1M）不一样时，才有得选；Claude Code 是「标准 200K / 长」，长的只给目录说能到 1M 的模型。落到引擎上各不相同：Codex 是 `model_context_window` 配置项，Claude Code 是模型名后缀 `[1m]`（和 `/model` 的写法一样），自研引擎没有「窗口」这个设置，它能管的是什么时候开始裁剪历史，所以是裁剪预算 = 窗口 × 0.8；没选时用模型列表给这个模型的窗口（就是环的分母，Codex 订阅的 GPT-6-Astra 是 272K），列表也不知道才落到引擎自己的 150K。以前没选就是 150K，界面显示 272K，一轮读两份大文档就在 150K 处爆了。换模型时 server 把它清掉（窗口是跟着模型的）。
- **级联菜单**：`CascadeMenu.tsx`，通用的。下一级用 `position: fixed` 贴在所在行旁边，所以滚动的列表不会裁掉它；它仍然是弹层面板的 DOM 后代，弹层的「点外面关闭」才不会把它关掉。悬停 110ms 才切换，斜着移进子菜单时擦过邻行不会跳。
- 聊天框里的推理强度 chip 和 Fast 按钮没动：它们是用户前一天定的，菜单是第二个入口。设置页选默认模型用同一个菜单，只有引擎一级（任务怎么跑它是任务的事）。

**没验证的**：ChatGPT 的 Codex 后端接不接受订阅账号开 1M 窗口，没跑过；Claude Code 经公司网关时 `[1m]` 后缀会不会被网关认成另一个模型名，没跑过。

**同一天的几处修正。**

- 用户追问「GPT 有报 1M 吗」：没有。Codex 订阅报的是 272K，1M 是 models.dev 里 OpenAI API 的窗口。用户确认从 models.dev 取是对的，保留。
- **保底**：models.dev 访问不了时用本地缓存（`<dataDir>/cache/provider-catalog.json`），多旧都用；旧版本格式的缓存也照用，只是算过期、一有机会就重拉。之前我把缓存版本号一升，旧缓存就直接作废，断网的机器会掉回内置预设——错的。从没拉到过目录的机器才用内置预设。
- **名字匹配**：网关的模型名不规范（`anthropic-claude/claude-opus-5`、`codex/gpt-5.5:auto`、`claude-haiku-4-5-20251001`、`x-ai-grok/grok-4.6`）。`modelKeys()` 从严到松给出三种写法：最后一段 → 去掉 `:变体`、`[1m]`、`-latest`、结尾日期 → `.` 和 `_` 当 `-`。严的写法先全部登记，松的写法不会盖掉真叫那个名字的模型；只去修饰，不猜别的模型（不去 `-mini`，不动版本号）。拿公司网关 50 个名字对真实目录：49 个对上，没对上的 `seed-2.1-pro` 是目录里确实没有。
- **默认引擎和记住上次选择**（用户定的规则）：GPT 默认 Codex 跑，Claude 默认 Claude Code，其余默认 Vgent；默认引擎跑不了这个模型时取能跑的第一个。**看的是模型是谁做的，不是谁提供的**（我第一版按来源分，用户纠正：「看模型，别看 Provider」「xd 里的 gpt 模型也默认走 codex」）：`ModelEntry.vendor` 是目录匹配到的那条所属的厂商 id（`openai`、`anthropic`…），公司网关的 `codex/gpt-6-astra` 的 vendor 是 `openai`。在「引擎」子菜单里选过一次，就按模型记住（`Settings.modelPicks[modelKey].engine`），下次点这一行直接用它；只记那一个模型，不连带同来源的别的模型。存在 server 上而不是浏览器里：桌面 app 每次启动端口不同，源变了 localStorage 就没了。写入是 `PUT /api/settings/model-picks`，server 端读改写，连点两次不会互相盖掉。之前「任务当前在哪个引擎就留在哪个引擎」的规则删了。
- **每个模型也记住推理强度 / Fast / 上下文**（2026-09-24 用户：「每个模型，要记住它上次被选择的其他选项」）：和引擎放在同一个 `Settings.modelPicks[modelKey]` 里（旧的 `modelEngines` 在 `migrateSettings` 里并进来）。菜单里改哪项就只写哪项，改回模型自己的默认就删掉那项。换到另一个模型时带上它记住的值；在任务里只换引擎、不换模型时带任务自己的值；新任务界面（`adoptRemembered`）一拿到当前模型就套上它的记忆，换模型时再套一次。套用前都过 `optionsOn`：当前引擎不提供的强度、档位、窗口一律退回默认，别的引擎上选的 1M 不会跑到没有 1M 的引擎上去。任务里切模型是一次 PATCH，模型和三项一起改。模型列表里别的行名字后面的灰色后缀，读的也是那一行记住的值。运行中不写记忆，因为那时的改动本来就会被拒。
- 只知道一个 ≥1M 窗口的模型，加一个 300K 选项（用户要的：长窗口又慢又贵，多数任务用不上）。提供商里没存窗口的模型，窗口取目录里的。

## 2026-09-20：无项目

用户要的：不指向任何仓库也能开任务。参考了两家（用户点名，要求别抄）：Koma（opencode 分支）其实没有这个东西，它的 `global` 项目只是给非 git 目录归类用的桶，每个会话仍然跑在用户选的目录里；Fumie 有，叫 quick chat——每个会话一个隐藏的临时目录当 cwd，跟工作区有关的功能一律关掉。Vgent 取的是后者的思路。

- 项目 id 是常量 `no-project`，不进 `projects.json`。`no-project.ts` 的 `projectOfThread()` 是 server 里「任务 → 项目」的统一入口：普通任务查库，无项目任务返回一个替身，`repoPath` 是 `<dataDir>/scratch/<任务 id>`（用到时才建）。一个 id 是为了侧栏能归到一个「无项目」分组下；目录按任务分是为了两个任务互相看不见对方的文件。删任务时目录一起删。
- 跟仓库有关的一律不出现，而不是点开了报「不是 git 仓库」：建任务时拒绝 worktree；空状态的运行位置不是选择器，写「临时目录」；任务页状态条写「本机 · 临时目录」、没有分支；右栏不列「变更」。checkpoint、任务基线、收口本来就对非 git 目录无操作，没有额外分支。
- 入口在项目选择器里，排在已有项目后面、「选择文件夹…」前面。
- 2026-09-21 补：「文件」的列表原来只会问 git，无项目任务点开就是「不是 git 仓库」。现在不是仓库就直接遍历目录（跳过 `.git`、`node_modules`，同样的条数上限）。

**没验证的**：没用真模型在无项目任务里跑完一整轮（隔离实例里跑到了调模型那一步，前面的建目录、快照、引擎创建都过了）；Claude Code / Codex 在一个空的非 git 目录里启动会不会有自己的提示或限制，没试。

## 2026-09-21：产物的显示（图片、SVG、公式）

起因：一个任务画了张 SVG 存成文件，用户问「不能直接显示？」，模型只能把源码再贴一遍。先读了 Cursor 3.19.7 和 Codex 桌面版的包看它们怎么做（笔记：参考目录 `findings-6-rich-content.md`），再照着做。两家共同点：文件查看器按类型预览；聊天里的图片是 `<img>`、能点开；公式 KaTeX；SVG 一律 `<img>` + data URL，不进 DOM。

**server**（`files.ts`）

- `GET /api/threads/:id/files/raw?path=`：文件本身的字节，带按扩展名定的 `content-type`，上限 20MB。响应头带 `content-security-policy: sandbox`、`nosniff`、`no-store`——这个地址只给前端 `fetch`，不是给人打开的。
- `POST /api/threads/:id/files/resolve {paths}`：这些路径里，哪些是这个任务目录里此刻存在的文件，返回根相对路径。模型写绝对路径和相对路径一样多，所以这两个接口都收绝对路径；是否在任务目录里仍然由 `realpath` 之后的前缀判断说了算（符号链接指到外面的照样拒绝）。原来的 `files/content` 不变，仍只收相对路径。
- 鉴权仍是请求头里的 token。`<img>` 带不了请求头，所以前端是 `fetch` 成 blob 再给 `<img>`，token 不进 URL。

**web**

- `lib/preview.ts`：路径 → 预览种类（image / svg / markdown）、SVG → data URI、markdown 里的地址 → 本地路径。（当时还有一个 DOMPurify 清洗，后来按用户意见删了，见下文「日志里的图只有一种样子」。）
- `features/files/fileAccess.tsx`：`FileAccessProvider` 把「这个任务的文件怎么取、点了在哪打开」交给任务视图里的任何东西；`useFilePicture(path)` 给出能放进 `<img>` 的地址（位图是 blob URL，SVG 是清洗后的 data URI），文件被重写时旧图留到新图到了再换。回合进行中不重取，结束时取一次。
- `components/RichMarkdown.tsx`：工作日志、计划文档、文件预览共用的 markdown。在 AI Elements 的 `MessageResponse`（Streamdown）外面配了四样：
  - KaTeX 的样式表（之前没引，公式一直是坏的）；`lib/mathDelimiters.ts` 把 `\(…\)`、`\[…\]` 换成 `$$` 形式，代码块和行内代码不动；单个 `$` 保持关闭（同 Cursor）。
  - `lib/svgFences.ts`（2026-09-21 补，来自一次真实任务）：回复里**裸贴**的 `<svg>…</svg>` 先包成 `svg` 代码块。模型画图时不包代码块和包的一样多；不包的话 markdown 把它当原始 HTML 清洗，只剩 `<title>` 里的字——活干了、界面上什么都没有。包了之后和别的图走同一条路；还在流式输出的是一个没闭合的 fence，渲染器本来就当「正在画…」。代码块和行内代码里的不动。
  - 代码块渲染器：`svg`，或 `xml` / `html` 且内容以 `<svg` 开头 → 显示成图，下面一个「源码」切换；不是 SVG 的 xml / html 退回 Streamdown 自己的代码块；没写完的显示「正在画…」（同 Codex）。
  - `lib/rehypeTaskFiles.ts`：排在 Streamdown 的清洗之前。它的 harden 会把不带 `./` 的相对地址整个拦掉、`file:` 也会被丢，所以本地图片的 `src` 先换成我们自己的根相对地址（`/__task_file__/<编码后的路径>`，能过清洗），渲染 `img` 时再解回来；本地链接直接换成自定义元素 `task-file`（清洗的白名单里加了它），渲染成一个在右栏打开文件的按钮——Streamdown 的链接会弹「在浏览器里打开？」的确认，对本地文件没有意义。
  - 被预览的 markdown 文档里的相对路径从文档所在目录算起（`FileAccess.baseDir`）。
- 右栏：`RightState.preview` 是一次「请打开这个文件」的请求（带 nonce，取走即清）；`FilesPanel` 先 `resolve` 成根相对路径再打开，打不开的原因写在文件树上方。工作日志里写入 / 编辑工具的文件 chip：能预览的开预览，其它仍开 diff。
- `features/worklog/outputs.ts` + `TurnOutputs.tsx`：回合产物。候选来自两处——写入 / 编辑工具的调用，和回复正文（链接目标、读起来像文件名的行内代码；已经用 `![]()` 贴出来的不重复算）。只靠工具调用不够：Codex 改文件不产生工具调用（适配器发的是 `file-change` 事件，server 没接）。候选交给 `resolve` 确认存在之后才出卡片，所以模型随口提到的名字不会变成打不开的卡。图片一律算，文档只有回复提到才算。

**没验证的**：只在隔离实例里对着手造的对话验过（本地图片含中文和空格的文件名、不存在的图片、三种公式写法、svg / html 代码块、点链接和卡片在右栏打开、SVG 里的 `<script>` 被清掉且没执行）；没有用真模型跑一轮看它实际怎么写路径。Tauri 的 WebView 里 blob URL 的图片没单独验过。PDF、视频、CSV 表格（Cursor 有）没做。

## 2026-09-21：标题栏双击、两个侧栏可拖宽

- **双击标题栏没反应**的原因在桌面壳的权限：Tauri 自带的拖动脚本单击调 `start_dragging`、双击调 `internal_toggle_maximize`，`capabilities/main.json` 只放行了前者。补上 `core:window:allow-internal-toggle-maximize`。三条顶栏的 `data-tauri-drag-region` 改成 `"deep"`：原来的写法只认「正好点在这条 div 自己身上」，点到里面的文字既不拖也不缩放；按钮和输入框仍然各管各的点击。
- 任务标题原来是个点一下就进编辑的按钮，正好占着标题栏中间。照 Cursor 把**重命名**挪到侧栏行的菜单里（R），行内就地编辑；标题回到普通标题栏文字。
- **侧栏拖宽**：`components/ResizeHandle.tsx` 是栏与会话之间那条缝（6px 热区，悬停才显线），拖动调宽、双击恢复设计宽度。`lib/paneWidths.ts` 管数：左栏、右栏列表态、右栏工具态各记各的宽；最小 200 / 200 / 320，最大以会话列不小于 420 为限。存的是用户拖出来的值，布局时再按当前窗口宽度收一次（`fitPaneWidths`），所以窗口缩小再放大，栏宽会回来。宽度是「这块屏幕上」的偏好，存浏览器本地，不进 server 的设置。拖动期间关掉栅格的开合过渡，不然栏宽会追着指针走。

**没验证的**：双击缩放只能在装好的桌面包里看，我没法自己点；它走的是窗口缩放，系统设置里把「连按标题栏」改成「最小化」的人不会得到最小化（Tauri 的这条命令不读那个偏好）。拖动是在隔离实例里用合成指针事件验的（宽度变化、两侧最小值、最大值、刷新后保留、双击复位），没有用真鼠标拖过。

## 2026-09-21：日志里的图只有一种样子（小图 → 点开叠层放大 → 下载）

用户定的，参照是 Codex 桌面版的截图：回复里就是一张大小适中的圆角图，周围什么都没有；点开变大，仍然是图；给的动作是「下载」，不往浏览器里开。同时立了一条规矩——**SDK 有的优先用 SDK 的**，外部库才需要先核对。中途做过一版带标题栏和三个图标的图框（build 83，AI Elements 的 `Artifact`）、SVG 清洗（DOMPurify）和「在浏览器打开」的一次性地址，都按这个方向删掉了。

- `components/Figure.tsx`：小图是 AI Elements 的 `Image`（`fetch-ai-elements.mjs` 的 ELEMENTS 里加了 `image`；它吃 `{ base64, mediaType }`，所以 `useFilePicture` 给的是字节的 base64，不再是 blob URL），最高 `--spacing-figure`（320px）、不放大。点它开 shadcn 的 `Dialog`（同一个脚本取，`UI_EXTRA`）：同一张图，最大 92vw × 88vh，点外面或 Esc 关。小图悬停时和叠层里，右上角各有一个「下载」。任务的文件、svg 代码块、裸贴的 SVG 都走它；网络图片是同样外观的普通 `<img>`（没有字节可下，也不进叠层）。2026-10-01 起网络图片点了才加载（`RemoteFigure`）：`externalHost` 判出要向别的服务器取的（`data:`、`blob:` 和同源地址不算），先画一个写着主机名的按钮，点了才渲染 `<img>`——图片地址本身就能把模型读到的东西带出去（`![](https://x/?d=…)`）；点过的地址记在模块级的 `LOADED` 里，这次访问里重新挂载也不再问。加载中 / 打不开 / 正在画 是一行灰字。
- **SVG 不清洗**：`<img>` 里的 SVG 不跑脚本、不触发事件、不取外部资源，没有可清洗的东西；`svgForImage` 只补模型漏写的 `xmlns`。下载下来的就是原样文件，拿什么打开是用户自己的事。
- **下载**（server `downloads.ts`，`POST /api/threads/:id/files/download {path | svg}`）：server 把文件复制到用户的「下载」文件夹（同名不覆盖，依次 `name (1).svg`…），返回落地路径，前端提示「已保存到 …」。由 server 做而不是页面做，是因为页面一半时候是桌面壳的 WebView，那里 `<a download>` 没有去处；而 server 永远和用户在同一台机器上。`--downloads-dir` / `VGENT_DOWNLOADS_DIR` 可以改目录，隔离实例和测试靠它不碰真的「下载」。右栏「文件」打开任何文件时标题行也有这个下载。
- 回复里指向本地文件的链接仍然在右栏打开；回合产物卡也是。只有「图」点开是叠层。

**没验证的**：叠层和悬停下载在桌面包的 WebView 里没法自己点（隔离实例里验到：小图 426×320、叠层出现且更大、下载落到指定目录并提示路径）。

## 2026-09-21：插话（运行中发的消息进当前回合）

用户提到 Codex 和 Claude Code 现在都能「无损打断」。查下来 AI SDK 的 harness 层就有：`HarnessAgent.experimental_steer({ session, text })` → 适配器的 `submitUserMessage`，消息在运行时的下一个安全输入边界进入**当前回合**，引出的输出仍在当前回合的流里。按「SDK 有的优先用」直接用它。

- **三个引擎三种情况**（能力表多了一列 `steer`）：
  - Claude Code：适配器实现了 `submitUserMessage`，runner 的 `steer()` 就是一行 `experimental_steer`。**推**。
  - Codex：适配器沙箱里的 bridge 已经会收 `user-message`，但宿主侧的 control 没有 `submitUserMessage`（1.0.117 和最新 1.0.119 都看过），调了只会抛「不支持」。所以 `steer: false`，照旧排队。升级适配器后先重查这一条。
  - 自研：SDK 没给现成的，但循环是我们自己的——`createVgentEngine` 多一个 `pendingUserMessages`，`prepareStep` 在每一步之前（第一步除外）问一次，把拿到的文字作为 `user` 消息并进去。v7 里 `prepareStep` 返回的 messages 会成为后续各步的基底，所以只并一次。**拉**：问的是任务的排队队列（`EngineContext.takeSteers`），取走即删。
- **入口没变**：前端仍然 `POST /api/threads/:id/queue`。server 先 `runs.steer()`——有活着的回合、runner 有 `steer`、运行时收下了——就不进队列；否则入队。入了队的，自研引擎在下一个步间取走；一直没被取走的（回合没再走下一步就结束了、Codex）由原来的排队调度当下一轮发出。所以「送不进去」永远退回排队，消息不会丢。
- **存成什么**：回合的 assistant 消息里一个 `data-steer` part（`steer.ts`），位置就是它进去的位置。UI message stream 一轮就是一条消息，没法中途结束 assistant、插一条 user、再开一条；data part 正是这个协议装「既不是文字也不是工具调用」的东西的办法。server 在运行时收下之后往 hub 里发这个 chunk，客户端和落盘走的是同一条流。
- **读回来**：`expandSteers()` 把带插话的 assistant 消息按插话切成 assistant / user / assistant，给一切把历史当对话读的地方用——每轮开头的 `convertToModelMessages`（无状态的自研引擎靠它在下一轮看到那句话）、分叉的文字记录、`/compact` 的摘要。harness 引擎自己的 session 里本来就有那句话。
- **前端**：`turns.ts` 多一种 block `steer`，永不折叠；`Turn.tsx` 把它画成和回合开头一样的用户消息框，夹在前后两段步骤之间。

**没验证的**：没有用真的 Claude Code 跑一次 `experimental_steer`（测试里是假引擎走真的 run manager、真的流和落盘；适配器那一侧只读了代码）。它名字里带 experimental，上游可能改。自研引擎的 session 文件（CLI 用的那份）不记插话进来的消息；server 每轮从 UI 消息重建历史，不受影响。

## 2026-09-21：build 86 上的一批报错（#185、工具报错、计划行、无项目）

用户在 build 86 上连着遇到「出错了 Minified React error #185」「出错了 File not found: …」，以及计划工具行点开是一坨 JSON。四件事，各是各的原因：

- **#185（嵌套更新超限）**：`useChat` 默认每个 chunk 一次同步提交；`ThreadView` 每次提交后又在 effect 里把 `messages` 往上抛（`onMessages` / `onQueue`），于是每次提交结束时根上都还挂着一个待办更新。chunk 一个个到没事；**打开或刷新一个正在跑的任务时，续流把已有的几百个 chunk 在同一批微任务里重放**，React 连续 50 次「提交完还有同步活」就抛 185。一直盯着任务看复现不出来，跑到一半刷新必现。修法是 SDK 排错文档（`09-troubleshooting/50-react-maximum-update-depth-exceeded`）给的：`useChat({ chat, throttle })`，常量 `CHAT_THROTTLE_MS = 50` 在 `lib/threadChats.ts`，`ThreadView` 和侧栏 `LiveTitle` 两处都用。
- **工具报错被当成任务报错**：`toUIMessageStream` 的 `onError` 既管 `error` chunk（回合失败），也管 `tool-error`（工具失败，代理读了接着干），而且只给一个 error、分不出是哪种。原来一律记进 `rawStreamError`，回合正常结束也把它写进了 `thread.error`，界面就在一个 `idle` 的任务上亮「出错了」。现在 `runs.ts` 在引擎流进 `toUIMessageStream` 之前过一道 `TransformStream`，把路过的 `tool-error` 的 error 记进一个 Set：`onError` 见到 Set 里的，原样返回工具自己的报错文字（工具行显示它，下一轮 `convertToModelMessages` 喂给模型的也是它，不再是 “An error occurred.”），不碰 `rawStreamError`；`thread.error` 只在真的出过 `error` chunk 时才写。旧记录里已经带着的，前端只在 `status === "error"` 时才显示。
- **计划**：聊天里的计划工具行不再展开成输入输出 JSON，行下面直接是清单，默认展开，点一下收起；右栏「计划」tab 用同一个 `features/plan/PlanList.tsx`。清单用 AI Elements 的 `queue`（`QueueItem` / `QueueItemIndicator` / `QueueItemContent`，`fetch-ai-elements.mjs` 的 ELEMENTS 加了 `queue`，连带 shadcn 的 `scroll-area`，没有新的 npm 依赖）。它只有「待办 / 完成」两态；进行中的那项字色提亮，只有任务还在跑时（右栏）才转圈——日志里的清单是当时的记录，不转。
- **无项目任务**：右栏早就不给「改动」tab，但 `useChanges` 照样去问 `/changes`（409）和 `/integration`（500）。现在无项目时给它的 `threadId` 是 `null`，两个请求都不发。

**没验证的**：#185 是在 Chromium 里复现并确认修好的，没在桌面包的 WKWebView 里再跑一遍同样的场景。

## 2026-09-21：回合写出来的图也按图显示

build 84 定的「日志里的图只有一种样子」只覆盖了回复里内嵌的图（markdown 图片、svg 代码块、裸贴的 SVG）。模型更常见的做法是**写一个文件**再回一句 “Created [pelican-bicycle.svg](…)”——三个引擎的真实回合都是这样——这条路当时还是回合末尾一张带小缩略图的卡片。用户问「svg 的处理是不是忘了做」，指的就是它。

- `TaskPicture`（任务自己的图片文件 → `Figure`）从 `RichMarkdown.tsx` 挪到 `features/files/TaskPicture.tsx`，回复里的 `![]()` 和回合产物共用。
- `TurnOutputs.tsx`：产物里的图片 / SVG 直接是 `Figure`（适中大小、点开叠层、下载），图下面一行文件名，点它在右栏打开；markdown 文档仍是卡片。
- `outputs.ts` 收紧了候选：回复里**链接**指向的文件照旧算；只在行内代码里**提到**的文件名，要这一轮动过它才算（写 / 改的路径，或 shell 命令里出现过这个文件名）。原来「只发现一个未跟踪文件 `pelican-bicycle.svg`，没有动它」也会出一张产物卡，图变大之后这种误报会很扎眼。

## 2026-09-21：模型空回复——「发了消息没有任何反馈」

用户在自研引擎（自己加的 openai-compatible 提供商，GPT 模型）上追问「再来一次」，界面毫无反应；再问「挂了？」才有回答。记录里那一轮的 assistant 消息只有一个空格，输出 1 个 token；四轮里出现了两次。离线把存下的历史过了一遍 `convertToModelMessages`：历史完整、以用户消息结尾，不是我们喂错了。真正的原因在网关 / 模型那一侧，没有 key 没法在隔离实例里复现（不碰用户的 key），所以**根因未确认**，做的是三层兜底：

- **引擎**：`packages/engine/src/empty-reply.ts`，一个 `wrapLanguageModel` 中间件。一次调用结束时既没有工具调用、正文也没有可见字符，就再调一次，最多 `EMPTY_REPLY_RETRIES = 2` 次；`length` / `content-filter` / `error` 收尾的不重试。正文在出现第一个可见字符之前先扣着，所以被丢掉的那次调用不会在流里留下东西；思考和工具调用照常直通。只管自研引擎——另外两个引擎的循环在厂商的 CLI 里。
- **日志**：`turns.ts` 丢掉空白的 text block（这个模型几乎每一步正文都以一个空格开头），`Turn.answered` 记下「有 assistant 消息」。回合结束却一个 block 都没有时，显示一行灰字「这一轮模型没有返回内容」，不再是一片空白。
- **等待中**：最后一轮在跑、还没有任何 block 时，显示 AI Elements 的 `Shimmer`「思考中…」。此前从发送到第一个字到达，聊天区什么都没有。

顺带：GPT 模型给自己写的文件用 `sandbox:/Users/…` 这种链接（ChatGPT 的习惯），被 rehype-harden 拦成 “[blocked]”。`localPathOf` 现在把 `sandbox:` 当本地路径。无项目任务那两个请求还漏了一个时序——从 URL 打开、任务列表还没到时不知道它是无项目——现在任务未知时也不发。

## 2026-09-21：每一轮显示它自己那一版 SVG；排队条一行

- **同一路径反复写**：任务里说「再来一次」，模型写的还是同一个 `pelican-bicycle.svg`。产物图原来按路径读磁盘，于是整屏每一轮都是最新那张。现在 `outputs.ts` 的 `writtenDrawings(blocks, before)` 从回合自己的工具调用里把 SVG 的内容重放出来——`write` 带整份文件，之后的 `edit` / `multiedit` 逐个套上去（套不上就放弃这个文件）——`WorkLog` 按回合顺序累积（`before` 是前面各轮留下的），所以只是**链接到**这个文件的回合，看到的也是当时那一版。`drawingFor` 把调用里的写法（绝对路径 / 相对路径）对到 server 解析出来的路径上。有内容就用 `DrawnPicture`（`Figure` + 这份源码，下载的也是这一版），没有就照旧 `TaskPicture` 读磁盘。
- **管不到的**：调用里不带内容的（Codex 的 fileChange）、位图、用 shell 生成的文件，仍然读磁盘上的现状；回复里 `![](x.svg)` 内嵌的图和右栏预览也是现状。要彻底解决得靠每轮的文件快照，无项目任务现在没有。
- **排队条**：「排队 N」不再单独占一行，和第一条消息同一排；后面几条前面留同样宽的空，文字对齐。消息字色提到 `text-fg`，和灰色的标签分得开。

## 2026-09-21：自定义提供商事后加引擎；图片右键菜单

- **事后加引擎**：「Codex 也用它」和「Claude Code 用的地址」原来只在新建自定义提供商那一步有，建好之后「连接设置」只能改已有引擎的地址——用户自己加的提供商就永远只有 Vgent 一列。现在 `EditDialog` 对自定义（没有 `presetId`）且 Vgent 走 openai-compatible 的连接给出同样两项，逻辑在 `providerModels.ts` 的 `withAgentChoices`：打开的引擎从空的模型清单开始（之后去「选模型」里勾），留着的保留已勾的，关掉的连清单一起去掉；Codex 跟着共用地址走，除非它原来就有一个不同的地址。目录里的提供商（有 `presetId`）哪些引擎能用由目录说了算，不给改。
- **图片右键**：桌面包里 WebView 的系统菜单对我们没用——Copy Image 对 SVG 什么都不做，下载和新窗口在 Tauri 里没有去处。`Figure` 的小图和叠层大图都换成自己的菜单（shadcn `context-menu`，`UI_EXTRA` 里加了它；脚本多一条 `exactOptionalPropertyTypes` 补丁）：「复制图片」和「下载」。复制走 `lib/copyPicture.ts`：画到 canvas 转 PNG（剪贴板只稳定收 PNG；SVG 没有自己的像素，按最长边 2048 渲染），`ClipboardItem` 收的是 promise 而不是 blob——WebKit 只允许在点击那一下里写剪贴板。网络图片（`RemoteFigure`）没动，还是系统菜单。

**没验证的**：复制在 Chromium 里确认写进了剪贴板；WKWebView 里 canvas 画 SVG data URI 和 `clipboard.write` 没有实测，失败时会提示「复制不了这张图」。

## 2026-09-21：对话视图被反复重建（「各种滚来滚去」）；断线的报错说人话

- **滚动**：`ThreadView` 加载 `Chat` 的 effect 依赖了整个 `actions`，而 `useWorkbench` 的 `actions` 是一个依赖 `state.threads` / `thread` / `state.projects` 的 `useMemo`——任何任务有任何变化都会重建：在当前任务上点 fast（改了任务记录）、另一个任务在跑（`updatedAt` 不停变）。每重建一次，effect 就 `setChat(null)`，整个对话视图卸载成「加载中…」再重新挂载，`Conversation` 从头滚到底。现在 effect 只依赖 `thread.id`，`actions` 经 ref 读最新值。隔离实例里验证：滚到中间后分别改当前任务和另一个任务，滚动容器是同一个 DOM 节点、`scrollTop` 不变。`actions` 本身仍然不稳定，凡是把它放进 effect 依赖的地方都要当心。
- **“Failed to process successful response”**：用户把自研引擎换到 Codex 订阅模型后出的错。离线用同一个模型复现：连「只回两个字」也会在几十秒后失败，`cause` 链的底是 `other side closed`——对方在流式输出中途关了连接，是这台机器到 Codex 后端的网络问题，和对话历史、换模型的动作无关。AI SDK 把它包成了一句没信息量的话，`rawErrorText` 现在把 `cause` 链最底下那条消息补在后面（「…（other side closed）」）。流到一半断开没法透明重试，没做重试。
- **还有两处会「滚」**（build 93）：AI Elements 的 `Conversation` 默认 `initial="smooth"` / `resize="smooth"`——每次打开任务都从顶部带动画滑到底，之后图片、产物卡片每落地一次、日志每长一次又滑一下。`WorkLog` 现在传 `initial="instant" resize="instant"`（没改取来的源码，props 在它的默认值之后展开）：打开就在底部，钉住不动。另外 `Figure` 在图片「还在来」（加载中 / 正在画）时先占住一张图的位置（`pending`）：桌面包的 WebView 没有 scroll anchoring，一行字后来长成一张图会把下面的内容整个往下推；「无法显示」这种不会再变的仍是一行小字。验证：打开任务后 2.5 秒内每 60ms 采样，距底部始终 1–2px。
- **少渲染**（2026-10-01）：状态 SSE 每次推来都是全量重新解析，`useServerState` 用 `lib/shareUnchanged.ts` 做结构共享——没变的项目、任务（按 id 对）、设置保住原来的引用，一个任务变了只有它那一行重渲染。正在看的任务的消息和待处理队列放进 `app/threadFeed.tsx` 的 `ThreadFeed`（外部 store，`useSyncExternalStore`），不再是 Shell 顶上的 state：右栏只在终端 / 计划 / 工具这几个读消息的 tab 开着时跟着每个 chunk 渲染。侧栏行 `TaskItem` 用 `memo`，`5m` 这种时间戳由行内的 `Stamp` 跟着每分钟的时钟自己刷新。

## 2026-09-22：模型菜单的层级反过来（选项在上，模型列表收进「模型」一行）

用户给了一张 Cursor 的图，要求照它的层级。和 09-20 那版正好相反：**第一级是这个模型怎么跑**——Fast（开关）/ 上下文 / 推理强度 / 引擎，各自右边就是当前值；一条分隔线之下最后一行是**模型**，它的子菜单才是清单。想法是「改设置」比「换模型」频繁得多，常用的那些不该藏在模型行的子菜单里，而几十上百行的清单不该是一打开就撞上的东西。

- **模型清单**（`ModelPicker.tsx` 的 `ModelList`）：分组标题是来源名（`Codex`、`XD Gateway（心动）`、`Claude`…，09-20 那版只有图标和一条空隙），顶上一个搜索框，按模型名和 id 过滤，分组标题跟着一起消失。点一行＝连引擎一起选中（`preferredRoute`，规则没变），不再有第三级——引擎回到第一级去改。每行右边灰色写它会跑在哪一档推理强度，清单本身就读得出「点下去会怎样」。
- **没指定模型就选中清单里的第一个**（用户 2026-09-22：「别用 Claude 默认这种」）。`resolveModel`：任务自己的选择，否则目录的 `defaultModel`，否则该引擎清单里第一个没被关掉的模型。聊天框在不忙的时候把这个选择写回去（`commitDefault`），所以 chip 上是一个真模型，不再出现「Claude Code 默认」。运行中不写，免得 toast「运行中不能改」。设置页只显示这个名字，不自动改草稿。
- **底下的名字带推理档位和 Fast**（照 Cursor 的 `Grok 4.7 Extra High Fast`）。chip 是 `模型名 推理强度 Fast`，Fast 只在开着的时候缀上；`none` / `disabled` 不算思考，不写进去。菜单里「模型」那一行的灰色值仍只是模型名。
- **除了换模型，菜单不关**。上下文、推理强度、引擎选完都留在原地，开关本来就不关；只有在模型清单里点了一个模型才 `close()`。
- **聊天框旁边的两个 chip 撤了**（用户定的）：独立的推理强度 chip 和 Fast 闪电按钮删掉，`ReasoningPicker.tsx` 整个文件删掉（它的 `agreedLevels` 兜底也不需要了：`effectiveModel` 已经在做同一件事）。`useModelCatalog` 跟着删——只有它用。Composer 里剩 `+` · （模式）· 模型 · 发送。
- **`CascadeMenu` 加了三样**：`section`（行上方的分组标题，相邻同名只画一次）、`toggle`（画一个开关，点行就翻；Fast 翻完**不关菜单**）、`content`（子菜单不是行列表而是任意内容，模型清单连它的搜索框就是这么进去的）。`separated` 从「上方留空隙」改成「上方画一条线」。开关是个 `span` 而不是 `button`：行本身是按钮，点击必须落在它身上。
- 搜索框 `autoFocus`：`Popover` 的按键快捷逻辑本来就跳过面板里的可编辑元素，打字不会被菜单吃掉。子菜单是弹层的 DOM 后代，所以「点外面关闭」也不会误伤。

浏览器核对（Playwright 连本机 server，Cursor 内置浏览器连不上 localhost）：默认态两行（引擎 / 模型）→ 清单里选 GPT-5.5 → 第一级变成 `Fast(关) / 上下文 272K / 推理强度 高 / 引擎 Codex / —— / 模型 GPT-5.5`；推理强度子菜单 低·中·高✓·极高，上下文 272K✓·1M；点 Fast 开关翻成开且菜单不关；选「低」菜单也不关，推理强度行变成「低」。搜「gpt」只剩三组。设置页（不传 `options`）是引擎 + 模型两行，清单向左弹。无 console 报错。

### 2026-09-22 设置改弹层；默认模型不再是设置

- **设置是弹层**：`Shell` 不再把中栏换成设置页，而是在三栏之上盖一层遮罩（`bg-bg-scrim` + `backdrop-blur-xs`），设置面板居中浮起（`bg-bg-elevated`，左侧 192px 导航栏带「设置」标题，内容区自己滚动）。点遮罩、Esc、右上角的叉都关；面板里再叠命令面板或 `Dialog` 时它们先吃掉 Esc（`defaultPrevented`），设置不会一起关掉。2026-10-01 起它是真的模态（`app/SettingsOverlay.tsx`）：背后的工作台 `inert`，`useModalFocus` 打开时把焦点移进面板、Tab 只在面板里转、关掉后焦点回到打开前的位置；不用 Radix 的 `Dialog`，它会锁住整个文档，叠在设置上的 ⌘K 就点不动、也收不到按键。右栏不再因为打开设置而隐藏。
- **视觉**：`layout.tsx` 加了 `Segmented`（分段切换器：主题 / 密度 / MCP 类型 / 协议），`PILL` 不再是橙色描边药丸；按钮里的图标从 `size-xs`（6px）改成 `size-md`（12px）；行标题 15、说明 13（`fg-muted`）；页面标题下的解释段落去掉。
- **默认模型那一行从设置里去掉了**（用户：「根本不需要」）。规则变成：`DEFAULT_SETTINGS.defaultEngine` 是 `vgent`；`GET /api/engines/:engine/models` 的 `defaultModel` 是**上一次开任务的选择，还在清单里且没被关掉才算**，否则该引擎清单里第一个能用的（`app.ts` 的 `listModels`；harness 引擎没记过就仍留空）。`POST /api/threads` 建完任务把用的 `engine` + `model` 写回 `settings.defaultEngine / defaultModel`——**记住上一次选择**就是这个，不是用户编辑的设置。`useWorkbench.newTask` 把当时看着的任务的 engine/model 记成 `newTaskSeed`，`EmptyState` 用它当**临时默认值**（排在 `settings.defaultModel` 之前，不落盘）。`ProvidersPage.onChanged` 变成可选：设置页里没有别的清单要重载了。
- **Agents 页只剩引擎运行时**（用户：「只需要留升级」）。运行模式三档和「一直允许的工具」从设置里拿掉了；`Settings.runMode / allowlist` 还在、服务端照读（用户机器上是 `allow-all`），只是暂时没有界面改它——下一步是把运行模式放进 composer 的模式菜单按任务切，像 Cursor 审批卡里那样。（名单 2026-10-01 以「通用 → 一直允许」回到设置里：`AllowlistSection`，有条目才出现，只能逐条移除；运行模式仍没有界面。）

## 2026-09-22：退出时提醒没完成的任务

落在任务一生第 3 步（执行）。⌘Q、菜单「退出」、AppleScript `quit` 都会停掉还在跑的回合，之前是直接停。现在 `ExitRequested` 先拦住，后台线程用启动时记下的地址和 token `GET /api/threads`，只看 `running` / `awaiting-approval` / `awaiting-input`。有的话弹原生对话框「还有任务没完成」，一个任务点名，多个列到 6 个；第一个按钮是「取消」（回车留下），只有点「退出」才走原来的 SIGTERM。问不到列表（服务已死、超时、非 200）照旧退出。关窗口仍是藏起来，不走这条确认。对话框在工作线程上 `blocking_show`——在 UI 线程上调会死锁，插件会把 alert 再投回 UI 线程。
- **上下文大小交给 Claude Code 自己压**（用户：「上下文选择应该让 agent 知道，从而触发自动压缩」）。模型菜单里选的上下文（200K / 1M）以前只决定模型名带不带 `[1m]`；现在 `engines/claude-code.ts` 还把它作为 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 送进 CLI 的环境（`ClaudeCodeEngineOptions.env`），CLI 的自动压缩阈值就是它减去摘要缓冲，和聊天框的环一致。没选（菜单里默认的 200K 存的就是「没选」）也照样送 200K：CLI 自己对能跑长窗口的模型放得很宽，Opus 5.5 不带 `[1m]` 也要到 650K 才压，任务显示 200K 却一路涨到 40 万。模型列表里 Claude Code 能跑长窗口的模型 `contextWindow` 也因此是 200K。Codex 一直是自己压（`codex exec` 没有手动压缩）。
- **手动压缩对 Claude Code 打开**。能力表 `claude-code.compact = true`；`POST /threads/:id/compact` 按 `EngineFactory.statelessTurns` 分流：自研引擎照旧把存的历史换成一条摘要；harness 引擎的记录在它自己那边，改我们存的会脱节，所以起一轮对话把 `/compact` 原样送进去（CLI 认这个命令）。2026-09-29 修正：请求消息用 `compactRequested`，`Turn.tsx` 在运行时只画「正在压缩上下文…」，命令正常结束（`run.endedAt`、`stopReason: response`、`finishReason: stop`）后才画「上下文已压缩」，失败、中断及缺少完成依据分别显示；旧版把 `/compact` 提前标成 `compacted` 的记录也按此解释。原生命令无正文是正常结果，不显示空回复警告；不拿壳里的消息条数当实际压缩量。没有新用量时上下文环显示「待更新」，下一次模型调用后恢复百分比。web 的 toast 看到 `status: running` 就不报「N 条 → 摘要」。Codex 仍返回 `compact_unsupported`，文案改成「它会自己压」。
- **适配器升到 `@ai-sdk/harness-claude-code` 1.0.125 / `-codex` 1.0.123 / `harness` 1.0.121**。钉着的 1.0.119 有个会把压缩弄崩的 bug：压缩后 CLI 发来的用户消息 `content` 是字符串，桥接进程按数组 `.filter` 直接 TypeError，整轮报错（1.0.122 修的：「ignore non-array user messages」）——也就是说升级之前 Claude Code 的**自动**压缩在 Vgent 里同样会崩。真机核对（haiku，`/tmp` 里的小仓库）：`/compact` 那轮只有 `start` / `finish` 两个事件，CLI 的 transcript 里有 `compact_boundary` + `isCompactSummary`，下一轮的回复明确引用了摘要。harness 1.0.125 还**没有**把 `compaction` 事件冒到 `HarnessAgent.stream` 里（bridge 里有 latch，adapter 没接），所以 `runs.ts` 把它转成 `data-compaction`、`turns.ts` 画成一行的那套先备着（有单测），自动压缩暂时没有标记，手动压缩的标记来自那条 `/compact` 消息。


## 2026-09-23：工作日志的折叠——过程是一份清单，收尾折成「工作了 N 步」

用户一天里问了三次（「之前折叠的修改不见了？」「这他妈能算好？」「你到底知不知道该怎么改折叠啊？」）。前因：09-22 三个会话按 Koma、Codex 各改了一版（104 摘要句 → 109 全平铺 → 112 标题行），互相打架，每版都不是用户要的。最后由用户拍板的模型只有三条，代码就按这三条写，不再引 Koma / Codex 的句式：

1. **运行中就是一份按时间顺序的清单**，一条调用一行，正在跑的那条带转圈，没有额外的标题行、没有摘要句。相邻的读取 / 搜索 / 列目录合成一行带计数（`读取 3 个文件 · 搜索 2 次`），点开是那几条；命令、改文件各自一行。思考不穿插：一段连续调用里的所有 reasoning 提成**一行「思考」**放在这段最上面，可展开看全文；这行是回合末尾还在进行的思考时写「思考中…」。
2. **回合结束**按正文和用户插话切分工具过程，每段收成一行 **「工作了 N 步」**（N = 该段调用数；没有耗时可用）；正文保持原位，不进入折叠，包含没有最终回复的中断历史。点开就是运行中那份清单，原样，不重新组织成句子。只回复没调用的回合不折。
3. **清单里的任何一条点了去右栏**（见下一条补记），行内不展开。

实现（`features/worklog/`）：`activity.ts` 的 `processItemsOf(blocks)` 把 blocks 变成 `thought` / `explore` / `block` 三种行——正文、插话、压缩标记、审批 / 提问卡切断一段，段内 reasoning 提成一个 `thought`，段内工具按相邻的探索合成 `explore`（≥2 条）；`splitReply` 取末尾连续的 text 作回复，其余是过程；`stepCount` 数工具调用。`Turn.tsx`：未结束 → `ProcessList` 直接画；结束且有调用 → `Fold`（「工作了 N 步」）包住同一个 `ProcessList`，回复接在后面。`explore.ts` 的 `shellExploreKind` 把只读的 Bash（`cat / sed -n / head / git log` 读取，`grep / rg` 搜索，`ls / find / git branch -a` 列目录；`cd` 和变量赋值跳过；`$(…)`、heredoc、`for`、写文件的重定向、`sed -i`、认不出的词一律算命令）归到探索里，Claude Code 引擎满屏 `sed -n` 才合得起来。`describeTool` 显示 Bash 时去掉开头的 `cd <目录>;`（`withoutCd`）。测试：`activity.test.ts`、`explore.test.ts`、`Turn.activity.test.tsx`。

- **工具行点开在右栏，不在行内**（用户：「折叠展开，应该是列出调用过哪些命令，点这些命令右侧栏打开详情」）。`ToolRow` 没有行内展开的盒子（计划行例外，它的清单就是内容，仍在原地开合）；点一行走 `TurnActions.inspect`，`ThreadView` 按种类分流：命令 → 右栏「终端」tab 并滚到那条、闪一下（`RightState.inspect` 带 `toolCallId` + `nonce`，`TerminalPanel` 的行有 `id="term-<toolCallId>"`，定位后停止跟底）；读取 → 「文件」tab 预览那个路径（`openPreview`）；写 / 编辑 → 和文件 chip 一样开「变更」；其余（搜索、子代理、MCP 等）→ 右栏的 `tool` 视图（`rightpane/ToolDetail.tsx`：动词 + 目标、状态、输入 JSON、输出或子代理记录），它不在 tab 条里，只由点击进入。
### 2026-09-29：重启历史的折叠与部分输出

`processSectionsOf` 将所有正文单独分段，正常完成和中断历史使用同一规则，不再把没有最终回复的整轮说明一起藏进工具折叠。`buildTurns` 根据所属用户消息的 `turnEnd` 为仍在等待结果或只有 `preliminary` 输出的工具生成只用于显示的 `interrupted` 标记，同时停止残留思考动画；不修改原始消息、不丢弃子代理部分输出。工作日志和右栏 `findToolPart` 使用相同投影：已中断调用独立可见，详情保留模型和已收到的内容，不冒充完成或运行中。旧版已标为中断的记录也直接适用，无须迁移历史。

### 2026-09-29：同类工具归组与命令分类分开

同类归组不再依赖能否解析 shell。连续的读取 / 搜索 / 列目录调用归为探索组，按调用次数显示「读取 N 次 · 搜索 N 次 · 列目录 N 次」；连续的其余 shell 调用归为「执行 N 条命令」，包含循环、`node -e` 和 Python 脚本。两条起归组，单条保留工具行；两种组互不混合，正文、用户插话、审批 / 提问卡片、压缩记录会截断归组。思考沿用同一工具段内合并的规则。编辑与子代理继续独立展示。

Codex 原生 `commandExecution.commandActions` 从适配器保留到工具输入，优先采用 `read` / `search` / `listFiles`；一条调用有多个动作时按搜索、读取、列目录优先级计数一次。有未知动作或显式空分类时进入普通命令组。只有缺少原生分类的历史记录或其他 Engine 调用才用有限的 shell 识别兜底：支持已知 shell 的字面量 `-c` 程序、只读 Git 检查等，不尝试解释任意脚本。这是展示分类，不是权限或安全判断。

命令行优先展示工具 `title` 或 Bash 输入的 `description`，没有说明才展示原始命令。归组展开列出每次调用，点击仍进入右栏终端；原始输入与输出完整保留。失败、拒绝、非零退出以及待处理审批 / 提问保持独立；即使整个回合已结束，也不藏入「工作了 N 步」折叠中。

回归覆盖 shell 外壳、未知脚本、原生分类保留与优先级、正文边界、用户插话、失败可见性、流式状态和终端详情路由。

## 2026-09-23：草稿带附件

用户：「聊天框保存的草稿，需要包含附件」。之前草稿只有文字：附件是 `ThreadView` / `EmptyState` 各自的 `useState`，切任务、刷新、重启都丢。

- **server**：`store/drafts.ts` 的 `drafts.json` 升到 `version: 2`，每条是 `{ text, attachments: [{ id, name, mediaType, size }] }`，旧的 v1 字符串读进来自动迁；字节不进 JSON，单独落 `<dataDir>/drafts/<key>/<attachmentId>`（id 和 key 同一套 `[A-Za-z0-9_-]{1,64}` 校验，mediaType 只许 `type/subtype`）。`PUT /api/drafts/:key` 的 body 是 `{ text, attachments }`，附件**第一次出现带 `url`（data URL）、以后只带 id**——不然每次击键都要把 10MB 重传；名单里没有的 id 又没带 `url` 是 400 `unknown_draft_attachment`；被从名单里拿掉的删文件；文字空且没附件就删条目和目录。单个 10MB、最多 20 个（413）。`GET` 把字节读回来拼成 data URL 返回，和消息里 file part 一个形状。所有写（JSON 和文件）串行在一条 chain 上。删线程时 `remove` 顺带删目录。
- **web**：`lib/drafts.ts` 的 `DraftSync` 持有 `{ text, attachments }`；`localStorage` 仍只缓存文字（10MB 的 data URL 放不进去），附件由 server 那次 `GET` 带回。对账分开算：用户敲过字就留本地文字、动过附件就留本地附件，另一半仍以 server 为准，所以「先敲字再等 server」不会把附件弄丢。`setAttachments` 不防抖、立刻 flush（拖进来的文件马上上 server，关窗口前就在）；`uploaded` 集合记住 server 已有字节的 id，写失败就清空、下次连字节一起重发。`clear()` 一并清附件。`useDraft` 多返回 `attachments` / `setAttachments`，`ThreadView` / `EmptyState` 直接用它，各自的 `useState` 删掉；`/compact` 只清文字不清附件。`startThread` 改收 `Attachment[]`，首条消息被拒时把文字和附件（带 `url`）一起写到新任务的草稿。
- 测试：server `drafts.test.ts`（落盘、按 id 引用、删 tile 删文件、v1 迁移、文件丢了就略过、路由校验和 413、删线程删目录），web `drafts.test.ts`（附件立刻带字节上、之后只带 id、失败重发、server 附件在用户已敲字时仍进来、本地动过附件时不被盖）。没验：真 WebView 里拖一张图、切任务再切回来看 tile 还在。


## 2026-09-24：已归档的任务不能再往下聊

- 之前只有 worktree 任务归档后被 `workspace_reclaimed` 挡住，主工作区任务归档了照样能发消息、排队、压缩。
- **server**：`app.ts` 的 `assertNotArchived`，四个会开回合或排回合的入口先问它：`POST /api/chat/:id`、`POST .../queue`、`POST .../queue/:item/send`、`POST .../compact`，有 `archivedAt` 就 409 `thread_archived`。排队派发本来就跳过已归档的任务。停止后暂停的队列跟着任务归档，不发、不丢。没放进 `runs.ts` 的 `startTurn`：那段当时有另一处改动在进行，入口在路由上已经齐了。
- **web**：`ThreadView` 在任务已归档时把 `Composer` 换成 `features/composer/ArchivedBar.tsx`（「已归档」+「取消归档」，下面留出状态行的高度，切换时日志不跳）；命令面板不再列「压缩上下文」；计划面板的 Build 在切模式之前就挡住；空任务的占位文案不再说「在下面写」；归档提示只在真有 worktree 时说「worktree 已回收」。
- 测试：`app.test.ts` 主工作区任务归档后三条路都 409、取消归档后能跑完一轮；`queue.test.ts` 那条原来断言「归档后还能排队」，改成排队和「发送」都 409、暂停的队列原样留着。

## 2026-09-26：归档照 Fumie——只存 Git 看得见的改动，依赖靠 setup 重建

用户：「按照 fumie 的整体做法来做，那个项目我调了很久，比较满意」。之前的归档是从 freecode 移植的整目录逐字节快照：每次归档把 worktree 连 `node_modules` 一起 `fs.cp` 到 `<dataDir>/snapshots/`（Vgent 自己的任务每个约 850MB、3.5 万个文件；Node 22 在 macOS 上不走 APFS 克隆），恢复再逐字节拷回去，前后各把每个字节读一遍算 sha256。对照的是 `~/Codes/fumie` 的 `WorktreeIsolation` 和 `src/vs/platform/agentHost/AGENTS.md` 的归档一节。

- **归档**（`workspace.ts` 的 `reclaimWorktree`）：`captureTrees` 用临时 index 写出四棵树——HEAD 的、暂存区的（`write-tree`）、已跟踪文件磁盘上的样子（`diff-files` 列出的路径 `add -f -A` 进以暂存区为底的临时 index）、没被忽略的未跟踪文件（`ls-files --others --exclude-standard` 进空 index）；真 index 和 HEAD 不碰。有改动就用 `commit-tree` 拼成 stash 形状的提交（工作树为 tree，父是 HEAD、暂存区提交、可选的未跟踪提交）挂在 `refs/vgent/archive/<threadId>`，干净的不建 ref。再抓一次四棵树，对不上就 `workspace_changed_during_snapshot`、删掉刚建的 ref、目录不动。子模块改动（gitlink）和 Git 表示不了的脏状态照旧拒绝回收。`snapshots/<id>/<uuid>/manifest.json` 升到 `version: 2`，只记 head、branch 和 archive 提交，几百字节。删目录走带重试的 `removeRegistered`（`index.lock` / "Directory not empty" 这类竞争退避重试 5 次，以 git 不再登记为准）。进程在删完目录、没来得及记账时退出，重做归档会认出最新的 v2 manifest 直接返回。
- **恢复**：分支规则照旧（没人动过就用原分支，否则在 head 上另起 `-restored-`），`worktree add` 之后校验 ref 和 manifest 对得上、HEAD 就是归档时的提交，`git stash apply --index` 应用，再抓一次四棵树必须和归档提交里的一致；失败就把刚建的 worktree（和另起的分支）删掉，改动还在 ref 里，下次重来是干净的。成功后删 ref，`app.ts` 记账后删掉用过的快照目录。v1 的旧快照（本机那 11 个、5.3GB）走原来的逐字节恢复，恢复成功同样删掉。
- **被忽略的文件不进归档**，照 Fumie 的约定由 `worktrees.json` 重建，新建和恢复同一条路（`app.ts` 的 `beginSetup`）：先按 `include-files`（git glob pathspec，只挑项目目录里被忽略的文件）从项目目录复制，再跑 `setup-worktree`。**碰 `node_modules` 的规则一律忽略**（Fumie 原话：可以带小的被忽略配置，永远不带依赖树），列出来的路径里带 `node_modules` 的也跳过。恢复之后 setup 状态重新从 running 走一遍，第一轮照旧等它。恢复之后顺带按上限整理一次 worktree（Fumie 在重建后也做磁盘预算）。
- 没照搬的：Fumie 删任务时会删掉没推送的分支，Vgent 仍只删停在基线上的分支（仓库常没有 remote，照搬会删掉有提交的分支）；Fumie 的磁盘预算按字节、只回收孤儿目录，Vgent 保留按个数的上限。
- 同一天合入 09-24 做完没进 main 的「归档 / 取消归档先换状态再干活」（`transition: archiving | unarchiving`，行上「归档中 / 恢复中」，失败退回，重启接着做）。
- 测试：`workspace.test.ts` 往返（未跟踪 / 已改 / 暂存后又改）、被忽略文件留不下来且干净任务不建 ref、归档途中文件变了、重做已完成的归档、恢复失败退干净后能重来、v1 旧快照照样恢复；`worktree-setup.test.ts` 的 `include-files` 过滤和「新建复制 `.env`、不带 `node_modules`，取消归档后 `.env` 重新复制、setup 重跑」。

## 2026-09-27：有改动的 worktree 归档前要确认（Fumie 的 `preserveChanges`）

用户：「这个需要加，因为不干净的归档问题很大」。照 Fumie 分两层，前端先问、服务端兜底：

- **服务端**：`reclaimWorktree({ preserveChanges })` 抓完四棵树，有改动又没有 `preserveChanges` 就 409 `archive_needs_confirmation`，不建 ref、不动目录。`PATCH /api/threads/:id` 的 `{ archived: true, preserveChanges: true }` 把确认记成 `ThreadRecord.archivePreserveChanges`，跟 `transition: "archiving"` 一起落盘、做完或退回时清掉，所以重启后 `resumeTransitions` 照原样接着做；没这个标记的（包括这之前的版本留下的）遇到有改动就退回活动列表、目录原样——和 Fumie 对旧记录的处理一样。`POST .../workspace/reclaim` 收同样的 `preserveChanges`。新增 `GET .../workspace/uncommitted` → `{ files }`，数的是 `git status --porcelain -uall`（改名算一个），被忽略的不算。
- **上限回收只收干净的**（Fumie 的磁盘预算也只收 `!dirty`）：有改动的跳过记一条 info；刚新建 / 刚恢复触发整理的那个任务也不收（`enforceWorktreeLimit({ keep })`，对应 Fumie 把当前会话标成 running），否则跳过脏的之后会轮到它。
- **前端**：`features/workspace/UncommittedConfirm.tsx` 的 `useUncommittedGate` + `UncommittedConfirm`，侧栏行菜单的「归档」（A）和标题栏工作目录菜单的「回收工作目录」共用：先问文件数，0 就直接做，否则关闭菜单、打开独立的居中确认弹窗（2026-09-30，复用 Radix Dialog），显示「带着没提交的改动归档？ / N 个文件没提交。改动随任务保存，取消归档时放回；被 git 忽略的文件不保留。」和底部「取消 / 确认归档」按钮。默认聚焦确认按钮，支持回车确认、Escape 取消，关闭后焦点回到入口；数不出来按有改动处理（Fumie：破坏性的界面失败时要保守）。确认之后才挪行、才发请求。主目录任务和已回收的不问。
- 验证：`workspace.test.ts`（没确认就拒、目录和 ref 都不动、改名只算一个），`app.test.ts`（没确认 409 且任务不动、确认后归档并清掉标记、重启后没确认的退回而确认过的做完、`preserveChanges` 非布尔 400），`worktree-setup.test.ts`（上限不收脏的也不收刚建的）。临时数据目录起 server，无头 Chrome 右键脏任务 → 归档 → 出确认 → 取消后没动 → A 再 ↵ 归档完成；干净任务直接归档不出确认；页面无报错。

## 2026-09-29：附件排队

- `QueuedMessage.files` 保存 AI SDK 的完整 `FileUIPart[]`（自包含 data URL）。服务端校验文件类型和编码、单文件 10 MiB、每条 20 个 / 合计 20 MiB、整条队列 encoded URL 合计 64 MiB；附件消息可没有正文，但不能进入只支持文字的引导链路。正文编辑保留文件，删除和重排沿用原队列操作。
- `ThreadSummary.queue` 使用不含 URL 的 `QueuedMessageSummary[]`，索引、列表和状态 SSE 不反复广播文件内容；完整任务记录仍保存原始附件。派发时按原消息 ID 构造 text/file parts，复用现有 `prepareAttachments` 适配三个引擎；开始失败、暂停、重启恢复沿用持久队列机制。
- `Composer` / `ThreadView` 在运行中有附件时让回车和发送按钮排队，只有附件也可提交，纯文字的引导和 ⌘回车行为不变。`useDraft.submit` 收到入队成功才清草稿，失败保留；`QueueStrip` 展示文件名和数量、允许清空正文且隐藏「引导」。聊天样式页增加「附件排队」场景。
- `safeFileName` 按 UTF-8 字节截断而非 UTF-16 字符数，避免长中文或 emoji 名称在原生引擎附件落盘时超出文件系统限制。

## 2026-09-29：运行中选择下一回合的模型

`PATCH /api/threads/:id` 在运行中允许修改 `model`、`reasoningEffort`、`serviceTier`、`contextWindow` 和 `unread`，并接受选择器一并发送的相同 `engine`。混入其它字段或切换引擎仍拒绝。配置写入 ThreadStore，RunManager 当前回合持有的配置快照不变，排队派发从最新记录创建下一轮引擎；每轮消息的 `run.model` 仍记录实际使用的模型。前端放开模型及选项操作与选择记忆，菜单注明「运行中修改将在下一回合生效」。


## 2026-09-29：模型速度档位与 Codex 请求一致

`ModelPicker` 将首个 `serviceTiers` 的 Fast 开关改为「速度」子菜单，列出标准与目录提供的全部档位；标签、模型列表摘要和每模型选择记忆按实际 tier id 查找。`CascadeMenu` 支持选项的第二行说明；已知英文名称和说明转成中文，保留目录提供的速度倍数。标准清空 `ThreadRecord.serviceTier`，运行中选择仍在下一回合生效。

`codex-catalog.ts` 共用在线目录读取与本机只读缓存读取，保留完整模型元数据，供 UI 做投影、原生运行时直接加载。最近成功获取的在线目录按凭据隔离，供回合复用 10 分钟；显式刷新模型列表仍会重拉。订阅加速回合为原生进程写一份独立临时目录快照，通过启动参数 `model_catalog_json` 传入，并开启 `features.fast_mode`。不能只在 `thread/start.config` 塞目录：进程启动时已创建模型管理器。进程关闭或启动失败时清掉自己的目录快照，不写用户的 Codex 配置或缓存。在线目录成功返回但撤掉某档位时明确拒绝，不回退到旧缓存掩盖；离线才使用本机缓存。

每次 `turn/start` 显式传 `serviceTier`，标准传 `null`，避免恢复线程时继承旧档位；不要在 `thread/start.config.service_tier` 传 null，随包 CLI 会将它读成空字符串并报警。自研引擎继续通过 AI SDK 的 `providerOptions.openai.serviceTier` 传递。没有升级依赖。

验证覆盖：真实随包 Codex app-server 对本地模拟 Responses 服务发出 priority、ultrafast，跨进程恢复后标准请求不带加速；AI SDK 与订阅请求改写后的原始请求保留两档参数；目录撤销/离线/并发快照隔离和清理；浏览器实际选择器的三档切换、每模型记忆、仅支持两档的模型以及运行中提示。未调用付费模型。

## 2026-10-01：默认模型只从清单来，下架的模型换成默认

起因：GPT-5.5 2026-10-14 从 ChatGPT 和 Codex 下线（API 不受影响），而自研引擎和 OpenCode 没指定模型时写死回退 `codex-subscription:gpt-5.5`，Codex 目录拉不到时还有一份内置的 `gpt-5.5` 清单。两处都删了，`DEFAULT_VGENT_MODEL` 和能力表里的 `knownDefaultModel` 一起去掉。

规则只有一条，四个引擎一样：`GET /api/engines/:engine/models` 的 `defaultModel` 是上一次开任务的选择（还在清单里且没关掉），否则清单第一个；清单空就没有默认，不编造。自研引擎 / OpenCode 的任务没有模型、清单也空时报「没有可用的模型」。

任务存着的模型被清单撤下时（`models.ts` 的 `isWithdrawn`）：同一来源（账号前缀 + 第一个 `:` 前的来源名）还列着别的模型、唯独没有它，且这次所有来源都完整回答了（没有 `warning`），才算下架。登出、拉取失败、退回缓存都不算，任务留着原模型，由引擎报真实原因。`RunManager` 每轮开始前用 `modelFor` 解析，换了就先写回任务记录，所以记录上就是实际跑的模型；压缩上下文用同一个解析。web 的 `resolveModel` 按同一条规则显示。

冒烟测试和 `engine-eval` 不再写模型名：没设 `VGENT_SMOKE_CODEX_MODEL` / `VGENT_EVAL_MODEL` 就取本机 Codex 缓存目录里排第一的模型（`@vgent/providers` 的 `readCodexModelCache` + `listedCodexModels`，服务端排序也用它）。

没动的：拉 Codex 目录时报的 `client_version` 取自本机缓存（现在 0.158.0）或兜底 0.155.0。官方默认的 GPT-6.1 Sol 要 0.159.1 以上才会列出，所以清单第一个暂时是 GPT-6 Astra；Codex 引擎随包的 `@openai/codex` 是 0.156.1。

## 2026-10-01：引擎选项

`packages/server/src/engine-options.ts` 是唯一来源：`ENGINE_OPTION_DEFAULTS` 定每个引擎有哪几个开关和默认值，`GET /api/engines` 的 `EngineDescriptor.options` 原样下发，web 按 key 出行，没有的 key 不出。`settings.json` 的 `engineOptions` 只存和默认值不同的（`PUT /api/settings/engine-options` `{ engine, key, value }`，走 `settings.mutate`，等于默认就删 key）；读时 `readEngineOptions` 丢掉引擎不支持的 key 和类型不对的值。每轮建引擎时 `engineOptionsOf(settings, engine)` 取值，所以改了下一轮生效。

各引擎怎么落：
- Claude Code：关掉的工具进 HarnessAgent 的 `inactiveTools`（`Agent`、`webSearch` / `WebFetch`、`TodoWrite` 和 `Task*`），Plan 模式从 `PLAN_ACTIVE_TOOLS` 里滤掉。待办开着时设 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` + `CLAUDE_CODE_ENABLE_TASKS=0`，新模型上默认给的是 Task 系列，计划栏只认 TodoWrite。记忆关掉设 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
- Codex：`thread/start.config` 带 `agents.enabled` + `features.multi_agent`（只关后者 v2 的协作工具还在）、`features.memories`、`web_search`。托管的 web_search 只给 gpt-5.5，`use_responses_lite` 的模型拿不到。
- OpenCode：子代理和抓取走 `inactiveTools`（`agent` / `webfetch`），在适配器里变成 ask 权限再被宿主拒，模型仍看得见；用 OpenCode 的 `tools` 配置关不掉，桥接层的权限表把 `task` / `webfetch` 写死成 ask，盖过 `tools` 转出来的 deny。待办不能走 `inactiveTools`：桥接层的 `toPermissionToolName` 先匹配到 `write`，`todowrite` 的权限名成了 `write`，调用照常放行（debug 210 就是这样漏的）；改成配置里 `tools: { todowrite: false }`，OpenCode 把它从工具列表里拿掉。`OPENCODE_ENABLE_EXA=1` 开 websearch；配置里 `lsp`。记忆用自研引擎的 `createMemoryTool`，同一个目录（`memoryDirOf` / `memorySourcesOf`），经 host-tool MCP 给模型（`harness-tools_memory`）。设置页的 MCP 也接上了，`openCodeMcpServers` 转成 OpenCode 自己的格式。
- 自研：`createVgentAgent` 的 `subagents` / `todos`，记忆关掉就不传 `memoryDir`。

验证：`engine-options.test.ts`（默认值、覆盖、三家的映射、MCP 转换），`app.test.ts`（下发、只存差异、非法值 400），`engine.test.ts`（自研的三个开关）。`engine-options.smoke.test.ts`（`VGENT_SMOKE=1`）对真运行时：Claude Code 用 `VGENT_SMOKE_CLAUDE_ACCOUNT` 指一个 app 管的账号，ToolSearch 查 WebSearch / WebFetch / Agent，关掉后查不到，TodoWrite 能用；Codex 列工具看 spawn_agent，搜索用 `VGENT_SMOKE_CODEX_MODEL=gpt-5.5` 看「Search」步骤；OpenCode 列工具看 websearch 和 memory，调一次 memory 回「记忆为空」，关掉后两个都不在。Claude 的自动记忆、Codex 的记忆、OpenCode 的 LSP 只验到配置传进去。
