//! Project audio preparation on `DesktopSession`: loading a song from disk or
//! an imported package, then driving the source-ready / prearm / waveform-prime
//! sequence that the Ableton-style loading model runs before playback. See
//! docs/REDESIGN_audio_preparation_ableton_model.md.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use libretracks_core::Song;
use libretracks_project::{ImportedSong, SONG_FILE_NAME};

use tauri::AppHandle;

use crate::audio_engine::AudioController;
use crate::automation::load_automation;
use crate::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{emit_project_load_progress, unique_waveform_keys, DesktopSession, DesktopState};

impl DesktopSession {
    #[allow(dead_code)]
    fn load_imported_song(
        &mut self,
        imported_song: ImportedSong,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.record_import_metrics(&imported_song.metrics);
        self.load_song_from_path(imported_song.song, imported_song.song_dir, audio)
    }

    pub(super) fn load_song_from_path(
        &mut self,
        song: Song,
        song_dir: PathBuf,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        audio.stop()?;
        // LoadSession (via replace_song_buffers) initializes the complete C++ mixer runtime:
        // gain, pan, mute, solo, audio_to, transpose_behavior, folder parent chains.
        // No Rust broad sync is needed after this point.
        audio.replace_song_buffers(&song_dir, &song, "session_load")?;

        self.transport_clock.stop();
        self.song_dir = Some(song_dir.clone());
        self.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
        self.last_drift_sample = None;
        self.automation = load_automation(&song_dir)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.live_history_anchor = None;
        self.engine.load_song(song)?;
        self.project_revision = self.project_revision.saturating_add(1);
        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.prime_waveform_cache(&song_dir, &loaded_song)?;

        Ok(())
    }

    pub(super) fn wait_for_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        const TIMEOUT: Duration = Duration::from_secs(120);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        // The loader reserves visible bands for each blocking phase so cached
        // projects still show meaningful progress instead of jumping 2 -> 96.
        // 0..18: file/model/session, 18..80: source/cache readiness,
        // 80..92: waveforms + first-play cache, 92..99: prearmed jump voices.
        const SOURCES_BASE: u8 = 18;
        const SOURCES_SPAN: u8 = 62;
        let started_at = Instant::now();
        let mut last_ready = usize::MAX;
        let mut last_total = usize::MAX;
        let mut last_percent = u8::MAX;

        // How many distinct audio sources the loaded song actually references.
        // Right after a structural import the engine upserts the new sources for
        // background decode, but they take a moment to appear in source_states.
        // Without this, the `total == 0` "empty project" escape hatch below fires
        // during that race window and returns "ready" before any MP3 is decoded —
        // so prime_waveforms_from_engine_peaks finds nothing and the tracks sit on
        // "analyzing waveform" forever. If the song HAS sources, we must wait for
        // the engine to register them instead of short-circuiting.
        let expected_sources = self
            .engine
            .song()
            .map(|song| unique_waveform_keys(song).len())
            .unwrap_or(0);

        loop {
            // engine_snapshot() uses try_lock and returns Err if the lock is
            // contended (e.g. meter polling holds it). Don't propagate — that
            // would abort the whole open flow. Just back off and retry on the
            // next iteration so the loop survives temporary contention.
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= TIMEOUT {
                        return Ok(());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let total = snapshot.source_states.len();
            let ready = snapshot
                .source_states
                .iter()
                .filter(|source| {
                    matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    )
                })
                .count();
            let failures = snapshot
                .source_states
                .iter()
                .filter(|source| source.status == "failed")
                .count();
            let source_progress_sum = snapshot
                .source_states
                .iter()
                .map(|source| {
                    if matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    ) {
                        100_usize
                    } else {
                        source.progress_percent.clamp(0, 99) as usize
                    }
                })
                .sum::<usize>();
            let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb = (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;

            let percent = if total == 0 {
                SOURCES_BASE
            } else {
                SOURCES_BASE
                    + ((source_progress_sum * SOURCES_SPAN as usize) / (total * 100))
                        .min(SOURCES_SPAN as usize) as u8
            };
            // Emit on every ready/total change so the UI shows 1/31 → 2/31 …
            // not just the few percent-step boundaries.
            if ready != last_ready || total != last_total || percent != last_percent {
                last_ready = ready;
                last_total = total;
                last_percent = percent;
                let message = if total == 0 {
                    "Inicializando preparacion de audio...".to_string()
                } else if failures > 0 {
                    format!("Preparando audio... {ready}/{total} fuentes ({failures} con error)")
                } else {
                    format!("Preparando audio... {ready}/{total} fuentes")
                };
                emit_project_load_progress(
                    app,
                    percent,
                    message,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }

            // Empty project (no sources): give the engine a brief moment to
            // register sources from LoadSession, then short-circuit straight
            // to 100% so the loader doesn't hang on "Inicializando..." forever
            // for projects that legitimately contain no audio.
            //
            // The grace window is short (300ms) for a truly empty song, but when
            // the loaded song HAS sources we extend it: right after a structural
            // import the engine upserts the new sources for background decode and
            // they take a moment to appear in source_states. Short-circuiting in
            // that race window returned "ready" before any MP3 was decoded, so the
            // waveform prime found nothing and the tracks sat on "analyzing
            // waveform" forever. Wait up to a few seconds for them to register; if
            // they never do (a decode-pipeline bug elsewhere) we still give up so
            // the importer isn't blocked for the full 120s — the background
            // waveform jobs fall back to native file_peaks generation anyway.
            let empty_grace = if expected_sources == 0 {
                Duration::from_millis(300)
            } else {
                Duration::from_secs(10)
            };
            if total == 0 && started_at.elapsed() >= empty_grace {
                emit_project_load_progress(
                    app,
                    100,
                    "Proyecto listo para reproducir.".into(),
                    0,
                    0,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                return Ok(());
            }

            if total > 0 && ready >= total {
                self.finish_project_audio_preparation(
                    app,
                    audio,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                )?;
                return Ok(());
            }
            if started_at.elapsed() >= TIMEOUT {
                emit_project_load_progress(
                    app,
                    percent,
                    "El proyecto se abrio; la preparacion continua en segundo plano.".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                return Ok(());
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn wait_for_project_audio_preparation_unlocked(
        app: &AppHandle,
        state: &DesktopState,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        const TIMEOUT: Duration = Duration::from_secs(120);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        const SOURCES_BASE: u8 = 18;
        const SOURCES_SPAN: u8 = 62;
        let started_at = Instant::now();
        let mut last_ready = usize::MAX;
        let mut last_total = usize::MAX;
        let mut last_percent = u8::MAX;
        loop {
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= TIMEOUT {
                        let mut session = state
                            .session
                            .lock()
                            .map_err(|_| DesktopError::StatePoisoned)?;
                        return Ok(session.snapshot());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let total = snapshot.source_states.len();
            let ready = snapshot
                .source_states
                .iter()
                .filter(|source| {
                    matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    )
                })
                .count();
            let failures = snapshot
                .source_states
                .iter()
                .filter(|source| source.status == "failed")
                .count();
            let source_progress_sum = snapshot
                .source_states
                .iter()
                .map(|source| {
                    if matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    ) {
                        100_usize
                    } else {
                        source.progress_percent.clamp(0, 99) as usize
                    }
                })
                .sum::<usize>();
            let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb = (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
            let percent = if total == 0 {
                SOURCES_BASE
            } else {
                SOURCES_BASE
                    + ((source_progress_sum * SOURCES_SPAN as usize) / (total * 100))
                        .min(SOURCES_SPAN as usize) as u8
            };

            if ready != last_ready || total != last_total || percent != last_percent {
                last_ready = ready;
                last_total = total;
                last_percent = percent;
                let message = if total == 0 {
                    "Inicializando preparacion de audio...".to_string()
                } else if failures > 0 {
                    format!("Preparando audio... {ready}/{total} fuentes ({failures} con error)")
                } else {
                    format!("Preparando audio... {ready}/{total} fuentes")
                };
                emit_project_load_progress(
                    app,
                    percent,
                    message,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }

            if total == 0 && started_at.elapsed() >= Duration::from_millis(300) {
                emit_project_load_progress(
                    app,
                    100,
                    "Proyecto listo para reproducir.".into(),
                    0,
                    0,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                return Ok(session.snapshot());
            }

            if total > 0 && ready >= total {
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                session.finish_project_audio_preparation(
                    app,
                    audio,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                )?;
                return Ok(session.snapshot());
            }

            if started_at.elapsed() >= TIMEOUT {
                emit_project_load_progress(
                    app,
                    percent,
                    "El proyecto se abrio; la preparacion continua en segundo plano.".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                return Ok(session.snapshot());
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    fn finish_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        ready: usize,
        total: usize,
        ram_cache_mb: usize,
        disk_cache_mb: usize,
    ) -> Result<(), DesktopError> {
        let song_opt = self.engine.song().cloned();
        if let Some(song) = song_opt {
            let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
            emit_project_load_progress(
                app,
                84,
                "Preparando waveforms...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            self.ensure_project_waveforms_ready(app, &song_dir, &song)?;
            emit_project_load_progress(
                app,
                88,
                "Waveforms preparadas.".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            let runtime_position_seconds =
                self.runtime_seconds_for_engine_position(self.current_position());
            emit_project_load_progress(
                app,
                90,
                "Preparando cache inicial de reproduccion...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            audio.prepare_playback_at(song.clone(), runtime_position_seconds)?;
            emit_project_load_progress(
                app,
                92,
                "Preparando voces para reproduccion instantanea...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            self.wait_for_prearm_idle(app, audio, ready, total)?;
            let prepared_snapshot = audio.engine_snapshot()?;
            let ram_cache_mb =
                (prepared_snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb =
                (prepared_snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
            emit_project_load_progress(
                app,
                99,
                "Audio preparado. Construyendo vista del proyecto...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            return Ok(());
        }
        emit_project_load_progress(
            app,
            99,
            "Audio preparado. Construyendo vista del proyecto...".into(),
            ready,
            total,
            ram_cache_mb,
            disk_cache_mb,
        );
        Ok(())
    }

    fn wait_for_prearm_idle(
        &self,
        app: &AppHandle,
        audio: &AudioController,
        ready: usize,
        total: usize,
    ) -> Result<(), DesktopError> {
        // Bungee voice priming for marker/region/song targets runs on a
        // background worker after LoadSession. Without waiting here, the first
        // Play after open pays the ~80ms × voices × markers warm cost on the
        // audio thread → multi-second silence before sound starts. Bound the
        // wait so a stuck worker can't freeze the open flow forever.
        const PREARM_TIMEOUT: Duration = Duration::from_secs(30);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        const STABLE_REQUIRED: u32 = 3; // ~150ms of idle to absorb re-post races
        const MIN_POSTS: u64 = 2; // initial (sources empty) + re-post once all decoded
        let started_at = Instant::now();
        let mut last_emitted_percent = 92_u8;
        let mut stable_polls: u32 = 0;
        loop {
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= PREARM_TIMEOUT {
                        return Ok(());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let prearm = &snapshot.prearmed_jumps;
            // The first prearm post (from LoadSession) fires before sources
            // are decoded, so the worker returns in ~0ms with nothing built
            // (ready_count=0). The REAL build only happens after the
            // source_ready callback re-posts once every source is decoded —
            // that's the post we actually need to wait for. So require:
            //   - at least 2 posts have been seen, AND
            //   - completed has caught up to posted, AND
            //   - the prepared cache actually contains voices (ready_count>0)
            //     OR the session legitimately has zero targets (no markers /
            //     regions), in which case prepared_total stays 0 and we'll
            //     bail via the timeout / no-targets check.
            let has_prepared_targets = prearm.ready_count > 0 || prearm.prepared_total > 0;
            let has_no_targets = prearm.active_target_total == 0
                && prearm.ready_count == 0
                && prearm.prepared_total == 0;
            let active_targets_complete = prearm.active_target_total == 0
                || prearm.active_target_completed >= prearm.active_target_total;
            let counters_idle = prearm.completed_count >= prearm.posted_count
                && (prearm.posted_count >= MIN_POSTS || has_prepared_targets || has_no_targets);
            let latest_revision_complete = prearm.latest_posted_revision > 0
                && prearm.last_completed_revision >= prearm.latest_posted_revision
                && active_targets_complete
                && (has_prepared_targets || has_no_targets);
            let idle = !prearm.worker_busy && (counters_idle || latest_revision_complete);
            if idle {
                stable_polls = stable_polls.saturating_add(1);
                if stable_polls >= STABLE_REQUIRED {
                    return Ok(());
                }
            } else {
                stable_polls = 0;
            }
            if started_at.elapsed() >= PREARM_TIMEOUT {
                return Ok(());
            }
            let active_progress = if prearm.active_target_total > 0 {
                let completed = prearm
                    .active_target_completed
                    .min(prearm.active_target_total) as f32;
                let total = prearm.active_target_total as f32;
                (completed / total).clamp(0.0, 1.0)
            } else {
                let elapsed_secs = (started_at.elapsed().as_millis() / 1_000).min(7) as f32;
                (elapsed_secs / 7.0).clamp(0.0, 1.0)
            };
            // Reserve 99% for the moment the worker is actually idle. This
            // prevents the UI from showing 99% while there is still a long
            // tail of target preparation work left.
            let percent = if idle {
                99
            } else {
                92_u8 + (active_progress * 6.0).floor() as u8
            };
            if percent != last_emitted_percent {
                last_emitted_percent = percent;
                let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
                let disk_cache_mb =
                    (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
                emit_project_load_progress(
                    app,
                    percent,
                    "Preparando voces para reproduccion instantanea...".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn finalize_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.wait_for_project_audio_preparation(app, audio)
    }
}
