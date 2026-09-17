import { execFileSync } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexEngine } from "./codex.js";

/**
 * Runs the real Codex runtime against the caller's own ChatGPT login, for one
 * tiny turn. Off by default: it costs a request and the first bootstrap
 * installs the bridge with pnpm, which takes minutes.
 */
const hasCodexLogin = await access(join(homedir(), ".codex", "auth.json"))
  .then(() => true)
  .catch(() => false);

const smoke = process.env.VGENT_SMOKE === "1" && hasCodexLogin ? it : it.skip;

describe("createCodexEngine (smoke)", () => {
  if (process.env.VGENT_SMOKE === "1" && !hasCodexLogin) {
    console.warn("[smoke] skipping createCodexEngine smoke test: ~/.codex/auth.json not found (no Codex login on this machine).");
  }

  smoke(
    "answers a question about the repository it was pointed at",
    async () => {
      const repoPath = await mkdtemp(join(tmpdir(), "vgent-smoke-repo-"));
      await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
      execFileSync("git", ["init", "--quiet"], { cwd: repoPath });

      const engine = await createCodexEngine({
        repoPath,
        permissionMode: "allow-all",
        dataDir: process.env.VGENT_SMOKE_DATA_DIR ?? join(tmpdir(), "vgent-smoke-codex-data"),
      });
      try {
        const result = await engine.agent.generate({
          prompt: "Read the file hello-vgent.txt in this repository and reply with only its exact contents.",
        });
        console.log(`[smoke] assistant reply: ${result.text}`);
        expect(result.text).toContain("hello from vgent");
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );
});
