//! A minimal HTTP/1.1 server for exercising the upload protocols offline.
//!
//! Enough of HTTP to answer reqwest: request line, headers, a body sized by
//! `Content-Length`, keep-alive. The handler may return `None` to drop the
//! connection without answering, which is how a test simulates the mobile
//! connection that dies after the server already stored a chunk.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

pub struct Request {
    pub method: String,
    /// Path and query, exactly as sent.
    pub target: String,
    /// Header names lower-cased.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn json(status: u16, body: impl Into<String>) -> Option<Self> {
        Some(Self {
            status,
            body: body.into(),
        })
    }
}

/// Start serving; returns the base URL (`http://127.0.0.1:<port>`).
pub async fn serve<H>(handler: H) -> String
where
    H: Fn(Request, &str) -> Option<Response> + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handler = Arc::new(handler);
    let base_for_task = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let handler = Arc::clone(&handler);
            let base = base_for_task.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                loop {
                    let Some(request) = read_request(&mut reader).await else {
                        return;
                    };
                    let Some(response) = handler(request, &base) else {
                        // Dropping both halves closes the socket mid-exchange.
                        return;
                    };
                    let reply = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        response.status,
                        response.body.len(),
                        response.body
                    );
                    if write.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    base
}

async fn read_request<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Option<Request> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).await.ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await.ok()?;
    Some(Request {
        method,
        target,
        headers,
        body,
    })
}

/// A file of `len` pseudo-random bytes, so a misplaced chunk cannot pass for
/// the right one by being identical to it.
pub fn sample_file(len: usize) -> (tempdir::TempPath, Vec<u8>) {
    let mut bytes = Vec::with_capacity(len);
    let mut x: u32 = 0x1234_5678;
    for _ in 0..len {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        bytes.push((x & 0xff) as u8);
    }
    let path = tempdir::TempPath::new("ltset");
    std::fs::write(&path.0, &bytes).unwrap();
    (path, bytes)
}

pub mod tempdir {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A temp file deleted on drop. Hand-rolled to avoid a dev-dependency for
    /// one helper.
    pub struct TempPath(pub PathBuf);

    impl TempPath {
        pub fn new(extension: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            Self(std::env::temp_dir().join(format!(
                "libretracks-cloud-test-{}-{n}.{extension}",
                std::process::id()
            )))
        }
    }

    impl Drop for TempPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}
