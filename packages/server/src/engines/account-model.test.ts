import { describe, expect, it, vi } from "vitest";
import { accountModel } from "./vgent.js";

describe("accountModel", () => {
  const copilot = vi.fn((account: string) => ({ available: async () => {}, model: async (id: string) => ({ account, id }) as never }));
  const accounts = { codexHome: (id: string) => `/data/accounts/${id}`, ensure: async () => {} };

  it("runs a Copilot model on the GitHub account the spec names, the first one when it names none", async () => {
    expect(await accountModel("github-copilot:gpt-4.1", { copilot, accounts })).toEqual({ account: "github", id: "gpt-4.1" });
    expect(await accountModel("@github-0a1b2c3d:github-copilot:gpt-4.1", { copilot, accounts })).toEqual({ account: "github-0a1b2c3d", id: "gpt-4.1" });
  });

  it("builds another Codex account's model, and leaves the machine's own login to the registry", async () => {
    const model = await accountModel("@codex-0a1b2c3d:codex-subscription:gpt-5.5", { copilot, accounts });
    expect(typeof model === "object" && model != null && "modelId" in model ? model.modelId : undefined).toBe("gpt-5.5");
    expect(await accountModel("codex-subscription:gpt-5.5", { copilot, accounts })).toBeUndefined();
    expect(await accountModel("deepseek:deepseek-v4", { copilot, accounts })).toBeUndefined();
  });
});
