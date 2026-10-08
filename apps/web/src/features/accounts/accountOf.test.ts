import { describe, expect, it } from "vitest";
import { accountOf, accountOfModel, bareSpec, isAccountFailure, meteredWindows } from "./accountOf";

describe("accountOf", () => {
  it("follows the model row's source", () => {
    expect(accountOf({ source: { kind: "claude-subscription", name: "Claude" } }, "claude-code")).toBe("claude");
    expect(accountOf({ source: { kind: "codex-subscription", name: "Codex" } }, "vgent")).toBe("codex");
    expect(accountOf({ source: { kind: "provider", id: "github-copilot", name: "GitHub Copilot" } }, "vgent")).toBe("github");
  });

  it("follows the account the source names, when there are several", () => {
    expect(accountOf({ source: { kind: "claude-subscription", name: "Claude · b@example.com", account: "claude-0a1b2c3d" } }, "claude-code")).toBe("claude-0a1b2c3d");
    expect(accountOf({ source: { kind: "provider", id: "github-copilot", name: "GitHub Copilot · @cat", account: "github-0a1b2c3d" } }, "vgent")).toBe("github-0a1b2c3d");
  });

  it("has no account for a provider's key or a gateway, whatever the engine", () => {
    expect(accountOf({ source: { kind: "provider", id: "jojo", name: "jojo" } }, "codex")).toBeUndefined();
    expect(accountOf({ source: { kind: "gateway", name: "AI Gateway" } }, "vgent")).toBeUndefined();
  });

  it("falls back to the engine's own login when no row names the model", () => {
    expect(accountOf(undefined, "claude-code")).toBe("claude");
    expect(accountOf({}, "codex")).toBe("codex");
    expect(accountOf(undefined, "vgent")).toBeUndefined();
  });
});

describe("accountOfModel", () => {
  it("reads the account off the spec, or the platform's first one", () => {
    expect(accountOfModel("claude-code", "@claude-0a1b2c3d:sonnet")).toBe("claude-0a1b2c3d");
    expect(accountOfModel("claude-code", "sonnet")).toBe("claude");
    expect(accountOfModel("claude-code", "deepseek:deepseek-v4")).toBeUndefined();
    expect(accountOfModel("codex", undefined)).toBe("codex");
    expect(accountOfModel("vgent", "github-copilot:gpt-4.1")).toBe("github");
    expect(accountOfModel("claude-code", "github-copilot:claude-sonnet-5.5")).toBe("github");
    expect(accountOfModel("codex", "github-copilot:gpt-6-luna")).toBe("github");
    expect(accountOfModel("vgent", "@codex-0a1b2c3d:codex-subscription:gpt-5.5")).toBe("codex-0a1b2c3d");
    expect(accountOfModel("vgent", "openai/gpt-5")).toBeUndefined();
    expect(bareSpec("@codex-0a1b2c3d:codex-subscription:gpt-5.5")).toBe("codex-subscription:gpt-5.5");
  });

  it("recognises a task that stopped for want of its login", () => {
    expect(isAccountFailure("Codex 未登录：在「账号」里添加一个 Codex 账号")).toBe(true);
    expect(isAccountFailure("Not logged in · Please run /login")).toBe(true);
    expect(isAccountFailure("OAuth token has expired")).toBe(true);
    expect(isAccountFailure("rate limited")).toBe(false);
  });
});

describe("meteredWindows", () => {
  it("drops what cannot run out and puts the fullest first", () => {
    const windows = meteredWindows([
      { id: "five_hour", label: "5 小时", usedPercent: 12 },
      { id: "chat", label: "聊天", unlimited: true },
      { id: "seven_day", label: "每周", usedPercent: 64 },
      { id: "unknown", label: "未知" },
    ]);
    expect(windows.map((window) => window.id)).toEqual(["seven_day", "five_hour"]);
  });
});
