//! One background thread that makes thumbnail strips, one video at a time.
//!
//! Low priority on purpose: thumbnails are a convenience and must never compete
//! with the audio engine or an import. Videos the timeline is showing jump the
//! queue; a deleted clip or a closed session cancels its job, including the one
//! being decoded.
//!
//! The ordering rules live in [`QueueState`], which is pure and tested; the
//! thread around it only pops jobs, runs `libretracks_video::extract` and
//! reports.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use std::thread;

#[derive(Debug, Clone, PartialEq)]
pub struct ThumbnailJob {
    /// The path as the session stores it; what the UI knows the clip by and
    /// what the "ready" event reports.
    pub key: String,
    /// The same file resolved on disk.
    pub source: PathBuf,
    /// 0 when unknown: the worker probes the file first.
    pub duration_seconds: f64,
}

/// Queue bookkeeping, separate from the thread so it can be tested.
#[derive(Debug, Default)]
pub struct QueueState {
    pending: VecDeque<ThumbnailJob>,
    running: Option<(PathBuf, Arc<AtomicBool>)>,
    stop: bool,
}

fn same_source(left: &Path, right: &Path) -> bool {
    libretracks_video::thumbs::source_identity(left)
        == libretracks_video::thumbs::source_identity(right)
}

impl QueueState {
    /// Add jobs. `urgent` ones (visible in the timeline) go to the front in
    /// the order given; a job already queued is moved rather than duplicated,
    /// and one already running is left alone.
    pub fn request(&mut self, jobs: Vec<ThumbnailJob>, urgent: bool) {
        let mut fresh = Vec::new();
        for job in jobs {
            let running = self
                .running
                .as_ref()
                .is_some_and(|(source, _)| same_source(source, &job.source));
            if running {
                continue;
            }
            let queued = self
                .pending
                .iter()
                .position(|pending| same_source(&pending.source, &job.source));
            match (queued, urgent) {
                (Some(index), true) => {
                    self.pending.remove(index);
                    fresh.push(job);
                }
                (Some(_), false) => {}
                (None, _) => fresh.push(job),
            }
        }
        if urgent {
            for job in fresh.into_iter().rev() {
                self.pending.push_front(job);
            }
        } else {
            self.pending.extend(fresh);
        }
    }

    /// Drop a queued job and flag the running one, if it is for `source`.
    pub fn cancel(&mut self, source: &Path) {
        self.pending.retain(|job| !same_source(&job.source, source));
        if let Some((running, flag)) = &self.running {
            if same_source(running, source) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Drop everything (session closed).
    pub fn cancel_all(&mut self) {
        self.pending.clear();
        if let Some((_, flag)) = &self.running {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn take_next(&mut self) -> Option<(ThumbnailJob, Arc<AtomicBool>)> {
        let job = self.pending.pop_front()?;
        let flag = Arc::new(AtomicBool::new(false));
        self.running = Some((job.source.clone(), Arc::clone(&flag)));
        Some((job, flag))
    }

    fn finish(&mut self) {
        self.running = None;
    }

    pub fn pending_sources(&self) -> Vec<PathBuf> {
        self.pending.iter().map(|job| job.source.clone()).collect()
    }
}

/// What the worker needs from the outside, injected so the queue has no
/// dependency on Tauri.
pub struct ThumbnailWorkerDeps {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub libmpv: Box<dyn Fn() -> Result<Arc<libretracks_video::MpvLibrary>, String> + Send>,
    pub cache_root: Box<dyn Fn() -> PathBuf + Send>,
    /// Called once the job's strip is on disk.
    pub on_ready: Box<dyn Fn(&ThumbnailJob) + Send>,
}

#[derive(Default)]
pub struct ThumbnailQueue {
    shared: Arc<(Mutex<QueueState>, Condvar)>,
    started: AtomicBool,
}

impl ThumbnailQueue {
    pub fn request(&self, jobs: Vec<ThumbnailJob>, urgent: bool) {
        let (state, condvar) = &*self.shared;
        if let Ok(mut state) = state.lock() {
            state.request(jobs, urgent);
            condvar.notify_one();
        }
    }

    pub fn cancel(&self, source: &Path) {
        if let Ok(mut state) = self.shared.0.lock() {
            state.cancel(source);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut state) = self.shared.0.lock() {
            state.cancel_all();
        }
    }

    /// Start the worker thread. Idempotent.
    pub fn start(&self, deps: ThumbnailWorkerDeps) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let spawned = thread::Builder::new()
            .name("lt-video-thumbnails".into())
            .spawn(move || run_worker(&shared, &deps));
        if let Err(error) = spawned {
            eprintln!("[libretracks-video] no se pudo arrancar el hilo de miniaturas: {error}");
        }
    }

    pub fn stop(&self) {
        let (state, condvar) = &*self.shared;
        if let Ok(mut state) = state.lock() {
            state.stop = true;
            state.cancel_all();
            condvar.notify_all();
        }
    }
}

fn run_worker(shared: &(Mutex<QueueState>, Condvar), deps: &ThumbnailWorkerDeps) {
    crate::platform::thread_priority::lower_current_thread_priority();
    loop {
        let next = {
            let (state, condvar) = shared;
            let Ok(mut guard) = state.lock() else { return };
            loop {
                if guard.stop {
                    return;
                }
                if let Some(next) = guard.take_next() {
                    break next;
                }
                guard = match condvar.wait(guard) {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
            }
        };
        let (job, cancel) = next;
        let produced = make_strip(deps, &job, &cancel);
        if let Ok(mut state) = shared.0.lock() {
            state.finish();
        }
        match produced {
            Ok(()) => (deps.on_ready)(&job),
            Err(error) if !cancel.load(Ordering::Relaxed) => {
                eprintln!(
                    "[libretracks-video] miniaturas de {}: {error}",
                    job.source.display()
                );
            }
            Err(_) => {}
        }
    }
}

fn make_strip(
    deps: &ThumbnailWorkerDeps,
    job: &ThumbnailJob,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let cache_root = (deps.cache_root)();
    // Already made (by another session, or before a restart).
    if libretracks_video::thumbs::read_cached(&cache_root, &job.source).is_some() {
        return Ok(());
    }
    extract_strip(deps, job, &cache_root, cancel)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn extract_strip(
    _deps: &ThumbnailWorkerDeps,
    _job: &ThumbnailJob,
    _cache_root: &Path,
    _cancel: &AtomicBool,
) -> Result<(), String> {
    Err("miniaturas aún no disponibles en móvil".into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn extract_strip(
    deps: &ThumbnailWorkerDeps,
    job: &ThumbnailJob,
    cache_root: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let cache_root = cache_root.to_path_buf();
    let libmpv = (deps.libmpv)()?;
    let duration_seconds = if job.duration_seconds > 0.0 {
        job.duration_seconds
    } else {
        libretracks_video::extract::probe(&libmpv, &job.source)
            .map_err(|error| error.to_string())?
            .duration_seconds
    };
    let work_dir = cache_root
        .join("video-thumbnails")
        .join(format!(".work-{}", std::process::id()));
    let strip = libretracks_video::extract::extract_thumbnails(
        &libmpv,
        &job.source,
        duration_seconds,
        &work_dir,
        cancel,
    )
    .map_err(|error| error.to_string())?;
    libretracks_video::thumbs::write_cached(&cache_root, &job.source, &strip)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(path: &str) -> ThumbnailJob {
        ThumbnailJob {
            key: path.to_string(),
            source: PathBuf::from(path),
            duration_seconds: 10.0,
        }
    }

    #[test]
    fn background_requests_keep_their_order_and_are_not_duplicated() {
        let mut state = QueueState::default();
        state.request(vec![job("a.mp4"), job("b.mp4")], false);
        state.request(vec![job("A.MP4"), job("c.mp4")], false);
        assert_eq!(
            state.pending_sources(),
            vec![
                PathBuf::from("a.mp4"),
                PathBuf::from("b.mp4"),
                PathBuf::from("c.mp4")
            ]
        );
    }

    #[test]
    fn visible_videos_jump_the_queue() {
        let mut state = QueueState::default();
        state.request(vec![job("a.mp4"), job("b.mp4"), job("c.mp4")], false);
        state.request(vec![job("c.mp4"), job("d.mp4")], true);
        assert_eq!(
            state.pending_sources(),
            vec![
                PathBuf::from("c.mp4"),
                PathBuf::from("d.mp4"),
                PathBuf::from("a.mp4"),
                PathBuf::from("b.mp4")
            ]
        );
    }

    #[test]
    fn cancelling_drops_queued_jobs_and_flags_the_running_one() {
        let mut state = QueueState::default();
        state.request(vec![job("a.mp4"), job("b.mp4")], false);
        let (running, flag) = state.take_next().expect("a job");
        assert_eq!(running.source, PathBuf::from("a.mp4"));
        // A request for the running source is ignored, not queued twice.
        state.request(vec![job("a.mp4")], true);
        assert_eq!(state.pending_sources(), vec![PathBuf::from("b.mp4")]);

        state.cancel(Path::new("b.mp4"));
        assert!(state.pending_sources().is_empty());
        assert!(!flag.load(Ordering::Relaxed));
        state.cancel(Path::new("A.mp4"));
        assert!(flag.load(Ordering::Relaxed), "running job told to stop");
    }

    #[test]
    fn closing_the_session_cancels_everything() {
        let mut state = QueueState::default();
        state.request(vec![job("a.mp4"), job("b.mp4")], false);
        let (_, flag) = state.take_next().expect("a job");
        state.cancel_all();
        assert!(state.pending_sources().is_empty());
        assert!(flag.load(Ordering::Relaxed));
    }
}
