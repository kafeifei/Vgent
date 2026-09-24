import { expect, test } from "vitest"
import { createGitHubClient, GITHUB_CLIENT_ID, GitHubAuthError } from "./github.js"

const authorization = {
  device_code: "test-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}

test("requests the GitHub scopes required by Dev Tunnels using the selected public client", async () => {
  const requests: { url: string; init: RequestInit }[] = []
  const github = createGitHubClient({
    now: () => 10_000,
    fetch: async (url, init) => {
      requests.push({ url, init })
      return Response.json(authorization)
    },
  })
  expect(await github.beginGitHubLogin()).toEqual({
    deviceCode: "test-device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    expiresAt: 910_000,
    interval: 5,
  })
  expect(requests[0]?.url).toBe("https://github.com/login/device/code")
  expect(new URLSearchParams(String(requests[0]?.init.body)).get("scope")).toBe("read:user read:org")
  expect(new URLSearchParams(String(requests[0]?.init.body)).get("client_id")).toBe(GITHUB_CLIENT_ID)
  expect(requests[0]?.init.redirect).toBe("error")
  await github.beginGitHubLogin({ clientId: "our-future-client" })
  expect(new URLSearchParams(String(requests[1]?.init.body)).get("client_id")).toBe("our-future-client")
})

test("polls after each minimum interval and incorporates the returned slow-down interval", async () => {
  let time = 0
  const polls: number[] = []
  const waits: number[] = []
  const replies = [
    { error: "authorization_pending" },
    { error: "slow_down", interval: 17 },
    { access_token: "test-access", token_type: "bearer", expires_in: 3600, refresh_token: "test-refresh" },
  ]
  const github = createGitHubClient({
    now: () => time,
    wait: async (milliseconds) => {
      waits.push(milliseconds)
      time += milliseconds
    },
    fetch: async (url, init) => {
      expect(url).toBe("https://github.com/login/oauth/access_token")
      const form = new URLSearchParams(String(init.body))
      expect(form.get("device_code")).toBe("test-code")
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
      expect(form.has("client_secret")).toBe(false)
      polls.push(time)
      return Response.json(replies.shift())
    },
  })
  expect(
    await github.waitGitHubLogin({
      deviceCode: "test-code",
      userCode: "ABCD-EFGH",
      verificationUri: authorization.verification_uri,
      expiresAt: 900_000,
      interval: 5,
    }),
  ).toEqual({ accessToken: "test-access", expiresAt: 3_627_000, refreshToken: "test-refresh" })
  expect(waits).toEqual([5_000, 5_000, 17_000])
  expect(polls).toEqual([5_000, 10_000, 27_000])
})

test("slow-down without an interval adds five seconds and expiry stops further polling", async () => {
  let time = 0
  const polls: number[] = []
  const github = createGitHubClient({
    now: () => time,
    wait: async (milliseconds) => {
      time += milliseconds
    },
    fetch: async () => {
      polls.push(time)
      return Response.json({ error: "slow_down" })
    },
  })
  await expect(
    github.waitGitHubLogin({
      deviceCode: "test-code",
      userCode: "ABCD-EFGH",
      verificationUri: authorization.verification_uri,
      expiresAt: 24_000,
      interval: 5,
    }),
  ).rejects.toMatchObject({ code: "expired" })
  expect(polls).toEqual([5_000, 15_000])
  expect(time).toBe(24_000)
})

test.each([
  ["authorization_pending", "pending"],
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["token_expired", "expired"],
] as const)("classifies %s without returning provider payloads", async (error, status) => {
  const github = createGitHubClient({
    fetch: async () => Response.json({ error, error_description: "private detail" }),
  })
  expect(await github.exchangeGitHubCode("test-code")).toEqual({ status })
})

test("cancels during the initial wait without making a token request", async () => {
  const controller = new AbortController()
  const github = createGitHubClient({
    fetch: async () => {
      throw new Error("Unexpected request")
    },
  })
  const pending = github.waitGitHubLogin(
    {
      deviceCode: "test-code",
      userCode: "ABCD-EFGH",
      verificationUri: authorization.verification_uri,
      expiresAt: Date.now() + 900_000,
      interval: 5,
    },
    { signal: controller.signal },
  )
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: "cancelled" })
})

test("an already aborted request never reaches the transport", async () => {
  const github = createGitHubClient({
    fetch: async () => {
      throw new Error("Unexpected request")
    },
  })
  await expect(github.beginGitHubLogin({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" })
})

test("refresh rotates credentials without requiring a secret or changing scope", async () => {
  const github = createGitHubClient({
    now: () => 10_000,
    fetch: async (url, init) => {
      expect(url).toBe("https://github.com/login/oauth/access_token")
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        client_id: GITHUB_CLIENT_ID,
        refresh_token: "old-refresh",
        grant_type: "refresh_token",
      })
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
        token_type: "bearer",
      })
    },
  })
  expect(await github.refreshGitHubCredential({ accessToken: "old-access", refreshToken: "old-refresh" })).toEqual({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 28_810_000,
  })
  await expect(github.refreshGitHubCredential({ accessToken: "old-access" })).rejects.toMatchObject({
    code: "reauth_required",
  })
})

test("returns only account identity and falls back from an empty display name", async () => {
  const github = createGitHubClient({
    fetch: async (url, init) => {
      expect(url).toBe("https://api.github.com/user")
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-access")
      return Response.json({
        id: 42,
        login: "octocat",
        name: null,
        email: "private@example.com",
        token: "do-not-return",
      })
    },
  })
  expect(await github.getGitHubAccount("test-access")).toEqual({ id: 42, username: "octocat", name: "octocat" })
})

test.each([
  { verification_uri: "https://evil.example/login/device" },
  { verification_uri: "https://github.com@evil.example/login/device" },
  { interval: 0 },
  { expires_in: -1 },
  { device_code: "bad\nheader" },
])("rejects malformed device authorizations", async (patch) => {
  const github = createGitHubClient({ fetch: async () => Response.json({ ...authorization, ...patch }) })
  await expect(github.beginGitHubLogin()).rejects.toMatchObject({ code: "invalid_response" })
})

test("does not include provider descriptions, response bodies, or network messages in errors", async () => {
  const rejected = createGitHubClient({
    fetch: async () => Response.json({ error: "unknown", error_description: "secret-one" }),
  })
  const broken = createGitHubClient({
    fetch: async () => {
      throw new Error("secret-two")
    },
  })
  const invalid = createGitHubClient({ fetch: async () => new Response("secret-three") })
  for (const github of [rejected, broken, invalid]) {
    const error = await github.beginGitHubLogin().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(GitHubAuthError)
    expect(String(error)).not.toContain("secret")
    expect(JSON.stringify(error)).not.toContain("secret")
  }
})
