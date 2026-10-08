import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { HarnessEngineId, HarnessRuntimeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_SECONDARY, SettingsGroup, SettingsRow, Switch } from "./layout";

/** The one line under an engine's name: what is installed, and what that means right now. */
export function runtimeSummary(runtime: HarnessRuntimeStatus): string {
  if (runtime.working) return runtime.installed != null ? `${runtime.installed} · 正在准备新版` : "正在安装运行时…";
  if (runtime.broken) return "安装不完整，可重试安装";
  if (runtime.installed == null) return "还没安装：第一次用这个引擎时自动装好";
  if (runtime.updateAvailable) {
    const skipped = runtime.latest != null && runtime.bad.includes(runtime.latest);
    return `${runtime.installed} · 最新 ${runtime.latest}${skipped ? "（上次升级失败，不会自动再装）" : ""}`;
  }
  return runtime.latest != null ? `${runtime.installed} · 已是最新` : runtime.installed;
}

/**
 * 引擎运行时: the Claude Code and OpenCode CLIs the harness engines really run.
 * They are installed per user under `~/.vgent/harness`, pinned by the AI SDK
 * adapters well behind the vendors' releases — so this is where they are moved
 * forward, by hand or (the default) on their own.
 */
export function RuntimesSection({
  client,
  autoUpgrade,
  onAutoUpgrade,
  disabled,
}: {
  client: ApiClient;
  autoUpgrade: boolean;
  disabled?: boolean;
  onAutoUpgrade: (next: boolean) => void;
}) {
  const toast = useToast();
  const [runtimes, setRuntimes] = useState<HarnessRuntimeStatus[] | null>(null);
  const [native, setNative] = useState<Awaited<ReturnType<ApiClient["nativeCodexStatus"]>> | null>(null);
  const [environment, setEnvironment] = useState<Awaited<ReturnType<ApiClient["runtimeEnvironment"]>> | null>(null);
  useEffect(() => {
    let disposed = false;
    void client.runtimeEnvironment().then(next => { if (!disposed) setEnvironment(next); }, (error: Error) => toast(error.message));
    return () => { disposed = true; };
  }, [client, toast]);
  const [installingNative, setInstallingNative] = useState(false);
  useEffect(() => {
    if (client.nativeCodexStatus == null) return;
    let disposed = false;
    const refresh = () => void client.nativeCodexStatus().then(next => { if (!disposed) setNative(next); }, () => undefined);
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client]);
  const installNative = () => {
    setInstallingNative(true);
    void client.installNativeCodex().then(() => client.nativeCodexStatus()).then(setNative, (error: Error) => toast(error.message)).finally(() => setInstallingNative(false));
  };
  const [application, setApplication] = useState<Awaited<ReturnType<ApiClient["checkApplicationUpdate"]>> | null>(null);
  const [checking, setChecking] = useState(false);
  /** The engine an install or rollback was asked for, until the server answers. */
  const [pending, setPending] = useState<{ engine: HarnessEngineId; action: "install" | "upgrade" | "rollback" } | null>(null);

  const replace = useCallback(
    (next: HarnessRuntimeStatus) =>
      setRuntimes((current) => current?.map((entry) => (entry.engine === next.engine ? next : entry)) ?? [next]),
    [],
  );

  // Opening the page asks npm once: a stale「已是最新」is worse than a second's wait.
  const check = useCallback(() => {
    setChecking(true);
    Promise.all([client.checkRuntimes(), client.checkApplicationUpdate().then(setApplication)])
      .then(([entries]) => setRuntimes(entries), (error: Error) => {
        toast(error.message);
        return client.listRuntimes().then(setRuntimes, () => undefined);
      })
      .finally(() => setChecking(false));
  }, [client, toast]);
  useEffect(check, [check]);

  // Turn results and automatic updates change this state outside this page.
  // Refresh local status while visible; only an explicit check asks npm again.
  useEffect(() => {
    if (checking || pending != null) return;
    let disposed = false;
    let loading = false;
    const refresh = () => {
      if (document.visibilityState === "hidden" || loading) return;
      loading = true;
      void client.listRuntimes().then((next) => { if (!disposed) setRuntimes(next); }, () => undefined)
        .finally(() => { loading = false; });
    };
    const timer = setInterval(refresh, 3_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, checking, pending]);

  const act = async (engine: HarnessEngineId, action: "install" | "upgrade" | "rollback"): Promise<void> => {
    setPending({ engine, action });
    try {
      if (action === "install") {
        await client.installRuntime(engine);
        setRuntimes(await client.listRuntimes());
      } else {
        replace(await (action === "upgrade" ? client.upgradeRuntime(engine) : client.rollbackRuntime(engine)));
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      await client.listRuntimes().then(setRuntimes, () => undefined);
    } finally {
      setPending(null);
    }
  };

  const checkedAt = runtimes?.find((entry) => entry.lastCheckedAt != null)?.lastCheckedAt;
  const working = pending != null || runtimes?.some((runtime) => runtime.working) === true;

  return (
    <SettingsGroup
      title="运行组件"
      note="统一管理工作台环境和引擎。可提前安装，也可在首次使用时自动安装；已有组件直接复用本地缓存。"
      actions={
        <button type="button" disabled={checking || working} onClick={check} className={BUTTON_GHOST}>
          <RefreshCw className={cn("size-md", checking && "animate-spin")} />
          {checking ? "检查中…" : checkedAt != null ? `检查更新 · ${relativeTime(checkedAt)}` : "检查更新"}
        </button>
      }
    >
      {environment != null && <>
        <SettingsRow title="Vgent 桌面应用" help={environment.desktop ? `当前 ${environment.version ?? "开发版"}${application?.version != null ? ` · ${application.updateAvailable ? "可更新到" : "最新发布"} ${application.version}${application.prerelease ? "（预览版）" : ""}` : ""} · 替换安装后重新打开生效` : "当前运行源码版；桌面版本在 GitHub Releases 发布"}>
          <a className={BUTTON_SECONDARY} href={application?.updateAvailable && application.downloadUrl != null ? application.downloadUrl : environment.releasesUrl} target="_blank" rel="noreferrer">{application?.updateAvailable ? `下载 ${application.version}` : "查看发布版本"}</a>
        </SettingsRow>
        <SettingsRow title="工作台环境" help={`Node.js ${environment.nodeVersion} · ${environment.desktop ? "已安装，与应用版本一起更新" : "使用当前源码环境"}`} />
        <SettingsRow title="安装工具" help={environment.managedInstaller ? `pnpm ${environment.pnpmVersion ?? ""} · 由 Vgent 管理，与工作台一起安装和更新` : "使用本机 pnpm；新版桌面应用自带安装工具"} />
      </>}
      <SettingsRow title="自动升级" help="引擎空闲时自动更新。安装失败保留当前版本；旧版保留到新版成功运行，期间可随时回退。">
        <Switch checked={autoUpgrade} onChange={onAutoUpgrade} label="自动升级引擎运行时" disabled={disabled === true} />
      </SettingsRow>

      {native?.available && (
        <SettingsRow title="Codex" help={native.phase === "ready" ? `${native.version ?? "随应用固定的版本"} · 已安装，与应用版本一起更新` : native.phase === "error" ? native.error : native.phase === "installing" ? "正在校验和安装…" : native.phase === "downloading" ? `正在下载 ${(native.downloaded / 1048576).toFixed(1)} / ${(native.total / 1048576).toFixed(1)} MB` : `GitHub Release · 首次使用时自动安装 · ${(native.total / 1048576).toFixed(1)} MB`}>
          {native.phase !== "ready" && <button type="button" className={BUTTON_SECONDARY} disabled={disabled || installingNative || native.phase === "downloading" || native.phase === "installing"} onClick={installNative}>{native.phase === "downloading" || native.phase === "installing" || installingNative ? "安装中…" : native.phase === "error" ? "重试安装" : "立即安装"}</button>}
        </SettingsRow>
      )}

      {(runtimes ?? []).filter(runtime => !(native?.available && runtime.engine === "codex")).map((runtime) => {
        const action = pending?.engine === runtime.engine ? pending.action : undefined;
        return (
          <SettingsRow
            key={runtime.engine}
            title={runtime.label}
            help={
              <>
                <span>{action === "rollback" ? `${runtime.installed} · 正在回退到 ${runtime.previous}…` : runtimeSummary({ ...runtime, working: action === "upgrade" || runtime.working || action === "install" })}</span>
                <span className="block">来源：npm 官方包</span>
                {runtime.busy && runtime.updateAvailable && <span className="block">任务运行中，结束后可升级</span>}
                {runtime.lastError != null && <span className="block text-danger">{runtime.lastError}</span>}
              </>
            }
          >
            {runtime.installed == null && (
              <button type="button" className={BUTTON_SECONDARY} disabled={disabled || working || checking} onClick={() => act(runtime.engine, "install")}>
                {action === "install" || runtime.working ? "安装中…" : runtime.lastError != null || runtime.broken ? "重试安装" : "立即安装"}
              </button>
            )}
            {runtime.previous != null && (
              <button
                type="button"
                disabled={working || checking || runtime.busy}
                title={runtime.busy ? "有这个引擎的任务在运行，结束后再回退" : `退回 ${runtime.previous}`}
                onClick={() => act(runtime.engine, "rollback")}
                className={BUTTON_GHOST}
              >
                {action === "rollback" ? "回退中…" : `回退到 ${runtime.previous}`}
              </button>
            )}
            {runtime.updateAvailable && (
              <button
                type="button"
                disabled={working || checking || runtime.busy}
                title={runtime.busy ? "有这个引擎的任务在运行，结束后再升级" : undefined}
                onClick={() => act(runtime.engine, "upgrade")}
                className={BUTTON_SECONDARY}
              >
                {action === "upgrade" || runtime.working ? "升级中…" : `升级到 ${runtime.latest}`}
              </button>
            )}
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}
