import { describe, expect, it } from "vitest";
import { logoutSubscription } from "./subscription-logout.js";

describe("subscription logout", () => {
  it("uses the vendor's exact logout command and preserves the login home", async () => {
    const calls: { command: string; args: string[]; codexHome?: string }[] = [];
    const options = {
      env: { CODEX_HOME: "/tmp/vgent-test-codex-home", PATH: "/usr/bin" },
      command: async (id: string) => id === "claude-subscription" ? "/test/claude" : "/test/codex",
      run: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
        calls.push({ command, args, ...(env.CODEX_HOME != null ? { codexHome: env.CODEX_HOME } : {}) });
      },
    };
    await logoutSubscription("claude-subscription", options);
    await logoutSubscription("codex-subscription", options);
    expect(calls).toEqual([
      { command: "/test/claude", args: ["auth", "logout"], codexHome: "/tmp/vgent-test-codex-home" },
      { command: "/test/codex", args: ["logout"], codexHome: "/tmp/vgent-test-codex-home" },
    ]);
  });

  it("does not claim success if the CLI fails", async () => {
    await expect(logoutSubscription("codex-subscription", {
      command: async () => "/test/codex",
      run: async () => { throw new Error("logout failed"); },
    })).rejects.toThrow("logout failed");
  });
});
