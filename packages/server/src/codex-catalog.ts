import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CHATGPT_CODEX_BASE_URL,
  codexCatalogEntries,
  createCodexFetch,
  getCodexTokenProvider,
  readCodexModelCache,
  type CodexCatalogEntry,
} from "@vgent/providers";

const isRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);

// The picker refreshes this; turns reuse its full metadata without another
// round trip. Scope it to the credential, so changing accounts cannot reuse it.
let latest: { key: string; at: number; models: CodexCatalogEntry[] } | undefined;

export async function fetchCodexModelCatalog(
  input: { clientVersion: string; signal: AbortSignal },
  env: NodeJS.ProcessEnv,
  options: { reuseFresh?: boolean } = {},
): Promise<CodexCatalogEntry[]> {
  const tokens = getCodexTokenProvider({ env });
  const credential = await tokens.getAccessToken();
  const key = createHash("sha256").update(credential.accessToken).update(input.clientVersion).digest("hex");
  if (options.reuseFresh && latest?.key === key && Date.now() - latest.at < 10 * 60_000) return latest.models;
  const fetch = createCodexFetch({ tokens });
  const response = await fetch(`${CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(input.clientVersion)}`, {
    headers: { accept: "application/json" },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Codex 模型目录返回 ${response.status}`);
  const models = codexCatalogEntries(await response.json());
  if (models.length > 0) latest = { key, at: Date.now(), models };
  return models;
}

/** One immutable snapshot per process, so concurrent turns cannot replace each other's catalog. */
export async function prepareCodexSpeedCatalog(
  home: string,
  model: string,
  tier: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchCatalog?: typeof fetchCodexModelCatalog;
  } = {},
): Promise<{ path: string; dispose(): Promise<void> }> {
  const env = options.env ?? process.env;
  const cache = await readCodexModelCache(resolve(env.CODEX_HOME ?? join(homedir(), ".codex")));
  let models: CodexCatalogEntry[];
  try {
    models = await (options.fetchCatalog ?? fetchCodexModelCatalog)({
      clientVersion: cache?.clientVersion ?? "0.156.1",
      signal: AbortSignal.timeout(5_000),
    }, env, { reuseFresh: true });
    if (models.length === 0) throw new Error("Codex 模型目录为空");
  } catch {
    models = cache?.models ?? [];
  }
  const selected = models.find((entry) => entry.slug === model);
  if (!Array.isArray(selected?.service_tiers) || !selected.service_tiers.some((entry) => isRecord(entry) && entry.id === tier)) {
    throw new Error(`Codex 模型目录未提供 ${model} 的 ${tier} 速度档位，请刷新模型列表或选择标准速度`);
  }
  const directory = await mkdtemp(join(home, "speed-catalog-"));
  const path = join(directory, "models.json");
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(path, JSON.stringify({ models }), { mode: 0o600 });
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
