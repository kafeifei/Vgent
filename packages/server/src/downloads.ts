/**
 * 「下载」: a copy of one of the task's files in the user's Downloads folder.
 *
 * The server does it rather than the page because the page is as often a
 * desktop WebView as a browser, and a WebView has no download shelf: an
 * `<a download>` there goes nowhere. Both have this server on the same machine.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export const defaultDownloadsDir = (): string => join(homedir(), "Downloads");

/** `name.svg`, then `name (1).svg`, … — whichever is free. Never overwrites. */
export async function saveDownload(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safe = basename(name).replace(/[\0/\\:]/g, "_") || "download";
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const target = join(dir, attempt === 0 ? safe : `${stem} (${attempt})${extension}`);
    try {
      // `wx` is the check and the claim in one step.
      await writeFile(target, bytes, { flag: "wx" });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`下载文件夹里同名文件太多: ${safe}`);
}
