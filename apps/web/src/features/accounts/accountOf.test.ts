import { describe, expect, it } from "vitest";
import { accountOf, meteredWindows } from "./accountOf";

describe("accountOf", () => {
  it("follows the model row's source", () => {
    expect(accountOf({ source: { kind: "claude-subscription", name: "Claude" } }, "claude-code")).toBe("claude");
    expect(accountOf({ source: { kind: "codex-subscription", name: "Codex" } }, "vgent")).toBe("codex");
    expect(accountOf({ source: { kind: "provider", id: "github-copilot", name: "GitHub Copilot" } }, "vgent")).toBe("github");
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
