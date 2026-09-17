import { randomBytes } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import type { Logger } from "../types.js";

/**
 * Write JSON so a reader never sees a half-written file, and so the rename is
 * durable across a power cut: temp file in the same directory → fsync the file
 * → rename → fsync the parent directory.
 */
export async function writeJsonAtomic(path: string, value: unknown, options?: { mode?: number }): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tmpPath, json, options?.mode != null ? { mode: options.mode } : {});
    const handle = await open(tmpPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  // The rename itself is only durable once the directory entry is flushed.
  const dirHandle = await open(dir, "r").catch(() => undefined);
  if (dirHandle != null) {
    try {
      await dirHandle.sync();
    } catch {
      // Some filesystems refuse fsync on a directory handle; the rename stands.
    } finally {
      await dirHandle.close();
    }
  }
}

/**
 * Read JSON, quarantining anything unreadable instead of throwing: a corrupt
 * file is renamed `<path>.corrupt-<ISO ts>` and the caller gets `undefined`,
 * so one bad thread can never take the server down.
 */
export async function readJsonOrQuarantine<T>(
  path: string,
  options?: { validate?: (value: unknown) => value is T; log?: Logger },
): Promise<T | undefined> {
  let raw: string;
  try {
    const handle = await open(path, "r");
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantine(path, options?.log);
    return undefined;
  }
  if (options?.validate != null && !options.validate(parsed)) {
    await quarantine(path, options.log);
    return undefined;
  }
  return parsed as T;
}

async function quarantine(path: string, log?: Logger): Promise<void> {
  const target = `${path}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`;
  await rename(path, target).catch(() => {});
  log?.warn(`文件损坏，已移到 ${target}`);
}
