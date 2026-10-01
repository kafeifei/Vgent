import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolUIPart, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it } from "vitest";
import { createEngineRegistry } from "./engines/registry.js";
import { createVgentEngineFactory } from "./engines/vgent.js";
import { createQueueStore } from "./queue.js";
import { createRunManager } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore } from "./store/threads.js";

/**
 * The provider's prompt cache only pays for a request that begins with the one
 * before it: the same tools, the same instructions, and the earlier messages
 * unchanged. Every request of a task is recorded here and checked against the
 * one before it, across steps and across turns, through everything a real task
 * does — the plan, memory, a nested AGENTS.md, a 插话, an approval.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-cache-prefix-"));
  dirs.push(dir);
  return dir;
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, reasoning: 0 },
  totalTokens: 2,
};

type Step = { tool: string; input: unknown } | { text: string };
/** `lane` keeps a subagent's requests apart from its parent's: each is a conversation of its own. */
type Call = { lane: string; tools: string; prompt: unknown[] };

const SUBAGENT = /You are Vgent's (exploration|coding) subagent/;

const chunksOf = (step: Step, id: string) =>
  "text" in step
    ? [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id },
        { type: "text-delta", id, delta: step.text },
        { type: "text-end", id },
        { type: "finish", finishReason: { unified: "stop" }, usage },
      ]
    : [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: step.tool, input: JSON.stringify(step.input) },
        { type: "finish", finishReason: { unified: "tool-calls" }, usage },
      ];

/** Where `next` stops repeating `previous`; undefined when it only appends. */
export function prefixBreak(previous: Call, next: Call): string | undefined {
  if (previous.tools !== next.tools) return "tools changed";
  for (let i = 0; i < previous.prompt.length; i++) {
    const before = JSON.stringify(previous.prompt[i]);
    const after = JSON.stringify(next.prompt[i]);
    if (before !== after) {
      let at = 0;
      while (at < (before?.length ?? 0) && before![at] === after?.[at]) at++;
      const from = Math.max(0, at - 60);
      return `prompt[${i}] changed at ${at}\n    before: …${before?.slice(from, at + 160)}\n    after:  …${after?.slice(from, at + 160)}`;
    }
  }
  return undefined;
}

function scripted(provider: string) {
  const steps: Step[] = [];
  const calls: Call[] = [];
  const during: Array<(() => Promise<void>) | undefined> = [];
  let n = 0;
  const model = new MockLanguageModelV3({
    provider,
    // The compaction summarizer.
    doGenerate: async () => ({
      content: [{ type: "text", text: "Summary of the earlier work." }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async (options) => {
      const prompt = options.prompt as Array<{ role: string; content: unknown }>;
      calls.push({
        lane: SUBAGENT.test(JSON.stringify(prompt[0])) ? `child ${JSON.stringify(prompt[1])}` : "parent",
        tools: JSON.stringify(options.tools ?? []),
        prompt,
      });
      const index = n++;
      await during[index]?.();
      const step = steps[index] ?? { text: "done" };
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunksOf(step, `call-${index}`)) controller.enqueue(chunk as never);
            controller.close();
          },
        }),
      };
    },
  });
  return { model, steps, calls, during, next: () => n };
}

async function fixture(provider: string) {
  const dataDir = await temp();
  const repoPath = await temp();
  await mkdir(join(repoPath, "sub"));
  await writeFile(join(repoPath, "a.txt"), "alpha\n");
  await writeFile(join(repoPath, "sub", "b.txt"), "beta\n");
  await writeFile(join(repoPath, "sub", "AGENTS.md"), "Files under sub/ are generated.\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repoPath });
  const threads = createThreadStore(dataDir);
  const projects = createProjectStore(dataDir);
  const settings = createSettingsStore(dataDir);
  const queue = createQueueStore(threads);
  await settings.update({ runMode: "allow-all" });
  const project = await projects.create({ repoPath });
  const thread = await threads.create({ projectId: project.id, engine: "vgent" });
  const script = scripted(provider);
  const runs = createRunManager({
    threads,
    projects,
    settings,
    dataDir,
    queue,
    registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model: script.model }) }),
  });

  /** One turn: `messages` defaults to the stored history plus a new user message. */
  const turn = async (text: string | undefined, steps: Step[], messages?: UIMessage[]) => {
    script.steps.push(...steps);
    const stored = (await threads.get(thread.id))!.messages;
    const input = messages ?? [...stored, { id: `u${stored.length}`, role: "user" as const, parts: [{ type: "text" as const, text: text! }] }];
    const hub = await runs.start(thread.id, input);
    for await (const _ of hub.subscribe()) {
      /* drain */
    }
    for (let i = 0; i < 400 && runs.isRunning(thread.id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    let record = (await threads.get(thread.id))!;
    for (let i = 0; i < 400 && record.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      record = (await threads.get(thread.id))!;
    }
    return record;
  };

  const breaks = () => {
    const found: string[] = [];
    const last = new Map<string, Call>();
    for (const [i, call] of script.calls.entries()) {
      const previous = last.get(call.lane);
      last.set(call.lane, call);
      const where = previous && prefixBreak(previous, call);
      if (where != null) found.push(`request ${i + 1} (${call.lane.slice(0, 40)}): ${where}`);
    }
    return found;
  };

  return { dataDir, repoPath, threads, settings, queue, thread, runs, script, turn, breaks };
}

for (const provider of ["codex-subscription.responses", "anthropic.messages"]) {
  it(`every request of a task repeats the one before it (${provider})`, { timeout: 30_000 }, async () => {
    const f = await fixture(provider);
    try {
      await f.turn("Plan, read, remember, then answer.", [
        { tool: "updatePlan", input: { items: [{ text: "read the files", status: "in_progress" }] } },
        { tool: "read", input: { file_path: "a.txt" } },
        { tool: "read", input: { file_path: "sub/b.txt" } },
        { tool: "memory", input: { action: "write", name: "alpha", content: "a.txt holds alpha" } },
        { tool: "updatePlan", input: { items: [{ text: "read the files", status: "done" }] } },
        { text: "Read both." },
      ]);
      const seen = JSON.stringify(f.script.calls.at(-1)!.prompt);
      expect(seen.includes("Files under sub/ are generated.")).toBe(true);
      expect(seen.includes("已写入记忆 alpha.md")).toBe(true);
      await f.turn("And now?", [{ text: "Nothing else." }]);

      // A subagent: its requests are a conversation of their own, and the parent's carries on.
      await f.turn("Ask a subagent about sub/.", [
        { tool: "explore", input: { prompt: "What is in sub/b.txt?" } },
        { tool: "read", input: { file_path: "sub/b.txt" } },
        { text: "It holds beta." },
        { text: "Beta, says the subagent." },
      ]);
      expect(new Set(f.script.calls.map((call) => call.lane)).size).toBe(2);

      // 插话 while the first step of the turn runs.
      f.script.during[f.script.next()] = async () => {
        await f.queue.append(f.thread.id, "Also mention beta.", "steer");
      };
      await f.turn("Run a command.", [{ tool: "bash", input: { command: "echo hi" } }, { text: "Ran it, and beta." }]);
      await f.turn("Anything left?", [{ text: "No." }]);

      // An approval: the turn parks on it, the answer continues it.
      await f.settings.update({ runMode: "allow-reads" });
      const parked = await f.turn("Write c.txt.", [{ tool: "write", input: { path: "c.txt", content: "gamma\n" } }]);
      const last = parked.messages.at(-1)!;
      const approved = {
        ...last,
        parts: last.parts.map((part) =>
          isToolUIPart(part) && part.state === "approval-requested"
            ? { ...part, state: "approval-responded", approval: { ...part.approval, approved: true } }
            : part,
        ),
      } as UIMessage;
      await f.turn(undefined, [{ text: "Wrote it." }], [...parked.messages.slice(0, -1), approved]);
      await f.turn("Done?", [{ text: "Yes." }]);

      expect(f.breaks()).toEqual([]);
    } finally {
      await f.runs.stopAll();
    }
  });

  it(`a compaction rewrites the history once, and the next turn starts from the rewrite (${provider})`, { timeout: 30_000 }, async () => {
    const f = await fixture(provider);
    try {
      const page = Array.from({ length: 900 }, (_, line) => `line ${line} ${"x".repeat(40)}`).join("\n");
      for (const name of ["m1", "m2", "m3"]) await writeFile(join(f.repoPath, `${name}.txt`), page);
      await f.turn("Hello.", [{ text: "Hi." }]);
      // Window the task so two pages fit and a third does not.
      const first = f.script.calls[0]!;
      const overhead = Math.ceil((Buffer.byteLength(JSON.stringify(first.prompt[0])) + Buffer.byteLength(first.tools)) / 3);
      const pageTokens = Math.ceil(Buffer.byteLength(page) / 3);
      await f.threads.update(f.thread.id, { contextWindow: Math.ceil((overhead + 1024 + pageTokens * 2.5) / 0.8) });

      await f.turn("Read the three pages.", [
        { tool: "read", input: { file_path: "m1.txt" } },
        { tool: "read", input: { file_path: "m2.txt" } },
        { tool: "read", input: { file_path: "m3.txt" } },
        { text: "Read them." },
      ]);
      await f.turn("Which pages?", [{ text: "m1 to m3." }]);
      await f.turn("Thanks.", [{ text: "Welcome." }]);

      const breaks = f.breaks();
      expect(breaks).toHaveLength(1);
      expect(breaks[0]).toMatch(/^request 5 /);
    } finally {
      await f.runs.stopAll();
    }
  });
}
