import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountSummary } from "./types.js";
import { createUsageCache, USAGE_FALLBACK_INTERVAL, USAGE_RATE_LIMIT_COOLDOWN } from "./usage-cache.js";
import { accountJson, parseClaudeRateLimit, parseCodexRateLimit, parseCodexRateLimitHeaders, parseClaudeUsage, retryAfter, UsageError } from "./usage.js";

let dataDir: string, now: number;
const account: AccountSummary = { id: "claude", kind: "claude", name: "Claude", loggedIn: true, email: "a@example.com", uses: [] };
const usage = (percent = 25) => ({ ...parseClaudeUsage({ five_hour: { utilization: percent, resets_at: 2_000_000_000 } }), fetchedAt: new Date(now).toISOString() });
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vgent-usage-"));
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dataDir, { recursive: true, force: true }); });

it("uses conversation observations without querying and merges sparse windows without refreshing old timestamps", async () => {
  const cache = createUsageCache(dataDir), fetcher = vi.fn(async () => usage());
  const first = usage();
  await cache.observe(account, first);
  await cache.observe(account, { ...parseClaudeUsage({ seven_day: { utilization: 80 } }), fetchedAt: new Date(now + 1000).toISOString() });
  const result = await cache.query(account, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result?.source).toBe("conversation");
  expect(result?.windows).toEqual([
    { ...first.windows[0], observedAt: first.fetchedAt },
    { id: "seven_day", label: "每周", usedPercent: 80, observedAt: new Date(now + 1000).toISOString() },
  ]);
  expect((await createUsageCache(dataDir).peek(account))?.windows).toHaveLength(2);
});

it("coalesces parallel requests and persists the minimum interval across service restart", async () => {
  const a = createUsageCache(dataDir), b = createUsageCache(dataDir), fetcher = vi.fn(async () => usage());
  await Promise.all([a.query(account, fetcher), b.query(account, fetcher), a.query(account, fetcher)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += USAGE_FALLBACK_INTERVAL - 1;
  await createUsageCache(dataDir).query(account, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 2;
  await b.query(account, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("a 429 stops the whole platform, honors Retry-After and is not cleared by passive updates or restart", async () => {
  const cache = createUsageCache(dataDir);
  const retryAt = now + 2 * USAGE_RATE_LIMIT_COOLDOWN;
  const limited = vi.fn(async () => { throw new UsageError(429, retryAt); });
  expect((await cache.query(account, limited))?.retryAt).toBe(new Date(retryAt).toISOString());
  const second = { ...account, id: "claude-12345678", email: "b@example.com" };
  await cache.observe(account, usage(30));
  const fetcher = vi.fn(async () => usage());
  const restarted = createUsageCache(dataDir);
  now += USAGE_FALLBACK_INTERVAL;
  const retained = await restarted.query(account, fetcher);
  expect(retained?.windows[0]?.usedPercent).toBe(30);
  expect(retained?.message).toContain("冷却");
  await restarted.query(second, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  now = retryAt + 1;
  const twice = await restarted.query(account, limited);
  expect(Date.parse(twice!.retryAt!)).toBe(now + 2 * USAGE_RATE_LIMIT_COOLDOWN);
  expect(limited).toHaveBeenCalledTimes(2);
});

it("never shares quota across identities and retains previous data with an error notice", async () => {
  const cache = createUsageCache(dataDir);
  await cache.query(account, async () => usage());
  expect(await cache.peek({ ...account, email: "other@example.com" })).toBeUndefined();
  now += USAGE_FALLBACK_INTERVAL + 1;
  const stale = await cache.query(account, async () => { throw new Error("offline"); });
  expect(stale?.windows[0]?.usedPercent).toBe(25);
  expect(stale?.message).toContain("上次结果");
});

it("does not make upstream requests when durable quota state is corrupt", async () => {
  await writeFile(join(dataDir, "account-usage.json"), "broken");
  const fetcher = vi.fn(async () => usage());
  await expect(createUsageCache(dataDir).query(account, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("parses the native quota formats, keeps missing fields unknown, and does not use token counts as quota", () => {
  expect(parseClaudeRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0, resetsAt: 2_000_000_000 }, seven_day: { utilization: 0.23 } } })?.windows.map(w => w.usedPercent)).toEqual([0, 23]);
  expect(parseClaudeRateLimit({ rateLimitType: "seven_day", utilization: 0.91 })?.windows[0]?.usedPercent).toBe(91);
  expect(parseClaudeRateLimit({ status: "allowed" })).toBeUndefined();
  expect(parseCodexRateLimit({ primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: null })?.windows).toEqual([{ id: "codex-primary_window", label: "5 小时", usedPercent: 42 }]);
  expect(parseCodexRateLimit({ totalTokens: 1000 })).toBeUndefined();
  expect(parseCodexRateLimitHeaders(new Headers())).toBeUndefined();
  expect(parseCodexRateLimitHeaders(new Headers({ "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "300" }))?.windows[0]?.usedPercent).toBe(0);
});

it("honors seconds and HTTP-date Retry-After without retrying a failed request", async () => {
  expect(retryAfter("120", now)).toBe(now + 120_000);
  const date = new Date(now + 3600_000).toUTCString();
  expect(retryAfter(date, now)).toBe(Date.parse(date));
  expect(retryAfter("invalid", now)).toBeUndefined();
  const fetcher = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
  await expect(accountJson("https://example.com", {}, fetcher)).rejects.toMatchObject({ status: 429, retryAt: now + 120_000 });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("treats in-band rate errors and GitHub's rate-limited 403 as cooldowns, not zero quota or expired login", async () => {
  await expect(accountJson("https://example.com", {}, async () => Response.json({ error: { type: "rate_limit_error" } }))).rejects.toMatchObject({ status: 429 });
  await expect(accountJson("https://example.com", {}, async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil((now + 3600_000) / 1000)) } }))).rejects.toMatchObject({ status: 429 });
  await expect(accountJson("https://example.com", {}, async () => new Response(null, { status: 403 }))).rejects.toMatchObject({ status: 403 });
});
