import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import type { CuaStatus, CuaTestResult } from "@/lib/types";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_SECONDARY, SettingsGroup, SettingsRow, Switch, Tag } from "./layout";

const INSTALL_URL = "https://cua.ai/docs/how-to-guides/driver/install";

const permissionText = (value: boolean | null): string =>
  value === true ? "已授权" : value === false ? "未授权" : "尚未确认";

export function ComputerUseSection({
  client,
  enabled,
  onEnabledChange,
}: {
  client: ApiClient;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<CuaStatus | null>(null);
  const [pending, setPending] = useState<"refresh" | "start" | "permissions" | "test" | null>(null);
  const [testResult, setTestResult] = useState<CuaTestResult | null>(null);

  const refresh = useCallback(async () => {
    setPending("refresh");
    try { setStatus(await client.getCuaStatus()); }
    catch (error) { toast(error instanceof Error ? error.message : String(error)); }
    finally { setPending(null); }
  }, [client, toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (kind: "start" | "permissions" | "test") => {
    setPending(kind);
    try {
      if (kind === "test") setTestResult(await client.testCuaDriver());
      else {
        setStatus(await (kind === "start" ? client.startCuaDriver() : client.requestCuaPermissions()));
        setTestResult(null);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      setStatus(await client.getCuaStatus().catch(() => status));
    } finally { setPending(null); }
  };

  const busy = pending != null;
  const canRequestPermissions = status?.installed === true && status.running;
  const needsAccessibility = canRequestPermissions && status.accessibility !== true;
  const needsScreenRecording = canRequestPermissions && status.screenRecording !== true;
  const permissionButton = (
    <button type="button" disabled={busy} onClick={() => void act("permissions")} className={BUTTON_SECONDARY}>
      {pending === "permissions" ? "等待授权…" : "请求系统授权"}
    </button>
  );

  return (
    <SettingsGroup
      title="Cua Driver"
      note="通过官方安装的 CuaDriver.app 控制本机桌面，系统权限授予 CuaDriver。Codex 引擎当前全自动；其桌面动作遵循 Cua Driver 的权限模式。"
      actions={
        <button type="button" disabled={busy} onClick={() => void refresh()} className={BUTTON_GHOST}>
          <RefreshCw className={cn("size-md", pending === "refresh" && "animate-spin")} />
          检查状态
        </button>
      }
    >
      <SettingsRow
        title={<>启用 Computer Use {status?.ready === true && <Tag>驱动已就绪</Tag>}</>}
        help="保存后，新回合可以调用 Cua Driver；各引擎使用同一份本机授权。"
      >
        <Switch checked={enabled} onChange={onEnabledChange} disabled={!enabled && status?.ready !== true} label="启用 Cua Driver Computer Use" />
      </SettingsRow>

      <SettingsRow
        title="安装"
        help={status == null ? "检查中…" : status.installed ? status.version ?? "已安装" : "未安装 Cua Driver"}
      >
        {status?.installed !== true && (
          <a href={INSTALL_URL} target="_blank" rel="noreferrer" className={BUTTON_SECONDARY}>查看官方安装说明</a>
        )}
      </SettingsRow>

      <SettingsRow title="服务" help={status == null ? "检查中…" : status.running ? `正在运行${status.permissionMode == null ? "" : ` · ${status.permissionMode} 模式`}` : "未运行"}>
        {status?.installed === true && !status.running && (
          <button type="button" disabled={busy} onClick={() => void act("start")} className={BUTTON_SECONDARY}>
            {pending === "start" ? "启动中…" : "启动服务"}
          </button>
        )}
      </SettingsRow>

      <SettingsRow title="辅助功能" help={status == null ? "检查中…" : permissionText(status.accessibility)}>
        {needsAccessibility && permissionButton}
      </SettingsRow>
      <SettingsRow title="屏幕录制" help={status == null ? "检查中…" : permissionText(status.screenRecording)}>
        {!needsAccessibility && needsScreenRecording && permissionButton}
      </SettingsRow>

      <SettingsRow
        title="桌面连接"
        help={testResult?.message ?? (status?.ready === true ? "可测试桌面应用读取" : "完成安装、启动和授权后可测试")}
      >
        <button type="button" disabled={busy || status?.ready !== true} onClick={() => void act("test")} className={BUTTON_SECONDARY}>
          {pending === "test" ? "测试中…" : "测试连接"}
        </button>
      </SettingsRow>
      {status?.error != null && <div className="px-md py-sm text-danger text-sm">{status.error}</div>}
    </SettingsGroup>
  );
}
