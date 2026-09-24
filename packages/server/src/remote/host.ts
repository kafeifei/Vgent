import { startRemoteHost as host, type RemoteHostOptions, type RemoteHostDependencies } from "@saymiao/remote-core/host";
import { createWebEntry } from "./gateway.js";
export type { RemoteHostRecord } from "@saymiao/remote-core/host";

/** Vgent owns the gateway; the shared core owns registration, ACLs and relay lifecycle. */
export function startRemoteHost(
  options: Omit<RemoteHostOptions, "application" | "createGateway"> & {
    backend: Parameters<typeof createWebEntry>[0]["backend"];
  },
  dependencies: RemoteHostDependencies = {},
) {
  return host({
    ...options,
    application: "vgent",
    createGateway: (input) => createWebEntry({ ...input, backend: options.backend }),
  }, dependencies);
}
