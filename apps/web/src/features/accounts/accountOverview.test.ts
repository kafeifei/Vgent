import { describe, expect, it } from "vitest";
import type { AccountSummary, UsageWindow } from "@/lib/types";
import { accountOverview, primaryWindows, quotaValue, resetText } from "./accountOverview";

const now = Date.parse("2026-09-29T12:00:00Z");
const account = (overrides: Partial<AccountSummary> = {}): AccountSummary => ({
  id: "codex", kind: "codex", name: "Codex", loggedIn: true, uses: [], ...overrides,
});
const usage = (windows: UsageWindow[], overrides: Partial<NonNullable<AccountSummary["usage"]>> = {}): NonNullable<AccountSummary["usage"]> => ({
  status: "ready", fetchedAt: new Date(now).toISOString(), windows, ...overrides,
});

describe("account overview", () => {
  it.each([
    { id: "github" as const, ids: ["premium_interactions"] },
    { id: "codex" as const, ids: ["codex-primary_window", "codex-secondary_window"] },
    { id: "claude" as const, ids: ["five_hour", "seven_day"] },
  ])("selects $id core windows by stable ID, regardless of order or unrelated usage", ({ id, ids }) => {
    const core = ids.map((id, index) => ({ id, label: `核心${index + 1}`, usedPercent: 20 + index * 15 }));
    const extra = { id: "extra", label: "额外额度", usedPercent: 100 };
    for (const windows of [[extra, ...core.toReversed()], [...core, extra]]) {
      const value = account({ id, kind: id, usage: usage(windows, { balance: "余额 $10" }) });
      expect(primaryWindows(value)).toEqual(core);
      expect(accountOverview(value, now)).toEqual({ action: "details", tone: "normal", label: core.map(w => `${w.label} ${w.usedPercent}%`).join(" · ") });
    }
  });

  it.each([
    { overrides: { loggedIn: false }, action: "login", label: "未登录", tone: "normal" },
    { overrides: { usage: usage([], { status: "reauth" }) }, action: "login", label: "需重新登录", tone: "warning" },
    { overrides: { loggedIn: undefined }, action: "details", label: "登录状态未知", tone: "normal" },
    { overrides: { method: "自定义 API", usage: usage([{ id: "codex-primary_window", label: "订阅", usedPercent: 100 }]) }, action: "details", label: "自定义 API", tone: "normal" },
    { overrides: { usage: usage([], { status: "unavailable" }) }, action: "details", label: "用量暂不可用", tone: "normal" },
    { overrides: {}, action: "details", label: "用量暂不可用", tone: "normal" },
    { overrides: { usage: usage([]) }, action: "details", label: "用量暂不可用", tone: "normal" },
  ])("reports $label without fabricating subscription usage", ({ overrides, ...expected }) => {
    expect(accountOverview(account(overrides), now)).toEqual(expected);
  });

  it.each([79.9, 80, 89.9, 90, 99.9])("uses the warning/danger boundaries for %s percent", usedPercent => {
    expect(accountOverview(account({ usage: usage([{ id: "codex-primary_window", label: "5 小时", usedPercent }]) }), now)).toEqual({
      action: "details", label: `5 小时 ${usedPercent}%`, tone: usedPercent >= 90 ? "danger" : usedPercent >= 80 ? "warning" : "normal",
    });
  });

  it("names the exhausted core quota and its reset instead of merging quotas", () => {
    expect(accountOverview(account({ usage: usage([
      { id: "codex-secondary_window", label: "每周", usedPercent: 25 },
      { id: "codex-primary_window", label: "5 小时", usedPercent: 100, resetsAt: "2026-09-29T13:30:00Z" },
    ]) }), now)).toEqual({ action: "details", label: "5 小时已用尽 · 1 小时 30 分钟后重置", tone: "danger" });
  });

  it.each([
    { short: "2026-09-29T12:30:00Z", week: "2026-10-02T12:00:00Z", reset: "最晚3 天 0 小时后重置" },
    { short: "2026-10-02T12:00:00Z", week: "2026-09-29T12:30:00Z", reset: "最晚3 天 0 小时后重置" },
    { short: "2026-09-29T12:30:00Z", week: undefined, reset: "重置时间未知" },
    { short: "invalid", week: "2026-10-02T12:00:00Z", reset: "重置时间未知" },
    { short: "2026-09-29T11:00:00Z", week: "2026-09-29T12:00:00Z", reset: "等待平台更新" },
  ])("names both exhausted quotas without implying recovery before the later reset: $reset", ({ short, week, reset }) => {
    expect(accountOverview(account({ usage: usage([
      { id: "codex-primary_window", label: "5 小时", usedPercent: 100, resetsAt: short },
      { id: "codex-secondary_window", label: "每周", usedPercent: 100, resetsAt: week },
    ]) }), now)).toEqual({ action: "details", label: `5 小时 / 每周已用尽 · ${reset}`, tone: "danger" });
  });

  it("does not warn about unlimited windows, even with a reported 100 percent", () => {
    expect(accountOverview(account({ usage: usage([{ id: "codex-primary_window", label: "5 小时", unlimited: true, usedPercent: 100 }]) }), now)).toEqual({ action: "details", label: "5 小时 不限量", tone: "normal" });
  });

  it.each([
    usage([{ id: "extra", label: "额外额度", usedPercent: 100 }]),
    usage([], { balance: "余额 $10" }),
  ])("offers details when only extra quota or balance is available", value => {
    expect(accountOverview(account({ usage: value }), now)).toEqual({ action: "details", label: "查看用量", tone: "normal" });
  });

  it("keeps zero usage distinct from missing data", () => {
    const window = { id: "codex-primary_window", label: "5 小时", usedPercent: 0 };
    expect(accountOverview(account({ usage: usage([window]) }), now).label).toBe("5 小时 0%");
    expect(quotaValue({ ...window, usedPercent: undefined, used: 0, limit: 0, unit: "次" })).toBe("0 / 0 次");
    expect(quotaValue({ id: "empty", label: "未知" })).toBe("暂无数据");
  });
});

describe("resetText", () => {
  it.each([
    ["invalid", "重置时间未知"],
    ["2026-09-29T11:59:59Z", "等待平台更新"],
    ["2026-09-29T12:00:00Z", "等待平台更新"],
    ["2026-09-29T12:00:01Z", "1 分钟后重置"],
    ["2026-09-29T12:59:00Z", "59 分钟后重置"],
    ["2026-09-29T13:00:00Z", "1 小时 0 分钟后重置"],
    ["2026-09-29T13:30:00Z", "1 小时 30 分钟后重置"],
    ["2026-09-30T12:00:00Z", "1 天 0 小时后重置"],
    ["2026-10-01T15:30:00Z", "2 天 3 小时后重置"],
  ])("formats %s", (at, expected) => expect(resetText(at, now)).toBe(expected));
});
