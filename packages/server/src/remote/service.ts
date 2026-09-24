import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createRemoteCredentials } from "./credentials.js";
import { createRemoteController } from "./controller.js";
import { createGitHubClient } from "./github.js";

export type RemoteService = ReturnType<typeof createRemoteController>;

/** Vgent owns its credential and device identity; no other application's state is read. */
export function createRemoteService(options: {
  dataDir: string;
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
  const github = createGitHubClient();
  const clientId = process.env.VGENT_GITHUB_CLIENT_ID;
  return createRemoteController({
    settings, deviceID, deviceName: hostname().slice(0, 40), changed: () => {},
    credentials: createRemoteCredentials(options.dataDir, {
      get: () => settings.get("remoteCredentialSaved") === true,
      set: (value) => settings.set("remoteCredentialSaved", value),
    }),
    login: (input) => github.beginGitHubLogin({ ...input, ...(clientId ? { clientId } : {}) }),
    waitLogin: (auth, input) => github.waitGitHubLogin(auth, { ...input, ...(clientId ? { clientId } : {}) }),
    account: github.getGitHubAccount,
    refreshCredential: (value) => github.refreshGitHubCredential(value, clientId ? { clientId } : {}),
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
