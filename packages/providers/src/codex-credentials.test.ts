import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexSubscriptionAuthError,
  CodexTokenProvider,
  getCodexTokenProvider,
  describeSubscriptionAuth,
  parseCodexAuthJson,
  toCodexCredential,
} from "./codex-credentials.js";

/** Minimal unsigned JWT: only the `exp` claim is ever read. */
function fakeJwt(expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}

async function codexHomeWith(auth: unknown, extra?: { configToml?: string }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vgent-codex-"));
  await writeFile(join(home, "auth.json"), JSON.stringify(auth, null, 2));
  if (extra?.configToml != null) await writeFile(join(home, "config.toml"), extra.configToml);
  return home;
}

function authFixture(expiresAtMs: number) {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      id_token: "id-token",
      access_token: fakeJwt(expiresAtMs),
      refresh_token: "refresh-token-1",
      account_id: "acct-123",
    },
    last_refresh: "2026-09-07T09:21:02.446478Z",
  };
}

const hour = 60 * 60 * 1000;

describe("auth.json parsing", () => {
  it("reads the chatgpt credential, taking expiry from the access token JWT", async () => {
    const expiresAt = Date.now() + 5 * hour;
    const value = await parseCodexAuthJson(JSON.stringify(authFixture(expiresAt)));
    expect(value).toBeDefined();
    const credential = await toCodexCredential(value!);
    expect(credential?.accountId).toBe("acct-123");
    expect(credential?.refreshToken).toBe("refresh-token-1");
    expect(credential?.expiresAt).toBe(Math.floor(expiresAt / 1000) * 1000);
  });

  it("rejects an api-key login", async () => {
    expect(await toCodexCredential({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" })).toBeUndefined();
  });

  it("rejects malformed json", async () => {
    expect(await parseCodexAuthJson("{ not json")).toBeUndefined();
  });
});

describe("describeSubscriptionAuth", () => {
  it("reports the file source and expiry without exposing the token", async () => {
    const expiresAt = Date.now() + 5 * hour;
    const home = await codexHomeWith(authFixture(expiresAt));
    const report = await describeSubscriptionAuth({ env: { CODEX_HOME: home } });
    expect(report.codex).toEqual({
      available: true,
      source: "file",
      expiresAt: Math.floor(expiresAt / 1000) * 1000,
    });
    expect(JSON.stringify(report)).not.toContain("refresh-token-1");
  });

  it("names the account and the plan from the id token, and nothing else out of it", async () => {
    const claims = { email: "dev@example.com", sub: "user-1", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_user_id: "u-9" } };
    const idToken = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const fixture = authFixture(Date.now() + 5 * hour);
    const home = await codexHomeWith({ ...fixture, tokens: { ...fixture.tokens, id_token: idToken } });
    const report = await describeSubscriptionAuth({ env: { CODEX_HOME: home } });
    expect(report.codex).toMatchObject({ available: true, email: "dev@example.com", plan: "pro" });
    expect(JSON.stringify(report)).not.toContain("u-9");
    expect(JSON.stringify(report)).not.toContain(idToken);
  });

  it("reports unavailable when there is no login", async () => {
    const home = await mkdtemp(join(tmpdir(), "vgent-codex-empty-"));
    const report = await describeSubscriptionAuth({ env: { CODEX_HOME: home } });
    expect(report.codex).toEqual({ available: false, source: null });
  });

  it("honours cli_auth_credentials_store = \"keyring\"", async () => {
    const expiresAt = Date.now() + 5 * hour;
    const home = await codexHomeWith(authFixture(expiresAt), {
      configToml: 'cli_auth_credentials_store = "keyring"\nmodel = "gpt-5.5"\n',
    });
    const keyringValue = JSON.stringify({
      ...authFixture(expiresAt),
      tokens: { ...authFixture(expiresAt).tokens, account_id: "acct-from-keychain" },
    });
    const report = await describeSubscriptionAuth({
      env: { CODEX_HOME: home },
      keyring: { read: async () => keyringValue, write: async () => undefined },
    });
    expect(report.codex.source).toBe("keychain");
  });

  it("ignores a cli_auth_credentials_store key that sits inside a table", async () => {
    const expiresAt = Date.now() + 5 * hour;
    const home = await codexHomeWith(authFixture(expiresAt), {
      configToml: '[profiles.x]\ncli_auth_credentials_store = "keyring"\n',
    });
    const report = await describeSubscriptionAuth({
      env: { CODEX_HOME: home },
      keyring: { read: async () => "{}", write: async () => undefined },
    });
    expect(report.codex.source).toBe("file");
  });
});

describe("CodexTokenProvider", () => {
  it("uses a supplied access token and never reads the local store", async () => {
    const provider = new CodexTokenProvider({
      accessToken: fakeJwt(Date.now() + hour),
      accountId: "acct-supplied",
      env: { CODEX_HOME: "/nonexistent" },
    });
    const token = await provider.getAccessToken();
    expect(token.source).toBe("env");
    expect(token.accountId).toBe("acct-supplied");
  });

  it("throws a typed error when nothing is logged in", async () => {
    const home = await mkdtemp(join(tmpdir(), "vgent-codex-none-"));
    const provider = new CodexTokenProvider({ env: { CODEX_HOME: home } });
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(CodexSubscriptionAuthError);
  });

  it("rereads the original store so an external logout takes effect immediately", async () => {
    const home = await codexHomeWith(authFixture(Date.now() + 5 * hour));
    const provider = new CodexTokenProvider({
      env: { CODEX_HOME: home },
      fetch: async () => {
        throw new Error("must not refresh");
      },
    });
    await provider.getAccessToken();
    await writeFile(join(home, "auth.json"), "{}");
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(CodexSubscriptionAuthError);
  });

  it("refreshes an expiring token once for concurrent callers and writes it back", async () => {
    const home = await codexHomeWith(authFixture(Date.now() + 60 * 1000));
    const refreshedAccessToken = fakeJwt(Date.now() + 8 * hour);
    let refreshCalls = 0;
    const provider = new CodexTokenProvider({
      env: { CODEX_HOME: home },
      fetch: async (_input, init) => {
        refreshCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(body.refresh_token).toBe("refresh-token-1");
        return new Response(
          JSON.stringify({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-token-2",
            expires_in: 8 * 60 * 60,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const [a, b, c] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(refreshCalls).toBe(1);
    expect(a.accessToken).toBe(refreshedAccessToken);
    expect(b.accessToken).toBe(refreshedAccessToken);
    expect(c.accessToken).toBe(refreshedAccessToken);
    expect(a.source).toBe("file");

    const written = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as {
      tokens: Record<string, unknown>;
      last_refresh: string;
    };
    expect(written.tokens.access_token).toBe(refreshedAccessToken);
    expect(written.tokens.refresh_token).toBe("refresh-token-2");
    expect(written.tokens.account_id).toBe("acct-123");
    expect(Date.parse(written.last_refresh)).toBeGreaterThan(0);

    // Cached afterwards: no second exchange.
    await provider.getAccessToken();
    expect(refreshCalls).toBe(1);
  });

  it("forces a refresh when asked, even on a fresh token", async () => {
    const home = await codexHomeWith(authFixture(Date.now() + 5 * hour));
    let refreshCalls = 0;
    const provider = new CodexTokenProvider({
      env: { CODEX_HOME: home },
      fetch: async () => {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({ access_token: fakeJwt(Date.now() + 8 * hour), expires_in: 8 * 60 * 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.getAccessToken();
    expect(refreshCalls).toBe(0);
    await provider.getAccessToken({ forceRefresh: true });
    expect(refreshCalls).toBe(1);
  });

  it("writes a refreshed credential back to the keychain when that is the store", async () => {
    const home = await codexHomeWith({ auth_mode: "apikey" }, {
      configToml: 'cli_auth_credentials_store = "keyring"\n',
    });
    const writes: string[] = [];
    const provider = new CodexTokenProvider({
      env: { CODEX_HOME: home },
      keyring: {
        read: async () => JSON.stringify(authFixture(Date.now() + 60 * 1000)),
        write: async ({ value }) => {
          writes.push(value);
        },
      },
      fetch: async () =>
        new Response(
          JSON.stringify({ access_token: fakeJwt(Date.now() + 8 * hour), expires_in: 8 * 60 * 60 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const token = await provider.getAccessToken();
    expect(token.source).toBe("keychain");
    expect(writes).toHaveLength(1);
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain("apikey");
  });
});


describe("shared Codex account lifecycle", () => {
  it("returns the same owner for every consumer of a home and separates homes", () => {
    const env = { CODEX_HOME: "/tmp/vgent-owner-a" };
    expect(getCodexTokenProvider({ env })).toBe(getCodexTokenProvider({ env: { ...env } }));
    expect(getCodexTokenProvider({ env })).not.toBe(getCodexTokenProvider({ env: { CODEX_HOME: "/tmp/vgent-owner-b" } }));
  });
  it("does not overwrite a switched account with a late OAuth response", async () => {
    const home = await codexHomeWith(authFixture(Date.now()));
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const provider = new CodexTokenProvider({ env: { CODEX_HOME: home }, fetch: async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ access_token: fakeJwt(Date.now() + hour), refresh_token: "late", expires_in: 3600 });
    } });
    const pending = provider.getAccessToken();
    const rejected = expect(pending).rejects.toThrow("account changed");
    await ready;
    const next = authFixture(Date.now() + 2 * hour);
    next.tokens.account_id = "different-account";
    await writeFile(join(home, "auth.json"), JSON.stringify(next));
    finish(); await rejected;
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.account_id).toBe("different-account");
    expect((await provider.getAccessToken()).accountId).toBe("different-account");
  });
  it("blocks requests during logout and drains a pending refresh before clearing", async () => {
    const home = await codexHomeWith(authFixture(Date.now()));
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const provider = new CodexTokenProvider({ env: { CODEX_HOME: home }, fetch: async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ access_token: fakeJwt(Date.now() + hour), expires_in: 3600 });
    } });
    const pending = provider.getAccessToken();
    const rejected = expect(pending).rejects.toThrow("account changed");
    await ready;
    const logout = provider.changeAccount(() => writeFile(join(home, "auth.json"), "{}"));
    await expect(provider.getAccessToken()).rejects.toThrow("changing");
    finish(); await rejected; await logout;
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe("{}");
  });
});
