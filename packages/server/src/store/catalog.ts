import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinCatalog, fetchProviderCatalog, type CatalogProvider } from "@vgent/providers";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { writeJsonAtomic } from "./atomic-file.js";

/** Where the catalog in hand came from: just fetched, the copy on disk, or the handful built into the app. */
export type CatalogSource = "live" | "cache" | "builtin";

export interface CatalogSnapshot {
  providers: CatalogProvider[];
  source: CatalogSource;
  /** When models.dev was last read, ISO. Absent for the built-in list. */
  fetchedAt?: string;
}

export interface CatalogStore {
  /**
   * The catalog, without ever making the page wait on the network twice: a
   * fresh copy is returned as is; a stale one is returned too, while a refresh
   * runs behind it; only a machine that has never had one waits for the fetch,
   * and gets the built-in list when that fails.
   */
  get(): Promise<CatalogSnapshot>;
  /** Fetch now. Resolves to the new snapshot, or to what there was when the fetch fails. */
  refresh(): Promise<CatalogSnapshot>;
}

/** 2: models carry `reasoningLevels`; a version-1 file has none and is fetched again. */
const CATALOG_FILE_VERSION = 2;

interface CatalogFile {
  version: typeof CATALOG_FILE_VERSION;
  fetchedAt: string;
  providers: CatalogProvider[];
}

const FRESH_FOR_MS = 24 * 60 * 60 * 1000;

const isCatalogFile = (value: unknown): value is CatalogFile =>
  typeof value === "object" &&
  value !== null &&
  (value as CatalogFile).version === CATALOG_FILE_VERSION &&
  typeof (value as CatalogFile).fetchedAt === "string" &&
  Array.isArray((value as CatalogFile).providers) &&
  (value as CatalogFile).providers.length > 0;

export interface CatalogStoreOptions {
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  now?: () => number;
}

/**
 * models.dev, cached in `<dataDir>/cache/provider-catalog.json`. A cache and
 * nothing more: deleting the file costs one download.
 */
export function createCatalogStore(dataDir: string, options: CatalogStoreOptions = {}): CatalogStore {
  const log = options.log ?? silentLogger;
  const now = options.now ?? Date.now;
  const dir = join(dataDir, "cache");
  const path = join(dir, "provider-catalog.json");

  let memory: CatalogSnapshot | undefined;
  let refreshing: Promise<CatalogSnapshot> | undefined;

  const readDisk = async (): Promise<CatalogSnapshot | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isCatalogFile(parsed)) return { providers: parsed.providers, source: "cache", fetchedAt: parsed.fetchedAt };
    } catch {
      // Missing or mangled: it is a cache, the next fetch rewrites it.
    }
    return undefined;
  };

  const isFresh = (snapshot: CatalogSnapshot): boolean =>
    snapshot.fetchedAt != null && now() - Date.parse(snapshot.fetchedAt) < FRESH_FOR_MS;

  const refresh = (): Promise<CatalogSnapshot> => {
    refreshing ??= (async () => {
      try {
        const providers = await fetchProviderCatalog(options.fetch != null ? { fetch: options.fetch } : {});
        const fetchedAt = new Date(now()).toISOString();
        memory = { providers, source: "live", fetchedAt };
        await mkdir(dir, { recursive: true });
        await writeJsonAtomic(path, { version: CATALOG_FILE_VERSION, fetchedAt, providers } satisfies CatalogFile);
        return memory;
      } catch (error) {
        log.warn?.(`provider catalog: ${error instanceof Error ? error.message : String(error)}`);
        memory ??= (await readDisk()) ?? { providers: builtinCatalog(), source: "builtin" };
        return memory;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  return {
    refresh,
    async get() {
      memory ??= await readDisk();
      if (memory == null || memory.source === "builtin") return refresh();
      if (!isFresh(memory)) void refresh();
      return memory;
    },
  };
}
