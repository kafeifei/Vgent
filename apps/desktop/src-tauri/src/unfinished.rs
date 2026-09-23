//! Quit-time check: a session that is still running, waiting for approval, or
//! waiting for an answer. Quitting stops those turns, so the shell asks first.

use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};
use tauri::Url;

const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const LIST_LIMIT: usize = 6;

/// One task whose turn is still alive. `status` is the server's `ThreadStatus`.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenSession {
    pub title: String,
    pub status: String,
}

#[derive(serde::Deserialize)]
struct ThreadList {
    threads: Vec<ThreadBrief>,
}

#[derive(serde::Deserialize)]
struct ThreadBrief {
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
}

fn is_open(status: &str) -> bool {
    matches!(status, "running" | "awaiting-approval" | "awaiting-input")
}

/// Titles the dialog can show. Empty titles fall back to the server's placeholder.
fn display_title(title: &str) -> String {
    let trimmed = title.trim();
    let name = if trimmed.is_empty() {
        "新任务"
    } else {
        trimmed
    };
    let mut chars = name.chars();
    let short: String = chars.by_ref().take(80).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

/// `GET /api/threads`, then keep only sessions that quitting would interrupt.
pub fn fetch_open_sessions(base: &Url, token: &str) -> Result<Vec<OpenSession>, String> {
    let host = base.host_str().ok_or("内置服务地址没有主机名")?;
    let port = base.port().ok_or("内置服务地址没有端口")?;
    let mut stream =
        TcpStream::connect((host, port)).map_err(|error| format!("连不上内置服务：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("无法设置读取时限：{error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("无法设置写入时限：{error}"))?;
    let request = format!(
        "GET /api/threads HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("询问任务列表失败：{error}"))?;
    let raw = read_capped(&mut stream, MAX_RESPONSE)?;
    let body = http_json_body(&raw)?;
    open_sessions_from_json(&body)
}

fn read_capped(stream: &mut TcpStream, max: usize) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if raw.len().saturating_add(n) > max {
                    return Err("任务列表过大".into());
                }
                raw.extend_from_slice(&buf[..n]);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                if raw.is_empty() {
                    return Err("询问任务列表超时".into());
                }
                return Err("任务列表响应不完整".into());
            }
            Err(error) => return Err(format!("读取任务列表失败：{error}")),
        }
    }
    Ok(raw)
}

fn http_json_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("内置服务返回了不完整的响应")?;
    let header = std::str::from_utf8(&raw[..split]).map_err(|_| "响应头不是 UTF-8".to_string())?;
    let rest = &raw[split + 4..];
    let status = header.lines().next().unwrap_or("");
    if status.split_whitespace().nth(1) != Some("200") {
        return Err(format!("任务列表请求失败：{status}"));
    }
    let header_lower = header.to_ascii_lowercase();
    if header_lower.contains("transfer-encoding: chunked") {
        return decode_chunked(rest);
    }
    if let Some(length) = content_length(header) {
        if rest.len() < length {
            return Err("任务列表响应被截断".into());
        }
        return Ok(rest[..length].to_vec());
    }
    Ok(rest.to_vec())
}

fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("分块响应不完整")?;
        let line =
            std::str::from_utf8(&body[..line_end]).map_err(|_| "分块长度无效".to_string())?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| "分块长度无效".to_string())?;
        body = &body[line_end + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size + 2 {
            return Err("分块响应被截断".into());
        }
        if out.len().saturating_add(size) > MAX_RESPONSE {
            return Err("任务列表过大".into());
        }
        out.extend_from_slice(&body[..size]);
        if &body[size..size + 2] != b"\r\n" {
            return Err("分块响应格式不对".into());
        }
        body = &body[size + 2..];
    }
    Ok(out)
}

pub fn open_sessions_from_json(body: &[u8]) -> Result<Vec<OpenSession>, String> {
    let list: ThreadList =
        serde_json::from_slice(body).map_err(|_| "任务列表无法解析".to_string())?;
    Ok(list
        .threads
        .into_iter()
        .filter(|thread| is_open(&thread.status))
        .map(|thread| OpenSession {
            title: thread.title,
            status: thread.status,
        })
        .collect())
}

/// Native-dialog copy. One session names it; several are a short list.
pub fn quit_warning(sessions: &[OpenSession]) -> String {
    match sessions {
        [] => String::new(),
        [only] => {
            let phrase = match only.status.as_str() {
                "awaiting-approval" => "还在等你审批",
                "awaiting-input" => "还在等你回答",
                _ => "还在跑",
            };
            format!("「{}」{phrase}。退出会停掉它。", display_title(&only.title))
        }
        many => {
            let mut lines = vec![format!(
                "还有 {} 个任务没完成。退出会停掉它们：",
                many.len()
            )];
            for session in many.iter().take(LIST_LIMIT) {
                let state = match session.status.as_str() {
                    "awaiting-approval" => "等你审批",
                    "awaiting-input" => "等你回答",
                    _ => "正在跑",
                };
                lines.push(format!("· {}（{state}）", display_title(&session.title)));
            }
            let extra = many.len().saturating_sub(LIST_LIMIT);
            if extra > 0 {
                lines.push(format!("· 另外 {extra} 个"));
            }
            lines.join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn session(title: &str, status: &str) -> OpenSession {
        OpenSession {
            title: title.into(),
            status: status.into(),
        }
    }

    #[test]
    fn json_keeps_only_live_turns_in_order() {
        let body = r#"{"threads":[
            {"title":"在跑","status":"running","id":"a"},
            {"title":"空闲","status":"idle"},
            {"title":"等审批","status":"awaiting-approval"},
            {"title":"出错了","status":"error"},
            {"title":"停了","status":"interrupted"},
            {"title":"","status":"awaiting-input"}
        ]}"#;
        let open = open_sessions_from_json(body.as_bytes()).unwrap();
        assert_eq!(
            open,
            vec![
                session("在跑", "running"),
                session("等审批", "awaiting-approval"),
                session("", "awaiting-input"),
            ]
        );
    }

    #[test]
    fn warning_names_one_session_and_lists_the_rest() {
        assert_eq!(
            quit_warning(&[session("修登录", "running")]),
            "「修登录」还在跑。退出会停掉它。"
        );
        assert_eq!(
            quit_warning(&[session("  ", "awaiting-approval")]),
            "「新任务」还在等你审批。退出会停掉它。"
        );
        assert_eq!(
            quit_warning(&[session("选方案", "awaiting-input")]),
            "「选方案」还在等你回答。退出会停掉它。"
        );
        let many: Vec<_> = (0..8)
            .map(|i| session(&format!("任务{i}"), "running"))
            .collect();
        let warning = quit_warning(&many);
        assert!(warning.starts_with("还有 8 个任务没完成。退出会停掉它们：\n"));
        assert!(warning.contains("· 任务0（正在跑）"));
        assert!(warning.contains("· 任务5（正在跑）"));
        assert!(!warning.contains("任务6"));
        assert!(warning.ends_with("\n· 另外 2 个"));
    }

    #[test]
    fn warning_clips_a_very_long_title() {
        let title = "题".repeat(90);
        let warning = quit_warning(&[session(&title, "running")]);
        assert!(warning.starts_with("「"));
        assert!(warning.contains('…'));
        assert!(warning.ends_with("还在跑。退出会停掉它。"));
        assert!(warning.chars().filter(|c| *c == '题').count() == 80);
    }

    fn serve(status_line: &str, header_extra: &str, body: &str) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status_line = status_line.to_string();
        let header_extra = header_extra.to_string();
        let body = body.to_string();
        thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]);
            assert!(request.starts_with("GET /api/threads HTTP/1.1\r\n"));
            assert!(request.contains("Authorization: Bearer test-token\r\n"));
            let response = format!("{status_line}\r\n{header_extra}\r\n\r\n{body}");
            sock.write_all(response.as_bytes()).unwrap();
        });
        Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
    }

    #[test]
    fn fetch_reads_a_content_length_body() {
        let body =
            r#"{"threads":[{"title":"在跑","status":"running"},{"title":"空闲","status":"idle"}]}"#;
        let url = serve(
            "HTTP/1.1 200 OK",
            &format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close",
                body.len()
            ),
            body,
        );
        let open = fetch_open_sessions(&url, "test-token").unwrap();
        assert_eq!(open, vec![session("在跑", "running")]);
    }

    #[test]
    fn fetch_decodes_chunked_and_rejects_non_200() {
        let payload = r#"{"threads":[{"title":"等回答","status":"awaiting-input"}]}"#;
        let chunked = format!("{:x}\r\n{payload}\r\n0\r\n\r\n", payload.len());
        let url = serve(
            "HTTP/1.1 200 OK",
            "Transfer-Encoding: chunked\r\nConnection: close",
            &chunked,
        );
        assert_eq!(
            fetch_open_sessions(&url, "test-token").unwrap(),
            vec![session("等回答", "awaiting-input")]
        );

        let denied = serve(
            "HTTP/1.1 401 Unauthorized",
            "Content-Length: 0\r\nConnection: close",
            "",
        );
        let error = fetch_open_sessions(&denied, "test-token").unwrap_err();
        assert!(error.contains("401"), "{error}");
    }
}
