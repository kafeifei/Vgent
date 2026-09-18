import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isProviderConfig, slugifyProviderId, RESERVED_PROVIDER_IDS, type ProviderConfig, type ProviderInput } from "@vgent/providers";
import { ConflictError, NotFoundError } from "../errors.js";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

interface ProvidersFile {
  version: 1;
  providers: ProviderConfig[];
}

export interface ProviderStore {
  /** Everything, keys included. Server-internal: a route hands out `redactProvider(...)` of these, never these. */
  list(): Promise<ProviderConfig[]>;
  get(id: string): Promise<ProviderConfig | undefined>;
  create(input: ProviderInput): Promise<ProviderConfig>;
  /** `input.apiKey` absent keeps the stored key, `""` clears it, anything else replaces it. The id never changes. */
  update(id: string, input: ProviderInput): Promise<ProviderConfig>;
  remove(id: string): Promise<void>;
}

const isProvidersFile = (value: unknown): value is ProvidersFile =>
  typeof value === "object" && value !== null && Array.isArray((value as ProvidersFile).providers) && (value as ProvidersFile).providers.every(isProviderConfig);

/**
 * The model providers from the settings page, in `<dataDir>/providers.json`.
 *
 * Its own file rather than a field of `settings.json` for one reason: it holds
 * API keys, and settings are broadcast whole over the state SSE. This file is
 * written 0600, is never served, and the only thing that leaves the process is
 * the redacted form. (The harness resume files are kept the same way.)
 *
 * Every mutation is a read-modify-write *inside* one promise chain, so two
 * requests landing together cannot lose each other's change.
 */
export function createProviderStore(dataDir: string, log: Logger = silentLogger): ProviderStore {
  const path = join(dataDir, "providers.json");
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  const read = async (): Promise<ProviderConfig[]> => {
    const file = await readJsonOrQuarantine<ProvidersFile>(path, { validate: isProvidersFile, log });
    return file?.providers ?? [];
  };

  const write = async (providers: ProviderConfig[]): Promise<void> => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path, { version: 1, providers } satisfies ProvidersFile, { mode: 0o600 });
  };

  /** `deepseek`, then `deepseek-2`, … — adding the same preset twice (two accounts) has to work. */
  const freeId = (wanted: string, taken: ReadonlySet<string>): string => {
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted.slice(0, 36)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  return {
    list: () => serialize(read),

    async get(id) {
      return (await serialize(read)).find((provider) => provider.id === id);
    },

    create: (input) =>
      serialize(async () => {
        const providers = await read();
        const taken = new Set([...providers.map((provider) => provider.id), ...RESERVED_PROVIDER_IDS]);
        if (input.id != null && taken.has(input.id)) throw new ConflictError(`已经有叫 ${JSON.stringify(input.id)} 的提供商`, "provider_exists");
        const provider: ProviderConfig = {
          id: input.id ?? freeId(slugifyProviderId(input.presetId ?? input.name), taken),
          name: input.name,
          ...(input.presetId != null ? { presetId: input.presetId } : {}),
          ...(input.apiKey != null && input.apiKey !== "" ? { apiKey: input.apiKey } : {}),
          agents: input.agents,
        };
        await write([...providers, provider]);
        return provider;
      }),

    update: (id, input) =>
      serialize(async () => {
        const providers = await read();
        const current = providers.find((provider) => provider.id === id);
        if (current == null) throw new NotFoundError(`提供商不存在: ${id}`, "provider_not_found");
        const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey;
        const next: ProviderConfig = {
          id,
          name: input.name,
          ...(current.presetId != null ? { presetId: current.presetId } : {}),
          ...(apiKey != null && apiKey !== "" ? { apiKey } : {}),
          agents: input.agents,
        };
        await write(providers.map((provider) => (provider.id === id ? next : provider)));
        return next;
      }),

    remove: (id) =>
      serialize(async () => {
        const providers = await read();
        if (!providers.some((provider) => provider.id === id)) throw new NotFoundError(`提供商不存在: ${id}`, "provider_not_found");
        await write(providers.filter((provider) => provider.id !== id));
      }),
  };
}
