//! On-demand sampler for operating-system resource usage (CPU / RAM / disk).
//!
//! Backs the top-bar resource meter. Sampling is driven by the frontend's
//! ~1 Hz poll through the `get_system_resource_snapshot` command; this module
//! keeps the persistent `sysinfo::System` and the previous disk counters that
//! the rate calculation needs.
//!
//! Why persistent state matters:
//! - sysinfo computes CPU% as the delta between two refreshes, so the very
//!   first refresh after construction yields 0% until a second one happens.
//! - `Process::disk_usage()` reports *cumulative* bytes read/written, so a
//!   bytes-per-second rate only exists by differencing against the previous
//!   sample and the elapsed wall-clock time.
//!
//! Sampling is intentionally cheap: we reuse one `System` and refresh only the
//! pieces we report (global CPU, memory, and the process list) — never
//! `refresh_all()` — so the meter doesn't inflate the very numbers it reports.
//!
//! Why we walk the whole process list: on a Tauri/WebView2 app the visible
//! cost is split across *several* OS processes — the Rust core
//! (`get_current_pid()`) plus the WebView2 renderer/GPU children, which on
//! Windows are the bulk of CPU and RAM. Sampling only our own PID would report
//! a fraction of what Task Manager shows, so we aggregate our process together
//! with its transitive descendants.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System,
};

use crate::models::SystemResourceSnapshot;

struct MonitorInner {
    system: System,
    pid: Option<Pid>,
    /// Cumulative disk counters from the previous sample, plus the instant we
    /// read them, so the next sample can derive a bytes/sec rate.
    last_disk: Option<DiskBaseline>,
}

#[derive(Clone, Copy)]
struct DiskBaseline {
    read_bytes: u64,
    written_bytes: u64,
    at: Instant,
}

/// Thread-safe resource sampler held in `DesktopState`.
pub struct ResourceMonitor {
    inner: Mutex<MonitorInner>,
}

impl Default for ResourceMonitor {
    fn default() -> Self {
        // Only the pieces we report — keeps construction and refresh cheap.
        // Processes carry CPU + memory + disk so we can aggregate our whole
        // process family (core + WebView2 children).
        let specifics = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram())
            .with_processes(
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_disk_usage(),
            );
        let system = System::new_with_specifics(specifics);

        ResourceMonitor {
            inner: Mutex::new(MonitorInner {
                system,
                pid: sysinfo::get_current_pid().ok(),
                last_disk: None,
            }),
        }
    }
}

impl ResourceMonitor {
    /// Take a fresh sample of CPU / RAM / disk usage.
    ///
    /// Best-effort: if the lock is poisoned or the process can't be found we
    /// return zeros rather than failing the command, since this is a
    /// diagnostics surface and must never break the UI.
    pub fn sample(&self) -> SystemResourceSnapshot {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        inner.system.refresh_cpu_usage();
        inner
            .system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

        // Refresh every process: we need the full list to build the parent →
        // child links that let us find our WebView2 descendants. Don't remove
        // dead processes — we never enumerate stale ones, and keeping them
        // avoids re-allocating the map each tick.
        inner.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            false,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_disk_usage(),
        );

        let system_cpu_percent = inner.system.global_cpu_usage();
        let system_memory_used_bytes = inner.system.used_memory();
        let system_memory_total_bytes = inner.system.total_memory();
        // Normalise per-core process CPU to a 0..100 whole-machine scale so it
        // matches Task Manager / Activity Monitor. cpus() is non-empty in
        // practice but guard against a zero divisor regardless.
        let core_count = inner.system.cpus().len().max(1) as f32;

        // The set of PIDs making up "our app": the core process plus every
        // transitive descendant (WebView2 renderer/GPU/utility children).
        let family = inner.pid.map(|pid| collect_family(&inner.system, pid));

        let mut process_cpu_raw = 0.0_f32;
        let mut process_memory_bytes = 0_u64;
        let mut total_read_bytes = 0_u64;
        let mut total_written_bytes = 0_u64;
        if let Some(family) = &family {
            for pid in family {
                if let Some(p) = inner.system.process(*pid) {
                    process_cpu_raw += p.cpu_usage();
                    process_memory_bytes += p.memory();
                    let usage = p.disk_usage();
                    total_read_bytes = total_read_bytes.saturating_add(usage.total_read_bytes);
                    total_written_bytes =
                        total_written_bytes.saturating_add(usage.total_written_bytes);
                }
            }
        }
        let process_cpu_percent = process_cpu_raw / core_count;

        // Disk: difference the family's cumulative counters against the
        // previous sample.
        let now = Instant::now();
        let (disk_read_bytes_per_sec, disk_write_bytes_per_sec) = match inner.last_disk {
            Some(prev) => {
                let elapsed = now.duration_since(prev.at).as_secs_f64();
                if elapsed > 0.0 {
                    let read = total_read_bytes.saturating_sub(prev.read_bytes);
                    let written = total_written_bytes.saturating_sub(prev.written_bytes);
                    (
                        (read as f64 / elapsed) as u64,
                        (written as f64 / elapsed) as u64,
                    )
                } else {
                    (0, 0)
                }
            }
            // No baseline yet: first sample reports 0 bytes/sec.
            None => (0, 0),
        };
        inner.last_disk = Some(DiskBaseline {
            read_bytes: total_read_bytes,
            written_bytes: total_written_bytes,
            at: now,
        });

        SystemResourceSnapshot {
            process_cpu_percent,
            process_memory_bytes,
            system_cpu_percent,
            system_memory_used_bytes,
            system_memory_total_bytes,
            disk_read_bytes_per_sec,
            disk_write_bytes_per_sec,
            // Audio-engine fields are filled in by the command from the engine
            // snapshot; this sampler only knows about the OS.
            audio_load_percent: 0.0,
            audio_underrun_count: 0,
            audio_engine_active: false,
        }
    }
}

/// Collect `root` plus every transitive child process, so the meter accounts
/// for the WebView2 renderer/GPU/utility processes spawned under our core.
///
/// sysinfo only exposes the parent link (`Process::parent()`), so we build the
/// descendant set with a breadth-first sweep: seed with `root`, then repeatedly
/// pull in any process whose parent is already in the set until it stops
/// growing. Process counts are small (hundreds), so the few passes this takes
/// are negligible next to the refresh itself.
fn collect_family(system: &System, root: Pid) -> HashSet<Pid> {
    let mut family = HashSet::new();
    family.insert(root);

    loop {
        let mut added = false;
        for (pid, process) in system.processes() {
            if family.contains(pid) {
                continue;
            }
            if let Some(parent) = process.parent() {
                if family.contains(&parent) {
                    family.insert(*pid);
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }

    family
}
