import { useState } from "react";
import { notificationsSupported, requestNotificationPermission } from "@/features/notify/host";
import { SettingsGroup, SettingsRow, Switch } from "./layout";

/**
 * 「系统通知」: one switch, default on. Turning it on is also the only place the
 * permission prompt may come from — a browser ignores it outside a click, and
 * asking on page load is the thing nobody wants.
 */
export function NotificationsSection({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [denied, setDenied] = useState(false);
  const supported = notificationsSupported();

  const toggle = () => {
    if (enabled) {
      setDenied(false);
      onChange(false);
      return;
    }
    // The setting goes on either way: it is the user's answer, not the OS's.
    onChange(true);
    void requestNotificationPermission().then((granted) => setDenied(!granted));
  };

  return (
    <SettingsGroup
      note={
        !supported ? (
          "这个环境不支持系统通知，侧栏的未读点照常。"
        ) : denied ? (
          <span className="text-danger">系统没给通知权限，去系统设置里给 Vgent 打开「通知」再回来。</span>
        ) : undefined
      }
    >
      <SettingsRow title="系统通知" help="任务跑完、或者要你审批和回答时提醒。只在窗口不在前台时发；点一下把 Vgent 叫到前面来。没有提示音。">
        <Switch checked={enabled} onChange={toggle} label="系统通知" />
      </SettingsRow>
    </SettingsGroup>
  );
}
