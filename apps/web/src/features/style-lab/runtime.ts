import { Chat } from "@ai-sdk/react";
import { getToolName, isToolUIPart, type ChatTransport, type FileUIPart, type UIMessage, type UIMessageChunk } from "ai";
import type { ApiClient } from "@/lib/api";
import type { DraftValue } from "@/lib/drafts";
import type { ChangesResponse, ThreadRecord, ThreadSummary } from "@/lib/types";
import { AT, DIFF, FILES, PLAN, ROOT, assistant, textPart, type ChatScenario } from "./fixtures";

/** Missing handlers fail closed. No production client, token, fetch or filesystem access enters a lab session. */
export function localClient(handlers: Partial<ApiClient>): ApiClient {
  return new Proxy(handlers, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => Promise.reject(new Error(`样例暂未提供此操作：${String(key)}`));
    },
  }) as ApiClient;
}

export class StyleSession {
  readonly chat: Chat<UIMessage>;
  readonly client: ApiClient;
  private listeners = new Set<() => void>();
  private thread: ThreadSummary;
  private draft: DraftValue;
  private queuedFiles = new Map<string, FileUIPart[]>();
  private plan = PLAN;
  private disposed = false;
  private stopStream: (() => void) | undefined;
  private files: ChangesResponse["files"] = [
    { path: "src/chat.ts", status: "modified", additions: 2, deletions: 1, binary: false },
    { path: "docs/plan.md", status: "added", additions: 14, deletions: 0, binary: false },
  ];
  private committed = false;
  private replaying = false;
  constructor(readonly scenario: ChatScenario, private notify: (text: string) => void = () => {}, delay = 65) {
    const id = `style-lab-${scenario.id}-${crypto.randomUUID()}`;
    this.thread = { version: 1, id, projectId: "style-lab", title: scenario.label, engine: "vgent", model: "sample-model", status: "idle", createdAt: AT, updatedAt: AT, messageCount: scenario.messages.length, pendingApprovals: 0, ...structuredClone(scenario.thread) };
    if (scenario.thread?.queue) this.thread.queue = scenario.thread.queue.map((item) => {
      const files = structuredClone(item.files ?? []);
      this.queuedFiles.set(item.id, files);
      return { ...item, files: files.map(({ type, filename, mediaType }) => ({ type, ...(filename != null ? { filename } : {}), mediaType })) };
    });
    this.draft = structuredClone(scenario.draft ?? { text: "", attachments: [] });
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream: async () => null,
      sendMessages: async ({ messages, abortSignal }) => {
        if (this.disposed) throw new Error("样例已关闭");
        this.patch({ status: "running", error: undefined, pendingApprovals: 0 });
        const last = messages.at(-1);
        const continuing = last?.role === "assistant";
        const chunks: UIMessageChunk[] = [{ type: "start", messageId: continuing ? last.id : crypto.randomUUID() }];
        for (const part of continuing ? last.parts : []) {
          if (!isToolUIPart(part) || part.state !== "approval-responded") continue;
          chunks.push(part.approval.approved
            ? { type: "tool-output-available", toolCallId: part.toolCallId, output: { stdout: "样例操作已完成", exitCode: 0 } }
            : { type: "tool-output-denied", toolCallId: part.toolCallId });
        }
        chunks.push({ type: "start-step" }, { type: "reasoning-start", id: "reasoning" });
        for (const delta of ["先检查消息布局。", "然后检查工具、输入框和窄窗口中的可读性。"])
          chunks.push({ type: "reasoning-delta", id: "reasoning", delta });
        chunks.push({ type: "reasoning-end", id: "reasoning" }, { type: "text-start", id: "reply" });
        const reply = "已收到。这里使用真实聊天组件演示逐字回复。\n\n你可以继续调节窗口宽度、切换主题，或展开工作过程查看细节。\n\n这次操作只更新当前样例。";
        for (const delta of reply.match(/.{1,4}|\n/g) ?? []) chunks.push({ type: "text-delta", id: "reply", delta });
        chunks.push({ type: "text-end", id: "reply" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" });
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            let index = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let ended = false;
            const close = () => {
              if (ended) return;
              ended = true;
              clearTimeout(timer);
              abortSignal?.removeEventListener("abort", close);
              this.stopStream = undefined;
              controller.close();
            };
            const tick = () => {
              if (ended) return;
              const chunk = chunks[index++];
              if (chunk == null) { close(); return; }
              controller.enqueue(chunk);
              timer = setTimeout(tick, delay);
            };
            this.stopStream = close;
            abortSignal?.addEventListener("abort", close, { once: true });
            if (abortSignal?.aborted) close(); else tick();
          },
          cancel: () => this.stopStream?.(),
        });
      },
    };
    this.chat = new Chat<UIMessage>({
      id, messages: structuredClone(scenario.messages), transport,
      sendAutomaticallyWhen: ({ messages }) => messages.at(-1)?.parts.some((part) => isToolUIPart(part) &&
        (part.state === "approval-responded" || (getToolName(part) === "askUserQuestions" && part.state === "output-available"))) === true &&
        !messages.at(-1)?.parts.some((part) => part.type === "step-start"),
      onFinish: ({ isAbort }) => this.patch({ status: isAbort ? "interrupted" : "idle", messageCount: this.chat.messages.length }),
      onError: (error) => this.patch({ status: "error", error: error.message }),
    });
    const content = (path: string) => {
      const relative = path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
      const value = FILES[relative];
      if (value == null) throw new Error(`样例中没有文件：${path}`);
      return value;
    };
    this.client = localClient({
      token: "style-lab", remoteSession: false,
      getDraft: async () => structuredClone(this.draft),
      putDraft: async (_key, value) => { this.draft = { text: value.text, attachments: value.attachments.map((file) => ({ ...file, url: file.url ?? this.draft.attachments.find((old) => old.id === file.id)?.url ?? "" })) }; },
      listModels: async (engine) => ({ engine, source: "样例", fetchedAt: AT, defaultModel: "sample-model", models: [{ id: "sample-model", label: "样例模型", contextWindow: 400000, contextOptions: [200000, 400000], reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium", serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }, { id: "ultrafast", name: "Ultrafast", description: "The fastest available responses for latency-sensitive work." }], cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, source: { kind: "codex-subscription", name: "Codex" } }] }),
      getAccounts: async () => ({
        revision: 1,
        accounts: [{
          id: "codex", name: "Codex", loggedIn: true, plan: "pro", engines: ["Vgent", "Codex"],
          usage: {
            status: "ready", fetchedAt: AT, balance: "可用点数 120",
            windows: [
              { id: "five_hour", label: "5 小时", usedPercent: 42, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
              { id: "weekly", label: "每周", usedPercent: 86, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
            ],
          },
        }],
      }),
      listFiles: async (_id, opts) => ({ root: ROOT, entries: Object.keys(FILES).filter((path) => path.toLowerCase().includes(opts?.q?.toLowerCase() ?? "")).slice(0, opts?.limit ?? 100).map((path) => ({ path, kind: "file" as const })), truncated: false }),
      getFileContent: async (_id, path) => ({ path, content: content(path), truncated: false, binary: false }),
      getFileBlob: async (_id, path) => new Blob([content(path)], { type: path.endsWith(".svg") ? "image/svg+xml" : "text/plain" }),
      resolveFiles: async (_id, paths) => paths.filter((path) => FILES[path] != null || path.startsWith(`${ROOT}/`)).map((path) => ({ raw: path, path })),
      downloadFile: async (_id, value) => {
        const blob = new Blob(["svg" in value ? value.svg : content(value.path)], { type: "svg" in value || value.path.endsWith(".svg") ? "image/svg+xml" : "text/plain" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "path" in value ? value.path.split("/").at(-1)! : "sample.svg";
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { savedTo: anchor.download };
      },
      getPlan: async () => ({ content: this.plan, updatedAt: AT }),
      putPlan: async (_id, value) => { this.plan = value; return { content: this.plan, updatedAt: new Date().toISOString() }; },
      getSetupLog: async () => ({ status: this.thread.workspace?.setup?.status ?? "none", ...(this.thread.workspace?.setup?.exitCode != null ? { exitCode: this.thread.workspace.setup.exitCode } : {}), log: this.scenario.id === "setup-error" ? "$ pnpm install\nProgress: resolved 412, reused 398, downloaded 0, added 0\n ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/ai: Service Unavailable - 503\n" : "$ pnpm install\nProgress: resolved 412, reused 398, downloaded 0, added 0\n" }),
      listChanges: async () => ({ repoPath: ROOT, branch: "style/chat-layout", files: [...this.files], lastTurn: true }),
      getFileDiff: async (_id, path) => ({ path, status: "modified", binary: false, diff: path === "src/chat.ts" ? DIFF : `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${PLAN.split("\n").length} @@\n${PLAN.split("\n").map((line) => `+${line}`).join("\n")}\n`, truncated: false }),
      revertFile: async (_id, path) => { this.files = this.files.filter((file) => file.path !== path); return { path }; },
      getIntegration: async () => ({ mode: this.thread.workspace ? "worktree" : "project", branch: "style/chat-layout", commitsAhead: this.committed ? 1 : 0, dirty: this.files.length > 0, canCommit: this.files.length > 0, canApply: !!this.thread.workspace, canDiscardAll: this.files.length > 0, canUndoApply: false, pr: { available: false, reason: "样例不连接代码托管服务" } }),
      integrate: async (_id, action) => {
        if (action === "commit") this.committed = true;
        if (action === "discard" || action === "commit") this.files = [];
        this.notify(`样例已执行：${action}`);
        this.patch({});
        const { queue, messageCount: _count, pendingApprovals: _pending, ...record } = this.thread;
        return { ...record, messages: this.chat.messages, ...(queue ? { queue: queue.map((item) => ({ ...item, files: this.queuedFiles.get(item.id) ?? [] })) } : {}) } satisfies ThreadRecord;
      },
      restoreCheckpoint: async () => { this.patch({ restoredTo: undefined }); return { restored: "sample-latest", undo: "sample-undo", files: 2, whole: false }; },
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.thread;
  patch = (patch: { [K in keyof ThreadSummary]?: ThreadSummary[K] | undefined }) => {
    if (this.disposed) return;
    this.thread = { ...this.thread, ...patch, updatedAt: new Date().toISOString() } as ThreadSummary;
    for (const listener of this.listeners) listener();
  };
  async send(text: string, files: UIMessage["parts"] = [], id?: string) {
    if (this.disposed) return false;
    await this.chat.sendMessage({ ...(id ? { id } : {}), role: "user", parts: [textPart(text), ...files] });
    return this.chat.status !== "error";
  }
  stop = async () => {
    await this.chat.stop(); this.stopStream?.();
    this.patch({ status: "interrupted" });
  };
  replay = async () => {
    if (this.disposed || this.replaying) return;
    this.replaying = true;
    try {
      await this.stop();
      if (this.disposed) return;
      if (this.chat.messages.length === 0) await this.send("演示一次完整回复。");
      else await this.chat.regenerate();
    } finally { this.replaying = false; }
  };
  compact = async () => {
    await this.stop();
    const before = this.chat.messages.length;
    this.chat.messages = [{ ...assistant([textPart("已检查聊天组件，接下来继续调整样式。")], crypto.randomUUID()), metadata: { compacted: { before, at: new Date().toISOString() } } }];
    this.patch({ status: "idle" });
  };
  queue = (text: string, mode: "steer" | "queue" = "queue", files: FileUIPart[] = []) => {
    const id = crypto.randomUUID();
    this.queuedFiles.set(id, structuredClone(files));
    this.patch({ queue: [...(this.thread.queue ?? []), { id, text, mode: files.length ? "queue" : mode, createdAt: new Date().toISOString(), files: files.map(({ type, filename, mediaType }) => ({ type, ...(filename != null ? { filename } : {}), mediaType })) }] });
    return Promise.resolve(true);
  };
  deleteQueued = (itemId: string) => {
    this.queuedFiles.delete(itemId);
    this.patch({ queue: this.thread.queue?.filter((item) => item.id !== itemId) });
  };
  sendQueued = async (itemId: string) => {
    const item = this.thread.queue?.find((entry) => entry.id === itemId);
    if (!item) return;
    const files = this.queuedFiles.get(itemId) ?? [];
    await this.stop();
    this.deleteQueued(itemId);
    await this.send(item.text, files, item.id);
  };
  dispose = () => { this.disposed = true; void this.chat.stop(); this.stopStream?.(); this.listeners.clear(); };
}
