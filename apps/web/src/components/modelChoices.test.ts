import { describe, expect, it } from "vitest";
import type { EngineDescriptor, ModelEntry } from "@/lib/types";
import { buildModelChoices, currentChoice, formatContext, preferredRoute } from "./modelChoices";

const engine = (id: string, label: string) => ({ id, label }) as unknown as EngineDescriptor;
const ENGINES = [engine("codex", "Codex"), engine("claude-code", "Claude Code"), engine("vgent", "Vgent")];

const CODEX = { kind: "codex-subscription", name: "Codex" } as const;
const CLAUDE = { kind: "claude-subscription", name: "Claude" } as const;
const XD = { kind: "provider", id: "xd", name: "XD" } as const;

const catalogs: Record<string, ModelEntry[]> = {
  codex: [
    { id: "gpt-6", label: "GPT-6", modelKey: "codex-subscription/gpt-6", source: CODEX, vendor: "openai" },
    { id: "xd:codex/gpt-6", label: "codex/gpt-6", modelKey: "xd/codex/gpt-6", source: XD, vendor: "openai" },
    { id: "xd:qwen", label: "qwen", modelKey: "xd/qwen", source: XD, vendor: "alibaba" },
  ],
  "claude-code": [
    { id: "opus", label: "opus", modelKey: "claude-subscription/opus", source: CLAUDE, vendor: "anthropic" },
    { id: "xd:claude-opus", label: "claude-opus", modelKey: "xd/claude-opus", source: XD, vendor: "anthropic" },
  ],
  vgent: [
    { id: "codex-subscription:gpt-6", label: "GPT-6", modelKey: "codex-subscription/gpt-6", source: CODEX },
    { id: "xd:codex/gpt-6", label: "codex/gpt-6", modelKey: "xd/codex/gpt-6", source: XD },
    { id: "xd:qwen", label: "qwen", modelKey: "xd/qwen", source: XD },
    { id: "xd:claude-opus", label: "claude-opus", modelKey: "xd/claude-opus", source: XD },
    { id: "codex-subscription:gpt-old", label: "GPT-Old", modelKey: "codex-subscription/gpt-old", source: CODEX, hidden: true },
  ],
};

describe("buildModelChoices", () => {
  const choices = buildModelChoices(ENGINES, catalogs);

  it("shows a model once, with the engines that can run it underneath — the in-house one first", () => {
    const gpt = choices.find((choice) => choice.key === "codex-subscription/gpt-6");
    expect(gpt?.routes.map((route) => [route.engine, route.entry.id])).toEqual([
      ["vgent", "codex-subscription:gpt-6"],
      ["codex", "gpt-6"],
    ]);
  });

  it("keeps a source's models together, sources in the order they first appear", () => {
    expect(choices.map((choice) => choice.label)).toEqual(["GPT-6", "codex/gpt-6", "qwen", "claude-opus", "opus"]);
  });

  it("puts the sources in 提供商排序, the ones never placed after them", () => {
    const ranked = Object.fromEntries(
      Object.entries(catalogs).map(([id, models]) => [
        id,
        models.map((entry) => (entry.source?.kind === "claude-subscription" ? { ...entry, source: { ...entry.source, rank: 0 } } : entry.source?.kind === "provider" ? { ...entry, source: { ...entry.source, rank: 1 } } : entry)),
      ]),
    );
    expect(buildModelChoices(ENGINES, ranked).map((choice) => choice.label)).toEqual(["opus", "codex/gpt-6", "qwen", "claude-opus", "GPT-6"]);
  });

  it("leaves out a switched-off model, except for the task already on it", () => {
    expect(choices.some((choice) => choice.label === "GPT-Old")).toBe(false);
    const mine = buildModelChoices(ENGINES, catalogs, { engine: "vgent", model: "codex-subscription:gpt-old" });
    expect(mine.some((choice) => choice.label === "GPT-Old")).toBe(true);
  });

  it("finds the row the task is on by the engine's own id for it", () => {
    expect(currentChoice(choices, "codex", "gpt-6")?.key).toBe("codex-subscription/gpt-6");
    expect(currentChoice(choices, "vgent", "codex-subscription:gpt-6")?.key).toBe("codex-subscription/gpt-6");
    expect(currentChoice(choices, "codex", undefined)).toBeUndefined();
  });
});

describe("preferredRoute", () => {
  const [gpt, xdGpt, xdQwen, xdOpus, opus] = buildModelChoices(ENGINES, catalogs);

  it("goes by who made the model, not who serves it: GPT on Codex, Claude on Claude Code, the rest in-house", () => {
    expect(preferredRoute(gpt!, "claude-code", false)?.engine).toBe("codex");
    expect(preferredRoute(opus!, "codex", false)?.engine).toBe("claude-code");
    // The company gateway's GPT and Claude are still a GPT and a Claude.
    expect(preferredRoute(xdGpt!, "vgent", false)?.engine).toBe("codex");
    expect(preferredRoute(xdOpus!, "vgent", false)?.engine).toBe("claude-code");
    expect(preferredRoute(xdQwen!, "codex", false)?.engine).toBe("vgent");
  });

  it("remembers the engine last chosen for that model, and only for that model", () => {
    const remembered = { [gpt!.key]: "vgent", [xdQwen!.key]: "codex" } as const;
    expect(preferredRoute(gpt!, "codex", false, remembered)?.engine).toBe("vgent");
    expect(preferredRoute(xdQwen!, "vgent", false, remembered)?.engine).toBe("codex");
    expect(preferredRoute(xdGpt!, "vgent", false, remembered)?.engine).toBe("codex");
    // A remembered engine that does not offer the model falls back to the default.
    expect(preferredRoute(opus!, "codex", false, { [opus!.key]: "vgent" })?.engine).toBe("claude-code");
  });

  it("offers nothing across engines once the task has history", () => {
    expect(preferredRoute(opus!, "codex", true)).toBeUndefined();
    expect(preferredRoute(gpt!, "vgent", true, { [gpt!.key]: "codex" })?.engine).toBe("vgent");
  });
});

describe("formatContext", () => {
  it("reads like the numbers people say", () => {
    expect(formatContext(272_000)).toBe("272K");
    expect(formatContext(1_050_000)).toBe("1M");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(2_500_000)).toBe("2.5M");
  });
});
