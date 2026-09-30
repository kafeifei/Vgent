import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@/lib/api";
import { ToastProvider } from "@/lib/toast";
import type { AccountSummary } from "@/lib/types";
import { useAccounts } from "@/features/accounts/useAccounts";
import { AccountsPage } from "./AccountsPage";

vi.mock("@/features/accounts/useAccounts", () => ({ useAccounts: vi.fn() }));

const accounts: AccountSummary[] = [
  { id: "claude", kind: "claude", name: "Claude", loggedIn: true, email: "a@example.com", plan: "max", machine: true, uses: [{ id: "models", enabled: true }] },
  { id: "claude-0a1b2c3d", kind: "claude", name: "Claude", loggedIn: false, email: "b@example.com", uses: [{ id: "models", enabled: false }] },
  { id: "github", kind: "github", name: "GitHub", loggedIn: true, username: "octo", uses: [{ id: "models", enabled: true }, { id: "remote", enabled: false }] },
];
const render = (focus?: string) => {
  vi.mocked(useAccounts).mockReturnValue({ snapshot: { accounts, revision: 1 }, refreshing: false, refresh: async () => {} });
  return renderToStaticMarkup(<ToastProvider><AccountsPage client={createClient("test-token")} focus={focus} onFocus={() => {}} /></ToastProvider>);
};

describe("账号", () => {
  it("lists every account, two of one platform told apart by who is signed in", () => {
    const html = render();
    expect(html).toContain('aria-label="Claude · a@example.com"');
    expect(html).toContain('aria-label="Claude · b@example.com"');
    expect(html).toContain('aria-label="GitHub · @octo"');
    expect(html).toContain("需要重新登录");
    expect(html).toContain("添加");
  });

  it("opens one account on what it is switched on for, and signing out", () => {
    const html = render("github");
    // Models, not engines: which engine runs a model is the model's business.
    expect(html).toContain('aria-label="模型"');
    expect(html).not.toContain("引擎");
    expect(html).toContain('aria-label="远程访问"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("退出登录");
    expect(html).not.toContain("b@example.com");
  });

  it("offers signing in again to an account that needs it", () => {
    const html = render("claude-0a1b2c3d");
    expect(html).toContain("重新登录");
  });
});
