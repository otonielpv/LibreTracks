//! Catching the OAuth redirect on desktop.
//!
//! Desktop cannot use a private URI scheme the way the mobile builds do, so the
//! app opens the system browser and listens on a throwaway port of the loopback
//! interface for Google to redirect back. This is the flow Google recommends
//! for desktop clients, and the only one still supported there.
//!
//! # Why the port is not fixed (except for Dropbox)
//!
//! Google and Microsoft accept any port for a desktop client, so the listener
//! binds port 0 and lets the OS pick a free one. A hardcoded port would collide
//! with whatever else the user is running and fail at the worst moment, and a
//! second LibreTracks window would fight the first for it.
//!
//! Dropbox matches the redirect URI exactly, port included, so it gets a short
//! list of registered ports via [`LoopbackListener::bind_first_free`] and takes
//! the first one nobody else holds.
//!
//! # Why anything on the machine can talk to this socket
//!
//! It can, which is exactly why the `state` parameter is checked before the
//! authorization code is redeemed. Anything on the box may connect to
//! 127.0.0.1; only the flow that started this sign-in knows the state value.
//! That check lives in [`crate::oauth::AuthSession::verify_state`] and
//! is not optional.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use url::Url;

use crate::redirect::{parse_redirect_url, RedirectParams};
use crate::CloudError;

/// A one-shot listener for a single OAuth redirect.
pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    /// Bind an OS-assigned port on the loopback interface.
    pub async fn bind() -> Result<Self, CloudError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(CloudError::Io)?;
        let port = listener.local_addr().map_err(CloudError::Io)?.port();
        Ok(Self { listener, port })
    }

    /// Bind the first of `ports` that is free, for providers that only accept
    /// redirect URIs registered in advance.
    pub async fn bind_first_free(ports: &[u16]) -> Result<Self, CloudError> {
        let mut last_error = None;
        for &port in ports {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => return Ok(Self { listener, port }),
                Err(e) => last_error = Some(e),
            }
        }
        Err(CloudError::Io(last_error.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "no ports to try")
        })))
    }

    /// The port the authorization request must advertise as its redirect.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Wait for the browser to arrive with the authorization code.
    ///
    /// Browsers also ask for `/favicon.ico` and may open speculative
    /// connections, so anything that is not the redirect is answered and
    /// ignored rather than treated as the answer. The caller is expected to
    /// impose its own timeout: a user who closes the browser tab never comes
    /// back, and this would otherwise wait forever.
    pub async fn wait_for_redirect(self) -> Result<RedirectParams, CloudError> {
        loop {
            let (mut stream, _) = self.listener.accept().await.map_err(CloudError::Io)?;

            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .await
                .map_err(CloudError::Io)?;

            match parse_redirect_request(&request_line) {
                Ok(params) => {
                    let _ = stream.write_all(closing_page().as_bytes()).await;
                    let _ = stream.flush().await;
                    return Ok(params);
                }
                Err(CloudError::Cancelled) => {
                    // The user pressed "Cancel" on the consent screen. Tell the
                    // browser something friendly and report it as a cancel, not
                    // as a failure: nothing went wrong.
                    let _ = stream.write_all(closing_page().as_bytes()).await;
                    let _ = stream.flush().await;
                    return Err(CloudError::Cancelled);
                }
                Err(_) => {
                    let _ = stream.write_all(NOT_FOUND.as_bytes()).await;
                    let _ = stream.flush().await;
                }
            }
        }
    }
}

const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";

/// The page the user is left looking at once the redirect lands.
///
/// Deliberately self-contained: this is served from a local socket that is
/// about to close, so it can load nothing from anywhere.
fn closing_page() -> String {
    let body = "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\">\
<title>LibreTracks</title>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding:3rem;color:#222\">\
<h2>Cuenta conectada</h2>\
<p>Ya puedes cerrar esta pestaña y volver a LibreTracks.</p>";
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// Pull `code` and `state` out of an HTTP request line.
///
/// Split out from the socket handling so the fiddly half is testable without a
/// browser: this has to cope with a cancelled consent screen, a browser probing
/// for a favicon, and percent-encoded values, and none of that is convenient to
/// reproduce live.
pub(crate) fn parse_redirect_request(request_line: &str) -> Result<RedirectParams, CloudError> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| CloudError::Network("malformed HTTP request".into()))?;

    // A relative target needs a base before it can be parsed; the host is
    // irrelevant, only the query matters.
    let url = Url::parse("http://127.0.0.1")
        .and_then(|base| base.join(target))
        .map_err(|e| CloudError::Network(e.to_string()))?;

    parse_redirect_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_redirect_yields_code_and_state() {
        let params =
            parse_redirect_request("GET /?code=4/0AY0e-abc&state=xyz123 HTTP/1.1\r\n").unwrap();
        assert_eq!(params.code, "4/0AY0e-abc");
        assert_eq!(params.state, "xyz123");
    }

    /// Authorization codes contain `/` and `-`, and Google percent-encodes
    /// them. Redeeming a still-encoded code fails with an opaque invalid_grant.
    #[test]
    fn percent_encoded_values_are_decoded() {
        let params =
            parse_redirect_request("GET /?code=4%2F0AY0e-a%2Bb&state=s%2Fx HTTP/1.1\r\n").unwrap();
        assert_eq!(params.code, "4/0AY0e-a+b");
        assert_eq!(params.state, "s/x");
    }

    #[test]
    fn declining_the_consent_screen_reads_as_a_cancel() {
        let err = parse_redirect_request("GET /?error=access_denied&state=xyz HTTP/1.1\r\n");
        assert!(matches!(err, Err(CloudError::Cancelled)));
    }

    /// Browsers ask for this unprompted. Treating it as the redirect would end
    /// the sign-in before the user has even chosen an account.
    #[test]
    fn a_favicon_probe_is_not_mistaken_for_the_redirect() {
        let err = parse_redirect_request("GET /favicon.ico HTTP/1.1\r\n");
        assert!(matches!(err, Err(CloudError::Network(_))));
    }

    #[test]
    fn a_redirect_missing_the_state_is_refused() {
        let err = parse_redirect_request("GET /?code=abc HTTP/1.1\r\n");
        assert!(matches!(err, Err(CloudError::Network(_))));
    }

    #[test]
    fn a_garbage_request_line_does_not_panic() {
        assert!(parse_redirect_request("").is_err());
        assert!(parse_redirect_request("GET").is_err());
    }

    /// Something else (another app, or a second LibreTracks window mid
    /// sign-in) holding the first registered port must not block the sign-in.
    #[tokio::test]
    async fn a_taken_port_falls_through_to_the_next() {
        let squatter = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let taken = squatter.local_addr().unwrap().port();
        let free = {
            let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            probe.local_addr().unwrap().port()
        };
        let listener = LoopbackListener::bind_first_free(&[taken, free]).await.unwrap();
        assert_eq!(listener.port(), free);
    }

    #[tokio::test]
    async fn no_free_port_is_an_error_not_a_panic() {
        let squatter = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let taken = squatter.local_addr().unwrap().port();
        assert!(LoopbackListener::bind_first_free(&[taken]).await.is_err());
        assert!(LoopbackListener::bind_first_free(&[]).await.is_err());
    }

    #[test]
    fn the_closing_page_declares_the_length_it_sends() {
        let page = closing_page();
        let (head, body) = page.split_once("\r\n\r\n").unwrap();
        let declared: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .unwrap()
            .parse()
            .unwrap();
        // A mismatch leaves the browser waiting on bytes that never arrive, so
        // the tab spins instead of showing "you can close this".
        assert_eq!(declared, body.len());
    }
}
