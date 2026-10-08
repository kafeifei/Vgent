//! The signed App pins an immutable archive. Installation never executes downloaded
//! bytes until SHA-256 matches, and publishes a complete version atomically.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Manifest {
    pub schema: u32,
    pub git_sha: String,
    pub target: String,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub url: String,
}
// Keep the release manifest's JS naming convention.
impl Manifest {
    pub fn read(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path).map_err(|e| format!("无法读取运行环境清单：{e}"))?;
        let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let mut value = value;
        value["git_sha"] = value["gitSha"].take();
        let manifest: Self = serde_json::from_value(value).map_err(|e| e.to_string())?;
        manifest.validate()?;
        Ok(manifest)
    }
    fn validate(&self) -> Result<(), String> {
        let target = format!("{}-apple-darwin", std::env::consts::ARCH);
        if self.schema != 1
            || self.target != target
            || !hex(&self.git_sha, 40)
            || !hex(&self.sha256, 64)
            || self.size == 0
        {
            return Err("运行环境清单与当前平台不匹配。".into());
        }
        let name = format!("Vgent-runtime-{}-{}.tar.gz", self.target, self.git_sha);
        if self.url
            != format!(
                "https://github.com/kafeifei/Vgent/releases/download/runtime-{}/{name}",
                self.git_sha
            )
        {
            return Err("运行环境下载地址无效。".into());
        }
        Ok(())
    }
    pub fn directory(&self, data: &Path) -> PathBuf {
        data.join("desktop-runtime")
            .join(format!("{}-{}", self.target, self.sha256))
    }
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub phase: String,
    pub message: String,
    pub downloaded: u64,
    pub total: u64,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            phase: "waiting".into(),
            message: "正在准备内置工作台…".into(),
            downloaded: 0,
            total: 0,
        }
    }
}
#[derive(Clone, Default)]
pub struct RuntimeState {
    pub status: Arc<Mutex<Status>>,
    pub busy: Arc<AtomicBool>,
    pub cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<u32>>>,
}
pub struct ProcessGuard(Arc<Mutex<Option<u32>>>);
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
}
impl RuntimeState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(slot) = self.child.lock() {
            if let Some(pid) = *slot {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }
    pub fn track(&self, pid: u32) -> ProcessGuard {
        let mut slot = self.child.lock().unwrap();
        *slot = Some(pid);
        if self.cancelled.load(Ordering::SeqCst) {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        ProcessGuard(self.child.clone())
    }

    pub fn update(&self, phase: &str, message: &str, downloaded: u64, total: u64) {
        if let Ok(mut status) = self.status.lock() {
            *status = Status {
                phase: phase.into(),
                message: message.into(),
                downloaded,
                total,
            };
        }
    }
}
fn complete(directory: &Path, manifest: &Manifest) -> bool {
    fs::read(directory.join("installed.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
        .as_ref()
        == Some(manifest)
        && ["node", "server/dist/main.js", "web/index.html", "bin/pnpm", "tools/package/bin/pnpm.cjs"]
            .iter()
            .all(|p| directory.join(p).is_file())
}

/// Poll child processes so quitting during verification or extraction reaps them.
fn command(
    mut command: Command,
    state: &RuntimeState,
) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let _guard = state.track(child.id());
    loop {
        if state.cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("安装已取消。".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "内置工作台安装命令失败（{status}），请重试；持续失败请重新安装应用。"
                    ))
                }
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
            _ => {}
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn install(manifest: &Manifest, data: &Path, state: &RuntimeState, bundled_archive: &Path) -> Result<PathBuf, String> {
    manifest.validate()?;
    let directory = manifest.directory(data);
    if complete(&directory, manifest) {
        return Ok(directory);
    }
    let parent = directory.parent().ok_or("缓存目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = parent.join(format!(".install-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let archive = staging.join("runtime.tar.gz");
        state.update("preparing", "正在准备内置工作台…", 0, manifest.size);
        fs::copy(bundled_archive, &archive)
            .map_err(|e| format!("无法读取内置工作台，请重新安装应用：{e}"))?;
        state.update(
            "verifying",
            "正在校验内置工作台…",
            manifest.size,
            manifest.size,
        );
        if fs::metadata(&archive).map_err(|e| e.to_string())?.len() != manifest.size {
            return Err("内置工作台大小不匹配，请重新安装应用。".into());
        }
        let checksum_file = staging.join("checksum.txt");
        fs::write(
            &checksum_file,
            format!("{}  runtime.tar.gz\n", manifest.sha256),
        )
        .map_err(|e| e.to_string())?;
        let mut sha = Command::new("/usr/bin/shasum");
        sha.current_dir(&staging)
            .args(["-a", "256", "-c"])
            .arg(&checksum_file);
        command(sha, state)
            .map_err(|_| "内置工作台校验失败，请重新安装应用。".to_string())?;
        state.update(
            "installing",
            "正在解压内置工作台…",
            manifest.size,
            manifest.size,
        );
        let tree = staging.join("tree");
        fs::create_dir(&tree).map_err(|e| e.to_string())?;
        let mut tar = Command::new("/usr/bin/tar");
        tar.arg("-xzf").arg(&archive).arg("-C").arg(&tree);
        command(tar, state)?;
        // The archive is pinned by the signed App; verify the executable's identity too.
        let mut signature = Command::new("/usr/bin/codesign");
        signature.args(["--verify", "--strict", "--test-requirement", "=anchor apple generic and certificate leaf[subject.OU] = \"UVZM439VGU\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"]).arg(tree.join("node"));
        command(signature, state)?;
        fs::write(
            tree.join("installed.json"),
            serde_json::to_vec(manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if !complete(&tree, manifest) {
            return Err("运行环境缺少启动所需文件，请重试。".into());
        }
        if state.cancelled.load(Ordering::SeqCst) {
            return Err("安装已取消。".into());
        }
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
        }
        fs::rename(&tree, &directory).map_err(|e| e.to_string())?;
        Ok(directory.clone())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

pub fn manifest(app: &tauri::AppHandle) -> Result<Manifest, String> {
    Manifest::read(
        &app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("bootstrap.json"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Manifest {
        let git_sha = "a".repeat(40);
        let target = format!("{}-apple-darwin", std::env::consts::ARCH);
        Manifest { schema: 1, url: format!("https://github.com/kafeifei/Vgent/releases/download/runtime-{git_sha}/Vgent-runtime-{target}-{git_sha}.tar.gz"), git_sha, target, version: "0.2.0".into(), sha256: "b".repeat(64), size: 10 }
    }
    #[test]
    fn installer_commands_are_only_granted_to_local_pages() {
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/bootstrap.json")).unwrap();
        let remote: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(local["local"], true);
        assert!(local.get("remote").is_none());
        let grants = remote["permissions"].as_array().unwrap();
        for command in ["allow-runtime-status", "allow-runtime-retry"] {
            assert!(!grants.iter().any(|value| value == command));
        }
    }

    #[test]
    fn rejects_untrusted_url_architecture_and_path_keys() {
        let good = fixture();
        assert!(good.validate().is_ok());
        let mut bad = good.clone();
        bad.url = "https://evil.test/runtime".into();
        assert!(bad.validate().is_err());
        let mut bad = good.clone();
        bad.target = "../escape".into();
        assert!(bad.validate().is_err());
        let mut bad = good.clone();
        bad.sha256 = "../escape".into();
        assert!(bad.validate().is_err());
        let mut other = good.clone();
        other.sha256 = "c".repeat(64);
        assert_ne!(
            good.directory(Path::new("/tmp")),
            other.directory(Path::new("/tmp"))
        );
    }
    #[test]
    fn incomplete_cache_is_never_a_hit() {
        let dir = std::env::temp_dir().join(format!("vgent-runtime-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = fixture();
        fs::write(
            dir.join("installed.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(!complete(&dir, &manifest));
        for file in ["node", "server/dist/main.js", "web/index.html", "bin/pnpm", "tools/package/bin/pnpm.cjs"] {
            let path = dir.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "fixture").unwrap();
        }
        assert!(complete(&dir, &manifest));
        let mut changed = manifest;
        changed.sha256 = "d".repeat(64);
        assert!(!complete(&dir, &changed));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_or_corrupt_bundle_never_falls_back_to_a_download() {
        let dir = std::env::temp_dir().join(format!("vgent-bundled-runtime-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = fixture();
        let archive = dir.join("workbench.tar.gz");
        let state = RuntimeState::default();
        assert!(install(&manifest, &dir, &state, &archive).unwrap_err().contains("内置工作台"));
        assert!(!manifest.directory(&dir).exists());
        fs::write(&archive, b"0123456789").unwrap();
        assert!(install(&manifest, &dir, &state, &archive).unwrap_err().contains("校验失败"));
        assert!(!manifest.directory(&dir).exists());
        assert!(state.child.lock().unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quitting_kills_an_active_installer_process_group() {
        let state = RuntimeState::default();
        let worker_state = state.clone();
        let worker = thread::spawn(move || {
            let mut child = Command::new("/bin/sleep");
            child.arg("30");
            command(child, &worker_state)
        });
        for _ in 0..100 {
            if state.child.lock().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(state.child.lock().unwrap().is_some());
        state.cancel();
        assert!(worker.join().unwrap().is_err());
        assert!(state.child.lock().unwrap().is_none());
    }

    #[test]
    fn cancellation_reaps_installer_child() {
        let state = RuntimeState::default();
        state.cancelled.store(true, Ordering::SeqCst);
        let mut process = Command::new("/bin/sleep");
        process.arg("30");
        assert!(command(process, &state).unwrap_err().contains("取消"));
    }
}
