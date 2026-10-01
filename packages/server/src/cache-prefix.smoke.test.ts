import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodexSubscriptionModel, listedCodexModels, readCodexModelCache } from "@vgent/providers";
import type { UIMessage } from "ai";
import { afterEach, expect, it } from "vitest";
import { createEngineRegistry } from "./engines/registry.js";
import { createVgentEngineFactory } from "./engines/vgent.js";
import { createRunManager } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore } from "./store/threads.js";

/**
 * Real Codex-subscription requests through the run manager: each turn is
 * stored as UI messages and converted back for the next one, exactly as the
 * app does. Every request body is recorded and compared with the one before
 * it — a request that does not begin with the previous one throws away the
 * provider's prompt cache from the first difference on.
 */
// Unless one is named, the first model the login's own catalog lists.
const codexModel =
  process.env.VGENT_SMOKE_CODEX_MODEL ??
  listedCodexModels((await readCodexModelCache(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))))?.models ?? [])[0]?.slug;
const smoke = process.env.VGENT_SMOKE === "1" && codexModel != null ? it : it.skip;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Request = { tools: unknown; instructions: unknown; input: unknown[] };

/** Where `next` stops repeating `previous`, or undefined when it extends it. */
function divergence(previous: Request, next: Request): { field: "tools" | "instructions" | "input"; index?: number } | undefined {
  if (JSON.stringify(previous.tools) !== JSON.stringify(next.tools)) return { field: "tools" };
  if (JSON.stringify(previous.instructions) !== JSON.stringify(next.instructions)) return { field: "instructions" };
  for (let i = 0; i < previous.input.length; i++) {
    if (JSON.stringify(previous.input[i]) !== JSON.stringify(next.input[i])) return { field: "input", index: i };
  }
  return undefined;
}

const brief = (item: unknown): string => JSON.stringify(item).slice(0, 220);

smoke(
  "every request repeats the one before it, across steps and turns",
  async () => {
    const temp = async (prefix: string) => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    };
    const dataDir = await temp("vgent-cache-data-");
    const repoPath = await temp("vgent-cache-repo-");
    await writeFile(join(repoPath, "a.txt"), "alpha\n");
    await writeFile(join(repoPath, "b.txt"), "beta\n");
    execFileSync("git", ["init", "--quiet"], { cwd: repoPath });

    const requests: Request[] = [];
    const usage: Array<{ input: number; cached: number }> = [];
    const model = createCodexSubscriptionModel(codexModel as string, {
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Request;
        requests.push({ tools: body.tools, instructions: body.instructions, input: body.input });
        return globalThis.fetch(url, init);
      },
    });

    const threads = createThreadStore(dataDir);
    const projects = createProjectStore(dataDir);
    const settings = createSettingsStore(dataDir);
    await settings.update({ runMode: "allow-all" });
    const project = await projects.create({ repoPath });
    const thread = await threads.create({ projectId: project.id, engine: "vgent" });
    const runs = createRunManager({
      threads,
      projects,
      settings,
      dataDir,
      registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model }) }),
    });

    const prompts = [
      "List the files in this repository, read each of them, then create summary.md with one line per file. Reply DONE when finished.",
      "Append a line `reviewed` to summary.md, then reply DONE.",
      "Which files did you change in this task? One short line.",
    ];
    try {
      for (const [turn, text] of prompts.entries()) {
        const before = requests.length;
        const stored = (await threads.get(thread.id))!.messages;
        const next: UIMessage = { id: `u${turn}`, role: "user", parts: [{ type: "text", text }] };
        const hub = await runs.start(thread.id, [...stored, next]);
        for await (const _ of hub.subscribe()) {
          /* drain */
        }
        let record = await threads.get(thread.id);
        for (let i = 0; i < 400 && record?.status === "running"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          record = await threads.get(thread.id);
        }
        const last = record!.messages.at(-1)!;
        const metadata = last.metadata as { totalUsage?: { inputTokens?: number; cachedInputTokens?: number } } | undefined;
        usage.push({ input: metadata?.totalUsage?.inputTokens ?? 0, cached: metadata?.totalUsage?.cachedInputTokens ?? 0 });
        console.log(`[cache] turn ${turn + 1}: ${requests.length - before} requests, input ${usage.at(-1)!.input}, cached ${usage.at(-1)!.cached}`);
      }
    } finally {
      await runs.stopAll();
    }

    const breaks: string[] = [];
    for (let i = 1; i < requests.length; i++) {
      const where = divergence(requests[i - 1]!, requests[i]!);
      if (where == null) continue;
      const line =
        where.field !== "input"
          ? `request ${i + 1}: ${where.field} changed`
          : `request ${i + 1}: input[${where.index}] changed\n  before: ${brief(requests[i - 1]!.input[where.index!])}\n  after:  ${brief(requests[i]!.input[where.index!])}`;
      breaks.push(line);
    }
    const input = usage.reduce((sum, turn) => sum + turn.input, 0);
    const cached = usage.reduce((sum, turn) => sum + turn.cached, 0);
    console.log(`[cache] ${requests.length} requests, ${breaks.length} prefix breaks, ${Math.round((100 * cached) / input)}% cached\n${breaks.join("\n")}`);
    expect(breaks).toEqual([]);
  },
  15 * 60_000,
);
