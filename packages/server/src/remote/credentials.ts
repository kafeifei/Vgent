import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { GitHubCredential } from "./github.js";

const exec = promisify(execFile);

/** An application-owned Keychain item, isolated by Vgent data directory. */
export function createRemoteCredentials(
  dataDir: string,
  configured: { get(): boolean; set(value: boolean): void },
  command: (args: string[], input?: string) => Promise<string> = security,
) {
  const service = `dev.vgent.remote.${createHash("sha256").update(dataDir).digest("hex").slice(0, 24)}`;
  const available = () => process.platform === "darwin";
  const read = async (): Promise<GitHubCredential | undefined> => {
    if (!configured.get()) return;
    if (!available()) throw new Error("Remote credential storage unavailable");
    let encoded: string;
    try {
      encoded = (await command(["find-generic-password", "-a", "github", "-s", service, "-w"])).trim();
    } catch (error) {
      if ((error as { code?: number }).code === 44) return;
      throw new Error("Remote credential storage unavailable");
    }
    return decodeCredential(encoded);
  };
  return {
    available,
    read,
    async write(value: GitHubCredential) {
      if (!available()) throw new Error("Remote credential storage unavailable");
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
      // Send the password on stdin to security's command reader. Putting it in
      // execFile argv would disclose it in process listings and crash reports.
      await command(["-i"], `add-generic-password -U -a github -s ${service} -w ${encoded}\n`).catch(() => {
        throw new Error("Remote credential storage unavailable");
      });
      configured.set(true);
      // The interactive security command may return success despite a failed
      // subcommand. Confirm the saved value before accepting this login.
      const saved = await read();
      if (saved?.accessToken !== value.accessToken || saved.refreshToken !== value.refreshToken) throw new Error("Remote credential was not saved");
    },
    async clear() {
      if (configured.get()) {
        try { await command(["delete-generic-password", "-a", "github", "-s", service]); }
        catch (error) { if ((error as { code?: number }).code !== 44) throw new Error("Remote credential storage unavailable"); }
      }
      configured.set(false);
    },
  };
}

async function security(args: string[], input?: string): Promise<string> {
  if (input === undefined) return (await exec("/usr/bin/security", args, { timeout: 30_000 })).stdout;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "ignore", "pipe"], timeout: 30_000 });
    let failed = false;
    child.stderr.on("data", (data: Buffer) => { if (data.toString().includes("SecKeychain")) failed = true; });
    child.on("error", () => reject(new Error("Remote credential storage unavailable")));
    child.on("close", (code) => code === 0 && !failed ? resolve("") : reject(new Error("Remote credential storage unavailable")));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function decodeCredential(encoded: string): GitHubCredential {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
  catch { throw new Error("Invalid remote credential"); }
  if (!value || typeof value !== "object" || !("accessToken" in value) || typeof value.accessToken !== "string" || !value.accessToken) throw new Error("Invalid remote credential");
  if ("expiresAt" in value && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))) throw new Error("Invalid remote credential");
  if ("refreshToken" in value && typeof value.refreshToken !== "string") throw new Error("Invalid remote credential");
  return value as GitHubCredential;
}
