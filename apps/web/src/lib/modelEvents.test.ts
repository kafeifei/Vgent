import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "./api";
import { onAccountsChanged } from "./accountEvents";
import { onModelsChanged } from "./modelEvents";

afterEach(() => vi.unstubAllGlobals());
it("refreshes catalog consumers after a saved model switch without reloading accounts", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const client = createClient("fixture");
  const models = vi.fn(), accounts = vi.fn();
  onModelsChanged(client, models); onAccountsChanged(client, accounts);
  const save = client.setSubscriptionModels("github-copilot", { agent: "vgent", models: ["test"], enabled: false });
  expect(models).not.toHaveBeenCalled();
  resolve(Response.json({ models: [] })); await save;
  expect(models).toHaveBeenCalledTimes(1);
  expect(accounts).not.toHaveBeenCalled();
});
it("does not publish failed model saves", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "failed" } }, { status: 500 })));
  const client = createClient("fixture"), changed = vi.fn();
  onModelsChanged(client, changed);
  await expect(client.setSubscriptionModels("github-copilot", { agent: "vgent", models: ["test"], enabled: false })).rejects.toThrow("failed");
  expect(changed).not.toHaveBeenCalled();
});
