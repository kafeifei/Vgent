import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@/lib/api";
import { BUILD_LABEL } from "@/lib/build";
import type { AccountSnapshot, AccountSummary, UsageWindow } from "@/lib/types";
import { AccountMenu, AccountPanel, AccountRow, Quota } from "./AccountMenu";
import { useAccounts } from "./useAccounts";

vi.mock("./useAccounts", () => ({ useAccounts: vi.fn() }));

const noop = () => {};
const resetsAt = "2026-09-29T13:30:00Z";
const core: UsageWindow = { id: "codex-primary_window", label: "5 小时", usedPercent: 20, used: 2, limit: 10, unit: "次", resetsAt };
const codex: AccountSummary = {
  id: "codex", name: "Codex", loggedIn: true, email: "codex@example.com", plan: "测试套餐", engines: ["Codex"],
  usage: { status: "ready", fetchedAt: "2026-09-29T12:00:00Z", balance: "余额 $10", windows: [
    core, { id: "codex-secondary_window", label: "每周", usedPercent: 35 },
    { id: "extra", label: "额外额度", usedPercent: 99 },
  ] },
};
const snapshot: AccountSnapshot = { revision: 1, accounts: [
  { ...codex, id: "github", name: "GitHub", usage: { ...codex.usage!, windows: [{ id: "premium_interactions", label: "Premium", usedPercent: 10 }] } },
  codex,
  { ...codex, id: "claude", name: "Claude", usage: { ...codex.usage!, windows: [{ id: "five_hour", label: "5 小时", usedPercent: 40 }, { id: "seven_day", label: "每周", usedPercent: 50 }] } },
] };
const row = (account: AccountSummary, expanded = true) => renderToStaticMarkup(<AccountRow account={account} expanded={expanded} toggle={noop} manage={noop} />);
const panel = (props: { error?: string; remote?: boolean } = {}) => renderToStaticMarkup(<AccountPanel snapshot={snapshot} refreshing={false} refresh={async () => {}} manage={noop} remote={false} {...props} />);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-29T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("account menu trigger branding", () => {
  const states: { name: string; state: ReturnType<typeof useAccounts>; connected: boolean }[] = [
    { name: "loading", state: { refreshing: true, refresh: async () => {} }, connected: true },
    { name: "signed in", state: { snapshot, refreshing: false, refresh: async () => {} }, connected: true },
    { name: "signed out", state: { snapshot: { ...snapshot, accounts: snapshot.accounts.map(a => ({ ...a, loggedIn: false })) }, refreshing: false, refresh: async () => {} }, connected: true },
    { name: "disconnected without a snapshot", state: { refreshing: false, error: "读取失败", refresh: async () => {} }, connected: false },
  ];
  it.each(states)("keeps all three brands while $name", ({ state, connected }) => {
    vi.mocked(useAccounts).mockReturnValue(state);
    const html = renderToStaticMarkup(<AccountMenu client={createClient("test-token")} connected={connected} onManage={noop} />);
    for (const id of ["github", "codex", "claude"]) {
      expect(html).toContain(`mask:url(/account-logos/${id}.svg)`);
      expect(html).toContain(`-webkit-mask:url(/account-logos/${id}.svg)`);
    }
    expect(html).toContain('aria-label="账号用量"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(connected ? BUILD_LABEL : "连接断开");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("codex@example.com");
  });
});

describe("account panel static presentation", () => {
  it("starts with three compact account rows and no detail content", () => {
    const html = panel();
    expect(html.split("<section>")).toHaveLength(4);
    expect(html.split('aria-expanded="false"')).toHaveLength(4);
    for (const name of ["GitHub", "Codex", "Claude"]) expect(html).toContain(`${name}：`);
    for (const label of ["Premium 10%", "5 小时 20% · 每周 35%", "5 小时 40% · 每周 50%"]) expect(html).toContain(label);
    for (const hidden of ['role="meter"', 'role="region"', "codex@example.com", "测试套餐", "管理账号", "额外额度", "余额 $10", " 更新"]) expect(html).not.toContain(hidden);
  });

  it("shows full details for the supplied expanded account only", () => {
    const html = row(codex);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="region" aria-label="Codex用量详情"');
    for (const text of ["5 小时", "每周", "额外额度", "余额 $10", "codex@example.com", "测试套餐", "管理账号", " 更新"]) expect(html).toContain(text);
    expect(html.split('role="meter"')).toHaveLength(4);
    expect(html).not.toContain("GitHub用量详情");
    expect(html).not.toContain("Claude用量详情");
    expect(row(codex, false)).not.toContain('role="region"');
  });

  it.each([
    { account: { ...codex, loggedIn: false }, label: "未登录" },
    { account: { ...codex, usage: { ...codex.usage!, status: "reauth" as const } }, label: "需重新登录" },
  ])("keeps $label a login entry even when expanded is requested", ({ account, label }) => {
    const html = row(account);
    expect(html).toContain(`aria-label="Codex：${label}，登录"`);
    for (const hidden of ["aria-expanded", "aria-controls", 'role="region"', 'role="meter"', "codex@example.com", "管理账号"]) expect(html).not.toContain(hidden);
  });

  it.each([
    { account: { ...codex, loggedIn: undefined }, label: "登录状态未知" },
    { account: { ...codex, usage: { ...codex.usage!, status: "unavailable" as const, message: "平台暂时离线" } }, label: "用量暂不可用" },
  ])("keeps $label expandable", ({ account, label }) => {
    expect(row(account, false)).toContain(`aria-label="Codex：${label}，查看详情"`);
    expect(row(account, false)).toContain('aria-expanded="false"');
    const html = row(account);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="region"');
    expect(html).toContain("管理账号");
    if (account.usage?.status === "unavailable") expect(html).toContain("平台暂时离线");
  });

  it("shows channel billing instead of subscription details", () => {
    const html = row({ ...codex, method: "自定义 API" });
    expect(html).toContain("自定义 API · 使用该渠道计费，不显示订阅额度");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("额外额度");
  });

  it("shows refresh errors alongside the cached snapshot", () => {
    const html = panel({ error: "刷新失败" });
    expect(html).toContain('role="status"');
    expect(html).toContain("刷新失败，仍显示上次结果");
    expect(html).toContain("5 小时 20% · 每周 35%");
    expect(panel({ error: "读取失败，仍显示上次结果" }).split("上次结果")).toHaveLength(2);
  });

  it("identifies remote host accounts only for remote panels", () => {
    expect(panel({ remote: true })).toContain("此处为远程主机的账号");
    expect(panel()).not.toContain("此处为远程主机的账号");
  });
});

describe("shared Quota presentation", () => {
  it("uses only a countdown in compact visible text, keeping the date in the tooltip", () => {
    const html = renderToStaticMarkup(<Quota window={core} compact />);
    expect(html).toContain(`<span title="${new Date(resetsAt).toLocaleString()}">1 小时 30 分钟后重置</span>`);
    expect(html).toContain('role="meter"');
    expect(html).toContain("2 / 10 次");
  });

  it("preserves the composer's default countdown, date, and missing-reset fallback", () => {
    const date = new Date(resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    expect(renderToStaticMarkup(<Quota window={core} />)).toContain(`1 小时 30 分钟后重置 · ${date}`);
    const withoutReset = { ...core, resetsAt: undefined };
    expect(renderToStaticMarkup(<Quota window={withoutReset} />)).toContain("平台未提供重置时间");
    expect(renderToStaticMarkup(<Quota window={withoutReset} compact />)).not.toContain("平台未提供重置时间");
  });

  it("renders zero usage but no misleading meter for unlimited quotas", () => {
    const zero = renderToStaticMarkup(<Quota window={{ ...core, usedPercent: 0, used: 0 }} />);
    expect(zero).toContain('aria-valuenow="0"');
    expect(zero).toContain("0%");
    expect(zero).toContain("0 / 10 次");
    const unlimited = renderToStaticMarkup(<Quota window={{ ...core, unlimited: true, usedPercent: 100 }} />);
    expect(unlimited).toContain("不限量");
    expect(unlimited).not.toContain('role="meter"');
    expect(unlimited).not.toContain("已用");
  });
});
