import { afterEach, expect, test } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConnectionStatus } from "@microsoft/dev-tunnels-connections"
import type { ConnectionStatusChangedEventArgs, TunnelRelayTunnelHost } from "@microsoft/dev-tunnels-connections"
import { TunnelConstraints } from "@microsoft/dev-tunnels-contracts"
import type { Tunnel, TunnelAccessControlEntry } from "@microsoft/dev-tunnels-contracts"
import { ManagementApiVersions, TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management"
import { REMOTE_LABEL, REMOTE_PORT_LABEL } from "./tunnels.js"
import { startRemoteHost } from "./host.js"
import type { RemoteHostRecord } from "./host.js"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose().catch(() => undefined)
  cleanup.length = 0
})

test("registers a UUID device using service-valid discovery and creation labels", async () => {
  const fixture = await setup()
  const hosted = await startRemoteHost(fixture.options, { createRelay: () => fixture.relay })
  cleanup.push(hosted.stop)
  const labels = fixture.requests[0]!.query.get("labels")!.split(",")
  expect(labels).toEqual(fixture.state.current!.labels!)
  expect(labels).toContain("vgent-device-1b29210ff87e4bed96125d91a298eb44")
  expect(fixture.state.connected).toBe(1)
})

test.each(["abort", "stop", "disconnect"] as const)(
  "%s after readiness closes the gateway, SSE",
  async (action) => {
    const fixture = await setup()
    const hosted = await startRemoteHost(fixture.options, { createRelay: () => fixture.relay })
    cleanup.push(hosted.stop)
    const url = `http://127.0.0.1:${fixture.state.record!.port}`
    const sse = request(`${url}/events`, { headers: { host: new URL(hosted.device.url!).host } })
    cleanup.push(async () => sse.destroy())
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      sse.once("response", resolve)
      sse.once("error", reject)
      sse.end()
    })
    response.on("error", () => undefined)
    response.resume()
    // A failure to delete an endpoint must not leave the local listener or streams alive.
    fixture.state.disposeFails = true
    if (action === "abort") fixture.abort.abort()
    if (action === "stop") await hosted.stop()
    if (action === "disconnect") fixture.emit(ConnectionStatus.Disconnected)
    await hosted.stop()
    await until(() => response.destroyed)
    expect(fixture.state.disposed).toBe(1)
    expect(fixture.state.connected).toBe(1)
    expect(fixture.state.record?.tunnelId).toBe(hosted.device.tunnelId)
    expect(fixture.requests.some((item) => item.method === "delete" && !item.path.includes("/ports/"))).toBe(false)
    await expect(fetch(url)).rejects.toThrow()
  },
)

test.each([
  { type: "Users", provider: "github", subjects: ["42"], scopes: ["connect"], isInverse: true },
  { type: "Users", provider: "github", subjects: ["99"], scopes: ["connect"] },
  { type: "Anonymous", subjects: [], scopes: ["connect"] },
] as TunnelAccessControlEntry[])("refuses non-owner or inverse allow rules before mutations", async (entry) => {
  const fixture = await setup()
  fixture.state.current = previousTunnel()
  fixture.state.current.accessControl = { entries: [entry] }
  await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow("owner")
  expect(fixture.requests.every((item) => item.method === "get")).toBe(true)
  expect(fixture.state.connected).toBe(0)
  expect(fixture.state.disposed).toBe(1)
  expect(
    fixture.requests
      .filter((item) => item.path.startsWith("/tunnels"))
      .every((item) => item.query.get("includeAccessControl") === "true"),
  ).toBe(true)
})

test("refuses missing tunnel ACLs and unsafe per-port ACLs", async () => {
  for (const kind of ["missing", "port"] as const) {
    const fixture = await setup()
    fixture.state.current = previousTunnel()
    if (kind === "missing") delete fixture.state.current.accessControl
    if (kind === "port")
      fixture.state.current.ports![0]!.accessControl = {
        entries: [{ type: "Anonymous", subjects: [], scopes: ["connect"] }],
      }
    await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow("owner")
    expect(fixture.state.connected).toBe(0)
    expect(fixture.requests.every((item) => item.method === "get")).toBe(true)
  }
})

test("refuses takeover when the existing host is online or its status is unknown", async () => {
  for (const count of [1, undefined]) {
    const fixture = await setup()
    fixture.state.current = previousTunnel()
    fixture.state.current.status = { hostConnectionCount: count }
    await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow()
    expect(fixture.requests.every((item) => item.method === "get")).toBe(true)
  }
})

test("recovers a confirmed deleted registration from SDK 404, without reusing its ID", async () => {
  const fixture = await setup()
  fixture.state.current = previousTunnel()
  fixture.state.firstGetStatus = 404
  fixture.options.record = { clusterId: "usw2", tunnelId: "lab-old-device", port: 54321 }
  const hosted = await startRemoteHost(fixture.options, { createRelay: () => fixture.relay })
  cleanup.push(hosted.stop)
  expect(hosted.device.tunnelId).not.toBe("lab-old-device")
  expect(fixture.requests.filter((item) => item.create)).toHaveLength(1)
  expect(fixture.requests[0]?.path).toBe("/tunnels")
  expect(fixture.state.record?.tunnelId).toBe(hosted.device.tunnelId)
})

test.each([401, 403, 500])("does not register a replacement after SDK HTTP %s", async (status) => {
  const fixture = await setup()
  fixture.state.current = previousTunnel()
  fixture.state.firstGetStatus = status
  await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow()
  expect(fixture.requests.some((item) => item.method !== "get")).toBe(false)
  expect(fixture.state.connected).toBe(0)
})

test("a local port collision keeps the existing listener alive and replaces only the obsolete Vgent web port", async () => {
  const fixture = await setup()
  const occupied = createServer((_request, response) => response.end("keep running"))
  const oldPort = await listen(occupied)
  fixture.state.current = previousTunnel(oldPort)
  fixture.options.record = { clusterId: "usw2", tunnelId: "lab-old-device", port: oldPort }
  const hosted = await startRemoteHost(fixture.options, { createRelay: () => fixture.relay })
  cleanup.push(hosted.stop)
  expect(hosted.device.tunnelId).toBe("lab-old-device")
  expect(hosted.device.port).not.toBe(oldPort)
  expect(fixture.requests.filter((item) => item.method === "delete").map((item) => item.path)).toEqual([
    `/tunnels/lab-old-device/ports/${oldPort}`,
  ])
  expect(fixture.requests.filter((item) => item.create)).toHaveLength(0)
  await hosted.stop()
  expect(await fetch(`http://127.0.0.1:${oldPort}`).then((response) => response.text())).toBe("keep running")
})

test("cancelled management startup performs no subsequent mutation or connection", async () => {
  const fixture = await setup()
  fixture.state.abortOnList = true
  await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow()
  expect(fixture.requests.every((item) => item.method === "get")).toBe(true)
  expect(fixture.state.connected).toBe(0)
  expect(fixture.state.disposed).toBe(1)
})

test("failed relay connection closes the gateway but preserves registration for a retry", async () => {
  const fixture = await setup()
  fixture.state.connectFails = true
  await expect(startRemoteHost(fixture.options, { createRelay: () => fixture.relay })).rejects.toThrow("connect failed")
  expect(fixture.state.record).toBeDefined()
  await expect(fetch(`http://127.0.0.1:${fixture.state.record!.port}`)).rejects.toThrow()
  const first = fixture.state.record
  fixture.state.connectFails = false
  fixture.options.record = first
  const hosted = await startRemoteHost(fixture.options, { createRelay: () => fixture.relay })
  cleanup.push(hosted.stop)
  expect(fixture.state.record).toEqual(first)
  expect(fixture.requests.filter((item) => item.create)).toHaveLength(1)
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-host-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "web.html"), "web shell")
  const backend = createServer((incoming, response) => {
    if (incoming.url !== "/events") return response.end("backend")
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write("data: ready\n\n")
  })
  backend.on("upgrade", (_incoming, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
    socket.on("data", (data) => socket.write(data))
    socket.on("error", () => undefined)
  })
  const backendPort = await listen(backend)
  const abort = new AbortController()
  const state = {
    current: undefined as Tunnel | undefined,
    record: undefined as RemoteHostRecord | undefined,
    firstGetStatus: undefined as number | undefined,
    connected: 0,
    disposed: 0,
    disposeFails: false,
    connectFails: false,
    abortOnList: false,
  }
  const requests: { method: string; path: string; query: URLSearchParams; create: boolean }[] = []
  const management = new TunnelManagementHttpClient(
    "OpenCode-Lab-test",
    ManagementApiVersions.Version20230927preview,
    async () => "github isolated-test",
    undefined,
    undefined,
    async (config) => {
      const url = new URL(config.url!)
      requests.push({
        method: config.method!,
        path: url.pathname,
        query: url.searchParams,
        create: config.headers["If-None-Match"] === "*",
      })
      const response = (data: unknown) => ({
        data: structuredClone(data),
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      })
      if (url.pathname === "/tunnels") {
        for (const label of (url.searchParams.get("labels") ?? "").split(",")) {
          if (label.length > TunnelConstraints.labelMaxLength) throw new Error("Service label exceeds 50 characters")
        }
        if (state.abortOnList) abort.abort()
        return response({ value: [{ value: state.current ? [state.current] : [] }] })
      }
      if (url.pathname.startsWith("/clusters")) return response({ recommendedClusterId: "usw2" })
      if (config.method === "get") {
        if (state.firstGetStatus) {
          const status = state.firstGetStatus
          state.firstGetStatus = undefined
          throw Object.assign(new Error("simulated service failure"), {
            isAxiosError: true,
            config,
            response: { ...response({ title: "service error" }), status },
          })
        }
        return response(state.current)
      }
      const body = config.data ? (JSON.parse(config.data) as Tunnel) : {}
      for (const label of body.labels ?? []) {
        if (label.length > TunnelConstraints.labelMaxLength) throw new Error("Service label exceeds 50 characters")
      }
      if (url.pathname.includes("/ports/")) {
        const port = Number(url.pathname.split("/").at(-1))
        state.current!.ports = state.current!.ports!.filter((item) => item.portNumber !== port)
        if (config.method !== "delete")
          state.current!.ports!.push({
            ...body,
            portNumber: port,
            protocol: "http",
            labels: [REMOTE_PORT_LABEL],
            portForwardingUris: [`https://${state.current!.tunnelId}-${port}.usw2.devtunnels.ms/`],
          })
        return response(config.method === "delete" ? {} : state.current!.ports!.at(-1))
      }
      state.current = {
        ...state.current,
        ...body,
        clusterId: "usw2",
        tunnelId: url.pathname.split("/").at(-1),
        status: { hostConnectionCount: 0 },
        accessControl: state.current?.accessControl ?? { entries: [] },
        accessTokens: { host: "test-host" },
        ports: body.ports ?? state.current?.ports ?? [],
      }
      state.current.ports = state.current.ports!.map((port) => ({
        ...port,
        portForwardingUris: [`https://${state.current!.tunnelId}-${port.portNumber}.usw2.devtunnels.ms/`],
      }))
      return response(state.current)
    },
  )
  cleanup.push(() => management.dispose())
  const listeners = new Set<(event: ConnectionStatusChangedEventArgs) => unknown>()
  const relay: Pick<TunnelRelayTunnelHost, "connectionStatusChanged" | "connect" | "dispose"> = {
    connectionStatusChanged(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    async connect() {
      state.connected++
      if (state.connectFails) throw new Error("connect failed")
    },
    async dispose() {
      state.disposed++
      if (state.disposeFails) throw new Error("endpoint deletion failed")
    },
  }
  const options: Parameters<typeof startRemoteHost>[0] = {
    management,
    deviceID: "1b29210f-f87e-4bed-9612-5d91a298eb44",
    accountID: 42,
    name: "Test Mac",
    signal: abort.signal,
    backend: async () => ({ url: `http://127.0.0.1:${backendPort}`, token: "test-token" }),
    save(record) {
      state.record = record
    },
    changed() {},
  }
  return {
    options,
    requests,
    state,
    abort,
    relay,
    emit: (status: ConnectionStatus) => {
      listeners.forEach((listener) => listener({ status, previousStatus: ConnectionStatus.Connected }))
    },
  }
}

function previousTunnel(port = 54321): Tunnel {
  return {
    clusterId: "usw2",
    tunnelId: "lab-old-device",
    labels: [REMOTE_LABEL, "vgent-device-1b29210ff87e4bed96125d91a298eb44"],
    accessControl: {
      entries: [{ type: "Users", provider: "github", subjects: ["42"], scopes: ["manage", "host", "connect"] }],
    },
    status: { hostConnectionCount: 0 },
    ports: [{ portNumber: port, protocol: "http", labels: [REMOTE_PORT_LABEL] }],
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test port")
  return address.port
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Stream did not close")
}
