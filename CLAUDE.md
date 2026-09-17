# Vgent

终端 coding agent 的壳，可插拔引擎：Claude Code、Codex（官方 harness 适配器）和自研引擎（`ToolLoopAgent` 实现的 `HarnessV1` 适配器）。**先读 `docs/architecture.md`**。

## AI SDK（Vercel `ai` 包）

本项目使用 Vercel AI SDK。模型训练数据里的 AI SDK 知识停在 v5，**当前 latest 是 v7**（7.0.x，2026-06 发布；v6 于 2025-12 发布）。写任何 AI SDK 代码前先对齐 v7 API，不要凭记忆。

### 资料优先级

1. **`node_modules/ai/docs/`**（装了 `ai` 之后才有）— 包内自带的全套文档，291 个 mdx，与安装版本严格一致。这是第一手资料，grep 它。
   - `03-ai-sdk-core/` 核心调用，`03-agents/` ToolLoopAgent，`04-ai-sdk-ui/` useChat 等，`07-reference/` API 参考，`08-migration-guides/` 迁移指南
   - provider 包同理：`node_modules/@ai-sdk/<name>/docs/`
2. **`docs/ai-sdk/`**（本仓库，2026-09-17 从 ai-sdk.dev 拉的快照）— 尚未安装 `ai` 时的兜底：
   - `migration-guide-7-0.md` — v6→v7 全部 breaking change（`system`→`instructions`、ESM only、Node 22+、`onFinish`→`onEnd`、`fullStream`→`stream`、usage 多步聚合、`toUIMessageStream({ stream })`、`needsApproval`→`toolApproval`）
   - `migration-guide-6-0.md` — v5→v6 全部 breaking change（`generateObject` 废弃改 `Output.object()`、`CoreMessage`→`ModelMessage`、`ToolLoopAgent`、`embeddingModel()`）
   - `navigating-the-library.md` 包结构、`agents.md` agent 用法、`llms.txt` 官方文档索引
3. **线上定点查**（本地都没有时）：先搜再拉 Markdown，单次几 KB
   ```
   https://ai-sdk.dev/api/search-docs?q=<关键词>
   ```
   返回的文档 URL 末尾加 `.md` 即得纯 Markdown。**不要**拉 `llms-full.txt`（6MB）或 HTML 页面（单页约 2MB）。

### 项目 skills

- `.claude/skills/ai-sdk/` — 官方使用 skill，写 AI SDK 相关代码时先加载
- `.claude/skills/migrate-ai-sdk-v6-to-v7/` — 升级迁移用

### 常用命令

```bash
pnpm build && pnpm test                     # 全量，冒烟默认跳过
VGENT_SMOKE=1 pnpm --filter @vgent/engines test     # 真跑 Claude Code 引擎（用本机登录）
VGENT_SMOKE=1 pnpm --filter @vgent/providers test   # 真跑 Codex 订阅 provider
node apps/cli/dist/index.js --engine claude-code --repo <path> --permission allow-reads
```

代码改动一律派 Coder 子代理做（机械活 Sonnet，接线和难点 Opus），主线只读结论、不读大文件。

### 更新本地资料

```bash
npx skills update -p -y
for f in migration-guide-7-0 migration-guide-6-0; do curl -sL -o docs/ai-sdk/$f.md https://ai-sdk.dev/docs/migration-guides/$f.md; done
curl -sL -o docs/ai-sdk/llms.txt https://ai-sdk.dev/llms.txt
```
