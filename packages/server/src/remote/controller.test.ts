import { describe, expect, vi, test } from "vitest"
const spyOn = vi.spyOn
import { GitHubAuthError } from "./github.js"
import { createRemoteController } from "./controller.js"

function fixture(
  overrides: Partial<Parameters<typeof createRemoteController>[0]> = {},
  initialSettings: Record<string, unknown> = {},
) {
  const settings = new Map<string, unknown>(Object.entries(initialSettings))
  const events: string[] = []
  const device = {
    id: "use1/hello-world",
    name: "Computer",
    online: true,
    url: "https://hello.use1.devtunnels.ms/",
    port: 1234,
    clusterId: "use1",
    tunnelId: "hello-world",
  }
  const controller = createRemoteController({
    credentials: {
      available: () => true,
      read: () => undefined,
      write: () => {
        events.push("save-credential")
      },
      clear: () => {
        events.push("clear-credential")
      },
    },
    settings: {
      get: (key) => settings.get(key),
      set: (key, value) => {
        settings.set(key, value)
      },
    },
    deviceID: "test-device",
    deviceName: "Computer",
    changed: () => {},
    login: async () => ({
      deviceCode: "private-device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 60_000,
      interval: 1,
    }),
    waitLogin: async () => ({ accessToken: "private-token" }),
    account: async () => ({ id: 10, name: "Tester", username: "tester" }),
    refreshCredential: async () => ({ accessToken: "new-private-token" }),
    list: async () => [device, { ...device, id: "use1/other-device", name: "Other computer" }],
    host: async (input) => {
      events.push("host-start")
      input.save({ clusterId: "use1", tunnelId: "hello-world", port: 1234 })
      return {
        device,
        stop: async () => {
          events.push("host-stop")
        },
      }
    },
    ...overrides,
  })
  return { controller, settings, events }
}

describe("remote controller", () => {
  test("denied credential access is not retried by polling or initialization, but explicit refresh can recover", async () => {
    let poll: (() => void) | undefined
    let reads = 0
    let denied = true
    const interval = globalThis.setInterval
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      poll = callback
      return interval(() => {}, 60_000)
    }) as typeof setInterval)
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => {
          reads++
          if (denied) throw new Error("Keychain access denied")
          return { accessToken: "stored-token" }
        },
        write: () => {},
        clear: () => {},
      },
    })
    try {
      await input.controller.initialize()
      expect(reads).toBe(1)
      for (let i = 0; i < 3; i++) {
        poll!()
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await input.controller.initialize()
      expect(reads).toBe(1)
      denied = false
      expect((await input.controller.refresh()).account?.username).toBe("tester")
      expect(reads).toBe(2)
    } finally {
      timer.mockRestore()
      await input.controller.stop()
    }
  })

  test("account sign-in leaves hosting off and never projects secrets", async () => {
    const input = fixture()
    const state = await input.controller.signIn()
    expect(state.account?.username).toBe("tester")
    expect(state.enabled).toBe(false)
    expect(input.events).toEqual(["save-credential"])
    expect(JSON.stringify(state)).not.toContain("private-")
    await input.controller.stop()
  })

  test("enable signs in, persists intent, and marks the confirmed current host", async () => {
    const input = fixture()
    const state = await input.controller.setEnabled(true)
    expect(state.status).toBe("online")
    expect(state.devices[0]).toMatchObject({ current: true, online: true })
    expect(input.settings.get("remoteEnabled")).toBe(true)
    await input.controller.stop()
    expect(input.events).toContain("host-stop")
  })

  test("sign-out invalidates a login queued in the same tick", async () => {
    const input = fixture()
    const login = input.controller.signIn()
    const logout = input.controller.signOut()
    await Promise.all([login, logout])
    expect(input.events).not.toContain("save-credential")
    expect((await input.controller.getState()).account).toBeNull()
    await input.controller.stop()
  })

  test("cancel interrupts active device polling without persisting a credential", async () => {
    const started = Promise.withResolvers<void>()
    const input = fixture({
      waitLogin: (_authorization, options) =>
        new Promise((_resolve, reject) => {
          started.resolve()
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }),
    })
    const login = input.controller.signIn()
    await started.promise
    expect((await input.controller.getState()).authorization?.userCode).toBe("ABCD-EFGH")
    await input.controller.cancelSignIn()
    await login
    expect(input.events).not.toContain("save-credential")
    expect((await input.controller.getState()).authorization).toBeNull()
    await input.controller.stop()
  })

  test("refresh recovers persisted account after a transient initialization failure", async () => {
    let requests = 0
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => ({ accessToken: "stored-token" }),
        write: () => {},
        clear: () => {},
      },
      account: async () => {
        if (++requests === 1) throw new GitHubAuthError("network_error")
        return { id: 10, name: "Tester", username: "tester" }
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
        credentials: {
          available: () => true,
          read: () => ({ accessToken: "stored-token" }),
          write: () => {},
          clear: () => {},
        },
        failed: (failure) => failures.push(failure),
        host: async (options) => {
          if (phase === "host") throw error
          return {
            device: {
              id: "use1/hello-world",
              name: "Computer",
              online: true,
              url: "https://hello.use1.devtunnels.ms/",
              port: 1234,
              clusterId: "use1",
              tunnelId: "hello-world",
            },
            stop: async () => {},
          }
        },
        list: async () => {
          if (phase === "list") throw error
          return []
        },
      },
      { remoteEnabled: true },
    )

    const state = await input.controller.initialize()
    expect(state.account?.username).toBe("tester")
    expect(state.error).toBe("connection")
    expect(failures).toEqual([{ operation: "initialize", category: "connection", status: 422 }])
    expect(JSON.stringify({ state, failures })).not.toContain("secret-token")
    await input.controller.stop()
  })

  test("classifies sign-in listing failures without exposing arbitrary error fields", async () => {
    const failures: unknown[] = []
    const input = fixture({
      failed: (failure) => failures.push(failure),
      list: async () => {
        throw Object.assign(new Error("secret-token"), {
          code: "ECONNRESET",
          headers: { authorization: "secret-token" },
          token: "secret-token",
        })
      },
    })

    const state = await input.controller.signIn()
    expect(state.error).toBe("connection")
    expect(failures).toEqual([{ operation: "signIn", category: "connection", code: "ECONNRESET" }])
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
      login: async () => {
        throw error
      },
      failed: () => {
        throw new Error("reporter failed")
      },
    })

    const state = await input.controller.signIn()
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

  test.each([
    ["reauth_required", "authentication"],
    ["network_error", "connection"],
    ["invalid_client", "configuration"],
  ] as const)("classifies GitHub %s failures as %s", async (code, category) => {
    const failures: unknown[] = []
    const input = fixture({
      login: async () => {
        throw new GitHubAuthError(code)
      },
      failed: (failure) => failures.push(failure),
    })

    const state = await input.controller.signIn()
    expect(state.error).toBe(category)
    expect(failures).toEqual([{ operation: "signIn", category, code }])
    await input.controller.stop()
  })

  test("sign-out cannot let a late restored account repopulate renderer state", async () => {
    const started = Promise.withResolvers<void>()
    const identity = Promise.withResolvers<{ id: number; name: string; username: string }>()
    const accounts: unknown[] = []
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => ({ accessToken: "stored-token" }),
        write: () => {},
        clear: () => {},
      },
      account: () => {
        started.resolve()
        return identity.promise
      },
      changed: (state) => accounts.push(state.account),
    })
    const initializing = input.controller.initialize()
    await started.promise
    const logout = input.controller.signOut()
    identity.resolve({ id: 10, name: "Tester", username: "tester" })
    await Promise.all([initializing, logout])
    expect(accounts.every((account) => account === null)).toBe(true)
    await input.controller.stop()
  })

  test("late device listing after cancellation does not publish stale devices", async () => {
    const started = Promise.withResolvers<void>()
    const devices = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof createRemoteController>[0]["list"]>>>()
    const visible: unknown[][] = []
    const input = fixture({
      list: () => {
        started.resolve()
        return devices.promise
      },
      changed: (state) => visible.push(state.devices),
    })
    const signingIn = input.controller.signIn()
    await started.promise
    const logout = input.controller.signOut()
    devices.resolve([
      {
        id: "use1/other-device",
        name: "Stale",
        online: true,
        url: null,
        port: 1234,
        clusterId: "use1",
        tunnelId: "other-device",
      },
    ])
    await Promise.all([signingIn, logout])
    expect(visible.every((devices) => devices.length === 0)).toBe(true)
    await input.controller.stop()
  })

  test("host recovery waits for the previous relay to finish stopping", async () => {
    const stopped = Promise.withResolvers<void>()
    const stopping = Promise.withResolvers<void>()
    const hosts: Parameters<Parameters<typeof createRemoteController>[0]["host"]>[0][] = []
    const input = fixture({
      host: async (options) => {
        hosts.push(options)
        return {
          device: {
            id: "use1/hello-world",
            name: "Host",
            online: true,
            url: null,
            port: 1234,
            clusterId: "use1",
            tunnelId: "hello-world",
          },
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
          device: {
            id: "use1/hello-world",
            name: "Host",
            online: true,
            url: null,
            port: 1234,
            clusterId: "use1",
            tunnelId: "hello-world",
          },
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

  test("disabling sharing preserves a concurrent account token rotation", async () => {
    const renewed = Promise.withResolvers<{ accessToken: string }>()
    const tokens: (() => Promise<string>)[] = []
    const written: string[] = []
    let refreshes = 0
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => undefined,
        clear: () => {},
        write: (credential) => {
          written.push(credential.accessToken)
        },
      },
      waitLogin: async () => ({ accessToken: "expired", expiresAt: 1, refreshToken: "refresh" }),
      refreshCredential: () => {
        refreshes++
        return renewed.promise
      },
      list: async (token) => {
        tokens.push(token)
        return []
      },
    })
    await input.controller.setEnabled(true)
    const first = tokens[0]!()
    const second = tokens[0]!()
    await input.controller.setEnabled(false)
    renewed.resolve({ accessToken: "rotated" })
    expect(await Promise.all([first, second])).toEqual(["rotated", "rotated"])
    expect(refreshes).toBe(1)
    expect(written).toContain("rotated")
    await input.controller.stop()
  })

  test("a token rotation finishing after sign-out cannot rewrite cleared credentials", async () => {
    const renewed = Promise.withResolvers<{ accessToken: string }>()
    const tokens: (() => Promise<string>)[] = []
    const written: string[] = []
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => undefined,
        clear: () => {},
        write: (credential) => {
          written.push(credential.accessToken)
        },
      },
      waitLogin: async () => ({ accessToken: "expired", expiresAt: 1, refreshToken: "refresh" }),
      refreshCredential: () => renewed.promise,
      list: async (token) => {
        tokens.push(token)
        return []
      },
    })
    await input.controller.signIn()
    const token = tokens[0]!()
    await input.controller.signOut()
    renewed.resolve({ accessToken: "must-not-save" })
    await expect(token).rejects.toThrow("Authentication cancelled")
    expect(written).toEqual(["expired"])
    await input.controller.stop()
  })
})
