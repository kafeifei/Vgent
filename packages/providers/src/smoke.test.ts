import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createCodexSubscriptionModel } from "./codex-model.js";
import { describeSubscriptionAuth } from "./codex-credentials.js";

/**
 * Live calls against the vendor endpoint. Off by default; they need a real
 * subscription login on this machine and they cost quota.
 */
const enabled = process.env.VGENT_SMOKE === "1";
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const codexLoggedIn = existsSync(join(codexHome, "auth.json"));
const codexModelId = process.env.VGENT_SMOKE_CODEX_MODEL ?? "gpt-5.5";

describe.skipIf(!enabled)("live subscription smoke", () => {
  it.skipIf(!codexLoggedIn)("reports the codex login", async () => {
    const report = await describeSubscriptionAuth();
    expect(report.codex.available).toBe(true);
    expect(report.codex.source).toBe("file");
  });

  it.skipIf(!codexLoggedIn)(
    "generates text through the ChatGPT Codex endpoint",
    async () => {
      const result = await generateText({
        model: createCodexSubscriptionModel(codexModelId),
        prompt: "Reply with the single word OK.",
      });
      expect(result.text.toUpperCase()).toContain("OK");
    },
    120_000,
  );

  it.skipIf(!codexLoggedIn)(
    "streams text through the ChatGPT Codex endpoint",
    async () => {
      const result = streamText({
        model: createCodexSubscriptionModel(codexModelId),
        prompt: "Reply with the single word OK.",
      });
      let text = "";
      for await (const delta of result.textStream) text += delta;
      expect(text.toUpperCase()).toContain("OK");
    },
    120_000,
  );
});
