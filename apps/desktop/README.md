# @vgent/desktop

Tauri 2 的 macOS 桌面壳。它本身没有界面代码：窗口是一个浏览器，指向自己拉起来的内置 Node 服务。

## 构建

```bash
pnpm desktop:build          # 仓库根目录执行
```

产物在 `apps/desktop/src-tauri/target/release/bundle/macos/Vgent.app`，双击即可运行。第一次 cargo 编译约 5–10 分钟。

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
- 退出：关窗口走 `CloseRequested` → `prevent_close` → 后台线程给子进程**进程组**发 SIGTERM（服务端据此停掉所有 run，让引擎落盘 resume state），最多等 20 秒，还不退就 SIGKILL 整组。⌘Q 和 AppleScript `quit` 走的是 `applicationWillTerminate`，`prevent_exit` 和后台线程都拦不住它（回调一返回进程就没了），所以 `RunEvent::Exit` 里**同步**再停一次；`shutdown` 全程持锁，两条路撞上也只会排队。子进程意外退出时看门狗线程弹原生对话框并退出应用。
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

## 已知限制

- **只支持 macOS**（arm64 / x64），`bundle.targets` 只有 `app`，不出 dmg。
- **只有 ad-hoc 签名**（`signingIdentity: "-"`），没有公证，没有自动更新。从别的机器拷过去的 `.app` 会被 Gatekeeper 拦。
- 关闭方式只认 macOS 的正常退出（关窗口、⌘Q、AppleScript `quit`）。直接对 `vgent-desktop` 进程 `kill` 不会走清理，内置服务会变成孤儿进程（`kill -TERM -<pid>` 手动收掉）。
- 单窗口，没有多开；桌面实例和命令行 `pnpm server` 共用 `~/.vgent`，`connection.json` 会互相覆盖（壳自己靠 pid 判断，但命令行那边的文件会被抹掉）。
- Claude Code / Codex 引擎第一次运行时，官方 harness 会在 `~/.vgent/harness/<harness>/` 里用 `pnpm install` 拉自己的 bootstrap（`@anthropic-ai/claude-code` 等不在 `.app` 里）。所以首次使用需要联网，且机器上要有 `pnpm` —— 这也是上面那段登录 shell PATH 的原因之一。
- `.app` 约 180MB，主要是内置 Node（112MB）和服务端依赖树。
