//! The parts of moving a gigabyte that do not depend on who receives it.
//!
//! Drive, OneDrive and Dropbox each have their own chunked-upload protocol, but
//! all three need the same things around it: chunks sized to the connection,
//! a body streamed from disk rather than loaded into RAM, a progress bar that
//! does not run ahead of what the server confirmed, cancellation that takes
//! effect mid-request, and downloads that never leave a half-written package
//! where the importer will find it. That lives here once.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio_util::io::ReaderStream;

use crate::{CancelFn, CloudError, ProgressFn};

/// ReaderStream defaults to 4 KiB. For a multi-gigabyte file that means
/// hundreds of thousands of async-file/pool round trips before the bytes even
/// reach TLS. One MiB keeps memory bounded while making disk feeding negligible
/// next to the network transfer.
const UPLOAD_READ_BUFFER_SIZE: usize = 1024 * 1024;
/// Avoid flooding the webview while still making the bar look continuous.
pub(crate) const PROGRESS_INTERVAL_MS: u64 = 100;

/// The most any one request may carry on this platform, before the provider's
/// own ceiling is applied.
///
/// On desktop large chunks amortise the per-request commit cost. On a phone a
/// failed chunk is retried over mobile data, so the retry unit stays small.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PLATFORM_MAX_CHUNK: u64 = 512 * 1024 * 1024;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) const PLATFORM_MAX_CHUNK: u64 = 32 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const TARGET_CHUNK_DURATION: Duration = Duration::from_secs(30);
#[cfg(any(target_os = "android", target_os = "ios"))]
const TARGET_CHUNK_DURATION: Duration = Duration::from_secs(4);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MAX_CHUNK_GROWTH: u64 = 32;
#[cfg(any(target_os = "android", target_os = "ios"))]
const MAX_CHUNK_GROWTH: u64 = 4;

/// Chunk-size rules for one provider.
///
/// Every chunk costs a full round trip *plus* server-side commit work before
/// the next may start — that cost is per chunk, not per byte, so small chunks
/// make a large upload dramatically slower than the connection warrants. A
/// fixed size is wrong at both ends: wastefully chatty on fibre and expensive
/// to retry on a weak mobile link. So the size starts conservatively and is
/// tuned toward a target duration from the rate just observed, within bounds
/// the provider dictates.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ChunkPolicy {
    /// Every chunk but the last must be a multiple of this.
    pub alignment: u64,
    pub min: u64,
    pub initial: u64,
    pub max: u64,
}

impl ChunkPolicy {
    /// Largest multiple of `alignment` that is at most `limit`.
    pub const fn align_down(alignment: u64, limit: u64) -> u64 {
        (limit / alignment) * alignment
    }

    /// Pick the next request size without abrupt swings from one noisy sample.
    ///
    /// Elapsed time deliberately includes the provider's acknowledgement and
    /// commit latency: that overhead is precisely what larger chunks should
    /// amortise. Growth and shrinkage are bounded per observation, then
    /// averaged with the current size.
    pub fn next(&self, current: u64, transferred: u64, elapsed: Duration) -> u64 {
        if transferred == 0 || elapsed.is_zero() {
            return current;
        }
        let bytes_per_second = transferred as f64 / elapsed.as_secs_f64();
        let measured_target =
            (bytes_per_second * TARGET_CHUNK_DURATION.as_secs_f64()).round() as u64;
        let gradual_target =
            measured_target.clamp(current / 2, current.saturating_mul(MAX_CHUNK_GROWTH));
        let smoothed = current.saturating_add(gradual_target) / 2;
        let aligned = (smoothed / self.alignment) * self.alignment;
        aligned.clamp(self.min, self.max)
    }
}

/// Chunk size and confirmed throughput for one upload in progress.
pub(crate) struct UploadPacer {
    policy: ChunkPolicy,
    chunk_size: u64,
    /// Smoothed rate of bytes the server has acknowledged. `None` until the
    /// first chunk lands, and until then the bar does not move inside a chunk.
    confirmed_bytes_per_second: Option<f64>,
}

impl UploadPacer {
    pub fn new(policy: ChunkPolicy) -> Self {
        Self {
            policy,
            chunk_size: policy.initial,
            confirmed_bytes_per_second: None,
        }
    }

    pub fn chunk_size(&self) -> u64 {
        self.chunk_size
    }

    /// Fold in a chunk the server confirmed: `transferred` bytes in `elapsed`.
    pub fn record(&mut self, transferred: u64, elapsed: Duration) {
        if transferred > 0 && !elapsed.is_zero() {
            let observed = transferred as f64 / elapsed.as_secs_f64();
            self.confirmed_bytes_per_second = Some(
                self.confirmed_bytes_per_second
                    .map(|previous| previous * 0.7 + observed * 0.3)
                    .unwrap_or(observed),
            );
        }
        self.chunk_size = self.policy.next(self.chunk_size, transferred, elapsed);
    }
}

/// Bytes that may be shown inside an unacknowledged request.
///
/// Hyper can consume a large part of the file into its own buffers much faster
/// than the socket sends it. Never let that buffered count outrun the effective
/// rate the server confirmed for the preceding request.
pub(crate) fn visible_streamed_bytes(consumed: u64, bytes_per_second: f64, elapsed: Duration) -> u64 {
    let rate_limited = (bytes_per_second * elapsed.as_secs_f64()) as u64;
    consumed.min(rate_limited)
}

/// Send `[offset, offset + len)` of `local_path` as the body of `request`.
///
/// The caller builds the request (method, URL, protocol headers); this adds a
/// body streamed from disk with its `Content-Length`, reports progress inside
/// the request at no more than the confirmed rate, and aborts on cancel.
/// Returns the response and how long the request took, for the pacer.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_chunk(
    request: reqwest::RequestBuilder,
    local_path: &Path,
    offset: u64,
    len: u64,
    total: u64,
    pacer: &UploadPacer,
    progress: &ProgressFn,
    cancelled: &CancelFn,
) -> Result<(reqwest::Response, Duration), CloudError> {
    // Reopened per request so the body owns its reader and reqwest can stream
    // it without first allocating the whole chunk. Reopening is negligible next
    // to a network round trip and makes a server-directed rewind trivial.
    let mut file = tokio::fs::File::open(local_path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;

    let request_started = Instant::now();
    let streamed = Arc::new(AtomicU64::new(0));
    let stream_count = Arc::clone(&streamed);
    let body_stream = ReaderStream::with_capacity(file.take(len), UPLOAD_READ_BUFFER_SIZE).map(
        move |result| {
            if let Ok(bytes) = &result {
                stream_count.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            }
            result
        },
    );

    let request = request
        // A streamed reqwest body has no intrinsic size hint, and every
        // chunked protocol here requires the length up front.
        .header(reqwest::header::CONTENT_LENGTH, len)
        .body(reqwest::Body::wrap_stream(body_stream))
        .send();
    tokio::pin!(request);
    let mut progress_tick = tokio::time::interval(Duration::from_millis(PROGRESS_INTERVAL_MS));
    progress_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_visible = offset;
    let response = loop {
        tokio::select! {
            result = &mut request => break result.map_err(net)?,
            _ = progress_tick.tick() => {
                if cancelled() {
                    return Err(CloudError::Cancelled);
                }
                let Some(confirmed_rate) = pacer.confirmed_bytes_per_second else {
                    continue;
                };
                let consumed = streamed.load(Ordering::Relaxed).min(len);
                let visible = offset + visible_streamed_bytes(
                    consumed,
                    confirmed_rate,
                    request_started.elapsed(),
                );
                if visible > last_visible {
                    last_visible = visible;
                    progress(visible.min(total), total);
                }
            }
        }
    };
    Ok((response, request_started.elapsed()))
}

/// Send a request that has no body to stream, checking for a cancel while the
/// server takes its time to answer.
pub(crate) async fn send_cancellable(
    request: reqwest::RequestBuilder,
    cancelled: &CancelFn,
) -> Result<reqwest::Response, CloudError> {
    if cancelled() {
        return Err(CloudError::Cancelled);
    }
    let request = request.send();
    tokio::pin!(request);
    let mut cancel_tick = tokio::time::interval(Duration::from_millis(PROGRESS_INTERVAL_MS));
    loop {
        tokio::select! {
            result = &mut request => return result.map_err(net),
            _ = cancel_tick.tick() => {
                if cancelled() {
                    return Err(CloudError::Cancelled);
                }
            }
        }
    }
}

/// Write a successful download response to `dest_path`.
///
/// Goes to a sibling `.part` file renamed at the end, so an interrupted
/// download never leaves something that looks like a complete package for the
/// importer to choke on.
pub(crate) async fn stream_to_file(
    response: reqwest::Response,
    dest_path: &Path,
    progress: &ProgressFn,
    cancelled: &CancelFn,
) -> Result<(), CloudError> {
    let total = response.content_length().unwrap_or(0);
    let staging = dest_path.with_extension("part");
    // Buffered, and generously. Every write on a `tokio::fs::File` is
    // dispatched to the blocking pool, while `bytes_stream` hands back chunks
    // of a few kilobytes: writing them straight through meant tens of
    // thousands of pool round trips for one download, which is most of why a
    // large fetch crawled regardless of the connection.
    let mut out = BufWriter::with_capacity(1024 * 1024, tokio::fs::File::create(&staging).await?);
    let mut done: u64 = 0;
    let mut last_reported_percent = u64::MAX;
    let mut stream = response.bytes_stream();

    loop {
        let chunk = tokio::select! {
            next = stream.next() => next,
            _ = tokio::time::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS)) => {
                if cancelled() {
                    drop(out);
                    let _ = tokio::fs::remove_file(&staging).await;
                    return Err(CloudError::Cancelled);
                }
                continue;
            }
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(net)?;
        out.write_all(&chunk).await?;
        done += chunk.len() as u64;

        // Reported only when the whole-percent figure moves. The stream yields
        // chunks of a few kilobytes, so a gigabyte download would otherwise
        // push tens of thousands of events at the UI thread to redraw a number
        // that did not change.
        let denominator = total.max(done);
        let percent = if denominator == 0 {
            0
        } else {
            done * 100 / denominator
        };
        if percent != last_reported_percent {
            last_reported_percent = percent;
            progress(done, denominator);
        }
    }
    if cancelled() {
        drop(out);
        let _ = tokio::fs::remove_file(&staging).await;
        return Err(CloudError::Cancelled);
    }
    // shutdown() flushes the buffer AND the file underneath. A bare flush()
    // would leave the last partial buffer unwritten and rename a truncated
    // package into place.
    out.shutdown().await?;
    drop(out);
    tokio::fs::rename(&staging, dest_path).await?;
    Ok(())
}

/// Back off before retrying a failed chunk: 1, 2, 4, 8, 16, 30, 30... seconds.
///
/// Sleeps in short ticks so a cancel during a long wait takes effect at once
/// rather than after half a minute of a frozen-looking dialog.
pub(crate) async fn wait_before_retry(attempt: u32, cancelled: &CancelFn) -> Result<(), CloudError> {
    let deadline = Instant::now() + retry_delay(attempt);
    while Instant::now() < deadline {
        if cancelled() {
            return Err(CloudError::Cancelled);
        }
        tokio::time::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS)).await;
    }
    Ok(())
}

pub(crate) fn retry_delay(attempt: u32) -> Duration {
    let secs = 1u64 << attempt.saturating_sub(1).min(5);
    Duration::from_secs(secs.min(30))
}

pub(crate) fn net(e: reqwest::Error) -> CloudError {
    CloudError::Network(e.to_string())
}

/// Turn a non-success response into the error the UI understands.
pub(crate) async fn provider_error(provider: &'static str, response: reqwest::Response) -> CloudError {
    let status = response.status().as_u16();
    // 401 survives token refresh only when the grant itself is gone: the user
    // revoked access, or the refresh token expired. That is a "sign in again",
    // never a hard error.
    if status == 401 {
        return CloudError::NotConnected;
    }
    let body = response.text().await.unwrap_or_default();
    CloudError::Provider {
        provider,
        status,
        body,
    }
}

/// Parse a JSON body, or turn a failure status into [`provider_error`].
pub(crate) async fn parse<T: for<'de> Deserialize<'de>>(
    provider: &'static str,
    response: reqwest::Response,
) -> Result<T, CloudError> {
    if !response.status().is_success() {
        return Err(provider_error(provider, response).await);
    }
    response.json::<T>().await.map_err(net)
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: ChunkPolicy = ChunkPolicy {
        alignment: 256 * 1024,
        min: 4 * 1024 * 1024,
        initial: 16 * 1024 * 1024,
        max: ChunkPolicy::align_down(256 * 1024, PLATFORM_MAX_CHUNK),
    };

    #[test]
    fn chunk_tuning_grows_on_a_fast_link_and_shrinks_on_a_slow_one() {
        let fast = POLICY.next(POLICY.initial, POLICY.initial, Duration::from_millis(500));
        let slow = POLICY.next(POLICY.initial, POLICY.initial, Duration::from_secs(64));
        assert!(fast > POLICY.initial);
        assert!(slow < POLICY.initial);
        assert_eq!(fast % POLICY.alignment, 0);
        assert_eq!(slow % POLICY.alignment, 0);
    }

    #[test]
    fn chunk_tuning_obeys_the_bounds() {
        assert_eq!(
            POLICY.next(POLICY.max, POLICY.max, Duration::from_millis(1)),
            POLICY.max
        );
        assert_eq!(
            POLICY.next(POLICY.min, POLICY.min, Duration::from_secs(3_600)),
            POLICY.min
        );
    }

    /// An alignment that does not divide the platform ceiling (OneDrive's
    /// 320 KiB) must still produce a ceiling that is itself aligned, or the
    /// largest chunk would be the one the provider rejects.
    #[test]
    fn align_down_never_rounds_up() {
        let unit = 320 * 1024;
        let max = ChunkPolicy::align_down(unit, 60 * 1024 * 1024 - 1);
        assert_eq!(max % unit, 0);
        assert!(max < 60 * 1024 * 1024);
        assert_eq!(ChunkPolicy::align_down(unit, unit * 3), unit * 3);
    }

    #[test]
    fn the_pacer_starts_at_the_initial_size_and_adapts() {
        let mut pacer = UploadPacer::new(POLICY);
        assert_eq!(pacer.chunk_size(), POLICY.initial);
        assert!(pacer.confirmed_bytes_per_second.is_none());
        pacer.record(POLICY.initial, Duration::from_millis(500));
        assert!(pacer.chunk_size() > POLICY.initial);
        assert!(pacer.confirmed_bytes_per_second.is_some());
    }

    #[test]
    fn retries_back_off_exponentially_up_to_half_a_minute() {
        let delays: Vec<u64> = (1..=8).map(|n| retry_delay(n).as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn streamed_progress_cannot_run_ahead_of_confirmed_rate() {
        let buffered = 70 * 1024 * 1024;
        let visible = visible_streamed_bytes(
            buffered,
            10.0 * 1024.0 * 1024.0,
            Duration::from_secs(2),
        );
        assert_eq!(visible, 20 * 1024 * 1024);
        assert_eq!(
            visible_streamed_bytes(5 * 1024 * 1024, 10.0 * 1024.0 * 1024.0, Duration::from_secs(2)),
            5 * 1024 * 1024
        );
    }
}
