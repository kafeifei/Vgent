#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{Backend, BackendReady, SpawnError};
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
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Clone, Default)]
struct Lifecycle {
    backend: Arc<Mutex<Option<Backend>>>,
    closing: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
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
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("找不到应用资源目录：{error}"))?;
    let node = std::env::current_exe()
        .map_err(|error| format!("找不到应用可执行文件：{error}"))?
        .parent()
        .ok_or("应用可执行目录不存在")?
        .join("vgent-node");
    Ok(Bundle {
        node,
        script: resources.join("server/dist/main.js"),
        web_dist: resources.join("web"),
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

fn create_window(app: &tauri::AppHandle, ready: BackendReady) -> tauri::Result<()> {
    let origin = ready.url.clone();
    // `apps/web` picks the token out of the hash, stores it and strips it, so no
    // injected script is needed — the shell is just a browser pointed at the server.
    let mut location = ready.url;
    location.set_fragment(Some(&format!("token={}", ready.token)));
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(location))
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
            if is_internal_navigation(url, &origin) {
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
        // 系统通知: the page calls it through `window.__TAURI__.notification`,
        // the same way it reaches the dialog plugin. Only the three commands
        // listed in `capabilities/main.json` are open to it.
        .plugin(tauri_plugin_notification::init())
        .manage(lifecycle)
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let inspector =
                MenuItem::with_id(app, "devtools", "开发者工具", true, Some("CmdOrCtrl+Alt+I"))?;
            menu.append(&Submenu::with_items(app, "调试", true, &[&inspector])?)?;
            app.set_menu(menu)?;

            let lifecycle = app.state::<Lifecycle>().inner().clone();
            let started = locate_bundle(app.handle())
                .and_then(|bundle| data_dir().map(|dir| (bundle, dir)))
                .map_err(SpawnError::from)
                .and_then(|(bundle, dir)| {
                    Backend::spawn(&bundle.node, &bundle.script, &bundle.web_dist, &dir)
                });
            match started {
                Ok((backend, ready)) => {
                    *lifecycle
                        .backend
                        .lock()
                        .map_err(|_| "无法记录内置服务进程")? = Some(backend);
                    if let Err(error) = create_window(app.handle(), ready) {
                        lifecycle.shutdown();
                        return Err(error.into());
                    }
                    let app_handle = app.handle().clone();
                    thread::spawn(move || loop {
                        if lifecycle.closing.load(Ordering::SeqCst) {
                            return;
                        }
                        let exited = lifecycle
                            .backend
                            .lock()
                            .map(|mut slot| slot.as_mut().is_some_and(Backend::has_exited))
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
                }
                Err(error) => {
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(error.message())
                        .title(error.title())
                        .kind(MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                }
            }
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
                    lifecycle.request_exit(handle, code.unwrap_or(0));
                }
            }
            // `⌘Q` and an AppleEvent quit go through `applicationWillTerminate`,
            // which neither `prevent_exit` nor a detached thread can outlive: the
            // process is gone the moment this returns. So stop the server *here*,
            // synchronously. `shutdown` holds the lock across the whole stop, so a
            // `request_exit` thread already doing it just makes this call wait.
            RunEvent::Exit => handle.state::<Lifecycle>().shutdown(),
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
