import { describe, expect, it } from "vitest";
import type { HarnessRuntimeStatus } from "@/lib/types";
import { runtimeSummary } from "./RuntimesSection";

const base: HarnessRuntimeStatus = {
  engine: "claude-code",
  label: "Claude Code",
  package: "@anthropic-ai/claude-code",
  updateAvailable: false,
  unverified: false,
  bad: [],
  busy: false,
  working: false,
  broken: false,
};

describe("runtimeSummary", () => {
  it("says what is installed and what that means right now", () => {
    expect(runtimeSummary(base)).toContain("还没安装");
    expect(runtimeSummary({ ...base, installed: "2.1.278", latest: "2.1.278" })).toBe("2.1.278 · 已是最新");
    expect(runtimeSummary({ ...base, installed: "2.1.245", latest: "2.1.278", updateAvailable: true })).toBe("2.1.245 · 最新 2.1.278");
    expect(runtimeSummary({ ...base, installed: "2.1.245", working: true })).toBe("2.1.245 · 正在准备新版");
    expect(runtimeSummary({ ...base, working: true })).toContain("正在安装");
    expect(runtimeSummary({ ...base, broken: true })).toContain("安装不完整");
  });

  it("explains why a newer version is not being installed on its own", () => {
    const text = runtimeSummary({ ...base, installed: "2.1.245", latest: "2.1.278", updateAvailable: true, bad: ["2.1.278"] });
    expect(text).toContain("不会自动再装");
  });

  it("shows updates normally while the previous runtime remains available as a fallback", () => {
    const runtime = { ...base, installed: "0.159.2", latest: "0.159.3", unverified: true, previous: "0.159.0", updateAvailable: true };
    expect(runtimeSummary(runtime)).toBe("0.159.2 · 最新 0.159.3");
    expect(runtimeSummary({ ...runtime, installed: "0.159.3", updateAvailable: false })).toBe("0.159.3 · 已是最新");
  });
});
