# @vgent/desktop

Tauri 2 的 macOS 桌面壳。它本身没有界面代码：窗口是一个浏览器，指向自己拉起来的内置 Node 服务。

## 构建

```bash
pnpm desktop:build          # 仓库根目录执行
pnpm desktop:install        # 装到 /Applications/Vgent.app
```

产物在 `apps/desktop/src-tauri/target/release/bundle/macos/Vgent.app`（设了 `CARGO_TARGET_DIR` 就在它下面），第一次 cargo 编译约 5–10 分钟。`desktop:install` 先核对产物的版本号和 `runtime.json` 里的提交等于当前 main，并验证 bundle ID 和 Developer ID 签名团队，再替换；换下来的旧包保存在 `/Applications/.Vgent.app.old-<时间>/Vgent.app`，保留正常的应用名称。没有 Vgent 进程在用时连目录移进废纸篓，兼容清理以前的 `Vgent.app.old-<时间>`，从不删除，也不启动或退出正在运行的实例。

打包使用 `tauri.conf.json` 中固定的 Developer ID Application 证书（团队 `UVZM439VGU`），构建机器的钥匙串需要有对应私钥。bundle ID 固定为 `dev.vgent.desktop`，让 macOS 的系统授权跨版本沿用；缺少证书时构建失败，不能退回 ad-hoc 签名交付。从旧版 ad-hoc 签名第一次升级后，系统可能要求重新授权一次；仍在运行的旧进程继续使用原来的身份，需用户自己 ⌘Q 重开才切到新包。

## GitHub Release

产品版本以 `src-tauri/tauri.conf.json` 的 `version` 为准，Web 界面读取同一份配置；`build-number` 是独立递增的构建计数。`desktop:bump` 保留当前 major/minor，将 patch 设为新 build 号，用于日常 debug 交付。正式发布时递增 build 号，再将产品版本设为目标版本（如 `0.2.0`）。

在干净且等于 main 的提交上构建后，执行 `node apps/desktop/scripts/sign-release.mjs`：验证版本和来源提交，为内置服务中的原生二进制和动态库补齐 Developer ID、hardened runtime 与时间戳签名，再重新签整个 App。Tauri 默认只签壳和 Node sidecar，不会处理服务资源里的 Codex 和原生依赖。

用 `ditto -c -k --sequesterRsrc --keepParent` 打包为 `Vgent-<version>-mac-arm64.zip`（Intel 构建用 `mac-x64`），并生成 SHA-256 校验文件。标签使用 `v<version>`，与安装包来自同一提交；GitHub Release 上传 ZIP 和校验文件。

目前默认构建没有 Apple 公证。发布说明必须标明实际签名、公证状态，不能把已签名当作已公证；若另行完成公证，应先给 App 附加票据，再生成最终 ZIP。发布和安装都不启动、退出或重启已有 Vgent 进程。

`tauri build` 之前会自动跑 `scripts/prepare-desktop.mjs`（也可以单独 `pnpm --filter @vgent/desktop prepare:resources`），它做五件事：

1. 下载官方 Node.js **22.23.2** 独立发行包（不是 Homebrew 的），**先校验 sha256 再解压**，放到 `src-tauri/binaries/vgent-node-<triple>`（Tauri 的 sidecar），许可证放 `resources/server/NODE-LICENSE.txt`。压缩包缓存在 `apps/desktop/.local/node-runtime/`。
2. `pnpm -w build` + `pnpm --filter @vgent/web build`。
3. `pnpm deploy --filter @vgent/server --prod --legacy --node-linker=hoisted src-tauri/resources/server` 生成自包含的服务端目录。
   - `--legacy`：pnpm 10 在共享 lockfile 的 workspace 里默认拒绝 `deploy`，另一条路是在根 `.npmrc` 写 `inject-workspace-packages=true`，那会改变整个仓库的安装方式，所以选了 `--legacy`。
   - `--node-linker=hoisted`：默认的符号链接农场过不了 Tauri 往 `.app` 里拷资源这一步，hoisted 出来的目录里零符号链接。
4. 用**打包进去的那个 Node** 真起一次服务（`--port 0` + 临时 data dir），等到 `connection.json` 出现才算通过，否则整个构建失败。
5. `apps/web/dist` → `resources/web/`，并写 `resources/server/runtime.json`（Node 版本、目标三元组、压缩包 sha256、git sha）。

## 壳和服务怎么对话

没有自定义协议。壳只是服务端已有机制的又一个客户端：

- 壳用 sidecar Node 跑 `resources/server/dist/main.js --port 0 --web-dist <resources/web>`，环境变量加 `VGENT_DESKTOP=1`，清掉 `NODE_OPTIONS` / `NODE_PATH`。
- 服务端照常把 `{ url, token, pid }` 写进 `<dataDir>/connection.json`（0600）。壳每 100ms 读一次，**直到 `pid` 等于自己 spawn 出来的那个子进程**（别的窗口跑着 `pnpm server` 留下的文件因此不会被误认），最多等 30 秒；期间子进程提前退出就把 stderr 末尾几行塞进原生错误对话框。
- url 必须是 `http://127.0.0.1:<port>/`（无 userinfo / query / fragment），token 必须是 32–128 位 `[A-Za-z0-9_-]`，否则拒绝启动。
- 窗口直接导航到 `<url>/#token=<token>`，`apps/web` 自己从 hash 里取 token 存进 sessionStorage 再抹掉 hash，所以**不需要注入任何脚本**。API 调用是同源相对路径。
- 数据目录跟命令行版完全一致：`VGENT_DATA_DIR` 优先，否则 `~/.vgent`。
- 关窗口（⌘W、红色关闭按钮）不退出：`CloseRequested` → `prevent_close` → `hide()`。进程和内置服务都留着，任务继续跑；点 Dock 图标走 `RunEvent::Reopen` 再把窗口显示出来。真正退出是 ⌘Q、菜单「退出」和 AppleScript `quit`：`ExitRequested` 先 `GET /api/threads`，有任务还在跑、等审批或等回答就弹原生确认（默认按钮是「取消」，只有点「退出」才继续；问不到列表就照旧退出，不把人困住）。确认之后后台线程给子进程**进程组**发 SIGTERM（服务端据此停掉所有 run，让引擎落盘 resume state；还在等 worktree setup、没开跑的消息不再拖住退出，挪回排队、下次启动再发），最多等 20 秒，还不退就 SIGKILL 整组。`applicationWillTerminate` 里 `prevent_exit` 和后台线程都拦不住（回调一返回进程就没了），所以 `RunEvent::Exit` 里**同步**再停一次；`shutdown` 全程持锁，两条路撞上也只会排队。子进程意外退出时看门狗线程弹原生对话框并退出应用。
- 「添加仓库」的原生文件夹选择器也在服务端（`POST /api/projects/pick` → `osascript ... choose folder`），桌面和浏览器共用一份实现，webview 是远端 origin，不碰 Tauri IPC / capability。
- 导航策略：只有服务自己的 origin 放行，其它 http(s) 用系统默认浏览器打开，`window.open` 一律拒绝。菜单里有「调试 → 开发者工具」。

Finder 启动的应用只有 `/usr/bin:/bin:/usr/sbin:/sbin`，agent 的 shell 工具会找不到 `git` / `claude` / `pnpm`。所以 spawn 之前壳会跑一次 `"$SHELL" -lc 'printf %s "$PATH"'`（5 秒超时，失败就忽略），把结果加上 sidecar 所在目录作为子进程的 PATH。

## 图标

源文件是 `apps/desktop/icon/vgent.svg`（1024×1024，圆角方 + 品牌琥珀色的 V，颜色直接取 `apps/web/src/tokens.css` 的 `neutral-900` / `amber-400`）。改完重新生成：

```bash
cd apps/desktop
qlmanage -t -s 1024 -o icon icon/vgent.svg && mv icon/vgent.svg.png icon/vgent-1024.png
rm -rf src-tauri/icons && pnpm exec tauri icon icon/vgent-1024.png
rm -rf src-tauri/icons/{android,ios,Square*Logo.png,StoreLogo.png}   # 只留 macOS 要的那几个
```

## 开发

```bash
pnpm desktop:dev
```

`tauri dev` 同样会先跑 prepare 脚本，Rust 侧在 `tauri::is_dev()` 时直接从源码树（`src-tauri/binaries`、`src-tauri/resources`）取 Node 和资源。注意这条路**不带前端热更**：窗口加载的是打包好的 `resources/web`。改前端还是用 `pnpm server` + `pnpm --filter @vgent/web dev` 那条 Web 路子，桌面壳只在验证壳本身的行为时用。

## 测试

```bash
pnpm --filter @vgent/desktop prepare:resources   # Tauri 的构建脚本要求 binaries/ 和 resources/ 存在
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --include-ignored
```

`backend.rs` 里四个要真起内置 Node 的测试（拉起并关停、启动失败留 stderr 尾巴、意外退出记信号、数据目录被占时立刻报「已在运行」）标了 `#[ignore]`：默认的 `cargo test` 只把它们报成 ignored，不算通过；没放好内置 Node 时加 `--include-ignored` 它们会失败，不会假装通过。只跑它们用 `-- --ignored`。CI 的 `desktop` job（`.github/workflows/ci.yml`）不跑 prepare 脚本（太重），而是把 `setup-node` 装的 Node 22 拷成 `binaries/vgent-node-<triple>`、建好空的 `resources/server` 和 `resources/web`，再 `cargo test -- --include-ignored`。

## 已知限制

- **只支持 macOS**（arm64 / x64），`bundle.targets` 只有 `app`，不出 dmg。
- **有 Developer ID 签名，尚无公证和自动更新**。跨机器分发仍需要处理 Gatekeeper 的公证要求。
- 退出只认 macOS 的正常退出（⌘Q、菜单退出、AppleScript `quit`）。关窗口不会退出。直接对 `vgent-desktop` 进程 `kill` 不会走清理，内置服务会变成孤儿进程（`kill -TERM -<pid>` 手动收掉）。
- 单窗口，没有多开；桌面实例和命令行 `pnpm server` 共用 `~/.vgent`，`connection.json` 会互相覆盖（壳自己靠 pid 判断，但命令行那边的文件会被抹掉）。
- Claude Code / Codex 引擎第一次运行时，官方 harness 会在 `~/.vgent/harness/<harness>/` 里用 `pnpm install` 拉自己的 bootstrap（`@anthropic-ai/claude-code` 等不在 `.app` 里）。所以首次使用需要联网，且机器上要有 `pnpm` —— 这也是上面那段登录 shell PATH 的原因之一。
- `.app` 约 180MB，主要是内置 Node（112MB）和服务端依赖树。
