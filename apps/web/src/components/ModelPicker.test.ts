import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "@/lib/types";
import { effectiveModel, modelChipLabel, modelLabel, optionNodes, resolveModel, serviceTierLabel } from "./ModelPicker";
import type { EngineRoute, ModelChoice } from "./modelChoices";

describe("speed choices", () => {
  const tiers = [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }, { id: "ultrafast", name: "Ultrafast" }];
  const route: EngineRoute = { engine: "codex", label: "Codex", entry: { id: "model", label: "Model", serviceTiers: tiers } };
  const choice: ModelChoice = { key: "model", label: "Model", source: { kind: "codex-subscription", name: "Codex" }, routes: [route] };
  it("selects and clears any advertised tier, including tiers after the first", () => {
    const onOptions = vi.fn();
    const nodes = optionNodes({ choice, route, options: { reasoningEffort: undefined, serviceTier: "ultrafast", contextWindow: undefined }, engineLocked: true, onOptions, onEngine: vi.fn() });
    const speed = nodes.find((node) => node.key === "speed")!;
    expect(speed.hint).toBe("超快");
    expect(speed.children?.map((node) => [node.label, node.selected])).toEqual([["标准", false], ["快速", false], ["超快", true]]);
    expect(speed.children?.[1]?.description).toBe("1.5 倍速度，用量更多");
    speed.children?.[1]?.onPick?.();
    expect(onOptions).toHaveBeenLastCalledWith({ serviceTier: "priority" });
    speed.children?.[2]?.onPick?.();
    expect(onOptions).toHaveBeenLastCalledWith({ serviceTier: "ultrafast" });
    speed.children?.[0]?.onPick?.();
    expect(onOptions).toHaveBeenLastCalledWith({ serviceTier: null });
    expect(serviceTierLabel({ id: "future", name: "Future" })).toBe("Future");
  });
  it("does not invent speeds for a model without them", () => {
    const nodes = optionNodes({ choice, route: { ...route, entry: { id: "other", label: "Other" } }, options: { reasoningEffort: undefined, serviceTier: undefined, contextWindow: undefined }, engineLocked: true, onOptions: vi.fn(), onEngine: vi.fn() });
    expect(nodes.some((node) => node.key === "speed")).toBe(false);
  });
});

const catalog = (defaultModel?: string): ModelCatalog => ({
  engine: "vgent",
  models: [],
  source: "builtin",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  ...(defaultModel != null ? { defaultModel } : {}),
});

describe("effectiveModel", () => {
  it("keeps the task's own model", () => {
    expect(effectiveModel("codex-subscription:gpt-6-astra", catalog("codex-subscription:gpt-5.5"))).toBe(
      "codex-subscription:gpt-6-astra",
    );
  });

  it("resolves「默认」to the catalog's default", () => {
    expect(effectiveModel(undefined, catalog("codex-subscription:gpt-5.5"))).toBe("codex-subscription:gpt-5.5");
  });

  it("stays unknown while the catalog is loading or empty", () => {
    expect(effectiveModel(undefined, null)).toBeUndefined();
    expect(effectiveModel(undefined, catalog())).toBeUndefined();
    expect(modelLabel(effectiveModel(undefined, catalog()))).toBe("默认");
  });

  it("selects the first listed model when the catalog names no default", () => {
    const listed = catalog();
    listed.models = [
      { id: "sonnet", label: "Claude Sonnet" },
      { id: "opus", label: "Claude Opus" },
    ];
    expect(resolveModel(undefined, listed)).toBe("sonnet");
    expect(resolveModel("opus", listed)).toBe("opus");
  });

  it("moves a task off a model its source no longer lists, as the server does", () => {
    const listed = catalog("codex-subscription:gpt-6.1-sol");
    listed.models = [
      { id: "codex-subscription:gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "github-copilot:gpt-5.5", label: "GPT-5.5" },
    ];
    expect(resolveModel("codex-subscription:gpt-5.5", listed)).toBe("codex-subscription:gpt-6.1-sol");
    // A source that lists nothing says nothing: the task keeps its model.
    expect(resolveModel("@codex-0a1b2c3d:codex-subscription:gpt-5.5", listed)).toBe("@codex-0a1b2c3d:codex-subscription:gpt-5.5");
    // Nor does a list that came back incomplete.
    expect(resolveModel("codex-subscription:gpt-5.5", { ...listed, warning: "Codex 在线目录不可用，已改用本地缓存" })).toBe("codex-subscription:gpt-5.5");
  });
});

describe("modelChipLabel", () => {
  it("joins the model, how hard it thinks, and Fast", () => {
    expect(modelChipLabel("GPT-5.5", "高", "Fast")).toBe("GPT-5.5 高 Fast");
    expect(modelChipLabel("GPT-5.5", "极高", undefined)).toBe("GPT-5.5 极高");
    expect(modelChipLabel("GPT-5.5", undefined, undefined)).toBe("GPT-5.5");
  });
});
