fn main() {
    // An app command called from the remote workbench page needs an ACL entry,
    // and app commands only get one when they are listed here.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify_task",
            "runtime_status",
            "runtime_retry",
        ]),
    ))
    .expect("failed to run tauri-build");
}
