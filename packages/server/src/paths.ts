import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".vgent");

/** Explicit option wins, then `VGENT_DATA_DIR`, then `~/.vgent`. */
export function resolveDataDir(dataDir?: string): string {
  return resolve(dataDir ?? process.env.VGENT_DATA_DIR ?? DEFAULT_DATA_DIR);
}
