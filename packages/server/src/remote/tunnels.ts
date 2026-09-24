import {
  REMOTE_APPLICATIONS,
  createTunnelManagement as management,
  listRemoteDevices as list,
  toRemoteDevice as project,
  getRemoteTunnel as get,
} from "@saymiao/remote-core/tunnels";
export { RemoteTunnelError } from "@saymiao/remote-core/tunnels";
export type { RemoteTunnelDevice } from "@saymiao/remote-core/tunnels";
export const REMOTE_LABEL = REMOTE_APPLICATIONS.vgent.label;
export const REMOTE_PORT_LABEL = REMOTE_APPLICATIONS.vgent.portLabel;
export const createTunnelManagement = (token: () => Promise<string>) => management(token, "vgent");
export const listRemoteDevices = (client: Parameters<typeof list>[0]) => list(client, "vgent");
export const toRemoteDevice = (tunnel: Parameters<typeof project>[0]) => project(tunnel, "vgent");
export const getRemoteTunnel = (client: Parameters<typeof get>[0], id: string, scopes?: string[]) => get(client, id, scopes, "vgent");
