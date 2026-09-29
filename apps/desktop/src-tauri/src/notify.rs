//! 系统通知, with a click that opens the task it is about.
//!
//! The notification plugin's desktop side is fire-and-forget: a click only
//! raises the app, so the page never learns which notification it was. This
//! command sends the same macOS notification through `mac-notification-sys`
//! (the library under the plugin), waits for the click on a worker thread,
//! then raises the window and tells the page which task to open.

use tauri::{AppHandle, Manager};

/// The page listens for this on `window`; the browser's own notifications fire it too.
const OPEN_TASK_EVENT: &str = "vgent:open-task";

#[tauri::command]
pub fn notify_task(app: AppHandle, title: String, body: String, thread_id: String) {
    #[cfg(target_os = "macos")]
    {
        use mac_notification_sys::{Notification, NotificationResponse};
        // Same identity the plugin gives it: without this the library looks the
        // app up by name and falls back to Finder.
        let _ = mac_notification_sys::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        });
        // Blocks until the notification is clicked or cleared from Notification
        // Center, so each one gets its own thread.
        std::thread::spawn(move || {
            let response = Notification::new()
                .title(&title)
                .message(&body)
                .wait_for_click(true)
                .send();
            if matches!(response, Ok(NotificationResponse::Click)) {
                open_task(&app, &thread_id);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = thread_id;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn open_task(app: &AppHandle, thread_id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let Ok(detail) = serde_json::to_string(thread_id) else {
        return;
    };
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('{OPEN_TASK_EVENT}', {{ detail: {detail} }}))"
    ));
}
