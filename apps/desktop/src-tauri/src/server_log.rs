use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

/// Each file stays around this size; one previous file (`server.log.1`) is kept.
const LOG_CAP: u64 = 4 * 1024 * 1024;
/// One runaway line (a dumped payload) must not fill a whole file on its own.
const LINE_CAP: usize = 16 * 1024;

/// The embedded server's stdout/stderr on disk. A Finder- or Dock-launched app
/// has no terminal, so without this a dead server leaves nothing behind but a
/// macOS crash report. Writing is best effort: a log that cannot be opened is
/// skipped, never a reason for the backend not to start.
#[derive(Clone)]
pub struct ServerLog(Arc<Mutex<LogFile>>);

struct LogFile {
    path: PathBuf,
    cap: u64,
    file: Option<File>,
    size: u64,
}

impl ServerLog {
    /// `<data dir>/logs/server.log`, appended to across launches.
    pub fn open(data_dir: &Path) -> Self {
        Self::with_cap(data_dir.join("logs").join("server.log"), LOG_CAP)
    }

    fn with_cap(path: PathBuf, cap: u64) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = open_append(&path);
        let size = file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map_or(0, |metadata| metadata.len());
        Self(Arc::new(Mutex::new(LogFile {
            path,
            cap,
            file,
            size,
        })))
    }

    /// Appends one timestamped line; `source` says which pipe it came from.
    pub fn line(&self, source: &str, text: &str) {
        let mut end = text.len().min(LINE_CAP);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let entry = format!("{} [{source}] {}\n", timestamp(), &text[..end]);
        if let Ok(mut log) = self.0.lock() {
            log.write(entry.as_bytes());
        }
    }
}

impl LogFile {
    fn write(&mut self, bytes: &[u8]) {
        if self.size > 0 && self.size + bytes.len() as u64 > self.cap {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(bytes).is_ok() {
                self.size += bytes.len() as u64;
            }
        }
    }

    /// `server.log` becomes `server.log.1` (replacing the older one) and a fresh
    /// file starts. If the rename fails the current file is cut back to empty,
    /// so the cap holds either way.
    fn rotate(&mut self) {
        self.file = None;
        let mut previous = self.path.clone().into_os_string();
        previous.push(".1");
        self.file = if std::fs::rename(&self.path, &previous).is_ok() {
            open_append(&self.path)
        } else {
            File::create(&self.path).ok()
        };
        self.size = 0;
    }
}

fn open_append(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Local time with its UTC offset, so a line can be matched against the
/// `vgent-node-*.ips` crash reports, which are stamped the same way.
#[cfg(unix)]
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&seconds, &mut tm) }.is_null() {
        return format!("@{}.{:03}", now.as_secs(), now.subsec_millis());
    }
    let offset = tm.tm_gmtoff / 60;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} {}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        now.subsec_millis(),
        if offset < 0 { '-' } else { '+' },
        offset.abs() / 60,
        offset.abs() % 60,
    )
}

#[cfg(not(unix))]
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("@{}.{:03}", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("vgent-rust-log-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }

    fn lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| line.split_once(" [").unwrap().1.to_string())
            .collect()
    }

    #[test]
    fn rotation_keeps_one_previous_file_and_caps_each() {
        let directory = scratch("rotate");
        let path = directory.join("logs").join("server.log");
        let previous = directory.join("logs").join("server.log.1");
        // Each entry is ~40 bytes with its timestamp; 200 bytes holds a few.
        let log = ServerLog::with_cap(path.clone(), 200);
        for index in 0..20 {
            log.line("stderr", &format!("line {index:02}"));
        }
        let current = lines(&path);
        let older = lines(&previous);
        assert!(!current.is_empty() && !older.is_empty());
        assert!(std::fs::metadata(&path).unwrap().len() <= 200);
        assert!(std::fs::metadata(&previous).unwrap().len() <= 200);
        // The newest line is last in the current file, and the previous file
        // runs straight into it: nothing between them was lost.
        assert_eq!(current.last().unwrap(), "stderr] line 19");
        let joined: Vec<_> = older.iter().chain(current.iter()).collect();
        let first = 20 - joined.len();
        for (offset, line) in joined.iter().enumerate() {
            assert_eq!(**line, format!("stderr] line {:02}", first + offset));
        }
        // Only ever one previous file.
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            2
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_relaunch_appends_and_counts_what_is_already_there() {
        let directory = scratch("reopen");
        let path = directory.join("server.log");
        ServerLog::with_cap(path.clone(), 1000).line("stdout", "first launch");
        let size = std::fs::metadata(&path).unwrap().len();
        // Reopened with a cap the old content already fills: the next line
        // rotates it out instead of growing past the cap.
        let log = ServerLog::with_cap(path.clone(), size + 5);
        log.line("stdout", "second launch");
        assert_eq!(lines(&path), ["stdout] second launch"]);
        assert_eq!(
            lines(&directory.join("server.log.1")),
            ["stdout] first launch"]
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn an_oversized_line_is_cut_on_a_char_boundary() {
        let directory = scratch("long");
        let path = directory.join("server.log");
        let log = ServerLog::with_cap(path.clone(), LOG_CAP);
        log.line("stderr", &"数".repeat(LINE_CAP));
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.len() < LINE_CAP + 100);
        assert!(written.ends_with("数\n"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
