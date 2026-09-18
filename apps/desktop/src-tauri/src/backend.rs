use serde::Deserialize;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Url;

/// `connection.json`, exactly as `packages/server/src/main.ts` writes it.
#[derive(Deserialize)]
struct ConnectionFile {
    url: String,
    token: String,
    pid: u32,
}

/// Mirrors `INSTANCE_LOCKED_EXIT_CODE` in `packages/server/src/instance-lock.ts`:
/// the server found another Vgent holding the data directory's `server.lock`.
/// Change both together.
const INSTANCE_LOCKED_EXIT_CODE: i32 = 75;

pub struct BackendReady {
    pub url: Url,
    pub token: String,
}

/// Why the backend never came up. Everything is a message for the native dialog;
/// only the "already running" case gets its own title and its own advice.
pub enum SpawnError {
    AlreadyRunning(String),
    Failed(String),
}

impl SpawnError {
    pub fn title(&self) -> &'static str {
        match self {
            Self::AlreadyRunning(_) => "Vgent 已在运行",
            Self::Failed(_) => "无法启动 Vgent",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::AlreadyRunning(message) | Self::Failed(message) => message,
        }
    }

    fn with_detail(self, detail: &str) -> Self {
        if detail.is_empty() {
            return self;
        }
        match self {
            Self::AlreadyRunning(message) => Self::AlreadyRunning(format!("{message}\n\n{detail}")),
            Self::Failed(message) => Self::Failed(format!("{message}\n\n{detail}")),
        }
    }
}

impl From<String> for SpawnError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for SpawnError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

pub struct Backend {
    child: Child,
}

/// The server is only ours if the handshake file names the process we spawned;
/// a leftover file, or a `pnpm server` running in another window, is ignored.
fn validate_ready(connection: ConnectionFile, child_pid: u32) -> Result<BackendReady, String> {
    if connection.pid != child_pid {
        return Err("内置服务返回了不匹配的启动标识。".into());
    }
    let url = Url::parse(&connection.url).map_err(|_| "内置服务返回了无效地址。")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("内置服务未绑定独立的本机端口。".into());
    }
    if !(32..=128).contains(&connection.token.len())
        || !connection
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("内置服务返回了无效的连接凭证。".into());
    }
    Ok(BackendReady {
        url,
        token: connection.token,
    })
}

/// A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin`, which is not
/// enough for the agent's own shell tool (git, claude, pnpm). Ask the user's
/// login shell for the PATH they actually use; a shell that hangs is ignored.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    let output = receiver.recv_timeout(Duration::from_secs(5)).ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn path_with(node_dir: Option<&Path>) -> Option<std::ffi::OsString> {
    let base = login_shell_path()
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let mut entries: Vec<PathBuf> = node_dir.map(|dir| vec![dir.to_path_buf()]).unwrap_or_default();
    entries.extend(std::env::split_paths(&base));
    std::env::join_paths(entries).ok()
}

impl Backend {
    /// Spawns the bundled Node on the bundled server and waits for the server's
    /// own `connection.json` to name this child. No side protocol: the desktop
    /// shell is just another client of the file the server always writes.
    pub fn spawn(
        node: &Path,
        script: &Path,
        web_dist: &Path,
        data_dir: &Path,
    ) -> Result<(Self, BackendReady), SpawnError> {
        if !node.is_file() || !script.is_file() {
            return Err("应用缺少内置运行时或后端资源，请重新构建完整的 Vgent.app。".into());
        }
        let mut command = Command::new(node);
        command
            .arg("--enable-source-maps")
            .arg(script)
            .arg("--port")
            .arg("0")
            .arg("--web-dist")
            .arg(web_dist)
            .current_dir(script.parent().ok_or("后端资源目录无效。")?)
            .env("VGENT_DESKTOP", "1")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // A separate group lets shutdown target only this owned backend and the
        // bridge processes it started.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        if let Some(value) = path_with(node.parent()) {
            command.env("PATH", value);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动内置服务：{e}"))?;
        let child_pid = child.id();
        let stdout = child.stdout.take().ok_or("无法建立内置服务的日志管道。")?;
        let stderr = child.stderr.take().ok_or("无法建立内置服务的日志管道。")?;
        let errors = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let error_tail = errors.clone();
        let (stderr_done, stderr_closed) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
                if let Ok(mut tail) = error_tail.lock() {
                    tail.push_back(line.chars().take(1000).collect());
                    while tail.len() > 8 {
                        tail.pop_front();
                    }
                }
            }
            let _ = stderr_done.send(());
        });
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // `VGENT_DESKTOP=1` keeps the token off stdout; belt and braces.
                if line.contains("#token=") {
                    continue;
                }
                eprintln!("[backend] {line}");
            }
        });

        let mut backend = Self { child };
        let connection_path = data_dir.join("connection.json");
        let deadline = Instant::now() + Duration::from_secs(30);
        let result = loop {
            match std::fs::read(&connection_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ConnectionFile>(&bytes).ok())
            {
                // A stale file from another instance keeps a foreign pid, so the
                // mismatch is not fatal: keep waiting for ours to land.
                Some(connection) if connection.pid == child_pid => {
                    break validate_ready(connection, child_pid).map_err(SpawnError::from)
                }
                _ => {}
            }
            match backend.child.try_wait() {
                // The server refused the data directory: another Vgent owns it.
                // Nothing will ever land in `connection.json`, so stop waiting now.
                Ok(Some(status)) if status.code() == Some(INSTANCE_LOCKED_EXIT_CODE) => {
                    break Err(SpawnError::AlreadyRunning(
                        "这个数据目录已被另一个 Vgent 占用（可能是 `pnpm start` 起的服务，或一个仍在运行的 Vgent）。请先退出它，再重新打开 Vgent。".into(),
                    ))
                }
                Ok(Some(status)) => break Err(format!("内置服务启动失败（{status}）。").into()),
                Err(error) => break Err(format!("无法读取内置服务状态：{error}").into()),
                _ => {}
            }
            if Instant::now() >= deadline {
                break Err("内置服务启动超时。".into());
            }
            thread::sleep(Duration::from_millis(100));
        };
        match result {
            Ok(ready) => Ok((backend, ready)),
            Err(error) => {
                backend.shutdown();
                // A fast startup failure can reach us before the stderr thread
                // has drained; give the closed pipe a bounded moment.
                let _ = stderr_closed.recv_timeout(Duration::from_millis(250));
                let detail = errors
                    .lock()
                    .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                Err(error.with_detail(&detail))
            }
        }
    }

    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn wait_for_exit(&mut self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        loop {
            if self.has_exited() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// SIGTERM is the server's own clean-shutdown path: it stops every run (up
    /// to 10s each so engines persist their resume state), closes the listener
    /// and removes `connection.json`. Only a server that ignores that gets killed.
    pub fn shutdown(&mut self) {
        if self.has_exited() {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
        }
        if self.wait_for_exit(Duration::from_secs(20)) {
            return;
        }
        eprintln!("[desktop] 内置服务未及时退出，正在强制终止本应用拥有的进程组。");
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
        }
        if !self.wait_for_exit(Duration::from_secs(2)) {
            eprintln!("[desktop] 内置服务未确认退出；已发送强制终止信号。");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(url: &str) -> ConnectionFile {
        ConnectionFile {
            url: url.into(),
            token: "a".repeat(64),
            pid: 42,
        }
    }

    #[test]
    fn ready_requires_owned_pid_and_exact_loopback_origin() {
        assert!(validate_ready(connection("http://127.0.0.1:42001"), 42).is_ok());
        assert!(validate_ready(connection("http://127.0.0.1:42001"), 43).is_err());
        for url in [
            "https://example.com:42001",
            "http://localhost:42001",
            "http://127.0.0.1:42001/?token=secret",
            "http://127.0.0.1:42001/path",
            "http://127.0.0.1",
        ] {
            assert!(validate_ready(connection(url), 42).is_err(), "{url}");
        }
    }

    #[test]
    fn ready_rejects_missing_or_script_like_tokens() {
        let mut missing = connection("http://127.0.0.1:42001");
        missing.token.clear();
        assert!(validate_ready(missing, 42).is_err());
        let mut invalid = connection("http://127.0.0.1:42001");
        invalid.token = "</script>".repeat(8);
        assert!(validate_ready(invalid, 42).is_err());
    }

    #[cfg(target_os = "macos")]
    fn scratch(name: &str) -> PathBuf {
        static NEXT_DIRECTORY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "vgent-rust-{}-{name}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[cfg(target_os = "macos")]
    fn bundled_node() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "binaries/vgent-node-{}-apple-darwin",
            std::env::consts::ARCH
        ))
    }

    /// Only meaningful once `scripts/prepare-desktop.mjs` has fetched the sidecar.
    #[test]
    #[cfg(target_os = "macos")]
    fn spawn_waits_for_our_own_connection_file_and_shuts_down_cleanly() {
        let node = bundled_node();
        if !node.is_file() {
            eprintln!("跳过：未准备内置 Node（先跑 scripts/prepare-desktop.mjs）");
            return;
        }
        let directory = scratch("spawn");
        let data_dir = directory.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        // A stale handshake from another instance must not be mistaken for ours.
        std::fs::write(
            data_dir.join("connection.json"),
            r#"{"version":1,"url":"http://127.0.0.1:1","token":"stale","pid":1}"#,
        )
        .unwrap();
        let script = directory.join("main.js");
        // A stand-in for the real server: same handshake file, same SIGTERM contract.
        std::fs::write(
            &script,
            format!(
                r#"const fs = require('node:fs');
const dataDir = {data_dir:?};
const file = dataDir + '/connection.json';
fs.writeFileSync(file, JSON.stringify({{version:1,url:'http://127.0.0.1:42001',token:'a'.repeat(64),pid:process.pid}}));
process.on('SIGTERM', () => {{ fs.writeFileSync(dataDir + '/stopped', 'clean'); fs.rmSync(file, {{force:true}}); process.exit(0); }});
setInterval(() => {{}}, 1000);
"#
            ),
        )
        .unwrap();

        let (mut backend, ready) = Backend::spawn(&node, &script, &directory, &data_dir)
            .unwrap_or_else(|error| panic!("{}", error.message()));
        assert_eq!(ready.url.port(), Some(42001));
        backend.shutdown();
        assert!(backend.has_exited());
        assert_eq!(
            std::fs::read_to_string(data_dir.join("stopped")).unwrap(),
            "clean"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_startup_failure_keeps_the_stderr_tail_for_the_native_dialog() {
        let node = bundled_node();
        if !node.is_file() {
            eprintln!("跳过：未准备内置 Node（先跑 scripts/prepare-desktop.mjs）");
            return;
        }
        let directory = scratch("failure");
        let script = directory.join("main.js");
        std::fs::write(
            &script,
            "process.stderr.write('测试：数据目录已被另一个实例使用。\\n'); process.exit(2);",
        )
        .unwrap();
        let result = Backend::spawn(&node, &script, &directory, &directory);
        let error = result.err().unwrap();
        assert!(matches!(error, SpawnError::Failed(_)));
        assert!(error.message().contains("数据目录已被另一个实例使用"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// The server's own refusal (`server.lock` held by a live process) must come
    /// back at once as its own error, not as a 30s wait for a handshake file
    /// that is never going to be written.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_locked_data_directory_fails_fast_as_already_running() {
        let node = bundled_node();
        if !node.is_file() {
            eprintln!("跳过：未准备内置 Node（先跑 scripts/prepare-desktop.mjs）");
            return;
        }
        let directory = scratch("locked");
        let data_dir = directory.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        // The lock names this test process, which is very much alive.
        std::fs::write(
            data_dir.join("server.lock"),
            format!(
                r#"{{"pid":{},"nonce":"held","createdAt":"2026-01-01T00:00:00.000Z"}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        let script = directory.join("main.js");
        // A stand-in for the real server's `acquireInstanceLock` refusal path.
        std::fs::write(
            &script,
            format!(
                r#"const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync({data_dir:?} + '/server.lock', 'utf8'));
try {{ process.kill(lock.pid, 0); }} catch {{ process.exit(0); }}
process.stderr.write(`Vgent 已在运行（进程 ${{lock.pid}}）。\n`);
process.exit(75);
"#
            ),
        )
        .unwrap();

        let started = Instant::now();
        let error = Backend::spawn(&node, &script, &directory, &data_dir)
            .err()
            .unwrap();
        assert!(matches!(error, SpawnError::AlreadyRunning(_)));
        assert_eq!(error.title(), "Vgent 已在运行");
        assert!(error.message().contains("已被另一个 Vgent 占用"));
        // The stderr tail carries the owner's pid into the dialog.
        assert!(error.message().contains(&std::process::id().to_string()));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!data_dir.join("connection.json").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
