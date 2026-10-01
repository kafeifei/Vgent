# Vgent

本地的 coding agent 工作台：你派活，它干，你验收，收口。不是聊天软件，也不是 IDE。

引擎可插拔：Claude Code、Codex、OpenCode，以及用 AI SDK `ToolLoopAgent` 自研的引擎。界面是 Web（本机 Hono server 自带），也有 macOS 桌面壳（Tauri）。任务可以在项目主目录或独立的 git worktree 里跑，有 Plan、审批、排队与插话、diff 验收、提交 / 开 PR / 带回主目录，也能从别的设备远程访问同一批任务。

## 要求

- Node ≥ 22.12（根 `package.json` 的 `engines`，`.npmrc` 开了 `engine-strict`）
- pnpm（版本见根 `package.json` 的 `packageManager`）
- Claude、Codex、GitHub（Copilot）账号在应用的「设置 → 账号」里登录，每家可以登多个；终端里已经登录的 `claude` / `codex` 自动算第一个账号
- 桌面版另需 macOS、Rust 工具链，以及 `tauri.conf.json` 里固定的 Developer ID 证书（见 `apps/desktop/README.md`）

## 跑起来

```bash
pnpm install
pnpm start        # build + 起 server（自带 web）+ 开浏览器 + 把当前 git 仓库注册成项目
```

- 默认端口 7412（`--port` / `VGENT_PORT`），数据在 `~/.vgent`（`--data-dir` / `VGENT_DATA_DIR`）。
- 只起 server：`pnpm build && pnpm server`。改前端：`pnpm server` 加 `pnpm --filter @vgent/web dev`（Vite 把 `/api` 代理到 `VGENT_SERVER_URL`，缺省 `http://127.0.0.1:7412`）。
- 桌面包：`pnpm desktop:build` 产出 `apps/desktop/src-tauri/target/release/bundle/macos/Vgent.app`；`pnpm desktop:install` 核对产物就是 main 上的提交和 build 号后替换 `/Applications/Vgent.app`；`pnpm desktop:dev` 是 `tauri dev`；`pnpm desktop:bump` 递增 `apps/desktop/build-number` 和 Tauri 版本号。详见 `apps/desktop/README.md`。
- 终端入口（只给开发调试）：`node apps/cli/dist/index.js --engine claude-code --repo <path> --permission allow-reads`（先 `pnpm build`；`--engine` 只有 `claude-code` / `codex` / `vgent`）。

## 测试

```bash
pnpm build && pnpm test                             # tsc -b 加全量 vitest，真机冒烟默认跳过
VGENT_SMOKE=1 pnpm --filter @vgent/engines test     # 真跑 Claude Code / Codex / OpenCode 引擎（用本机登录）
VGENT_SMOKE=1 pnpm --filter @vgent/providers test   # 真跑 Codex 订阅 provider
pnpm --filter @vgent/desktop prepare:resources      # 桌面壳的 Rust 测试要先有内置 Node 和资源目录
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --include-ignored
```

`packages/server`、`packages/engine` 里也有受 `VGENT_SMOKE=1` 门控的冒烟测试。真实模型的自研引擎回归是 `packages/engine/scripts/engine-eval.mts`，要 `VGENT_LIVE_EVAL=1` 和 `VGENT_EVAL_OUTPUT`，见 `docs/engine-reliability.md`。

CI（`.github/workflows/ci.yml`）在 macOS 上跑两个 job。`check`：`pnpm install --frozen-lockfile`，装 ripgrep（grep 工具的测试连 rg 一起测，没有 `rg` 那一半报跳过），`pnpm build`、`pnpm test`，再打一次 web 包（`pnpm build` 只给 web 做类型检查）。`desktop`：把 `setup-node` 装的 Node 22 拷成内置 Node 的位置、建好空的资源目录，跑 `cargo test -- --include-ignored`，`backend.rs` 里四个要真起内置 Node、标了 `#[ignore]` 的测试也在其中。没有 linter，靠 `tsconfig.base.json` 的严格项和 `.editorconfig`；各包的 tsconfig 把 `*.test.ts(x)` 排除在外，测试文件不在 `pnpm build` 的类型检查里。

## 仓库结构

```
apps/web               Vite + React 界面
apps/desktop           Tauri 2 桌面壳（仅 macOS）
apps/cli               终端入口（runAgentTUI，只连本地引擎）
packages/server        Hono 服务：引擎注册、运行管理、持久化、worktree / 收口、远程访问、账号、Computer Use
packages/engine        自研引擎：ToolLoopAgent + 权限 / 子代理 / MCP / skills / 记忆
packages/engines       Claude Code / Codex / OpenCode 的 harness 适配（server 里的 Codex 走原生 app-server，不走这里的 harness 版）
packages/providers     模型接入：提供商配置、models.dev 目录、Codex 订阅凭据
packages/tools         内建工具（read / write / edit / bash / grep / glob）
packages/sandbox-local 本地 sandbox（命令跑在宿主机）
vendor/                @saymiao/remote-core 的版本化 tarball（远程访问共用）
patches/               pnpm 补丁（@ai-sdk/harness*），说明在 patches/README.md
docs/                  文档
```

## 文档

- [`AGENTS.md`](AGENTS.md)：在这个仓库里干活的规矩：用词、AI SDK 怎么查、交付流程。
- [`docs/product.md`](docs/product.md)：做什么，每个功能落在任务生命周期的哪一步（落不上的不做）。
- [`docs/architecture.md`](docs/architecture.md)：怎么实现；账号另见 [`docs/architecture/accounts.md`](docs/architecture/accounts.md)。
- 其它：[`docs/remote-control.md`](docs/remote-control.md)（远程访问和它的边界）、[`docs/engine-reliability.md`](docs/engine-reliability.md)（自研引擎的执行契约）、[`docs/cursor-compare.md`](docs/cursor-compare.md)（对照 Cursor）、[`apps/desktop/README.md`](apps/desktop/README.md)（桌面壳）、`docs/ai-sdk/`（AI SDK 文档快照，写 AI SDK 代码前先看 `AGENTS.md`）。
