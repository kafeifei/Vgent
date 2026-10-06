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
  if (runtime.working) return runtime.installed != null ? `${runtime.installed} · 正在准备新版` : "正在恢复运行时…";
  if (runtime.broken) return "安装不完整（上次安装被打断）：重新打开这一页会自动修复";
  if (runtime.installed == null) return "还没安装：第一次用这个引擎时自动装好";
  if (runtime.updateAvailable) {
    const skipped = runtime.latest != null && runtime.bad.includes(runtime.latest);
    return `${runtime.installed} · 最新 ${runtime.latest}${skipped ? "（上次升级失败，不会自动再装）" : ""}`;
  }
  return runtime.latest != null ? `${runtime.installed} · 已是最新` : runtime.installed;
}

/**
 * 引擎运行时: the Claude Code and Codex CLIs the two harness engines really run.
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
  const [checking, setChecking] = useState(false);
  /** The engine an install or rollback was asked for, until the server answers. */
  const [pending, setPending] = useState<{ engine: HarnessEngineId; action: "upgrade" | "rollback" } | null>(null);

  const replace = useCallback(
    (next: HarnessRuntimeStatus) =>
      setRuntimes((current) => current?.map((entry) => (entry.engine === next.engine ? next : entry)) ?? [next]),
    [],
  );

  // Opening the page asks npm once: a stale「已是最新」is worse than a second's wait.
  const check = useCallback(() => {
    setChecking(true);
    client
      .checkRuntimes()
      .then(setRuntimes, (error: Error) => {
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

  const act = (engine: HarnessEngineId, action: "upgrade" | "rollback"): void => {
    setPending({ engine, action });
    (action === "upgrade" ? client.upgradeRuntime(engine) : client.rollbackRuntime(engine))
      .then(replace, (error: Error) => {
        toast(error.message);
        // A refused or rolled-back install still changed what there is to show.
        return client.listRuntimes().then(setRuntimes, () => undefined);
      })
      .finally(() => setPending(null));
  };

  const checkedAt = runtimes?.find((entry) => entry.lastCheckedAt != null)?.lastCheckedAt;
  const working = pending != null || runtimes?.some((runtime) => runtime.working) === true;

  return (
    <SettingsGroup
      title="引擎运行时"
      note={native?.available ? "Codex 随应用版本固定，可提前安装；Claude Code 支持独立升级。" : "引擎在首次使用时安装，运行时和终端里的安装独立。"}
      actions={
        <button type="button" disabled={checking || working} onClick={check} className={BUTTON_GHOST}>
          <RefreshCw className={cn("size-md", checking && "animate-spin")} />
          {checking ? "检查中…" : checkedAt != null ? `检查更新 · ${relativeTime(checkedAt)}` : "检查更新"}
        </button>
      }
    >
      <SettingsRow title="自动升级" help="引擎空闲时自动更新。安装失败保留当前版本；旧版保留到新版成功运行，期间可随时回退。">
        <Switch checked={autoUpgrade} onChange={onAutoUpgrade} label="自动升级引擎运行时" disabled={disabled === true} />
      </SettingsRow>

      {native?.available && (
        <SettingsRow title="原生 Codex" help={native.phase === "ready" ? "已安装，后续直接使用本地缓存" : native.phase === "error" ? native.error : native.phase === "installing" ? "正在校验和安装…" : native.phase === "downloading" ? `正在下载 ${(native.downloaded / 1048576).toFixed(1)} / ${(native.total / 1048576).toFixed(1)} MB` : `首次使用时自动安装 · ${(native.total / 1048576).toFixed(1)} MB`}>
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
                <span>{action === "rollback" ? `${runtime.installed} · 正在回退到 ${runtime.previous}…` : runtimeSummary({ ...runtime, working: action === "upgrade" || runtime.working })}</span>
                {runtime.busy && runtime.updateAvailable && <span className="block">任务运行中，结束后可升级</span>}
                {runtime.lastError != null && <span className="block text-danger">{runtime.lastError}</span>}
              </>
            }
          >
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
