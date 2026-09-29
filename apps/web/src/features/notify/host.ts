/**
 * Where a notification actually goes out.
 *
 * In the desktop shell the workbench is a remote page (`http://127.0.0.1:<port>`)
 * and reaches the shell through `window.__TAURI__`, exactly like the folder
 * picker reaches the dialog plugin: permission through the notification plugin,
 * sending through the shell's own `notify_task`, whose click the plugin cannot
 * report. `capabilities/main.json` grants that origin those and nothing else.
 * In a plain browser it is the Web Notification API.
 *
 * Either way a click comes back as {@link OPEN_TASK_EVENT} on `window`.
 */

import type { NotifyDecision } from "./notify";

type TauriNotification = {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<string>;
};

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriHost {
  __TAURI__?: { core?: { invoke?: TauriInvoke }; notification?: TauriNotification };
}

/** Dispatched by `apps/desktop/src-tauri/src/notify.rs` too; keep the name in step. */
const OPEN_TASK_EVENT = "vgent:open-task";

/** The desktop shell, when this page is running inside it. */
function tauriShell(): { notification: TauriNotification; invoke: TauriInvoke } | undefined {
  const tauri = (globalThis as unknown as TauriHost).__TAURI__;
  const notification = tauri?.notification;
  const invoke = tauri?.core?.invoke;
  return notification != null && typeof invoke === "function" ? { notification, invoke } : undefined;
}

const webNotification = (): typeof Notification | undefined =>
  typeof Notification === "undefined" ? undefined : Notification;

/** Whether anything here could ever notify — the setting says so when it cannot. */
export function notificationsSupported(): boolean {
  return tauriShell() != null || webNotification() != null;
}

/**
 * Ask for permission. Called from the click that turns 「系统通知」 on and from
 * nowhere else: the browser only honours the prompt inside a user gesture, and
 * asking on page load is exactly the thing every user hates. Resolves to
 * whether we may notify now.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const tauri = tauriShell()?.notification;
  if (tauri != null) {
    try {
      if ((await tauri.isPermissionGranted?.()) === true) return true;
      return (await tauri.requestPermission?.()) === "granted";
    } catch {
      return false;
    }
  }
  const api = webNotification();
  if (api == null) return false;
  if (api.permission === "granted") return true;
  if (api.permission === "denied") return false;
  try {
    return (await api.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Deliver one notification. Returns whether it went out, and logs the line it
 * sent — 「发了没有」 has to be checkable without watching the screen. Clicking
 * it raises the window and fires {@link OPEN_TASK_EVENT} with the task's id.
 */
export async function sendSystemNotification(decision: NotifyDecision): Promise<boolean> {
  const sent = await deliver(decision);
  if (sent) console.info(`[通知] ${decision.title} — ${decision.body}`);
  return sent;
}

/** Calls `open` with the task a clicked notification is about; returns the unsubscribe. */
export function onNotificationOpen(open: (threadId: string) => void): () => void {
  const listener = (event: Event) => {
    const threadId = (event as CustomEvent<unknown>).detail;
    if (typeof threadId === "string") open(threadId);
  };
  window.addEventListener(OPEN_TASK_EVENT, listener);
  return () => window.removeEventListener(OPEN_TASK_EVENT, listener);
}

async function deliver(decision: NotifyDecision): Promise<boolean> {
  const tauri = tauriShell();
  if (tauri != null) {
    const { notification, invoke } = tauri;
    try {
      // The OS permission belongs to the app, not to a gesture, so it is fine
      // to make sure of it here; macOS only ever prompts once.
      if ((await notification.isPermissionGranted?.()) !== true && (await notification.requestPermission?.()) !== "granted") return false;
      await invoke("notify_task", { title: decision.title, body: decision.body, threadId: decision.threadId });
      return true;
    } catch {
      return false;
    }
  }
  const api = webNotification();
  // Never prompts: permission is asked for in 设置, on the user's own click.
  if (api == null || api.permission !== "granted") return false;
  try {
    // One notification per task at a time: a second one on the same task
    // replaces the first instead of stacking up.
    const notification = new api(decision.title, { body: decision.body, tag: `vgent-${decision.threadId}` });
    notification.onclick = () => {
      window.focus();
      window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: decision.threadId }));
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
