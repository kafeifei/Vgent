import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

interface Manifest { version?: string; schema: number; gitSha: string; target: string; sha256: string; size: number; url: string }
export interface NativeCodexStatus { version?: string; available: boolean; phase: "missing" | "downloading" | "installing" | "ready" | "error"; downloaded: number; total: number; error?: string }
const states = new Map<string, NativeCodexStatus>();
const pending = new Map<string, Promise<string>>();
const exec = promisify(execFile);

export function validateCodexManifest(manifest: Manifest): void {
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  if (process.platform !== "darwin" || manifest.schema !== 1 || manifest.target !== target || !/^[a-f0-9]{40}$/.test(manifest.gitSha) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.url !== `https://github.com/kafeifei/Vgent/releases/download/runtime-${manifest.gitSha}/Vgent-codex-${target}-${manifest.gitSha}.tar.gz`) {
    throw new Error("Codex 运行环境清单无效。");
  }
}

/** Source/server installations keep using the npm CLI. Desktop deployment alone
 * carries this pinned manifest and downloads the signed vendor tree on demand. */
export async function ensureNativeCodex(dataDir: string, report: (message: string) => void = () => {}): Promise<string | undefined> {
  const manifest = await readManifest();
  if (manifest == null) return undefined;
  const key = join(dataDir, "native-codex", manifest.sha256);
  const previous = pending.get(key);
  if (previous != null) return previous;
  const state: NativeCodexStatus = { ...(manifest.version != null ? { version: manifest.version } : {}), available: true, phase: "downloading", downloaded: 0, total: manifest.size };
  states.set(key, state);
  const installation = installCodexArchive(manifest, key, report, fetch, (phase, downloaded) => {
    state.phase = phase; state.downloaded = downloaded;
  }).then(command => { state.phase = "ready"; return command; }, (error: unknown) => {
    state.phase = "error"; state.error = error instanceof Error ? error.message : String(error); throw error;
  }).finally(() => pending.delete(key));
  pending.set(key, installation);
  return installation;
}

async function readManifest(): Promise<Manifest | undefined> {
  const file = fileURLToPath(new URL("../codex-runtime.json", import.meta.url));
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw == null) return undefined;
  const manifest = JSON.parse(raw) as Manifest;
  validateCodexManifest(manifest);
  return manifest;
}

export async function nativeCodexStatus(dataDir: string): Promise<NativeCodexStatus> {
  const manifest = await readManifest();
  if (manifest == null) return { available: false, phase: "missing", downloaded: 0, total: 0 };
  const key = join(dataDir, "native-codex", manifest.sha256);
  const active = states.get(key);
  if (active != null && active.phase !== "ready") return { ...active };
  const command = join(key, "vendor", manifest.target, "bin/codex");
  const marker = await readFile(join(key, "installed.sha256"), "utf8").catch(() => "");
  const exists = await access(command).then(() => true, () => false);
  return { ...(manifest.version != null ? { version: manifest.version } : {}), available: true, phase: marker === manifest.sha256 && exists ? "ready" : "missing", downloaded: 0, total: manifest.size };
}

export async function installCodexArchive(manifest: Manifest, directory: string, report: (message: string) => void, fetchArchive: typeof fetch = fetch, progress: (phase: "downloading" | "installing", bytes: number) => void = () => {}): Promise<string> {
  validateCodexManifest(manifest);
  const binary = join("vendor", manifest.target, "bin/codex");
  const command = join(directory, binary);
  if (await readFile(join(directory, "installed.sha256"), "utf8").catch(() => "") === manifest.sha256) {
    try { await access(command); return command; } catch { /* Incomplete cache: reinstall. */ }
  }
  report("首次使用 Codex：正在下载并安装引擎运行环境，完成后会自动继续。失败后重新发送即可重试。");
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(join(dirname(directory), ".install-"));
  try {
    const response = await fetchArchive(manifest.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || response.body == null) throw new Error(`Codex 下载失败：HTTP ${response.status}，请检查网络后重试。`);
    const hash = createHash("sha256");
    let size = 0;
    const archive = join(staging, "codex.tar.gz");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > manifest.size) { callback(new Error("Codex 下载大小不匹配。")); return; }
        hash.update(chunk); progress("downloading", size); callback(null, chunk);
      },
    }), createWriteStream(archive, { mode: 0o600 }));
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) throw new Error("Codex 下载校验失败，未执行下载内容；请重试。");
    progress("installing", size);
    const tree = join(staging, "tree");
    await mkdir(tree);
    await exec("/usr/bin/tar", ["-xzf", archive, "-C", tree], { timeout: 120_000 });
    await exec("/usr/bin/codesign", ["--verify", "--strict", "--test-requirement", '=anchor apple generic and certificate leaf[subject.OU] = "UVZM439VGU" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', join(tree, binary)], { timeout: 30_000 });
    await writeFile(join(tree, "installed.sha256"), manifest.sha256);
    await rm(directory, { recursive: true, force: true });
    await rename(tree, directory);
    report("Codex 运行环境安装完成。");
    return command;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
