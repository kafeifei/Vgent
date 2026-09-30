import type { HarnessV1Bootstrap } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createOpenCode } from "@ai-sdk/harness-opencode";

/**
 * The recipe the adapter applies before its first session in a sandbox
 * directory: its bridge script and the pinned CLI and SDK it installs. Read
 * from the adapter itself, so it is always the one this build would apply.
 */
export async function harnessBootstrapRecipe(engine: "claude-code" | "codex" | "opencode"): Promise<HarnessV1Bootstrap | undefined> {
  const harness = engine === "claude-code" ? createClaudeCode() : engine === "codex" ? createCodex() : createOpenCode();
  return harness.getBootstrap?.();
}
