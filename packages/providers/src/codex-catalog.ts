import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One Codex catalog entry with every field kept: the picker's projection is not a Codex catalog. */
export type CodexCatalogEntry = Record<string, unknown> & { slug: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);

/** The entries of a `GET /models` body or a `models_cache.json`; anything without a slug is dropped. */
export const codexCatalogEntries = (value: unknown): CodexCatalogEntry[] =>
  isRecord(value) && Array.isArray(value.models)
    ? value.models.filter((model): model is CodexCatalogEntry => isRecord(model) && typeof model.slug === "string")
    : [];

/**
 * The catalog the Codex CLI last fetched into `<home>/models_cache.json`.
 * Read-only on purpose: the file belongs to that CLI.
 */
export async function readCodexModelCache(home: string): Promise<{ clientVersion?: string; models: CodexCatalogEntry[] } | undefined> {
  try {
    const cache: unknown = JSON.parse(await readFile(join(home, "models_cache.json"), "utf8"));
    if (!isRecord(cache) || !Array.isArray(cache.models)) return undefined;
    return {
      ...(typeof cache.client_version === "string" ? { clientVersion: cache.client_version } : {}),
      models: codexCatalogEntries(cache),
    };
  } catch {
    return undefined;
  }
}

/** What Codex's own picker shows, in its order: `visibility: "list"`, by `priority`. The first is the account's default. */
export function listedCodexModels<T extends CodexCatalogEntry>(models: readonly T[]): T[] {
  const priorityOf = (entry: T) => (typeof entry.priority === "number" ? entry.priority : Number.MAX_SAFE_INTEGER);
  return models.filter((entry) => entry.visibility === "list").sort((a, b) => priorityOf(a) - priorityOf(b));
}
