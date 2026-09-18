import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "@/lib/types";
import { effectiveModel, modelLabel } from "./ModelPicker";

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

  it("stays unknown while the catalog is loading or names no default", () => {
    expect(effectiveModel(undefined, null)).toBeUndefined();
    expect(effectiveModel(undefined, catalog())).toBeUndefined();
    expect(modelLabel(effectiveModel(undefined, catalog()))).toBe("默认");
  });
});
