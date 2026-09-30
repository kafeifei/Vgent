import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@vgent/providers";
import { describe, expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { openCodeInstructions, openCodeRoute, withoutFileChangeNotices } from "./opencode.js";

const gateway: ProviderConfig = {
  id: "xd",
  name: "XD Gateway",
  apiKey: "sk-test",
  agents: {
    vgent: { baseURL: "https://gw.example.com/v1", protocol: "openai-compatible", models: [{ id: "glm-5" }] },
    opencode: { baseURL: "https://gw.example.com/v1", protocol: "openai-compatible", models: [{ id: "glm-5", label: "GLM 5", contextWindow: 200_000 }] },
  },
};

const claudeGateway: ProviderConfig = {
  id: "j-claude",
  name: "J.Claude",
  apiKey: "sk-claude",
  agents: { opencode: { baseURL: "https://claude.example.com", protocol: "anthropic", models: [{ id: "claude-opus-5" }] } },
};

describe("openCodeRoute", () => {
  it("runs a Codex login's model as OpenCode's own openai model, on that account", () => {
    expect(openCodeRoute("codex-subscription:gpt-5.5", [])).toEqual({ model: "openai/gpt-5.5", codexAccount: "codex" });
    expect(openCodeRoute("@codex-1a2b3c4d:codex-subscription:gpt-5.5", [])).toMatchObject({ model: "openai/gpt-5.5", codexAccount: "codex-1a2b3c4d" });
  });

  it("tells OpenCode the subscription's window, which is not the API's", () => {
    expect(openCodeRoute("codex-subscription:gpt-6-astra", [], { contextWindow: 272_000 }).provider).toEqual({
      openai: { models: { "gpt-6-astra": { limit: { context: 272_000, output: 0 } } } },
    });
  });

  it("builds a namespaced provider from the provider's OpenCode endpoint", () => {
    const route = openCodeRoute("xd:glm-5", [gateway], { reasoning: true });
    expect(route.model).toBe("vgent-xd/glm-5");
    expect(route.codexAccount).toBeUndefined();
    expect(route.provider).toEqual({
      "vgent-xd": {
        npm: "@ai-sdk/openai-compatible",
        name: "XD Gateway",
        options: { baseURL: "https://gw.example.com/v1", apiKey: "sk-test", includeUsage: true },
        models: { "glm-5": { name: "GLM 5", reasoning: true, limit: { context: 200_000, output: 0 } } },
      },
    });
  });

  it("speaks to a third-party Anthropic endpoint the way the in-house engine does", () => {
    const provider = openCodeRoute("j-claude:claude-opus-5", [claudeGateway]).provider?.["vgent-j-claude"] as Record<string, unknown>;
    expect(provider.npm).toBe("@ai-sdk/anthropic");
    expect(provider.options).toEqual({ baseURL: "https://claude.example.com/v1", authToken: "sk-claude" });
    expect(provider.models).toEqual({ "claude-opus-5": { name: "claude-opus-5", limit: { context: 0, output: 16_000 } } });
  });

  it("refuses what it cannot run", () => {
    expect(() => openCodeRoute("gone:glm-5", [])).toThrow(/没有叫 "gone" 的提供商/);
    expect(() => openCodeRoute("xd:glm-5", [{ ...gateway, agents: { vgent: gateway.agents.vgent! } }])).toThrow(/没有给 OpenCode 配置接入地址/);
    expect(() => openCodeRoute("sonnet", [])).toThrow(/OpenCode 不认识这个模型/);
  });
});

describe("openCodeInstructions", () => {
  it("adds only the global AGENTS.md — OpenCode reads the repository's itself — then plan mode's rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vgent-opencode-instructions-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".agents"), { recursive: true });
    await mkdir(repo);
    expect(await openCodeInstructions(repo, false, home)).toBeUndefined();

    await writeFile(join(home, ".agents", "AGENTS.md"), "始终用中文回复。");
    await writeFile(join(repo, "AGENTS.md"), "改完发 debug。");
    const plain = await openCodeInstructions(repo, false, home);
    expect(plain).toContain("始终用中文回复。");
    expect(plain).not.toContain("改完发 debug。");

    const planning = await openCodeInstructions(repo, true, home);
    expect(planning?.startsWith(plain!)).toBe(true);
    expect(planning!.length).toBeGreaterThan(plain!.length);
  });
});

describe("withoutFileChangeNotices", () => {
  it("drops the harness's fileChange calls and keeps everything else", async () => {
    const parts = [
      { type: "tool-call", toolCallId: "call_1", toolName: "edit", input: {} },
      { type: "tool-call", toolCallId: "harness-file-change-abc", toolName: "fileChange", input: { path: "b.txt" }, dynamic: true },
      { type: "tool-result", toolCallId: "harness-file-change-abc", toolName: "fileChange", input: {}, output: {}, dynamic: true },
      { type: "text-delta", id: "t", text: "done" },
    ] as unknown as TextStreamPart<ToolSet>[];
    const stream = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const kept: TextStreamPart<ToolSet>[] = [];
    for await (const part of withoutFileChangeNotices(stream)) kept.push(part);
    expect(kept.map((part) => part.type)).toEqual(["tool-call", "text-delta"]);
  });
});
