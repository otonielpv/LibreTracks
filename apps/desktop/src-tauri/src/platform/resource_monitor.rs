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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

// ProcessesToUpdate solo lo usa el muestreo de escritorio.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(unused_imports))]
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
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    last_disk: Option<DiskBaseline>,
    /// Móvil: tiempo de CPU acumulado del proceso en la muestra anterior.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    last_cpu: Option<CpuBaseline>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Clone, Copy)]
struct CpuBaseline {
    cpu_seconds: f64,
    at: Instant,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                last_disk: None,
                #[cfg(any(target_os = "android", target_os = "ios"))]
                last_cpu: None,
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

        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            mobile::sample(&mut inner)
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            Self::sample_desktop(&mut inner)
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn sample_desktop(inner: &mut MonitorInner) -> SystemResourceSnapshot {
        inner.system.refresh_cpu_usage();
        inner
            .system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

        // Refresh every process to build the parent/child links for our WebView
        // descendants. Remove dead entries: retaining their last CPU/RSS sample
        // can make the app-family totals grow after those children have exited.
        inner.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
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

        // Linux WebKitGTK splits the app into processes that share many mapped
        // pages. Summed RSS counts those pages once per process; PSS apportions
        // them and is the meaningful aggregate footprint. Keep sysinfo RSS as
        // the fallback when /proc is restricted or lacks smaps_rollup.
        #[cfg(target_os = "linux")]
        if let Some(pss_bytes) = family.as_ref().and_then(linux_family_pss_bytes) {
            process_memory_bytes = pss_bytes;
        }

        // Guard against over-counting the family's memory. `Process::memory()`
        // reports each process's RSS, and on Linux the WebKitGTK process model
        // (WebProcess + NetworkProcess + GPU child) shares large mapped regions
        // — shared libraries and shared-memory buffers between the processes.
        // Summing raw RSS counts those shared pages once per process, which on
        // real user machines inflated the meter to absurd values (e.g. "91.2 GB"
        // on a 15.5 GB box). sysinfo exposes no portable shared/PSS figure to
        // subtract, so clamp the aggregate to the RAM the whole system is
        // actually using: our process family physically cannot hold more
        // resident memory than that. This keeps the meter truthful as a
        // "is it us or the machine?" diagnostic on every platform.
        if system_memory_used_bytes > 0 {
            process_memory_bytes = process_memory_bytes.min(system_memory_used_bytes);
        }

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
            available_memory_bytes: 0,
        }
    }
}

/// Muestreo en Android e iOS.
///
/// No sirve el camino de escritorio: el WebView corre en un proceso aislado con
/// otro uid que no aparece como hijo, Android prohíbe `/proc/stat` a las apps
/// (CPU del sistema) y en iOS sysinfo no ve ningún proceso. Así que se mide
/// solo el proceso propio —donde viven el motor de audio y el núcleo— y nunca
/// se recorre la lista entera, que a 1 Hz gastaría batería para nada.
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile {
    use std::time::Instant;

    use sysinfo::MemoryRefreshKind;

    use super::{CpuBaseline, MonitorInner};
    use crate::models::SystemResourceSnapshot;

    pub(super) fn sample(inner: &mut MonitorInner) -> SystemResourceSnapshot {
        inner
            .system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

        // CPU de la app: tiempo de CPU acumulado (todos los hilos) entre dos
        // muestras, normalizado a la máquina entera como en escritorio.
        let now = Instant::now();
        let cpu_seconds = process_cpu_seconds();
        let process_cpu_percent = match (inner.last_cpu, cpu_seconds) {
            (Some(prev), Some(current)) => {
                let elapsed = now.duration_since(prev.at).as_secs_f64();
                let cores = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(1) as f64;
                if elapsed > 0.0 {
                    ((current - prev.cpu_seconds).max(0.0) / elapsed / cores * 100.0) as f32
                } else {
                    0.0
                }
            }
            // Sin muestra anterior todavía: 0 %, igual que el disco en escritorio.
            _ => 0.0,
        };
        inner.last_cpu = cpu_seconds.map(|cpu_seconds| CpuBaseline {
            cpu_seconds,
            at: now,
        });

        SystemResourceSnapshot {
            process_cpu_percent,
            process_memory_bytes: process_memory_bytes(inner),
            // Ni CPU del sistema ni disco: en Android no son legibles y en iOS
            // no hay API pública de disco por proceso. La UI móvil no los pinta.
            system_cpu_percent: 0.0,
            system_memory_used_bytes: inner.system.used_memory(),
            system_memory_total_bytes: inner.system.total_memory(),
            disk_read_bytes_per_sec: 0,
            disk_write_bytes_per_sec: 0,
            audio_load_percent: 0.0,
            audio_underrun_count: 0,
            audio_engine_active: false,
            available_memory_bytes: available_memory_bytes(),
        }
    }

    fn process_cpu_seconds() -> Option<f64> {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage solo escribe en el struct que le pasamos.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: devolvió 0, así que el struct está relleno.
        let usage = unsafe { usage.assume_init() };
        let seconds = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1_000_000.0;
        Some(seconds(usage.ru_utime) + seconds(usage.ru_stime))
    }

    #[cfg(target_os = "android")]
    fn process_memory_bytes(inner: &mut MonitorInner) -> u64 {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};

        let Some(pid) = inner.pid else {
            return 0;
        };
        inner.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        inner.system.process(pid).map(|p| p.memory()).unwrap_or(0)
    }

    /// `phys_footprint`: la cifra que usa iOS para decidir si mata la app y la
    /// que enseña Xcode. sysinfo no la da (en iOS no ve procesos).
    #[cfg(target_os = "ios")]
    fn process_memory_bytes(_inner: &mut MonitorInner) -> u64 {
        /// `task_vm_info_data_t` hasta `phys_footprint` (TASK_VM_INFO_REV1_COUNT).
        /// El kernel rellena solo los campos que caben en `count`.
        #[repr(C)]
        #[derive(Default)]
        #[allow(dead_code)]
        struct TaskVmInfoRev1 {
            virtual_size: u64,
            region_count: i32,
            page_size: i32,
            // resident_size … compressed_lifetime: no los usamos.
            _rev0: [u64; 16],
            phys_footprint: u64,
        }
        const TASK_VM_INFO: libc::task_flavor_t = 22;

        let mut info = TaskVmInfoRev1::default();
        let mut count = (std::mem::size_of::<TaskVmInfoRev1>()
            / std::mem::size_of::<libc::natural_t>())
            as libc::mach_msg_type_number_t;
        // SAFETY: el buffer mide exactamente `count` natural_t.
        #[allow(deprecated)]
        let result = unsafe {
            libc::task_info(
                libc::mach_task_self(),
                TASK_VM_INFO,
                &mut info as *mut TaskVmInfoRev1 as libc::task_info_t,
                &mut count,
            )
        };
        if result == libc::KERN_SUCCESS {
            info.phys_footprint
        } else {
            0
        }
    }

    #[cfg(target_os = "ios")]
    fn available_memory_bytes() -> u64 {
        extern "C" {
            // <os/proc.h>, iOS 13+.
            fn os_proc_available_memory() -> libc::size_t;
        }
        // SAFETY: sin argumentos ni efectos secundarios.
        unsafe { os_proc_available_memory() as u64 }
    }

    #[cfg(target_os = "android")]
    fn available_memory_bytes() -> u64 {
        0
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
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

#[cfg(target_os = "linux")]
fn linux_family_pss_bytes(family: &HashSet<Pid>) -> Option<u64> {
    let mut total = 0_u64;
    let mut measured = 0_usize;
    for pid in family {
        let path = format!("/proc/{}/smaps_rollup", pid.as_u32());
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let Some(bytes) = parse_smaps_rollup_pss_bytes(&contents) else {
            continue;
        };
        total = total.saturating_add(bytes);
        measured += 1;
    }
    (measured == family.len() && measured > 0).then_some(total)
}

#[cfg(target_os = "linux")]
fn parse_smaps_rollup_pss_bytes(contents: &str) -> Option<u64> {
    let kilobytes = contents.lines().find_map(|line| {
        let value = line.strip_prefix("Pss:")?.trim();
        value.split_whitespace().next()?.parse::<u64>().ok()
    })?;
    kilobytes.checked_mul(1024)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::parse_smaps_rollup_pss_bytes;

    #[test]
    fn parses_pss_from_smaps_rollup() {
        let sample =
            "Rss:               2048 kB\nPss:               1536 kB\nPss_Dirty:          128 kB\n";
        assert_eq!(parse_smaps_rollup_pss_bytes(sample), Some(1536 * 1024));
    }
}
