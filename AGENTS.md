# Vgent

终端 coding agent 的壳，引擎可插拔：Claude Code、Codex（AI SDK 官方 harness 适配器）和自研引擎（`ToolLoopAgent` 实现的 `HarnessV1` 适配器）。**先读 `docs/product.md`（做什么、每个功能落在任务生命周期哪一步；落不上的不做），再读 `docs/architecture.md`（怎么实现）。**

## 用词

- **引擎**：Claude Code、Codex、Vgent 这一层运行时。界面、文档和自有代码都叫引擎（Engine）。
- **harness**：只指 AI SDK 的 harness 适配器（`@ai-sdk/harness*`、`HarnessAgent`、`HarnessV1`），Claude Code 和 Codex 经它接入。
- **模型**、**提供商**（模型的接入渠道）、**agent / 子代理**（执行任务的实例）各说各的，不拿来指引擎。

## AI SDK

项目用 Vercel AI SDK v7（7.0.x）。模型训练数据多停在 v5，写 AI SDK 代码前先对齐 v7，不凭记忆。按顺序查：

1. `packages/engine/node_modules/ai/docs/`：包内文档，与安装版本一致，grep 它（pnpm 不提升，根目录没有 `ai`）；provider 包在 `packages/providers/node_modules/@ai-sdk/<name>/docs/`。
2. `docs/ai-sdk/`：v6、v7 迁移指南快照和官方文档索引 `llms.txt`。
3. 线上定点查 `https://ai-sdk.dev/api/search-docs?q=<关键词>`，结果 URL 末尾加 `.md` 取纯文本；不要拉 `llms-full.txt` 或 HTML 页面。

官方 skill 在 `.claude/skills/ai-sdk/` 和 `.claude/skills/migrate-ai-sdk-v6-to-v7/`。`ai`、`@ai-sdk/*`、AI Elements（用 `apps/web/scripts/fetch-ai-elements.mjs` 取）、Streamdown 里有的直接用，不自己另写；引入这之外的库先问用户。升级 AI SDK 相关依赖后，确认依赖树里只有一份 `@ai-sdk/provider-utils`。

更新本地资料：

```bash
npx skills update -p -y
for f in migration-guide-7-0 migration-guide-6-0; do curl -sL -o docs/ai-sdk/$f.md https://ai-sdk.dev/docs/migration-guides/$f.md; done
curl -sL -o docs/ai-sdk/llms.txt https://ai-sdk.dev/llms.txt
```

## 常用命令

```bash
pnpm start                                          # build + 起 server（自带 web）+ 开浏览器 + 注册当前仓库
pnpm build && pnpm test                             # 全量，冒烟默认跳过
VGENT_SMOKE=1 pnpm --filter @vgent/engines test     # 真跑 Claude Code 引擎（用本机登录）
VGENT_SMOKE=1 pnpm --filter @vgent/providers test   # 真跑 Codex 订阅 provider
node apps/cli/dist/index.js --engine claude-code --repo <path> --permission allow-reads
```

## 交付

改了代码就交付到装好的桌面包，这就是「发 debug」，不用等用户开口；用户说先别交付时除外。

1. 在任务 worktree 里提交，`pnpm build && pnpm test` 通过后把 main 快进到这个提交。主检出（`git worktree list` 第一行）里有用户和其他会话的改动：不在那里暂存、stash、提交或丢弃任何东西；快进被挡住就停下，说明卡在哪。
2. 在等于 main 的 worktree 里 `pnpm desktop:bump`，只提交 `apps/desktop/build-number` 和 `apps/desktop/src-tauri/tauri.conf.json`（`build: deliver … in debug <n>`），再快进一次 main。
3. `pnpm install --frozen-lockfile && pnpm desktop:build && pnpm desktop:install`。安装脚本核对产物就是 main 上的这个提交和 build 号，替换 `/Applications/Vgent.app`，把没有进程在用的旧包移进废纸篓。把 `CARGO_TARGET_DIR` 指向主检出的 `apps/desktop/src-tauri/target` 可以复用 Rust 编译缓存。
4. 不启动、退出或重启 Vgent。汇报 main 的提交和 build 号；安装脚本提示 Vgent 正在运行时，告诉用户要自己 ⌘Q 重开才生效。
