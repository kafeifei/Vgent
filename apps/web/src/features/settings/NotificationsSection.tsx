import { useState } from "react";
import { notificationsSupported, requestNotificationPermission } from "@/features/notify/host";
import { cn } from "@/lib/utils";

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
    <section className="flex flex-col gap-sm">
      <h2 className="font-semibold text-fg text-sm">系统通知</h2>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-sm rounded-md border border-border bg-bg-elevated px-sm py-xs text-left hover:border-border-strong",
          enabled && "border-brand bg-brand-bg hover:border-brand",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-3xs">
          <span className={cn("text-fg text-sm", enabled && "text-brand")}>任务跑完、或者要你审批和回答时提醒</span>
          <span className="text-fg-faint text-xs">只在窗口不在前台时发；点一下把 Vgent 叫到前面来。没有提示音。</span>
        </span>
        <span className="flex-none text-fg-muted text-xs">{enabled ? "开" : "关"}</span>
      </button>
      {!supported && <p className="text-fg-faint text-xs">这个环境不支持系统通知，侧栏的未读点照常。</p>}
      {denied && supported && <p className="text-danger text-xs">系统没给通知权限，去系统设置里给 Vgent 打开「通知」再回来。</p>}
    </section>
  );
}
