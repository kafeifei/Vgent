import { expect, test } from "vitest"
import type { Tunnel } from "@microsoft/dev-tunnels-contracts"
import { getRemoteTunnel, listRemoteDevices, REMOTE_LABEL, REMOTE_PORT_LABEL, toRemoteDevice } from "./tunnels.js"

function tunnel(): Tunnel {
  return {
    clusterId: "usw2",
    tunnelId: "lab-test-device",
    name: "alias",
    description: "My Mac",
    labels: [REMOTE_LABEL],
    accessTokens: { connect: "secret-connect", host: "secret-host" },
    status: { hostConnectionCount: { current: 1, limit: 1 } },
    ports: [
      {
        portNumber: 4321,
        protocol: "http",
        labels: [REMOTE_PORT_LABEL],
        portForwardingUris: ["https://lab-test-device-4321.usw2.devtunnels.ms/"],
        accessTokens: { connect: "secret-port" },
      },
    ],
  }
}

test("projects only approved single-port metadata, with no token material", () => {
  const device = toRemoteDevice(tunnel())
  expect(device).toEqual({
    id: "usw2/lab-test-device",
    name: "My Mac",
    online: true,
    url: "https://lab-test-device-4321.usw2.devtunnels.ms",
    port: 4321,
    clusterId: "usw2",
    tunnelId: "lab-test-device",
  })
  expect(JSON.stringify(device)).not.toContain("secret")
})

test.each([0, 1, { current: 0 }, undefined, -1, NaN] as const)(
  "reads host counts without inventing online status (%j)",
  (count) => {
    const data = tunnel()
    data.status = { hostConnectionCount: count }
    const expected =
      count === 0 || (typeof count === "object" && count.current === 0) ? false : count === 1 ? true : null
    expect(toRemoteDevice(data)?.online).toBe(expected)
  },
)

test.each([
  "http://lab-test-device-4321.usw2.devtunnels.ms/",
  "https://devtunnels.ms/",
  "https://devtunnels.ms.evil.example/",
  "https://user:secret@lab-test-device-4321.usw2.devtunnels.ms/",
  "https://lab-test-device-4321.usw2.devtunnels.ms/?token=secret",
  "https://lab-test-device-4321.usw2.devtunnels.ms/#secret",
  "https://lab-test-device-4321.usw2.devtunnels.ms/path",
  "https://lab-test-device-4321.usw2.devtunnels.ms:1234/",
  "invalid",
])("does not advertise unsafe or credential-bearing URLs (%s)", (url) => {
  const data = tunnel()
  data.ports![0]!.portForwardingUris = [url]
  expect(toRemoteDevice(data)?.url).toBeNull()
})

test("does not synthesize a URL when the service has not provided one", () => {
  const data = tunnel()
  delete data.ports![0]!.portForwardingUris
  expect(toRemoteDevice(data)?.url).toBeNull()
})

test("rejects unrelated products, extra ports, wrong protocols and mismatched port identities", () => {
  const candidates = [tunnel(), tunnel(), tunnel(), tunnel(), tunnel(), tunnel()]
  candidates[0]!.labels = ["another-product"]
  candidates[1]!.ports!.push({ portNumber: 22, protocol: "ssh" })
  candidates[2]!.ports![0]!.labels = []
  candidates[3]!.ports![0]!.protocol = "tcp"
  candidates[4]!.ports![0]!.tunnelId = "different-tunnel"
  candidates[5]!.ports![0]!.portNumber = 0
  candidates.forEach((candidate) => expect(toRemoteDevice(candidate)).toBeUndefined())
})

test("malformed metadata fails closed instead of throwing during list projection", () => {
  for (const patch of [{ labels: REMOTE_LABEL }, { ports: {} }, { ports: [null] }, { clusterId: "../evil" }]) {
    expect(toRemoteDevice({ ...tunnel(), ...patch } as unknown as Tunnel)).toBeUndefined()
  }
})

test.each(["empty", "missing"] as const)(
  "hydrates complete device metadata when the global listing has %s ports",
  async (ports) => {
    const summary = tunnel()
    if (ports === "empty") summary.ports = []
    if (ports === "missing") delete summary.ports
    const devices = await listRemoteDevices({
      listTunnels: async (cluster, domain, options) => {
        expect(cluster).toBeUndefined()
        expect(domain).toBeUndefined()
        expect(options).toEqual({ labels: [REMOTE_LABEL] })
        return [summary]
      },
      getTunnel: async (reference, options) => {
        expect(reference).toEqual({ clusterId: "usw2", tunnelId: "lab-test-device" })
        expect(options).toEqual({ includePorts: true })
        return tunnel()
      },
    })
    expect(devices).toHaveLength(1)
    expect(devices[0]?.id).toBe("usw2/lab-test-device")
    expect(JSON.stringify(devices)).not.toContain("secret")
  },
)

test("hydrates each owned identity once when the listing contains duplicates", async () => {
  const summaries = [tunnel(), tunnel()]
  summaries.forEach((summary) => delete summary.ports)
  const fetched: string[] = []
  const devices = await listRemoteDevices({
    listTunnels: async () => summaries,
    getTunnel: async (reference) => {
      fetched.push(`${reference.clusterId}/${reference.tunnelId}`)
      return tunnel()
    },
  })
  expect(fetched).toEqual(["usw2/lab-test-device"])
  expect(devices).toHaveLength(1)
})

test("does not fetch unrelated or malformed listing candidates", async () => {
  const unrelated = tunnel()
  unrelated.labels = ["another-product"]
  const malformed = tunnel()
  malformed.clusterId = "../evil"
  let fetched = 0
  const devices = await listRemoteDevices({
    listTunnels: async () => [unrelated, malformed],
    getTunnel: async () => {
      fetched++
      return tunnel()
    },
  })
  expect(fetched).toBe(0)
  expect(devices).toEqual([])
})

test("rejects a detail response whose identity differs from the owned listing", async () => {
  const changed = tunnel()
  changed.tunnelId = "other-device"
  await expect(
    listRemoteDevices({ listTunnels: async () => [tunnel()], getTunnel: async () => changed }),
  ).rejects.toMatchObject({ code: "invalid_tunnel" })
})

test("does not display a device whose hydrated detail fails strict projection", async () => {
  const invalid = tunnel()
  invalid.ports![0]!.labels = []
  expect(
    await listRemoteDevices({ listTunnels: async () => [tunnel()], getTunnel: async () => invalid }),
  ).toEqual([])
})

test("skips a listing candidate that disappears before detail hydration", async () => {
  expect(
    await listRemoteDevices({ listTunnels: async () => [tunnel()], getTunnel: async () => null }),
  ).toEqual([])
})

test("fetches tokens only after confirming current-account ownership", async () => {
  const calls: string[] = []
  const result = await getRemoteTunnel(
    {
      listTunnels: async () => {
        calls.push("list")
        return [tunnel()]
      },
      getTunnel: async (reference, options) => {
        expect(reference).toEqual({ clusterId: "usw2", tunnelId: "lab-test-device" })
        if (calls.length === 1) {
          calls.push("get-detail")
          expect(options).toEqual({ includePorts: true })
          return tunnel()
        }
        calls.push("get-connect")
        expect(options).toEqual({ includePorts: true, tokenScopes: ["connect"] })
        return tunnel()
      },
    },
    "usw2/lab-test-device",
    ["connect"],
  )
  expect(calls).toEqual(["list", "get-detail", "get-connect"])
  expect(result.device.id).toBe("usw2/lab-test-device")
  expect(result.tunnel.accessTokens?.connect).toBe("secret-connect")
})

test("rejects a non-owned ID before fetching even if it could be publicly accessible", async () => {
  await expect(
    getRemoteTunnel(
      {
        listTunnels: async () => [],
        getTunnel: async () => {
          throw new Error("must not fetch")
        },
      },
      "usw2/lab-test-device",
      ["connect"],
    ),
  ).rejects.toMatchObject({ code: "not_found" })
})

test.each(["../lab-test-device", "usw2/lab-test-device/extra", "usw2/../../evil", "usw2/x", "usw2/lab?token=secret"])(
  "rejects malformed identity before sending any network request (%s)",
  async (id) => {
    await expect(
      getRemoteTunnel(
        {
          listTunnels: async () => {
            throw new Error("must not list")
          },
          getTunnel: async () => {
            throw new Error("must not fetch")
          },
        },
        id,
      ),
    ).rejects.toMatchObject({ code: "invalid_id" })
  },
)

test("rejects an identity swap or newly unlabelled response after the owned listing", async () => {
  const changed = tunnel()
  changed.tunnelId = "other-device"
  let fetched = 0
  await expect(
    getRemoteTunnel(
      {
        listTunnels: async () => [tunnel()],
        getTunnel: async () => {
          fetched++
          return fetched === 1 ? tunnel() : changed
        },
      },
      "usw2/lab-test-device",
    ),
  ).rejects.toMatchObject({ code: "invalid_tunnel" })
})

test("redacts SDK request errors that may include authorization headers", async () => {
  const error = await listRemoteDevices({
    listTunnels: async () => {
      throw Object.assign(new Error("secret"), { config: { authorization: "secret" } })
    },
    getTunnel: async () => {
      throw new Error("must not fetch")
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "request_failed" })
  expect(JSON.stringify(error)).not.toContain("secret")
  expect(String(error)).not.toContain("secret")
})

test("redacts detail request errors that may include authorization headers", async () => {
  const error = await listRemoteDevices({
    listTunnels: async () => [tunnel()],
    getTunnel: async () => {
      throw Object.assign(new Error("secret"), { config: { authorization: "secret" } })
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "request_failed" })
  expect(JSON.stringify(error)).not.toContain("secret")
  expect(String(error)).not.toContain("secret")
})
