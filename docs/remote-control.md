# 远程控制

在主机的「设置 → 远程访问」选一个 GitHub 账号（没有就在那里「添加 GitHub 账号」，按验证码完成授权；账号本身在「设置 → 账号」里管），再开启「允许远程访问」。远程访问同一时间只用一个 GitHub 账号，换号会先停掉用旧号挂着的隧道。在另一台电脑或手机上扫描设置页的二维码，或打开连接链接 https://saymiao-remote.vercel.app/，用同一个 GitHub 账户登录并从设备列表选择 Vgent。二维码和链接只指向公开的设备发现页，不含本机 token。设备在线时，也可以复制设置页出现的 HTTPS「访问地址」直接连接这台主机，经 Dev Tunnels 验证。

远程页面使用主机上的项目、任务和引擎，支持聊天、停止、审批、文件预览与下载。下载保存在访问端浏览器；选择项目时填写主机上的路径。「我的设备」列出这个 GitHub 账户下的 Vgent 设备。登录、选号、设备命名和开关只在主机上管理；远程会话还有哪些事做不了，见下文「边界」。

开启状态和设备身份会保存，Vgent 下次启动时自动恢复连接；断线后每 30 秒重试。关闭窗口不退出应用，因此仍可连接。退出 Vgent 或电脑休眠会中断远程访问。关闭远程开关只停止远程网关和隧道，不停止本机任务。

## 实现与存储

- Koma、Vgent 和 SayMiao Remote 网页共用 `@saymiao/remote-core`：源码位于 Koma 仓库的 `packages/remote-core`，Vgent 引用 `vendor/` 中由该源码生成的版本化 Node 包。更新方式和来源见 `vendor/README.md`；授权通知随服务包发布。
- SayMiao Remote 统一登录并列出 Koma / Vgent，可按软件筛选，再选择设备。网页只负责登录和发现设备，工作区流量直接连接对应的 Dev Tunnels 地址。每个软件保留自己的凭据、开关和设备身份。
- GitHub 设备登录请求 `read:user read:org`。默认沿用来源实现使用的公开 OAuth client ID，可通过 `VGENT_GITHUB_CLIENT_ID` 指定启用设备登录的其他应用。
- GitHub 凭据保存在 macOS Keychain 的 `dev.vgent.remote.<数据目录摘要>` 服务下，一个账号一项（钥匙串账户名就是 Vgent 的账号 id，第一个账号仍是原来的 `github`）；账号清单在数据目录的 `accounts.json`。`remote/settings.json` 只保存设备标识、名称、启用状态、选中的账号 id 和隧道注册。不会读取 Koma 或 GitHub CLI 的凭据。
- Vgent 使用独立的 `vgent-remote-v1` / `vgent-web-v1` 隧道标签，且只恢复账户所有、设备标识匹配、没有其他在线 host 的注册。隧道和端口 ACL 必须限制为账户本人。
- 本机服务继续只监听 loopback 并验证本机 token。远程网关使用单独的 loopback 端口，仅接受已确认的隧道 Host，检查 Origin / Fetch Metadata，拒绝远程管理路由，并在转发时加入本机 token 和 `x-vgent-remote` 标记。浏览器中的 `vgent-remote-session` 只是界面标记，不能用于访问本机 API。
- SSE、聊天流和文件直接流式转发。关闭远程访问会销毁网关连接，包括长连接；无需改变本机服务的监听地址。

## 边界

远程会话是这台电脑上任务的另一个入口，不是这台电脑的管理员：任务照常驱动，这台电脑被允许怎么做事留在主机上。网关给转发的每个请求加上 `x-vgent-remote` 标记，本机 API 的中间件（`packages/server/src/app.ts`）按 `packages/server/src/remote/policy.ts` 处理带标记的请求，被拒的返回 403 `remote_forbidden`「此操作需在主机上完成」。远程会话不能：

- 碰「一直允许」名单（`/api/settings/allowlist*`）、引擎选项（`/api/settings/engine-options`）、电脑操作（`/api/computer-use/*`）和远程访问本身（`/api/remote/*`），读也不行。网关自己也拒绝 `/api/remote/*`，只有 `GET /api/remote/session` 由网关回一个只当界面标记的值；原生目录选择器 `/api/projects/pick` 由网关直接回 409，远程页面要填主机上的路径。
- 登录、退出账号或改账号用途：`/api/accounts/` 下的路由一律拒绝，包括进行中的登录（它的设备码能让远端替你完成登录）；账号列表 `GET /api/accounts` 可以读。
- 改提供商、订阅、引擎运行时：`/api/providers*`、`/api/subscriptions*`、`/api/runtimes*` 只能读（模型选择器要用），增删、改模型、拉模型清单、检查更新、升级、回退都拒绝。
- 经 `PUT /api/settings` 改默认引擎、默认模型、默认运行位置、主题、密度以外的字段：运行模式、MCP 服务器、worktree 上限等只要带了一个，整个请求就被拒。`PUT /api/settings/model-picks`（每个模型记住的选项）和 `PUT /api/settings/provider-order`（提供商排序）不在被拒之列。

远程读到的设置是另建的一份，认不出的一律不给：`GET /api/settings`、设置路由的回包（包括它被允许的写）和状态流里的 `settings` 都是 `redactSettingsForRemote` 的结果。顶层只留已知字段，运行模式和名单照给（审批卡要靠名单判断哪些审批已被「一直允许」）。每个 MCP 服务器只剩名字、transport 和命令；`env` 只留变量名，值显示成 `••••••••`；地址剪到 `scheme://host[:port]`；启动参数只留一眼看得出不是密钥的：单独的旗标（`-y`、`--stdio`）、包名（`@scope/name`、`server-github`，可带 `@版本`）、剪到主机的地址、`NAME=value` / `--flag=value` 的名字那一半（值只在它是地址、名字又不像密钥时剪到主机后留下）。其余的，以及名字像密钥的旗标（`--token`、`--api-key`）后面的值，不管长什么样都换成 `••••••••`。手改成对象形式的 `mcpServers` 先读成同一张清单再脱敏。状态流按本机、远程分别构建，一份构建失败不影响另一份，远程客户端永远拿不到本机那份。本机窗口读到的是完整的。

通过任务读文件（`changes/file`、`files/content`、`files/raw`、`files/download`）时，先顺着符号链接找到真实位置，落在下面这些地方的拒绝（「这个文件只能在主机上查看」）：Vgent 的数据目录（任务自己的 `worktrees/`、`scratch/`、`attachments/`、`outputs/` 除外）、`~/.vgent/harness`（引擎运行时和它们的私有 home，数据目录换了位置也照拒）、Codex 的整个 home（`CODEX_HOME` 或 `~/.codex`）、Claude 的 `.credentials.json`（`CLAUDE_CONFIG_DIR` 或 `~/.claude` 下，只拦这一个文件）、OpenCode 的 `auth.json`（`$XDG_DATA_HOME/opencode/` 和 `~/.local/share/opencode/`）。远程填路径添加项目时，数据目录、Codex 的 home、`~/.vgent/harness` 和它们里面的目录都不能加，别的路径（包括家目录）照样能加。没堵上的：项目包着这些目录时，文件列表和 `files/resolve` 仍会让远程看到那里的文件名；远程也能让 agent 去读这些文件，那归引擎的权限管（Codex 是全自动运行的）。

这个标记只能由网关设置：本机 API 只看有没有这个请求头、不看它的值，网关转发时总是写上它，远程一侧发来的同名请求头被覆盖；没经过网关却带着标记的请求（仍要有本机 token）只会被限制得更严。除上面这些，远程会话和本机窗口用的是同一套接口。

## 验证范围

自动化测试覆盖设备登录轮询与取消、凭据隔离、ACL、注册恢复、端口冲突、断线回收、跨源请求拒绝，以及通过真实 HTTP 网关创建任务、流式回复和持久化历史。上面的边界由 `remote/policy.test.ts`、`security.test.ts` 和 `remote/gateway.test.ts` 覆盖：对 app 直接发带标记的请求，以及经本机回环上的真实 HTTP 网关（网关写上标记，远端发来 `x-vgent-remote: 0` 也去不掉它）。公网端到端验证需要用户完成 GitHub 授权后从另一设备访问；本地测试和获取设备授权码不代表这一步已经通过，这些边界在真实隧道上的表现也还没有人验过。
