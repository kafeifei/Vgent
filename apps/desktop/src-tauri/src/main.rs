#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod notify;
mod runtime;
mod server_log;
mod unfinished;

use backend::{Backend, BackendReady};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    webview::NewWindowResponse,
    Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

#[derive(Clone, Default)]
struct Lifecycle {
    backend: Arc<Mutex<Option<Backend>>>,
    /// Loopback origin and token, kept so a quit can ask which sessions are still open.
    connection: Arc<Mutex<Option<BackendReady>>>,
    closing: Arc<AtomicBool>,
    /// A quit confirmation is already on screen. A second ⌘Q must not stack another.
    confirming: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
}

/// Clears `confirming` even if the quit check panics, so a later ⌘Q can ask again.
struct ResetConfirm(Arc<AtomicBool>);

impl Drop for ResetConfirm {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Lifecycle {
    fn shutdown(&self) {
        if let Ok(mut slot) = self.backend.lock() {
            if let Some(mut backend) = slot.take() {
                backend.shutdown();
            }
        }
        self.stopped.store(true, Ordering::SeqCst);
    }

    fn request_exit(&self, app: &tauri::AppHandle, code: i32) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        app.state::<runtime::RuntimeState>().cancel();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_title("Vgent · 正在停止任务…");
        }
        let lifecycle = self.clone();
        let app = app.clone();
        // Stopping runs can take seconds; the UI thread must not block on it.
        thread::spawn(move || {
            lifecycle.shutdown();
            app.exit(code);
        });
    }

    /// ⌘Q / Quit menu / AppleEvent. Stop immediately when nothing is mid-turn;
    /// otherwise ask. The dialog blocks a worker thread — `blocking_show` on the
    /// UI thread deadlocks, because the plugin hops the alert back onto it.
    fn confirm_then_exit(&self, app: &tauri::AppHandle, code: i32) {
        if self.closing.load(Ordering::SeqCst) || self.confirming.swap(true, Ordering::SeqCst) {
            return;
        }
        let lifecycle = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            let _reset = ResetConfirm(lifecycle.confirming.clone());
            let sessions = lifecycle.connection.lock().ok().and_then(|slot| {
                slot.as_ref()
                    .map(|ready| unfinished::fetch_open_sessions(&ready.url, &ready.token))
            });
            let proceed = match sessions {
                Some(Ok(open)) if !open.is_empty() => ask_to_quit(&app, &open),
                Some(Err(error)) => {
                    eprintln!("[desktop] 退出前没能确认任务状态（{error}），继续退出。");
                    true
                }
                _ => true,
            };
            if proceed {
                lifecycle.request_exit(&app, code);
            }
        });
    }
}

/// True only when the user explicitly chose 退出. The first button is 取消, so
/// Return stays in the app; closing the alert any other way does too.
fn ask_to_quit(app: &tauri::AppHandle, sessions: &[unfinished::OpenSession]) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let result = app
        .dialog()
        .message(unfinished::quit_warning(sessions))
        .title("还有任务没完成")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "取消".into(),
            "退出".into(),
        ))
        .blocking_show_with_result();
    matches!(result, MessageDialogResult::Custom(label) if label == "退出")
}

/// Where the bundled runtime and resources live. A dev run has no `.app`, so it
/// reads the same tree `scripts/prepare-desktop.mjs` just wrote.
struct Bundle {
    node: PathBuf,
    script: PathBuf,
    web_dist: PathBuf,
}

fn locate_bundle(app: &tauri::AppHandle) -> Result<Bundle, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if tauri::is_dev() {
        return Ok(Bundle {
            node: manifest.join(format!(
                "binaries/vgent-node-{}-apple-darwin",
                std::env::consts::ARCH
            )),
            script: manifest.join("resources/server/dist/main.js"),
            web_dist: manifest.join("resources/web"),
        });
    }
    let manifest = runtime::manifest(app)?;
    let state = app.state::<runtime::RuntimeState>();
    let archive = app.path().resource_dir().map_err(|e| e.to_string())?.join("workbench.tar.gz");
    let root = runtime::install(&manifest, &data_dir()?, &state, &archive)?;
    Ok(Bundle {
        node: root.join("node"),
        script: root.join("server/dist/main.js"),
        web_dist: root.join("web"),
    })
}

/// Mirrors `resolveDataDir` in `packages/server/src/paths.ts`: the shell has to
/// look for `connection.json` exactly where the server will write it.
fn data_dir() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("VGENT_DATA_DIR") {
        return Ok(PathBuf::from(explicit));
    }
    let home = std::env::var_os("HOME").ok_or("找不到用户主目录。")?;
    Ok(PathBuf::from(home).join(".vgent"))
}

fn is_internal_navigation(url: &Url, server: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.origin() == server.origin())
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        if let Err(error) = open::that_detached(url.as_str()) {
            eprintln!("[desktop] 无法打开默认浏览器：{error}");
        }
    }
}

fn create_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let lifecycle = app.state::<Lifecycle>().inner().clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Vgent")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .decorations(true)
        .devtools(true);
    // The page has no window bar of its own: its columns run to the top edge and
    // their 35px strips are the title bar (`data-tauri-drag-region`). On macOS the
    // native bar is laid over the page, with the traffic lights centred on that strip.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));
    builder
        .on_navigation(move |url| {
            let internal = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || lifecycle
                    .connection
                    .lock()
                    .ok()
                    .and_then(|slot| {
                        slot.as_ref()
                            .map(|ready| is_internal_navigation(url, &ready.url))
                    })
                    .unwrap_or(false);
            if internal {
                true
            } else {
                open_external(url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

#[tauri::command]
fn runtime_status(
    state: tauri::State<'_, runtime::RuntimeState>,
) -> Result<runtime::Status, String> {
    state
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "无法读取安装状态".into())
}
#[tauri::command]
fn runtime_retry(app: tauri::AppHandle) {
    start_runtime(&app);
}

/// Installation and Node startup happen away from the native UI thread. Retry is
/// local-only, and an atomic guard prevents overlapping installers/backends.
fn start_runtime(app: &tauri::AppHandle) {
    let state = app.state::<runtime::RuntimeState>().inner().clone();
    let lifecycle = app.state::<Lifecycle>().inner().clone();
    if lifecycle.closing.load(Ordering::SeqCst) || state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    if lifecycle
        .connection
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(true)
    {
        state.busy.store(false, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let bundle = locate_bundle(&app)?;
            if state.cancelled.load(Ordering::SeqCst) {
                return Err("启动已取消。".into());
            }
            state.update("starting", "正在启动工作台…", 0, 0);
            let mut slot = lifecycle.backend.lock().map_err(|_| "无法记录服务进程")?;
            let (mut backend, ready) = Backend::spawn_tracked(
                &bundle.node,
                &bundle.script,
                &bundle.web_dist,
                &data_dir()?,
                Some(&state),
            )
            .map_err(|e| e.message().to_string())?;
            // Hold the backend slot across checking closing and publishing; quit
            // cannot miss a process started while the handshake was in progress.
            if lifecycle.closing.load(Ordering::SeqCst) {
                backend.shutdown();
                return Err("启动已取消。".into());
            }
            *lifecycle
                .connection
                .lock()
                .map_err(|_| "无法记录服务地址")? = Some(ready.clone());
            *slot = Some(backend);
            drop(slot);
            let mut location = ready.url;
            location.set_fragment(Some(&format!("token={}", ready.token)));
            app.get_webview_window("main")
                .ok_or("工作台窗口不存在")?
                .navigate(location)
                .map_err(|e| e.to_string())?;
            state.update("ready", "运行环境已就绪", 0, 0);
            let app_handle = app.clone();
            let lifecycle = lifecycle.clone();
            thread::spawn(move || loop {
                if lifecycle.closing.load(Ordering::SeqCst) {
                    return;
                }
                // A quit takes the backend out of the slot before stopping
                // it, so an exit seen here was not asked for.
                let exited = lifecycle
                    .backend
                    .lock()
                    .map(|mut slot| {
                        slot.as_mut().is_some_and(|backend| {
                            let Some(status) = backend.exit_status() else {
                                return false;
                            };
                            backend.record_exit("内置服务意外退出", status);
                            true
                        })
                    })
                    .unwrap_or(false);
                if exited {
                    let handle = app_handle.clone();
                    app_handle
                        .dialog()
                        .message("内置服务意外退出。已保存的任务仍保留；请重新打开 Vgent。")
                        .title("Vgent")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            });
            Ok(())
        })();
        if let Err(error) = result {
            if lifecycle.closing.load(Ordering::SeqCst) {
                state.busy.store(false, Ordering::SeqCst);
                return;
            }
            lifecycle.shutdown();
            // Startup failure is retryable, unlike normal application shutdown.
            lifecycle.stopped.store(false, Ordering::SeqCst);
            *lifecycle.connection.lock().unwrap() = None;
            state.update("error", &error, 0, 0);
        }
        state.busy.store(false, Ordering::SeqCst);
    });
}

fn main() {
    let lifecycle = Lifecycle::default();
    let cleanup = lifecycle.clone();
    let builder = tauri::Builder::default()
        // Must be the first plugin registered (the plugin's own requirement). A
        // second launch hands its arguments here and exits, so it never gets as
        // far as starting a rival server on the same data directory.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Before the backend is up there is no window yet; nothing to raise.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // 系统通知: the page asks the plugin for permission through
        // `window.__TAURI__.notification`, and sends through `notify_task` so a
        // click can open the task. `capabilities/main.json` opens exactly those.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            notify::notify_task,
            runtime_status,
            runtime_retry
        ])
        .manage(runtime::RuntimeState::default())
        .manage(lifecycle)
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let inspector =
                MenuItem::with_id(app, "devtools", "开发者工具", true, Some("CmdOrCtrl+Alt+I"))?;
            menu.append(&Submenu::with_items(app, "调试", true, &[&inspector])?)?;
            app.set_menu(menu)?;

            create_window(app.handle())?;
            start_runtime(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "devtools" {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            // ⌘W and the red button both ask to close the window. On macOS that
            // must not quit: hide it, leave the process and the embedded server
            // running so in-flight tasks keep going. Quit is ⌘Q, the Quit menu
            // item, or an AppleEvent — those hit `ExitRequested` / `Exit` below.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(|handle, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                let lifecycle = handle.state::<Lifecycle>();
                if !lifecycle.stopped.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    lifecycle.confirm_then_exit(handle, code.unwrap_or(0));
                }
            }
            // `⌘Q` and an AppleEvent quit go through `applicationWillTerminate`,
            // which neither `prevent_exit` nor a detached thread can outlive: the
            // process is gone the moment this returns. So stop the server *here*,
            // synchronously. `shutdown` holds the lock across the whole stop, so a
            // `request_exit` thread already doing it just makes this call wait.
            RunEvent::Exit => {
                handle
                    .state::<Lifecycle>()
                    .closing
                    .store(true, Ordering::SeqCst);
                handle.state::<runtime::RuntimeState>().cancel();
                handle.state::<Lifecycle>().shutdown();
            }
            // Dock-icon click while the window is hidden or minimized.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }),
        Err(error) => eprintln!("Vgent 启动失败：{error}"),
    }
    cleanup.shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_policy_keeps_web_content_out_of_the_workbench() {
        let server = Url::parse("http://127.0.0.1:53211/").unwrap();
        assert!(is_internal_navigation(
            &Url::parse("http://127.0.0.1:53211/threads/abc").unwrap(),
            &server
        ));
        assert!(is_internal_navigation(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            &server
        ));
        for target in [
            "https://chatgpt.com",
            "http://127.0.0.1:7412/",
            "http://localhost:53211/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://tauri.localhost.evil.test",
        ] {
            assert!(
                !is_internal_navigation(&Url::parse(target).unwrap(), &server),
                "{target}"
            );
        }
    }
}
