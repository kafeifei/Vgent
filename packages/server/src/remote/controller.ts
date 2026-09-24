import type { RemoteAccessState } from "./types.js"
import {
  GitHubAuthError,
  type GitHubCredential,
  type getGitHubAccount,
  type beginGitHubLogin,
  type waitGitHubLogin,
} from "./github.js"
import type { RemoteTunnelDevice } from "./tunnels.js"
import type { RemoteHostRecord } from "./host.js"

type Account = Awaited<ReturnType<typeof getGitHubAccount>>
type Connection = { stop(): Promise<void> }
type FailureCategory = Exclude<RemoteAccessState["error"], null>
type FailureOperation =
  | "initialize"
  | "poll"
  | "signIn"
  | "cancelSignIn"
  | "signOut"
  | "enable"
  | "disable"
  | "rename"
  | "refresh"
export type RemoteControllerFailure = {
  operation: FailureOperation
  category: FailureCategory
  code?: string
  status?: number
}
type Dependencies = {
  credentials: {
    available(): boolean
    read(): GitHubCredential | undefined | Promise<GitHubCredential | undefined>
    write(value: GitHubCredential): void | Promise<void>
    clear(): void | Promise<void>
  }
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  deviceID: string
  deviceName: string
  changed(state: RemoteAccessState): void
  failed?(failure: RemoteControllerFailure): void
  login: typeof beginGitHubLogin
  waitLogin: typeof waitGitHubLogin
  account(token: string): Promise<Account>
  refreshCredential(value: GitHubCredential): Promise<GitHubCredential>
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
  let state: RemoteAccessState = {
    configured: deps.credentials.available(),
    account: null,
    authorization: null,
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
  let credential: GitHubCredential | undefined
  let credentialReadAttempted = false
  let account: Account | undefined
  let host: Connection | undefined
  let login: AbortController | undefined
  let hosting: AbortController | undefined
  let revision = 0
  let authentication = 0
  let disposed = false
  let refresh: { generation: number; promise: Promise<GitHubCredential> } | undefined
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
    if (!credential || disposed) throw new Error("Authentication required")
    if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential.accessToken
    const generation = authentication
    if (!refresh || refresh.generation !== generation) {
      const promise = deps.refreshCredential(credential).finally(() => {
        if (refresh?.promise === promise) refresh = undefined
      })
      refresh = { generation, promise }
    }
    const next = await refresh.promise
    if (disposed || generation !== authentication) throw new Error("Authentication cancelled")
    await deps.credentials.write(next)
    if (disposed || generation !== authentication) throw new Error("Authentication cancelled")
    credential = next
    return next.accessToken
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
  const halt = async () => {
    await haltHost()
  }
  const restoreAccount = async (generation: number) => {
    check(generation)
    if (account) return
    if (!credential) {
      // A denied or locked credential store may show a native authorization dialog.
      // Polling must not repeatedly ask; only an explicit refresh retries the read.
      if (credentialReadAttempted) return
      credentialReadAttempted = true
      const saved = await deps.credentials.read()
      check(generation)
      credential = saved
    }
    if (!credential) return
    const identity = await deps.account(await token())
    check(generation)
    account = identity
    publish({ account: { name: identity.name, username: identity.username }, error: null })
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
  const authenticate = async (generation: number) => {
    check(generation)
    if (account) return
    if (!deps.credentials.available()) throw new RemoteConfigurationError()
    const controller = new AbortController()
    login = controller
    try {
      const authorization = await deps.login({ signal: controller.signal })
      controller.signal.throwIfAborted()
      publish({
        authorization: {
          userCode: authorization.userCode,
          verificationUri: authorization.verificationUri,
          expiresAt: authorization.expiresAt,
        },
        error: null,
      })
      const next = await deps.waitLogin(authorization, { signal: controller.signal })
      const identity = await deps.account(next.accessToken)
      controller.signal.throwIfAborted()
      check(generation)
      await deps.credentials.write(next)
      controller.signal.throwIfAborted()
      check(generation)
      credential = next
      account = identity
      publish({ account: { name: identity.name, username: identity.username }, authorization: null })
    } finally {
      if (login === controller) login = undefined
      if (generation === revision) publish({ authorization: null })
    }
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
      return run("initialize", async (generation) => {
        await restoreAccount(generation)
        if (account) {
          await ensureHost(generation)
          await list(generation)
        } else if (state.enabled) publish({ status: "offline", error: "authentication" })
      })
    },
    signIn: () =>
      run("signIn", async (generation) => {
        await authenticate(generation)
        check(generation)
        await ensureHost(generation)
        await list(generation)
      }),
    cancelSignIn: () => {
      revision++
      login?.abort()
      return run("cancelSignIn", async () => {
        publish({ authorization: null, error: null })
      })
    },
    signOut: () => {
      revision++
      authentication++
      login?.abort()
      hosting?.abort()
      return run("signOut", async () => {
        await halt()
        await deps.credentials.clear()
        deps.settings.set("remoteEnabled", false)
        credential = undefined
        account = undefined
        publish({ account: null, authorization: null, url: null, enabled: false, status: "disabled", devices: [], error: null })
      })
    },
    setEnabled: (enabled: boolean) => {
      if (!enabled) {
        revision++
        login?.abort()
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
        await authenticate(generation)
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
        if (!credential) credentialReadAttempted = false
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
      authentication++
      if (timer) clearInterval(timer)
      login?.abort()
      hosting?.abort()
      await halt()
      await pending
    },
  }
}

class RemoteConfigurationError extends Error {}

function failureCategory(error: unknown): FailureCategory {
  if (error instanceof RemoteConfigurationError) return "configuration"
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
