# 远程控制

在主机的「设置 → 远程访问」登录 GitHub，按页面上的验证码完成授权，再开启「允许远程访问」。在另一台电脑或手机上扫描设置页的二维码，或打开连接链接 https://saymiao-remote.vercel.app/，用同一个 GitHub 账户登录并从设备列表选择 Vgent。二维码和链接只指向公开的设备发现页，不含本机 token。设备在线时，也可以复制设置页出现的 HTTPS「访问地址」直接连接这台主机，经 Dev Tunnels 验证。

远程页面使用主机上的项目、任务和引擎，支持聊天、停止、审批、文件预览与下载。下载保存在访问端浏览器；选择项目时填写主机上的路径。「我的设备」列出这个 GitHub 账户下的 Vgent 设备。登录、设备命名和开关只在主机上管理。

开启状态和设备身份会保存，Vgent 下次启动时自动恢复连接；断线后每 30 秒重试。关闭窗口不退出应用，因此仍可连接。退出 Vgent 或电脑休眠会中断远程访问。关闭远程开关只停止远程网关和隧道，不停止本机任务。

## 实现与存储

- Koma、Vgent 和 SayMiao Remote 网页共用 `@saymiao/remote-core`：源码位于 Koma 仓库的 `packages/remote-core`，Vgent 引用 `vendor/` 中由该源码生成的版本化 Node 包。更新方式和来源见 `vendor/README.md`；授权通知随服务包发布。
- SayMiao Remote 统一登录并列出 Koma / Vgent，可按软件筛选，再选择设备。网页只负责登录和发现设备，工作区流量直接连接对应的 Dev Tunnels 地址。每个软件保留自己的凭据、开关和设备身份。
- GitHub 设备登录请求 `read:user read:org`。默认沿用来源实现使用的公开 OAuth client ID，可通过 `VGENT_GITHUB_CLIENT_ID` 指定启用设备登录的其他应用。
- GitHub 凭据保存在 macOS Keychain 的 `dev.vgent.remote.<数据目录摘要>` 项中；Vgent 数据目录的 `remote/settings.json` 只保存设备标识、名称、启用状态、隧道注册与凭据存在标记。不会读取 Koma 或 GitHub CLI 的凭据。
- Vgent 使用独立的 `vgent-remote-v1` / `vgent-web-v1` 隧道标签，且只恢复账户所有、设备标识匹配、没有其他在线 host 的注册。隧道和端口 ACL 必须限制为账户本人。
- 本机服务继续只监听 loopback 并验证本机 token。远程网关使用单独的 loopback 端口，仅接受已确认的隧道 Host，检查 Origin / Fetch Metadata，拒绝远程管理路由，并在转发时加入本机 token。浏览器中的 `vgent-remote-session` 只是界面标记，不能用于访问本机 API。
- SSE、聊天流和文件直接流式转发。关闭远程访问会销毁网关连接，包括长连接；无需改变本机服务的监听地址。

## 验证范围

自动化测试覆盖设备登录轮询与取消、凭据隔离、ACL、注册恢复、端口冲突、断线回收、跨源请求拒绝，以及通过真实 HTTP 网关创建任务、流式回复和持久化历史。公网端到端验证需要用户完成 GitHub 授权后从另一设备访问；本地测试和获取设备授权码不代表这一步已经通过。
