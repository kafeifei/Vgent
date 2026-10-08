import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Report only public build metadata, never host paths or credentials. */
export async function runtimeEnvironment() {
  const metadata = await readFile(fileURLToPath(new URL("../runtime.json", import.meta.url)), "utf8")
    .then(text => JSON.parse(text) as { version?: string; nodeVersion?: string; pnpmVersion?: string; gitSha?: string })
    .catch(() => undefined);
  return {
    desktop: process.env.VGENT_DESKTOP === "1",
    version: metadata?.version ?? null,
    nodeVersion: metadata?.nodeVersion ?? process.versions.node,
    pnpmVersion: metadata?.pnpmVersion ?? null,
    managedInstaller: process.env.VGENT_PNPM_DIR != null,
    releasesUrl: "https://github.com/kafeifei/Vgent/releases",
  };
}

export interface ApplicationUpdate {
  version: string | null;
  downloadUrl: string | null;
  prerelease: boolean;
  updateAvailable: boolean;
}

/** Select a published installer for this machine, including the preview channel. */
export function selectApplicationUpdate(releases: unknown, current: string, arch = process.arch): ApplicationUpdate {
  const empty: ApplicationUpdate = { version: null, downloadUrl: null, prerelease: false, updateAvailable: false };
  if (!Array.isArray(releases)) throw new Error("GitHub 返回的版本清单无效");
  const compare = (a: string, b: string) => {
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
    return 0;
  };
  let latest = empty;
  for (const release of releases) {
    if (release == null || release.draft !== false || !Array.isArray(release.assets)) continue;
    const tag = release.tag_name;
    if (typeof tag !== "string" || !/^(runtime-[a-f0-9]{40}|v\d+\.\d+\.\d+)$/.test(tag)) continue;
    for (const asset of release.assets) {
      if (typeof asset?.name !== "string") continue;
      const match = /^Vgent-(\d+\.\d+\.\d+)-mac-(arm64|x64)\.zip$/.exec(asset.name);
      if (match == null || match[2] !== arch) continue;
      const version = match[1]!;
      const url = `https://github.com/kafeifei/Vgent/releases/download/${tag}/${asset.name}`;
      if (asset.browser_download_url !== url) continue;
      if (latest.version == null || compare(version, latest.version) > 0) {
        latest = { version, downloadUrl: url, prerelease: release.prerelease === true, updateAvailable: compare(version, current) > 0 };
      }
    }
  }
  return latest;
}

export async function checkApplicationUpdate(): Promise<ApplicationUpdate> {
  const environment = await runtimeEnvironment();
  if (!environment.desktop || environment.version == null) return { version: null, downloadUrl: null, prerelease: false, updateAvailable: false };
  const response = await fetch("https://api.github.com/repos/kafeifei/Vgent/releases?per_page=100", {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`检查应用更新失败：GitHub HTTP ${response.status}`);
  return selectApplicationUpdate(await response.json(), environment.version);
}
