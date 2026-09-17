import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVgentEngine } from "./engine.js";

/**
 * Drives the real engine against the machine's ChatGPT (Codex CLI) login for
 * one tiny turn. Off by default: it costs a request and needs `~/.codex/auth.json`.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;

describe("createVgentEngine (smoke)", () => {
  smoke(
    "reads a file in the repository it was pointed at",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-smoke-"));
      await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");

      const { agent, dispose } = createVgentEngine({
        model: "codex-subscription:gpt-5.5",
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

  smoke(
    "delegates a search to the explore subagent",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-smoke-"));
      await writeFile(join(repoPath, "engine.ts"), "export function createVgentEngine() {}\n");
      await writeFile(join(repoPath, "index.ts"), 'export { createVgentEngine } from "./engine.js";\n');

      const { agent, dispose } = createVgentEngine({
        model: "codex-subscription:gpt-5.5",
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
