import { describe, expect, it, vi } from "vitest";
import { accountModel } from "./vgent.js";

describe("accountModel", () => {
  const copilot = vi.fn((account: string) => ({ available: async () => {}, model: async (id: string) => ({ account, id }) as never }));
  const accounts = { codexHome: (id: string) => `/data/accounts/${id}`, ensure: async () => {} };

  it("runs a Copilot model on the GitHub account the spec names, the first one when it names none", async () => {
    expect(await accountModel("github-copilot:gpt-4.1", { copilot, accounts })).toEqual({ account: "github", id: "gpt-4.1" });
    expect(await accountModel("@github-0a1b2c3d:github-copilot:gpt-4.1", { copilot, accounts })).toEqual({ account: "github-0a1b2c3d", id: "gpt-4.1" });
  });

  it("binds both the machine's and added Codex models to their own quota observer", async () => {
    const bindUsage = vi.fn(async () => async () => {});
    const observed = { ...accounts, bindUsage };
    const model = await accountModel("@codex-0a1b2c3d:codex-subscription:gpt-5.5", { copilot, accounts: observed });
    expect(typeof model === "object" && model != null && "modelId" in model ? model.modelId : undefined).toBe("gpt-5.5");
    expect(bindUsage).toHaveBeenLastCalledWith("codex-0a1b2c3d");
    expect(await accountModel("codex-subscription:gpt-5.5", { copilot, accounts: observed })).toMatchObject({ modelId: "gpt-5.5" });
    expect(bindUsage).toHaveBeenLastCalledWith("codex");
    expect(await accountModel("deepseek:deepseek-v4", { copilot, accounts })).toBeUndefined();
  });
});
