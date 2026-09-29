import type { RemoteAccessState } from "./types.js"
import { GitHubAuthError } from "./github.js"
import type { RemoteTunnelDevice } from "./tunnels.js"
import type { RemoteHostRecord } from "./host.js"

type Identity = { id: number; name: string; username: string; avatarUrl?: string }
type Connection = { stop(): Promise<void> }
type FailureCategory = Exclude<RemoteAccessState["error"], null>
type FailureOperation = "initialize" | "poll" | "select" | "enable" | "disable" | "rename" | "refresh"
export type RemoteControllerFailure = {
  operation: FailureOperation
  category: FailureCategory
  code?: string
  status?: number
}
/**
 * The GitHub accounts remote access can run as. Signing in and out is theirs:
 * remote access only picks one, by its account id, and borrows its token.
 */
export type RemoteGitHub = {
  available(): boolean
  identity(id: string): Promise<Identity>
  token(id: string): Promise<string>
  /** Changes when the account signs out, so work started before cannot finish after. */
  revision(id: string): number
}
type Dependencies = {
  github: RemoteGitHub
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  deviceID: string
  deviceName: string
  changed(state: RemoteAccessState): void
  failed?(failure: RemoteControllerFailure): void
  list(token: () => Promise<string>): Promise<RemoteTunnelDevice[]>
  host(options: {
    token(): Promise<string>
    accountID: number
    deviceID: string
    name: string
    record?: RemoteHostRecord | undefined
    signal: AbortSignal
    save(record: RemoteHostRecord): void
    changed(status: "connecting" | "online" | "offline"): void
  }): Promise<Connection & { device: RemoteTunnelDevice }>
}

export function createRemoteController(deps: Dependencies) {
  const savedAccount = deps.settings.get("remoteAccountId")
  let state: RemoteAccessState = {
    configured: deps.github.available(),
    accountId: typeof savedAccount === "string" ? savedAccount : null,
    account: null,
    enabled: deps.settings.get("remoteEnabled") === true,
    status: "disabled",
    deviceName:
      typeof deps.settings.get("remoteDeviceName") === "string"
        ? String(deps.settings.get("remoteDeviceName"))
        : deps.deviceName,
    url: null,
    devices: [],
    error: null,
  }
  let account: Identity | undefined
  /** The account's revision when `account` was read; a sign-out moves it. */
  let accountRevision = 0
  let host: Connection | undefined
  let hosting: AbortController | undefined
  let revision = 0
  let disposed = false
  let hostStopping = Promise.resolve()
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const publish = (patch: Partial<RemoteAccessState>) => {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
    return state
  }
  const check = (generation: number) => {
    if (disposed || generation !== revision) throw new Error("Remote operation cancelled")
  }
  const token = async () => {
    const id = state.accountId
    if (id == null || disposed) throw new Error("Authentication required")
    if (deps.github.revision(id) !== accountRevision) throw new Error("Authentication cancelled")
    return deps.github.token(id)
  }
  const records = () => {
    const value = deps.settings.get("remoteTunnels")
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, RemoteHostRecord>)
      : {}
  }
  const currentID = () => {
    const record = account ? records()[String(account.id)] : undefined
    return record ? `${record.clusterId}/${record.tunnelId}` : undefined
  }
  const haltHost = async () => {
    hosting?.abort()
    hosting = undefined
    const previous = host
    host = undefined
    publish({ url: null })
    hostStopping = Promise.allSettled([hostStopping, previous?.stop()]).then(() => undefined)
    await hostStopping
  }
  const restoreAccount = async (generation: number) => {
    check(generation)
    if (account) return
    const id = state.accountId
    if (id == null) return
    const before = deps.github.revision(id)
    const identity = await deps.github.identity(id)
    check(generation)
    if (deps.github.revision(id) !== before) throw new Error("Authentication cancelled")
    account = identity
    accountRevision = before
    publish({ account: { name: identity.name, username: identity.username, avatarUrl: identity.avatarUrl ?? `https://avatars.githubusercontent.com/u/${identity.id}?s=80` }, error: null })
  }
  const list = async (generation: number) => {
    check(generation)
    if (!account) return state
    const devices = await deps.list(token)
    check(generation)
    return publish({
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        url: device.url,
        current: device.id === currentID(),
        online: device.id === currentID() ? state.status === "online" : device.online,
      })),
    })
  }
  const ensureHost = async (generation: number) => {
    await hostStopping
    check(generation)
    if (!state.enabled || !account || host) return
    const identity = account
    const controller = new AbortController()
    hosting = controller
    publish({ status: "connecting", error: null })
    const result = await deps.host({
      token,
      accountID: identity.id,
      deviceID: deps.deviceID,
      name: state.deviceName,
      record: records()[String(identity.id)],
      signal: controller.signal,
      save: (record) => {
        if (controller.signal.aborted || disposed || generation !== revision) return
        deps.settings.set("remoteTunnels", { ...records(), [String(identity.id)]: record })
      },
      changed: (status) => {
        if (controller.signal.aborted || disposed || hosting !== controller) return
        publish({
          url: status === "offline" ? null : state.url,
          status,
          devices: state.devices.map((device) =>
            device.current ? { ...device, online: status === "online" } : device,
          ),
        })
        if (status === "offline") void haltHost()
      },
    })
    if (controller.signal.aborted || disposed || generation !== revision) {
      await result.stop()
      check(generation)
      throw new Error("Remote host disconnected")
    }
    host = result
    publish({ status: "online", url: result.device.url, error: null })
  }
  const run = (operation: FailureOperation, action: (generation: number) => Promise<unknown>) => {
    const generation = revision
    const result = pending.then(async () => {
      if (disposed || generation !== revision) return state
      try {
        await action(generation)
      } catch (error) {
        if (disposed || generation !== revision) return state
        const category = failureCategory(error)
        try {
          deps.failed?.({ operation, category, ...failureDetails(error) })
        } catch {}
        publish({ error: category, status: state.enabled ? (host ? state.status : "offline") : "disabled" })
      }
      return state
    })
    pending = result.then(() => undefined)
    return result
  }
  /** Stops using the current account: whatever runs as it goes down with it. */
  const forget = async (next: string | null) => {
    await haltHost()
    account = undefined
    deps.settings.set("remoteAccountId", next)
    publish({ accountId: next, account: null, url: null, devices: [], status: state.enabled ? "offline" : "disabled", error: null })
  }
  const startUp = async (generation: number) => {
    await restoreAccount(generation)
    if (account) {
      await ensureHost(generation)
      await list(generation)
    } else if (state.enabled) publish({ status: "offline", error: "authentication" })
  }
  return {
    getState: async () => state,
    initialize: () => {
      if (disposed) return Promise.resolve(state)
      timer ??= setInterval(() => {
        void run("poll", async (generation) => {
          await restoreAccount(generation)
          await ensureHost(generation)
          await list(generation)
        })
      }, 30_000)
      timer.unref?.()
      return run("initialize", startUp)
    },
    /** Run as another GitHub account, or as none. Hosting follows if it is on. */
    selectAccount: (id: string | null) => {
      revision++
      hosting?.abort()
      return run("select", async (generation) => {
        await forget(id)
        check(generation)
        await startUp(generation)
      })
    },
    /** An account signed out: if it is the one in use, remote access stops and forgets it. */
    accountRemoved: (id: string) => {
      if (state.accountId !== id) return Promise.resolve(state)
      revision++
      hosting?.abort()
      return run("disable", async () => {
        deps.settings.set("remoteEnabled", false)
        publish({ enabled: false })
        await forget(null)
      })
    },
    setEnabled: (enabled: boolean) => {
      if (!enabled) {
        revision++
        hosting?.abort()
      }
      return run(enabled ? "enable" : "disable", async (generation) => {
        if (!enabled) {
          deps.settings.set("remoteEnabled", false)
          await haltHost()
          publish({
            enabled: false,
            url: null,
            status: "disabled",
            error: null,
            devices: state.devices.map((device) => (device.current ? { ...device, online: false } : device)),
          })
          return
        }
        await restoreAccount(generation)
        if (!account) throw new RemoteAuthenticationError()
        check(generation)
        deps.settings.set("remoteEnabled", true)
        publish({ enabled: true })
        await ensureHost(generation)
        await list(generation)
      })
    },
    rename: (name: string) =>
      run("rename", async (generation) => {
        if (!name.trim() || name.trim().length > 40) throw new Error("Invalid device name")
        deps.settings.set("remoteDeviceName", name.trim())
        publish({ deviceName: name.trim() })
        await haltHost()
        await ensureHost(generation)
        await list(generation)
      }),
    refresh: () =>
      run("refresh", async (generation) => {
        // A login renewed elsewhere is read again rather than trusted from before.
        if (account && state.accountId != null && deps.github.revision(state.accountId) !== accountRevision) {
          await haltHost()
          account = undefined
        }
        await restoreAccount(generation)
        if (!account) {
          if (state.enabled) publish({ status: "offline", error: "authentication" })
          return
        }
        await ensureHost(generation)
        await list(generation)
        publish({ error: null })
      }),
    stop: async () => {
      disposed = true
      revision++
      if (timer) clearInterval(timer)
      hosting?.abort()
      await haltHost()
      await pending
    },
  }
}

class RemoteAuthenticationError extends Error {}

function failureCategory(error: unknown): FailureCategory {
  if (error instanceof RemoteAuthenticationError) return "authentication"
  if (error instanceof Error && ["Authentication required", "Authentication cancelled", "GitHub account is not signed in", "GitHub account changed"].includes(error.message)) return "authentication"
  if (error && typeof error === "object") {
    const response = property(error, "response")
    if (response && typeof response === "object" && property(response, "status") === 403) {
      const data = property(response, "data")
      if (
        data &&
        typeof data === "object" &&
        property(data, "detail") === "GitHub token is missing required scope: read:org"
      )
        return "authentication"
    }
  }
  if (!(error instanceof GitHubAuthError)) return "connection"
  if (error.code === "invalid_client" || error.code === "device_flow_disabled") return "configuration"
  if (
    error.code === "network_error" ||
    error.code === "rate_limited" ||
    error.code === "invalid_response" ||
    error.code === "request_failed"
  )
    return "connection"
  return "authentication"
}

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])

function failureDetails(error: unknown): Pick<RemoteControllerFailure, "code" | "status"> {
  if (error instanceof GitHubAuthError) return { code: error.code }
  if (!error || typeof error !== "object") return {}
  const response = property(error, "response")
  const status =
    property(error, "status") ??
    property(error, "statusCode") ??
    (response && typeof response === "object" ? property(response, "status") : undefined)
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return { status }
  const code = property(error, "code")
  return typeof code === "string" && NETWORK_CODES.has(code) ? { code } : {}
}

function property(value: object, key: string) {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}
