import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listedCodexModels, readCodexModelCache } from "@vgent/providers";
import { describe, expect, it } from "vitest";
import { createVgentEngine } from "./engine.js";

/**
 * Drives the real engine against the machine's ChatGPT (Codex CLI) login for
 * one tiny turn. Off by default: it costs a request and needs `~/.codex/auth.json`.
 */
// Unless one is named, the first model the login's own catalog lists.
const codexModel =
  process.env.VGENT_SMOKE_CODEX_MODEL ??
  listedCodexModels((await readCodexModelCache(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))))?.models ?? [])[0]?.slug;
const smoke = process.env.VGENT_SMOKE === "1" && codexModel != null ? it : it.skip;

describe("createVgentEngine (smoke)", () => {
  smoke(
    "reads a file in the repository it was pointed at",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-smoke-"));
      await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");

      const { agent, dispose } = createVgentEngine({
        model: `codex-subscription:${codexModel}`,
        repoPath,
        // `allow-reads` keeps the turn inside the tools that never pause for
        // approval; a shell command would stall on an approval request.
        permissionMode: "allow-reads",
      });
      try {
        const result = await agent.generate({
          prompt: "Read hello-vgent.txt and reply with only its exact contents.",
        });
        console.log(`[smoke] assistant reply: ${JSON.stringify(result.text)}`);
        expect(result.toolCalls.map((call) => call.toolName)).toContain("read");
        expect(result.text).toContain("hello from vgent");
      } finally {
        await dispose();
      }
    },
    5 * 60_000,
  );

  /**
   * The user-visible bug this guards: the ChatGPT/Codex backend returns its
   * reasoning *encrypted*, so without `reasoningSummary` every turn arrives
   * with empty `reasoning` parts and the UI has nothing to show.
   *
   * The prompt is a hard puzzle on purpose. The backend only emits a summary
   * when there was enough reasoning to be worth summarizing: measured against
   * the real endpoint, an easy question comes back with an empty part even with
   * the option correctly set, and a medium one is a coin flip. This one
   * produces double-digit reasoning parts every run.
   */
  smoke(
    "streams a non-empty reasoning part when an effort is set",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-smoke-"));

      const { agent, dispose } = createVgentEngine({
        model: `codex-subscription:${codexModel}`,
        repoPath,
        permissionMode: "allow-reads",
        reasoning: { effort: "medium" },
      });
      try {
        const result = await agent.generate({
          prompt:
            "不要调用任何工具。请仔细推导：把 1 到 9 这九个数字各用一次，填进三位数 ABC、DEF、GHI，" +
            "使得 ABC + DEF = GHI。列出所有解各自的 ABC、DEF、GHI，并说明你是怎么缩小搜索范围的。",
        });
        const reasoning = result.reasoning.map((part) => part.text).filter((text) => text.trim() !== "");
        console.log(`[smoke] reasoning parts: ${reasoning.length}, first: ${JSON.stringify(reasoning[0]?.slice(0, 120))}`);
        expect(reasoning.length).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    },
    5 * 60_000,
  );

  smoke(
    "delegates a search to the explore subagent",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-smoke-"));
      await writeFile(join(repoPath, "engine.ts"), "export function createVgentEngine() {}\n");
      await writeFile(join(repoPath, "index.ts"), 'export { createVgentEngine } from "./engine.js";\n');

      const { agent, dispose } = createVgentEngine({
        model: `codex-subscription:${codexModel}`,
        repoPath,
        permissionMode: "allow-reads",
      });
      try {
        const result = await agent.generate({
          prompt:
            "Use the `explore` subagent (do not search yourself) to find which file defines createVgentEngine, " +
            "then reply with that file name only.",
        });
        console.log(`[smoke] assistant reply: ${JSON.stringify(result.text)}`);
        expect(result.toolCalls.map((call) => call.toolName)).toContain("explore");
        expect(result.text).toContain("engine.ts");
      } finally {
        await dispose();
      }
    },
    5 * 60_000,
  );
});
