import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCodeEngine } from "./claude-code.js";

/**
 * Runs the real Claude Code runtime against the caller's own login, for one
 * tiny turn. Off by default: it costs a request and the first bootstrap
 * installs the bridge with pnpm, which takes minutes.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;

describe("createClaudeCodeEngine (smoke)", () => {
  smoke(
    "answers a question about the repository it was pointed at",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-smoke-repo-"));
      await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
      execFileSync("git", ["init", "--quiet"], { cwd: repoPath });

      const engine = await createClaudeCodeEngine({
        repoPath,
        permissionMode: "allow-reads",
        dataDir: process.env.VGENT_SMOKE_DATA_DIR ?? join(tmpdir(), "vgent-smoke-data"),
      });
      try {
        // `allow-reads` makes the runtime request approval before any shell
        // command, so the prompt has to stay inside the read-only tools or the
        // turn pauses on an approval request instead of answering.
        const result = await engine.agent.generate({
          prompt:
            "Read the file hello-vgent.txt at the root of this repository, then reply with only that file name. Do not run any shell command.",
        });
        console.log(`[smoke] assistant reply: ${result.text}`);
        expect(result.text).toContain("hello-vgent.txt");
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );
});
