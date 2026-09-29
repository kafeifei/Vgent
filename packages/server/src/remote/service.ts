import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT } from "../accounts/spec.js";
import { createRemoteController, type RemoteGitHub } from "./controller.js";

export type RemoteService = ReturnType<typeof createRemoteController>;

/** Vgent owns its device identity; the GitHub login it runs as is one of the accounts'. */
export function createRemoteService(options: {
  dataDir: string;
  github: RemoteGitHub;
  backend(): Promise<{ url: string; token: string }>;
}) {
  const directory = join(options.dataDir, "remote");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settingsPath = join(directory, "settings.json");
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取远程控制配置"); }
  if (values == null || Array.isArray(values) || typeof values !== "object") throw new Error("远程控制配置格式错误");
  const settings = {
    get: (key: string) => values[key],
    set(key: string, value: unknown) {
      const next = { ...values, [key]: value };
      const temporary = `${settingsPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, settingsPath);
      values = next;
    },
  };
  const saved = settings.get("remoteDeviceID");
  const deviceID = typeof saved === "string" && /^[a-f0-9-]{36}$/.test(saved) ? saved : randomUUID();
  if (deviceID !== saved) settings.set("remoteDeviceID", deviceID);
  // The single login remote access used to keep is now the first GitHub account.
  if (settings.get("remoteAccountId") === undefined && settings.get("remoteCredentialSaved") === true) settings.set("remoteAccountId", DEFAULT_ACCOUNT.github);
  return createRemoteController({
    github: options.github,
    settings, deviceID, deviceName: hostname().slice(0, 40), changed: () => {},
    list: async (token) => {
      const { createTunnelManagement, listRemoteDevices } = await import("./tunnels.js");
      return listRemoteDevices(createTunnelManagement(token));
    },
    host: async ({ record, ...input }) => {
      const { createTunnelManagement } = await import("./tunnels.js");
      const { startRemoteHost } = await import("./host.js");
      return startRemoteHost({ ...input, ...(record ? { record } : {}), management: createTunnelManagement(input.token), backend: options.backend });
    },
    // SDK errors can contain authorization headers; only the redacted category is logged.
    failed: (failure) => console.warn("Vgent remote", failure),
  });
}
