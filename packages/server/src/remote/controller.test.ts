import { describe, expect, test } from "vitest"
import { GitHubAuthError } from "./github.js"
import { createRemoteController, type RemoteGitHub } from "./controller.js"

type Deps = Parameters<typeof createRemoteController>[0]
type Identity = { id: number; name: string; username: string }

/** GitHub accounts as remote access sees them: an identity and a token per account id, and a revision that moves on sign-out. */
function githubFixture(accounts: Record<string, Identity> = { github: { id: 10, name: "Tester", username: "tester" } }) {
  const revisions = new Map<string, number>()
  const github = {
    available: () => true,
    identity: async (id: string) => {
      const found = accounts[id]
      if (!found) throw new Error("GitHub account is not signed in")
      return found
    },
    token: async (id: string) => {
      if (!accounts[id]) throw new Error("GitHub account is not signed in")
      return `private-token-${id}`
    },
    revision: (id: string) => revisions.get(id) ?? 0,
  } satisfies RemoteGitHub
  const signOut = (id: string) => {
    delete accounts[id]
    revisions.set(id, (revisions.get(id) ?? 0) + 1)
  }
  return { github, accounts, signOut }
}

const DEVICE = {
  id: "use1/hello-world",
  name: "Computer",
  online: true,
  url: "https://hello.use1.devtunnels.ms/",
  port: 1234,
  clusterId: "use1",
  tunnelId: "hello-world",
}

function fixture(overrides: Partial<Deps> = {}, initialSettings: Record<string, unknown> = { remoteAccountId: "github" }) {
  const settings = new Map<string, unknown>(Object.entries(initialSettings))
  const events: string[] = []
  const accounts = githubFixture()
  const controller = createRemoteController({
    github: accounts.github,
    settings: {
      get: (key) => settings.get(key),
      set: (key, value) => {
        settings.set(key, value)
      },
    },
    deviceID: "test-device",
    deviceName: "Computer",
    changed: () => {},
    list: async () => [DEVICE, { ...DEVICE, id: "use1/other-device", name: "Other computer" }],
    host: async (input) => {
      events.push(`host-start:${input.accountID}`)
      input.save({ clusterId: "use1", tunnelId: "hello-world", port: 1234 })
      return {
        device: DEVICE,
        stop: async () => {
          events.push("host-stop")
        },
      }
    },
    ...overrides,
  })
  return { controller, settings, events, accounts }
}

describe("remote controller", () => {
  test("runs as the chosen account, leaves hosting off, and never projects secrets", async () => {
    const input = fixture()
    const state = await input.controller.initialize()
    expect(state).toMatchObject({ accountId: "github", account: { username: "tester" }, enabled: false, status: "disabled" })
    expect(JSON.stringify(state)).not.toContain("private-")
    await input.controller.stop()
  })

  test("enabling persists intent and marks the confirmed current host", async () => {
    const input = fixture()
    const state = await input.controller.setEnabled(true)
    expect(state.status).toBe("online")
    expect(state.devices[0]).toMatchObject({ current: true, online: true })
    expect(input.settings.get("remoteEnabled")).toBe(true)
    await input.controller.stop()
    expect(input.events).toContain("host-stop")
  })

  test("cannot be switched on without an account", async () => {
    const input = fixture({}, {})
    const state = await input.controller.setEnabled(true)
    expect(state).toMatchObject({ enabled: false, error: "authentication" })
    expect(input.events).toEqual([])
    await input.controller.stop()
  })

  test("switching accounts stops the host running as the old one and hosts as the new one", async () => {
    const input = fixture()
    input.accounts.accounts["github-0a1b2c3d"] = { id: 20, name: "Other", username: "other" }
    await input.controller.setEnabled(true)
    const state = await input.controller.selectAccount("github-0a1b2c3d")
    expect(state).toMatchObject({ accountId: "github-0a1b2c3d", account: { username: "other" }, status: "online" })
    expect(input.events).toEqual(["host-start:10", "host-stop", "host-start:20"])
    expect(input.settings.get("remoteAccountId")).toBe("github-0a1b2c3d")
    await input.controller.stop()
  })

  test("an account signing out takes remote access down with it; another account's does not", async () => {
    const input = fixture()
    await input.controller.setEnabled(true)
    expect((await input.controller.accountRemoved("github-0a1b2c3d")).status).toBe("online")
    input.accounts.signOut("github")
    const state = await input.controller.accountRemoved("github")
    expect(state).toMatchObject({ accountId: null, account: null, enabled: false, status: "disabled", devices: [] })
    expect(input.settings.get("remoteEnabled")).toBe(false)
    expect(input.settings.get("remoteAccountId")).toBeNull()
    await input.controller.stop()
  })

  test("refresh recovers the account after a transient initialization failure", async () => {
    let requests = 0
    const accounts = githubFixture()
    const input = fixture({
      github: {
        ...accounts.github,
        identity: async (id) => {
          if (++requests === 1) throw new GitHubAuthError("network_error")
          return accounts.github.identity(id)
        },
      },
    })
    expect((await input.controller.initialize()).error).toBe("connection")
    expect((await input.controller.refresh()).account?.username).toBe("tester")
    expect(requests).toBe(2)
    await input.controller.stop()
  })

  test.each(["host", "list"] as const)("classifies initialize %s failures as connection errors", async (phase) => {
    const failures: unknown[] = []
    const error = Object.assign(new Error("secret-token"), {
      response: { status: 422, headers: { authorization: "secret-token" } },
      config: { token: "secret-token" },
    })
    const input = fixture(
      {
        failed: (failure) => failures.push(failure),
        host: async () => {
          if (phase === "host") throw error
          return { device: DEVICE, stop: async () => {} }
        },
        list: async () => {
          if (phase === "list") throw error
          return []
        },
      },
      { remoteAccountId: "github", remoteEnabled: true },
    )

    const state = await input.controller.initialize()
    expect(state.account?.username).toBe("tester")
    expect(state.error).toBe("connection")
    expect(failures).toEqual([{ operation: "initialize", category: "connection", status: 422 }])
    expect(JSON.stringify({ state, failures })).not.toContain("secret-token")
    await input.controller.stop()
  })

  test("hostile diagnostic metadata and a failing reporter cannot break state updates", async () => {
    const error = {
      get response() {
        throw new Error("secret-token")
      },
      get code() {
        throw new Error("secret-token")
      },
      message: "secret-token",
      token: "secret-token",
    }
    const input = fixture({
      list: async () => {
        throw error
      },
      failed: () => {
        throw new Error("reporter failed")
      },
    })

    const state = await input.controller.initialize()
    expect(state.error).toBe("connection")
    expect(JSON.stringify(state)).not.toContain("secret-token")
    await input.controller.stop()
  })

  test.each([
    ["GitHub token is missing required scope: read:org", "authentication"],
    ["Another access policy rejected this request", "connection"],
  ] as const)("classifies the service permission failure: %s", async (detail, category) => {
    const input = fixture({
      host: async () => {
        throw { response: { status: 403, data: { detail } } }
      },
    })
    const state = await input.controller.setEnabled(true)
    expect(state.account?.username).toBe("tester")
    expect(state.error).toBe(category)
    await input.controller.stop()
  })

  test("an account signing out cannot let a late identity repopulate renderer state", async () => {
    const started = Promise.withResolvers<void>()
    const identity = Promise.withResolvers<Identity>()
    const seen: unknown[] = []
    const accounts = githubFixture()
    const input = fixture({
      github: {
        ...accounts.github,
        identity: () => {
          started.resolve()
          return identity.promise
        },
      },
      changed: (state) => seen.push(state.account),
    })
    const initializing = input.controller.initialize()
    await started.promise
    const removed = input.controller.accountRemoved("github")
    identity.resolve({ id: 10, name: "Tester", username: "tester" })
    await Promise.all([initializing, removed])
    expect(seen.every((account) => account === null)).toBe(true)
    await input.controller.stop()
  })

  test("late device listing after the account is removed does not publish stale devices", async () => {
    const started = Promise.withResolvers<void>()
    const devices = Promise.withResolvers<Awaited<ReturnType<Deps["list"]>>>()
    const visible: unknown[][] = []
    const input = fixture({
      list: () => {
        started.resolve()
        return devices.promise
      },
      changed: (state) => visible.push(state.devices),
    })
    const initializing = input.controller.initialize()
    await started.promise
    const removed = input.controller.accountRemoved("github")
    devices.resolve([{ ...DEVICE, id: "use1/other-device", name: "Stale", url: null }])
    await Promise.all([initializing, removed])
    expect(visible.every((list) => list.length === 0)).toBe(true)
    await input.controller.stop()
  })

  test("a token asked for after the account signs out is refused", async () => {
    const tokens: (() => Promise<string>)[] = []
    const input = fixture({
      list: async (token) => {
        tokens.push(token)
        return []
      },
    })
    await input.controller.initialize()
    expect(await tokens[0]!()).toBe("private-token-github")
    input.accounts.signOut("github")
    await expect(tokens[0]!()).rejects.toThrow("Authentication cancelled")
    await input.controller.stop()
  })

  test("host recovery waits for the previous relay to finish stopping", async () => {
    const stopped = Promise.withResolvers<void>()
    const stopping = Promise.withResolvers<void>()
    const hosts: Parameters<Deps["host"]>[0][] = []
    const input = fixture({
      host: async (options) => {
        hosts.push(options)
        return {
          device: { ...DEVICE, name: "Host", url: null },
          stop: async () => {
            stopping.resolve()
            await stopped.promise
          },
        }
      },
    })
    await input.controller.setEnabled(true)
    hosts[0]!.changed("offline")
    await stopping.promise
    const refresh = input.controller.refresh()
    await Promise.resolve()
    expect(hosts).toHaveLength(1)
    stopped.resolve()
    expect((await refresh).status).toBe("online")
    expect(hosts).toHaveLength(2)
    hosts[0]!.changed("offline")
    expect((await input.controller.getState()).status).toBe("online")
    await input.controller.stop()
  })

  test("disabling while rename stops the host cannot restart sharing from the stale rename", async () => {
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    let starts = 0
    const input = fixture({
      host: async () => {
        starts++
        return {
          device: { ...DEVICE, name: "Host", url: null },
          stop: async () => {
            stopping.resolve()
            await stopped.promise
          },
        }
      },
    })
    await input.controller.setEnabled(true)
    const rename = input.controller.rename("New name")
    await stopping.promise
    const disable = input.controller.setEnabled(false)
    stopped.resolve()
    await Promise.all([rename, disable])
    expect(starts).toBe(1)
    expect((await input.controller.getState()).enabled).toBe(false)
    await input.controller.stop()
  })
})
