import { describe, expect, it } from "vitest";
import { reasoningFor } from "./reasoning.js";

describe("reasoningFor", () => {
  it("offers what the catalog lists for that model, cut down to what the engine can carry", () => {
    // Opus 4.5 stops at 高.
    expect(reasoningFor("claude-code", ["low", "medium", "high"])).toEqual({ reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "high" });
    // The in-house engine's portable setting has no `max`.
    expect(reasoningFor("vgent", ["none", "low", "medium", "high", "xhigh", "max"]).reasoningLevels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    // Codex has no `none`.
    expect(reasoningFor("codex", ["none", "low", "high", "max"]).reasoningLevels).toEqual(["low", "high", "max"]);
  });

  it("defaults to 高, or to the most the model offers when it has no 高", () => {
    expect(reasoningFor("vgent", ["minimal", "low"]).defaultReasoningLevel).toBe("low");
    expect(reasoningFor("claude-code", ["high", "max"]).defaultReasoningLevel).toBe("high");
  });

  it("shows no chip for a model the catalog says has no effort to set", () => {
    expect(reasoningFor("claude-code", [])).toEqual({});
    expect(reasoningFor("vgent", ["max"])).toEqual({});
  });

  it("falls back to the engine's generic set only for a model nobody knows, with a way out on the in-house engine", () => {
    expect(reasoningFor("vgent", undefined)).toEqual({ reasoningLevels: ["provider-default", "low", "medium", "high"], defaultReasoningLevel: "high" });
    expect(reasoningFor("codex", undefined).reasoningLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reasoningFor("claude-code", undefined).reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
