import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { HarnessEngineId, HarnessRuntimeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_SECONDARY, SettingsGroup, SettingsRow, Switch, Tag } from "./layout";

/** The one line under an engine's name: what is installed, and what that means right now. */
export function runtimeSummary(runtime: HarnessRuntimeStatus): string {
  // Mid-install the packages are briefly not there at all; that is not「还没安装」.
  if (runtime.working) return runtime.installed != null ? `${runtime.installed} · 正在安装…` : "正在安装…别退出 Vgent";
  if (runtime.broken) return "安装不完整（上次安装被打断）：重新打开这一页会自动修复";
  if (runtime.installed == null) return "还没安装：第一次用这个引擎时自动装好";
  if (runtime.unverified) return `${runtime.installed} · 刚升级，等第一轮跑通；跑不起来会自动退回 ${runtime.previous ?? "上一版"}`;
  if (runtime.updateAvailable) {
    const skipped = runtime.latest != null && runtime.bad.includes(runtime.latest);
    return `${runtime.installed} · 最新 ${runtime.latest}${skipped ? "（上次装它没跑起来，不会自动再装）" : ""}`;
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
}: {
  client: ApiClient;
  autoUpgrade: boolean;
  onAutoUpgrade: (next: boolean) => void;
}) {
  const toast = useToast();
  const [runtimes, setRuntimes] = useState<HarnessRuntimeStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  /** The engine an install or rollback was asked for, until the server answers. */
  const [pending, setPending] = useState<HarnessEngineId | null>(null);

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

  const act = (engine: HarnessEngineId, action: "upgrade" | "rollback"): void => {
    setPending(engine);
    (action === "upgrade" ? client.upgradeRuntime(engine) : client.rollbackRuntime(engine))
      .then(replace, (error: Error) => {
        toast(error.message);
        // A refused or rolled-back install still changed what there is to show.
        return client.listRuntimes().then(setRuntimes, () => undefined);
      })
      .finally(() => setPending(null));
  };

  const checkedAt = runtimes?.find((entry) => entry.lastCheckedAt != null)?.lastCheckedAt;

  return (
    <SettingsGroup
      title="引擎运行时"
      note="Claude Code 和 Codex 的 CLI，装在 ~/.vgent/harness 里，和你自己终端里的那份无关。"
      actions={
        <button type="button" disabled={checking} onClick={check} className={BUTTON_GHOST}>
          <RefreshCw className={cn("size-md", checking && "animate-spin")} />
          {checking ? "检查中…" : checkedAt != null ? `检查更新 · ${relativeTime(checkedAt)}` : "检查更新"}
        </button>
      }
    >
      <SettingsRow title="自动升级" help="没有任务在跑时自动装最新版；装完验证不过、或者第一轮跑不起来，会自动退回上一版。">
        <Switch checked={autoUpgrade} onChange={onAutoUpgrade} label="自动升级引擎运行时" />
      </SettingsRow>

      {(runtimes ?? []).map((runtime) => {
        const busy = pending === runtime.engine || runtime.working;
        return (
          <SettingsRow
            key={runtime.engine}
            title={
              <>
                <span>{runtime.label}</span>
                {runtime.unverified && <Tag>待验证</Tag>}
              </>
            }
            help={
              <>
                <span>{runtimeSummary(runtime)}</span>
                {runtime.lastError != null && <span className="block text-danger">{runtime.lastError}</span>}
              </>
            }
          >
            {runtime.previous != null && (
              <button
                type="button"
                disabled={busy || runtime.busy}
                title={runtime.busy ? "有这个引擎的任务在运行，结束后再回退" : `退回 ${runtime.previous}`}
                onClick={() => act(runtime.engine, "rollback")}
                className={BUTTON_GHOST}
              >
                回退到 {runtime.previous}
              </button>
            )}
            {runtime.updateAvailable && (
              <button
                type="button"
                disabled={busy || runtime.busy}
                title={runtime.busy ? "有这个引擎的任务在运行，结束后再升级" : undefined}
                onClick={() => act(runtime.engine, "upgrade")}
                className={BUTTON_SECONDARY}
              >
                {busy ? "安装中，别退出…" : `升级到 ${runtime.latest}`}
              </button>
            )}
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}
