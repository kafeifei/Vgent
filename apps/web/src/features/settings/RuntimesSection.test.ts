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
};

describe("runtimeSummary", () => {
  it("says what is installed and what that means right now", () => {
    expect(runtimeSummary(base)).toContain("还没安装");
    expect(runtimeSummary({ ...base, installed: "2.1.278", latest: "2.1.278" })).toBe("2.1.278 · 已是最新");
    expect(runtimeSummary({ ...base, installed: "2.1.245", latest: "2.1.278", updateAvailable: true })).toBe("2.1.245 · 最新 2.1.278");
    expect(runtimeSummary({ ...base, installed: "2.1.278", unverified: true, previous: "2.1.245" })).toContain("自动退回 2.1.245");
    expect(runtimeSummary({ ...base, installed: "2.1.245", working: true })).toBe("2.1.245 · 正在安装…");
  });

  it("explains why a newer version is not being installed on its own", () => {
    const text = runtimeSummary({ ...base, installed: "2.1.245", latest: "2.1.278", updateAvailable: true, bad: ["2.1.278"] });
    expect(text).toContain("不会自动再装");
  });
});
