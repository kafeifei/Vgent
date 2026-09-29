import SVG from "./sample.svg?raw";
export { SVG };
import type { UIMessage } from "ai";
import type { EngineDescriptor, QueuedMessage, ThreadSummary } from "@/lib/types";
import type { RightTab } from "@/features/rightpane/RightPane";
import type { DraftValue } from "@/lib/drafts";

export interface ChatScenario {
  id: string;
  group: string;
  label: string;
  hint: string;
  messages: UIMessage[];
  thread?: Partial<Omit<ThreadSummary, "queue">> & { queue?: QueuedMessage[] };
  tab?: RightTab;
  file?: string;
  inspect?: string;
  draft?: DraftValue;
}
export const AT = "2026-09-26T08:30:00.000Z";
/** `AT` plus some seconds, for spans that need a duration to show. */
const AT_PLUS = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString();
export const ROOT = "/style-lab/sample-project";

export const IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
export const DIFF = 'diff --git a/src/chat.ts b/src/chat.ts\n--- a/src/chat.ts\n+++ b/src/chat.ts\n@@ -1,3 +1,4 @@\n export function title(value: string) {\n-  return value;\n+  const trimmed = value.trim();\n+  return trimmed || "新任务";\n }\n';
export const PLAN = '# 聊天状态验收\n\n## 目标\n统一消息、工具和输入框的视觉节奏。\n\n- [x] 检查现有组件\n- [x] 补充场景数据\n- [ ] 调整间距并验收深浅主题\n\n## 验收\n审批、提问、文件预览在窄窗口中也可操作。';
export const FILES: Record<string, string> = {
  "src/chat.ts": 'export function title(value: string) {\n  const trimmed = value.trim();\n  return trimmed || "新任务";\n}\n',
  "README.md": '# 样例项目\n\n这里的文件可以预览，所有内容来自内存。\n\n![布局示意](assets/preview.svg)\n\n```ts\nconst ready = true;\n```',
  "docs/plan.md": PLAN,
  "assets/preview.svg": SVG,
  "package.json": '{\n  "name": "chat-style-sample",\n  "scripts": { "test": "vitest run" }\n}',
};
export const ENGINES: EngineDescriptor[] = [{ id: "vgent", label: "Vgent", capabilities: { approvals: true, askUser: true, planMode: true, compact: true, knownDefaultModel: true, extensions: true, steer: true, customProviders: true } }];
export const textPart = (text: string): UIMessage["parts"][number] => ({ type: "text", text });
export const user = (text: string, id = "user-1"): UIMessage => ({ id, role: "user", parts: [textPart(text)] });
export const assistant = (parts: UIMessage["parts"], id = "assistant-1"): UIMessage => ({ id, role: "assistant", parts });
export const tool = (name: string, input: unknown, output: unknown, id = name): UIMessage["parts"][number] => ({ type: "dynamic-tool", toolName: name, toolCallId: id, state: "output-available", input, output });
const thought: UIMessage["parts"][number] = { type: "reasoning", text: "先确认输入、执行过程和最终回复的层次，再检查工具结果与边界状态。", state: "done" };
const read = tool("read", { path: "src/chat.ts" }, { content: FILES["src/chat.ts"] });
const bash = tool("bash", { command: "pnpm test" }, { stdout: "✓ chat.test.ts (8 tests)\nTest Files  1 passed\n     Tests  8 passed\n  Duration  312ms", exitCode: 0 });
const edit = tool("edit", { path: "src/chat.ts", oldText: "return value;", newText: 'return value.trim() || "新任务";' }, { diff: DIFF });
const question = { type: "dynamic-tool", toolName: "askUserQuestions", toolCallId: "question", state: "input-available", input: { allowPartialAnswers: true, questions: [
  { id: "layout", header: "布局", question: "对话的阅读密度应该如何调整？", options: [{ id: "comfortable", label: "舒适", description: "保留充足留白，适合长时间阅读。" }, { id: "compact", label: "紧凑", description: "在一屏里展示更多工作过程。" }], allowFreeForm: true },
  { id: "coverage", header: "验收", question: "这次需要检查哪些状态？", options: [{ id: "tools", label: "工具调用" }, { id: "errors", label: "异常与恢复" }], allowMultiple: true, allowFreeForm: true },
] } } satisfies UIMessage["parts"][number];
const approval = { type: "dynamic-tool", toolName: "bash", toolCallId: "approval", state: "approval-requested", input: { command: "pnpm install", description: "安装项目依赖" }, approval: { id: "approval-1" } } satisfies UIMessage["parts"][number];
const workspace = { mode: "worktree" as const, path: ROOT, branch: "style/chat-layout", baseCommit: "sample-base" };
const settled = [user("检查聊天组件并修复空标题。"), assistant([thought, read, edit, bash, textPart("已修复空标题。输入只有空格时，现在显示 **新任务**。\n\n修改位于 [src/chat.ts](src/chat.ts)，8 项测试通过。")])];
const markdown = `# 排版与阅读\n\n这是一段中文与 English 混排，包含 **重点**、*强调*、~~删除~~、\`inline code\` 和 [本地文件](README.md)。\n\n## 列表\n\n1. 检查消息之间的距离\n2. 比较工具和最终回复的字号\n\n- [x] 深色主题\n- [ ] 浅色主题\n\n> 让需要做的选择清晰，让过程保持安静。\n\n| 状态 | 说明 | 结果 |\n| --- | --- | --- |\n| 运行中 | 正在读取文件 | 等待 |\n| 已完成 | 8 项测试通过 | 成功 |\n\n---\n\n公式：$E = mc^2$\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$`;
const code = '```typescript\nexport async function loadThread(id: string): Promise<Thread> {\n  const response = await fetch(`/api/threads/${encodeURIComponent(id)}`);\n  if (!response.ok) throw new Error(`Request failed: ${response.status}`);\n  return response.json();\n}\n```\n\n```diff\n- const title = value;\n+ const title = value.trim() || "新任务";\n```';
const queued = [{ id: "queued-1", text: "完成以后再检查浅色主题。", createdAt: AT, mode: "queue" as const }, { id: "queued-2", text: "先检查输入框，不改配色。", createdAt: AT, mode: "steer" as const }];
const pair = (prompt: string, ...parts: UIMessage["parts"]): UIMessage[] => [user(prompt), assistant(parts)];

/** Stable fixtures describe every renderer branch; behavior is supplied by the local Chat transport. */
export const SCENARIOS: ChatScenario[] = [
  { id: "overview", group: "消息", label: "完整工作过程", hint: "展开工作过程、点击文件和终端，再发送一条消息。", messages: settled, thread: { workspace } },
  { id: "empty", group: "消息", label: "空对话", hint: "空白任务与可编辑输入框。发送内容会在本地逐字回复。", messages: [] },
  { id: "markdown", group: "消息", label: "Markdown 与公式", hint: "标题、混排、引用、列表、任务清单、表格与公式。", messages: pair("展示常见排版。", textPart(markdown)) },
  { id: "code", group: "消息", label: "代码与长行", hint: "检查代码高亮、复制按钮和横向滚动。", messages: pair("展示 TypeScript 和 diff。", textPart(code + '\n\n```text\n' + 'very-long-identifier/'.repeat(25) + '\n```')) },
  { id: "diagram", group: "消息", label: "图表与图片", hint: "Mermaid、内联 SVG、工作区图片和文件链接。", messages: pair("展示流程和结果。", textPart('```mermaid\nflowchart LR\n  A[发送消息] --> B[执行工具]\n  B --> C[返回结果]\n```\n\n```svg\n' + SVG + '\n```\n\n![布局示意](assets/preview.svg)\n\n[查看计划](docs/plan.md)')) },
  { id: "attachments", group: "消息", label: "用户附件", hint: "消息中的图片、文件和输入框中待发送的附件。", messages: [{ ...user("按照附件检查布局。"), parts: [textPart("按照附件检查布局。"), { type: "file", mediaType: "image/svg+xml", filename: "preview.svg", url: IMAGE }, { type: "file", mediaType: "text/plain", filename: "requirements.txt", url: "data:text/plain,Check%20chat%20layout" }] }, assistant([textPart("已收到图片和需求文件。")])], draft: { text: "再对照这张图检查留白。", attachments: [{ id: "sample-image", name: "preview.svg", mediaType: "image/svg+xml", url: IMAGE, size: SVG.length }] } },
  { id: "long", group: "消息", label: "长对话", hint: "24 轮对话：滚动、回到底部、复制、分叉和长标题截断。", messages: Array.from({ length: 24 }, (_, i) => [user(`第 ${i + 1} 轮：检查聊天场景 ${i + 1}，保留已有操作。`, `user-${i}`), assistant([textPart(`已检查第 ${i + 1} 项。\n\n${i % 4 === 0 ? markdown : "消息布局正常，接下来检查输入框与详情面板。"}`)], `assistant-${i}`)]).flat(), thread: { title: "这是一个用于验证窄窗口与长标题截断效果的聊天任务，包含很多轮真实组件渲染的对话内容" } },
  { id: "thinking", group: "运行", label: "等待首字", hint: "请求已开始、尚未返回内容。点击演示回复或停止。", messages: [user("分析现有聊天布局。")], thread: { status: "running" } },
  { id: "reasoning", group: "运行", label: "思考中", hint: "实时思考与展开、收起。点击演示回复可查看完整流式过程。", messages: pair("分析现有聊天布局。", { ...thought, state: "streaming" }), thread: { status: "running" } },
  { id: "streaming", group: "运行", label: "回复生成中", hint: "停留在流式文本中间，便于调样式；点击演示回复继续观察动画。", messages: pair("给出修改建议。", { type: "text", text: "先调整消息间距，再检查 **工具执行** 和最终回复之间的层次。\n\n```ts\nconst layout =", state: "streaming" }), thread: { status: "running" } },
  { id: "queue-attachments", group: "运行", label: "附件排队", hint: "纯附件与图文队列：可以清空正文，不提供引导；打断发送或停止后发送会保留完整附件。", messages: pair("检查聊天布局。", read), thread: { status: "running", queue: [
    { id: "queued-file", text: "", mode: "queue", createdAt: AT, files: [{ type: "file", filename: "preview.svg", mediaType: "image/svg+xml", url: IMAGE }] },
    { id: "queued-files", text: "对照需求检查", mode: "queue", createdAt: AT, files: [{ type: "file", filename: "requirements.txt", mediaType: "text/plain", url: "data:text/plain,Check%20chat%20layout" }, { type: "file", filename: "preview.svg", mediaType: "image/svg+xml", url: IMAGE }] },
  ] }, draft: { text: "", attachments: [{ id: "queued-draft", name: "preview.svg", mediaType: "image/svg+xml", url: IMAGE, size: SVG.length }] } },
  { id: "queue", group: "运行", label: "排队与插话", hint: "可编辑、重排、删除、插话；停止后观察暂停队列。", messages: pair("检查全部聊天组件。", { ...thought, state: "streaming" }), thread: { status: "running", queue: queued } },
  { id: "steer-pending", group: "运行", label: "引导等待处理", hint: "消息只有正文；悬停显示立即打断并发送，下一轮排队仍在输入框。", messages: pair("检查所有布局。", read, { type: "data-steer", id: "steer-pending-1", data: { messageId: "steer-pending-1", text: "先检查输入框，不改配色。", receipt: true } }), thread: { status: "running", queue: [{ id: "steer-pending-1", text: "先检查输入框，不改配色。", mode: "steer", accepted: true, createdAt: AT }, queued[0]!] } },
  { id: "steer-stopped", group: "运行", label: "停止后的引导", hint: "悬停显示立即发送。保留消息正文与输入框上方的下一轮队列。", messages: pair("检查所有布局。", read), thread: { status: "interrupted", queue: [{ id: "steer-stopped-1", text: "先检查输入框，不改配色。", mode: "steer", createdAt: AT }, queued[0]!] } },
  { id: "steer", group: "运行", label: "插话已接受", hint: "运行过程中的方向修正消息。", messages: pair("检查所有布局。", read, { type: "data-steer", data: { text: "先检查输入框，不改配色。", id: "steer-1", at: AT } }, textPart("收到，先检查输入框。")) },
  { id: "explore", group: "工具", label: "读取与搜索分组", hint: "连续读取、搜索会合并；展开分组检查各工具。", messages: pair("找出标题相关代码。", read, tool("grep", { pattern: "title", path: "src" }, { content: "src/chat.ts:1: export function title" }), tool("glob", { pattern: "src/**/*.tsx" }, { content: "src/chat.ts\nsrc/ThreadView.tsx" }), textPart("标题处理位于 [src/chat.ts](src/chat.ts)。")) },
  { id: "tool-running", group: "工具", label: "执行中与部分输出", hint: "执行状态、未完成参数和终端部分输出。", messages: pair("运行测试。", { type: "dynamic-tool", toolName: "bash", toolCallId: "bash-live", state: "output-available", input: { command: "pnpm test" }, preliminary: true, output: { stdout: "RUN v5\n✓ chat.test.ts\n" } }, { type: "dynamic-tool", toolName: "read", toolCallId: "read-partial", state: "input-streaming", input: { path: "src/" } }), thread: { status: "running" }, tab: "term" },
  { id: "terminal", group: "工具", label: "终端成功与失败", hint: "检查标准输出、错误退出和详细终端。", messages: pair("运行检查。", bash, tool("bash", { command: "pnpm lint" }, { stdout: "src/chat.ts:2:3\nerror: Unexpected indentation\n", stderr: "Command failed with exit code 1", exitCode: 1 }, "lint"), textPart("测试通过，格式检查有一处待修复。")), tab: "term" },
  { id: "edit", group: "工具", label: "文件修改与 Diff", hint: "点击文件、切换改动范围、查看差异与撤销确认。", messages: settled, thread: { workspace }, tab: "changes", file: "src/chat.ts" },
  { id: "tool-error", group: "工具", label: "工具失败", hint: "工具错误与模型解释同时存在。", messages: pair("读取配置。", { type: "dynamic-tool", toolName: "read", toolCallId: "read-error", state: "output-error", input: { path: "missing.json" }, errorText: "ENOENT: no such file or directory, open missing.json" }, textPart("配置文件不存在，需要先创建。")), tab: "tool", inspect: "read-error" },
  { id: "mcp", group: "工具", label: "MCP 与通用工具", hint: "字段、短列表与空值；可切换原始数据并复制。", messages: pair("检查设计规范。", tool("mcp__design__inspect", { node: "chat/composer", include: ["spacing", "colors"] }, { node: "chat/composer", spacing: 16, tokens: ["bg", "fg-muted"], warnings: [] }), textPart("已检查输入框的样式变量。")), tab: "tool", inspect: "mcp__design__inspect" },
  { id: "tool-records", group: "工具", label: "结构化结果列表", hint: "同类记录按表格展示，长列表分批展开，路径可打开。", messages: pair("列出检查结果。", tool("inspectFiles", { path: "src", query: "title" }, Array.from({ length: 45 }, (_, index) => ({ path: "src/chat.ts", line: index + 1, message: `第 ${index + 1} 项检查通过` }))), textPart("检查结果已列出。")), tab: "tool", inspect: "inspectFiles" },
  { id: "tool-nested", group: "工具", label: "嵌套与长结果", hint: "复杂字段折叠、长文本逐步展开，保留 false、null 和错误信息。", messages: pair("检查完整配置。", tool("inspectConfig", { config: { output: { format: "json", verbose: false } } }, { metadata: { request: { id: "sample-request", attempts: 2 }, cached: false }, stdout: "检查通过。\n".repeat(450) + "检查结束。", warnings: [], error: null })), tab: "tool", inspect: "inspectConfig" },
  { id: "mcp-content", group: "工具", label: "MCP 内容与错误", hint: "MCP 文本按 Markdown 展示、JSON 文本转为字段，错误标记与附加信息保留。", messages: pair("检查设计结果。", tool("mcp__design__report", { node: "chat/composer" }, { content: [{ type: "text", text: "### 检查结果\n\n已检查 **输入框**；有一项间距需要调整。\n\n[查看规范](docs/plan.md)\n\n![结果预览](assets/preview.svg)" }, { type: "text", text: '{"spacing":16,"warnings":["按钮间距偏大"]}' }, { type: "resource_link", name: "设计规范", uri: "design://chat/composer" }], isError: true })), tab: "tool", inspect: "mcp__design__report" },
  { id: "subagent", group: "工具", label: "子代理记录", hint: "子代理的嵌套工具、思考与最终结果。", messages: pair("安排一次独立检查。", tool("explore", { prompt: "检查聊天组件覆盖范围" }, { ...assistant([thought, read, textPart("发现输入框、工作过程和审批卡片三组组件。")], "child-message"), metadata: { subagent: { modelId: "sample-model", provider: "sample-provider" } } }), textPart("检查已完成。")), tab: "tool", inspect: "explore" },
  { id: "subagent-thinking", group: "工具", label: "子代理思考中", hint: "运行时就能看到子代理模型，点击思考可查看正在生成的内容。", messages: pair("安排一次独立检查。", { type: "dynamic-tool", toolName: "explore", toolCallId: "child-live", state: "output-available", preliminary: true, input: { prompt: "检查聊天组件" }, output: { ...assistant([{ ...thought, state: "streaming" }], "child-live-message"), metadata: { subagent: { modelId: "sample-model", provider: "sample-provider" } } } }), thread: { status: "running" }, tab: "tool", inspect: "child-live" },
  { id: "subagent-legacy", group: "工具", label: "子代理旧记录", hint: "未保存模型与思考的历史记录明确标注缺失，保留工具和最终结果。", messages: pair("查看旧的子代理记录。", tool("explore", { prompt: "检查组件" }, assistant([read, textPart("已检查组件。")], "child-legacy-message"))), tab: "tool", inspect: "explore" },
  {
    id: "narrow-panes", group: "工具", label: "窄窗口与长内容",
    hint: "打开子代理详情并缩窄窗口：消息、长命令、模型选择器和输入框应留在各自分栏内。",
    thread: { status: "running", model: "sample-provider:very-long-model-name-for-narrow-window", workspace: { ...workspace, branch: "codex/long-branch-name-for-narrow-window" } },
    messages: pair("检查窄窗口中的主对话和子代理详情。",
      ...["engine", "runtime-context", "prompt-caching"].map((name) => tool("write", { path: `packages/engine/src/${name}.ts` }, { ok: true }, name)),
      tool("bash", { command: "pnpm build && pnpm exec vitest run packages/engine/src/prompt-caching.test.ts packages/engine/src/runtime-context.test.ts" }, { stdout: "检查通过", exitCode: 0 }),
      { type: "dynamic-tool", toolName: "explore", toolCallId: "narrow-child", state: "output-available", preliminary: true,
        input: { prompt: "只读检查 packages/engine/src/prompt-caching.ts 和 packages/engine/src/runtime-context.ts，核对长路径、命令和详情在窄窗口中的显示。", thoroughness: "very thorough" },
        output: { ...assistant([thought, read, bash], "narrow-child-message"), metadata: { subagent: { modelId: "sample-model", provider: "sample-provider" } } },
      }),
    tab: "tool", inspect: "narrow-child",
  },
  { id: "plan", group: "工具", label: "计划与步骤", hint: "步骤状态和可编辑计划文档；Build 在样例中执行。", messages: pair("先制定计划。", tool("updatePlan", { items: [{ text: "检查组件", status: "completed" }, { text: "建立样例", status: "in_progress" }, { text: "视觉验收", status: "pending" }] }, { ok: true }), textPart(PLAN)), thread: { mode: "plan" }, tab: "plan" },
  { id: "approval", group: "等待你处理", label: "等待审批", hint: "允许、拒绝、一直允许均会更新当前样例。", messages: pair("安装依赖后继续。", approval), thread: { status: "awaiting-approval", pendingApprovals: 1 }, tab: "queue" },
  { id: "approval-done", group: "等待你处理", label: "审批已通过与拒绝", hint: "已处理审批的历史样式。", messages: pair("检查审批结果。", { ...approval, state: "output-available", approval: { id: "approval-1", approved: true }, output: { stdout: "Already up to date", exitCode: 0 } }, { ...approval, toolCallId: "denied", state: "output-denied", approval: { id: "approval-2", approved: false, reason: "暂不执行" } }, textPart("已完成允许的操作，其余操作已跳过。")) },
  { id: "question", group: "等待你处理", label: "单选、多选与补充", hint: "使用真实提问表单，支持提交、部分回答和跳过。", messages: pair("帮我确定验收方式。", question), thread: { status: "awaiting-input" }, tab: "queue" },
  { id: "question-done", group: "等待你处理", label: "回答后的记录", hint: "已回答与已跳过的提问历史。", messages: pair("确定验收方式。", { ...question, state: "output-available", output: { action: "answered", answers: { layout: { optionIds: ["comfortable"], freeform: "保持输入框紧凑。" }, coverage: { optionIds: ["tools", "errors"] } } } }, { ...question, toolCallId: "skipped-question", state: "output-available", output: { action: "declined" } }, textPart("按舒适密度验收工具和异常状态。")) },
  { id: "error", group: "异常与恢复", label: "请求失败", hint: "错误横幅、历史失败说明与再次发送。", messages: [{ ...user("检查聊天布局。"), metadata: { turnEnd: { status: "error", reason: "连接中断，回复未完成。" } } }], thread: { status: "error", error: "服务暂时不可用（503）。请稍后重试。", queue: queued } },
  { id: "interrupted", group: "异常与恢复", label: "用户停止", hint: "保留部分内容、停止说明与暂停队列。", messages: [{ ...user("继续检查。"), metadata: { turnEnd: { status: "interrupted", reason: "已由你停止" } } }, assistant([read])], thread: { status: "interrupted", queue: queued } },
  {
    id: "restart-folds", group: "异常与恢复", label: "重启后的工作过程",
    hint: "没有最终回复的中断历史：文字说明留在折叠外，工具按段折叠，子代理部分输出可查看但不再转圈。",
    messages: [
      { ...user("检查附件排队。"), metadata: { turnEnd: { status: "interrupted", reason: "服务已重启" } } },
      assistant([
        textPart("先检查输入框和队列的附件处理。"), thought, read, bash,
        textPart("已定位到附件排队入口，正在补充回归测试。"), edit,
        { type: "dynamic-tool", toolName: "coder", toolCallId: "restart-child", state: "output-available", preliminary: true,
          input: { task: "补充附件排队测试" },
          output: { ...assistant([{ ...thought, state: "streaming" }, textPart("已完成部分回归检查，尚未确认最终结果。")], "restart-child-message"), metadata: { subagent: { modelId: "sample-model" } } },
        },
      ]),
    ],
    thread: { status: "interrupted" },
  },
  { id: "no-output", group: "异常与恢复", label: "空回复", hint: "模型结束但没有内容的兜底状态。", messages: [user("检查代码。"), assistant([])] },
  { id: "compact-running", group: "异常与恢复", label: "Claude 正在压缩", hint: "压缩过程中只显示压缩状态，不提前报完成或显示思考中。", messages: [{ ...user("/compact"), metadata: { compactRequested: { at: AT } } }, assistant([{ type: "step-start" }])], thread: { engine: "claude-code", status: "running" } },
  { id: "compact-done", group: "异常与恢复", label: "Claude 压缩完成", hint: "原生压缩正常结束，无文字回复；上下文用量等待下一次调用更新。", messages: [user("检查聊天组件。", "before-user"), { ...assistant([textPart("检查完毕。")], "before-assistant"), metadata: { usage: { inputTokens: 504206 } } }, { ...user("/compact"), metadata: { compactRequested: { at: AT }, run: { id: "compact-run", engine: "claude-code", startedAt: AT, endedAt: AT_PLUS(71), stopReason: "response", finishReason: "stop" } } }, assistant([{ type: "step-start" }])], thread: { engine: "claude-code" } },
  { id: "compact-error", group: "异常与恢复", label: "Claude 压缩失败", hint: "失败保留原因，不报完成。", messages: [{ ...user("/compact"), metadata: { compactRequested: { at: AT }, turnEnd: { status: "error", reason: "连接中断，压缩未完成。" } } }], thread: { engine: "claude-code", status: "error", error: "连接中断，压缩未完成。" } },
  { id: "compact-interrupted", group: "异常与恢复", label: "Claude 压缩中断", hint: "手动停止后保留中断状态。", messages: [{ ...user("/compact"), metadata: { compactRequested: { at: AT }, turnEnd: { status: "interrupted", reason: "已由你停止" } } }], thread: { engine: "claude-code", status: "interrupted" } },
  { id: "compacted", group: "异常与恢复", label: "上下文已压缩", hint: "压缩标记、摘要与上下文占用。", messages: [{ ...user("之前已检查 24 个组件，剩余输入框和文件预览待验收。", "summary"), metadata: { compacted: { before: 48, at: AT }, usage: { inputTokens: 365000, outputTokens: 350, totalTokens: 365350 }, totalUsage: { inputTokens: 2840000, cachedInputTokens: 2610000, cacheWriteTokens: 42000, outputTokens: 38400, reasoningTokens: 12800, totalTokens: 2878400 } } }, user("继续检查。", "user-2"), assistant([textPart("从输入框继续。")], "assistant-2")] },
  { id: "restored", group: "异常与恢复", label: "回到检查点", hint: "被撤销的回合与回到最新按钮。", messages: settled, thread: { restoredTo: { messageId: "user-1", undoCommit: "sample-undo", at: AT } } },
  { id: "setup", group: "任务与工作区", label: "环境准备中", hint: "第一条消息下的创建 worktree 与 setup 脚本两行。", messages: [user("开始检查。")], thread: { workspace: { ...workspace, created: { startedAt: AT, finishedAt: AT_PLUS(2) }, setup: { status: "running", startedAt: new Date().toISOString() } } } },
  { id: "setup-error", group: "任务与工作区", label: "环境准备失败", hint: "失败原因与输出末尾。", messages: settled, thread: { workspace: { ...workspace, created: { startedAt: AT, finishedAt: AT_PLUS(2) }, setup: { status: "failed", startedAt: AT_PLUS(2), finishedAt: AT_PLUS(16), exitCode: 1, error: "setup 脚本失败，退出码 1" } } } },
  { id: "reclaimed", group: "任务与工作区", label: "工作区已回收", hint: "目录回收提示和恢复操作。", messages: settled, thread: { workspace: { ...workspace, reclaimed: true, snapshotPath: "/style-lab/snapshot" } } },
  { id: "archived", group: "任务与工作区", label: "任务已归档", hint: "归档后的输入区与恢复任务。", messages: settled, thread: { archivedAt: AT } },
  { id: "files", group: "详情面板", label: "文件树与预览", hint: "浏览样例目录，预览 Markdown、代码和图片。", messages: settled, tab: "files" },
  { id: "review", group: "详情面板", label: "审查与收尾", hint: "提交、带回主目录等确认框均只操作样例状态。", messages: settled, thread: { workspace }, tab: "changes" },
  { id: "draft", group: "输入框", label: "多行草稿", hint: "编辑、换行、@ 文件补全、/ 命令与模型选项。", messages: settled, draft: { text: "请检查这些地方：\n1. 消息的行高和留白\n2. 工具结果的展开状态\n3. 输入框的多行高度\n\n保留现在的主题。", attachments: [] } },
];
