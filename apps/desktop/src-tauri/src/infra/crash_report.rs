//! What is left behind when the app dies without a Rust panic.
//!
//! `errors.log` only sees panics and failed commands. A native crash (an
//! access violation in the C++ engine, in libmpv, in a GPU driver) kills the
//! process before any of that runs, and a user reporting "it just closed"
//! had nothing to send. Three pieces, from cheapest to most detailed:
//!
//! - **Trail**: the last [`TRAIL_CAPACITY`] notable operations (video loads,
//!   swaps, fades, mpv warnings, MIDI changes…), in memory. Any module adds to
//!   it with [`breadcrumb`]; nothing reaches the disk unless the app crashes.
//! - **Unclean-exit marker**: `logs/session.running` exists while the app
//!   runs and is removed on a normal exit. Found at startup, the previous run
//!   died: one line in `errors.log` says so, with the crash report if one was
//!   written. Also counts the deaths a handler cannot see (a `__fastfail`, the
//!   task manager, a power cut).
//! - **Crash report (Windows)**: an unhandled-exception filter writes
//!   `logs/crashes/crash-<time>.txt` — exception, faulting module, return
//!   addresses on the stack with their modules, recently unloaded DLLs, the
//!   trail — and `crash-<time>.dmp`, a minidump for WinDbg with the PDB of
//!   that release. Only the newest [`KEEP_REPORTS`] are kept.
//!
//! The filter runs inside a process that is already broken, so it does not
//! allocate or take locks it could wait on: it writes with `WriteFile` from
//! stack buffers and reads the trail only through `try_lock`.

// Mobile keeps only the trail (see `install`).
#![cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const TRAIL_CAPACITY: usize = 300;
const KEEP_REPORTS: usize = 3;
const MARKER_FILE: &str = "session.running";
const CRASH_DIR: &str = "crashes";

static TRAIL: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// Remember one operation for a crash report. Cheap; never fails.
pub fn breadcrumb(message: &str) {
    let line = format!("[{}] {message}\n", unix_ms());
    let mut trail = match TRAIL.lock() {
        Ok(trail) => trail,
        Err(poisoned) => poisoned.into_inner(),
    };
    if trail.len() == TRAIL_CAPACITY {
        trail.pop_front();
    }
    trail.push_back(line);
}

/// Sink for crates that cannot depend on the app (`libretracks-video`):
/// `persist` lines also go to `errors.log`.
pub fn breadcrumb_sink(message: &str, persist: bool) {
    breadcrumb(message);
    if persist {
        super::error_log::write_error(message);
    }
}

/// Call once from setup, after `error_log::init`: reports an unclean end of
/// the previous run, marks this one as running and (Windows) installs the
/// crash handler. Desktop only: a phone's OS kills backgrounded apps as a
/// matter of course, which is not a crash.
pub fn install(app_data_dir: &Path) {
    let logs = app_data_dir.join("logs");
    let crashes = logs.join(CRASH_DIR);
    let _ = fs::create_dir_all(&crashes);
    let marker = logs.join(MARKER_FILE);

    PREVIOUS_RUN_UNCLEAN.store(marker.exists(), std::sync::atomic::Ordering::Relaxed);
    report_previous_run(&marker, &crashes);
    prune_reports(&crashes);
    let _ = fs::write(
        &marker,
        format!(
            "version={} pid={} started={}\n",
            env!("CARGO_PKG_VERSION"),
            std::process::id(),
            unix_ms()
        ),
    );
    if let Ok(mut slot) = MARKER.lock() {
        *slot = Some(marker);
    }

    #[cfg(windows)]
    windows::install(&crashes);
}

static MARKER: Mutex<Option<PathBuf>> = Mutex::new(None);
static PREVIOUS_RUN_UNCLEAN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether the previous run left its marker behind (it did not exit
/// cleanly). Valid after [`install`].
pub fn previous_run_was_unclean() -> bool {
    PREVIOUS_RUN_UNCLEAN.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether `logs/session.running` is present under `app_data_dir`.
pub fn unclean_marker_present(app_data_dir: &Path) -> bool {
    app_data_dir.join("logs").join(MARKER_FILE).exists()
}

/// The app is exiting normally.
pub fn mark_clean_exit() {
    let marker = match MARKER.lock() {
        Ok(mut slot) => slot.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(marker) = marker {
        let _ = fs::remove_file(marker);
    }
}

fn report_previous_run(marker: &Path, crashes: &Path) {
    if let Some(message) = previous_run_message(marker, crashes) {
        super::error_log::write_error(&message);
    }
}

/// What `errors.log` says about the previous run, if it did not end cleanly.
fn previous_run_message(marker: &Path, crashes: &Path) -> Option<String> {
    let previous = fs::read_to_string(marker).ok()?;
    let started = fs::metadata(marker).and_then(|meta| meta.modified()).ok();
    // Reports written by the previous run: newer than its marker.
    let mut reports: Vec<PathBuf> = fs::read_dir(crashes)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
        .filter(|path| {
            let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok();
            match (started, modified) {
                (Some(started), Some(modified)) => modified >= started,
                _ => false,
            }
        })
        .collect();
    reports.sort();

    let mut message = format!(
        "[crash] la ejecución anterior no se cerró con normalidad ({})",
        previous.trim()
    );
    match reports.last() {
        Some(report) => {
            message.push_str(&format!("; informe: {}", report.display()));
            // The summary (everything before the trail) is what a user pastes.
            if let Ok(text) = fs::read_to_string(report) {
                let summary = text.split("--- trail").next().unwrap_or("").trim_end();
                message.push('\n');
                message.push_str(summary);
            }
        }
        None => message.push_str(
            "; sin informe de fallo (cierre forzado, apagado, o un fallo que no pasa por el manejador)",
        ),
    }
    Some(message)
}

/// Keep the newest `KEEP_REPORTS` reports (a `.txt` and its `.dmp`).
fn prune_reports(crashes: &Path) {
    let mut stems: Vec<String> = fs::read_dir(crashes)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".txt").or_else(|| name.strip_suffix(".dmp"))?;
            stem.starts_with("crash-").then(|| stem.to_string())
        })
        .collect();
    stems.sort();
    stems.dedup();
    // `crash-<unix seconds>`: same width for centuries, so text order is time order.
    let excess = stems.len().saturating_sub(KEEP_REPORTS);
    for stem in &stems[..excess] {
        let _ = fs::remove_file(crashes.join(format!("{stem}.txt")));
        let _ = fs::remove_file(crashes.join(format!("{stem}.dmp")));
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::sync::OnceLock;

    type Handle = *mut c_void;
    type Filter = unsafe extern "system" fn(*mut ExceptionPointers) -> i32;

    #[repr(C)]
    struct ExceptionPointers {
        record: *mut ExceptionRecord,
        context: *mut c_void,
    }

    #[repr(C)]
    struct ExceptionRecord {
        code: u32,
        flags: u32,
        record: *mut ExceptionRecord,
        address: *mut c_void,
        parameter_count: u32,
        information: [usize; 15],
    }

    /// dbghelp.h wraps it in `pshpack4.h`.
    #[repr(C, packed(4))]
    struct MinidumpExceptionInformation {
        thread_id: u32,
        pointers: *mut ExceptionPointers,
        client_pointers: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetUnhandledExceptionFilter(filter: Option<Filter>) -> Option<Filter>;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn WriteFile(file: Handle, buffer: *const u8, len: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn GetCurrentProcessId() -> u32;
        fn GetCurrentThreadId() -> u32;
        fn GetSystemTimeAsFileTime(time: *mut u64);
        fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut Handle) -> i32;
        fn GetModuleFileNameW(module: Handle, name: *mut u16, size: u32) -> u32;
        fn ReadProcessMemory(process: Handle, base: *const c_void, buffer: *mut c_void, size: usize, read: *mut usize) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetUnloadEventTraceEx(size: *mut *mut u32, count: *mut *mut u32, trace: *mut *mut c_void);
    }

    #[link(name = "dbghelp")]
    extern "system" {
        fn MiniDumpWriteDump(
            process: Handle,
            process_id: u32,
            file: Handle,
            dump_type: u32,
            exception: *const MinidumpExceptionInformation,
            user_stream: *const c_void,
            callback: *const c_void,
        ) -> i32;
    }

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const CREATE_ALWAYS: u32 = 2;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const INVALID_HANDLE: Handle = -1isize as Handle;
    const FROM_ADDRESS: u32 = 0x4;
    const UNCHANGED_REFCOUNT: u32 = 0x2;
    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

    /// Threads, unloaded modules (an address in a DLL that was already gone
    /// shows up only there), handles and the memory the stacks point at:
    /// a few MB, enough for a stack in WinDbg.
    const DUMP_TYPE: u32 = 0x4 | 0x20 | 0x40 | 0x100 | 0x1000;

    /// `<crashes>\crash-`, NUL-free, built once at install.
    static PREFIX: OnceLock<Vec<u16>> = OnceLock::new();
    static PREVIOUS: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static ENTERED: AtomicBool = AtomicBool::new(false);

    pub fn install(crashes: &Path) {
        let mut prefix: Vec<u16> = crashes.as_os_str().encode_wide().collect();
        prefix.extend("\\crash-".encode_utf16());
        if PREFIX.set(prefix).is_err() {
            return;
        }
        // SAFETY: installing a process-wide filter; `on_crash` matches the
        // `LPTOP_LEVEL_EXCEPTION_FILTER` signature.
        let previous = unsafe { SetUnhandledExceptionFilter(Some(on_crash)) };
        if let Some(previous) = previous {
            PREVIOUS.store(previous as *mut c_void, Ordering::Release);
        }
    }

    /// A fixed buffer to build text in without allocating.
    struct Buf {
        bytes: [u8; 1024],
        len: usize,
    }

    impl Buf {
        fn new() -> Self {
            Self {
                bytes: [0; 1024],
                len: 0,
            }
        }
        fn push(&mut self, text: &[u8]) -> &mut Self {
            let room = self.bytes.len() - self.len;
            let take = text.len().min(room);
            self.bytes[self.len..self.len + take].copy_from_slice(&text[..take]);
            self.len += take;
            self
        }
        fn str(&mut self, text: &str) -> &mut Self {
            self.push(text.as_bytes())
        }
        fn hex(&mut self, value: u64) -> &mut Self {
            let mut digits = [0u8; 18];
            digits[0] = b'0';
            digits[1] = b'x';
            for index in 0..16 {
                let nibble = ((value >> ((15 - index) * 4)) & 0xf) as u8;
                digits[2 + index] = if nibble < 10 { b'0' + nibble } else { b'a' + nibble - 10 };
            }
            self.push(&digits)
        }
        fn dec(&mut self, mut value: u64) -> &mut Self {
            let mut digits = [0u8; 20];
            let mut at = digits.len();
            loop {
                at -= 1;
                digits[at] = b'0' + (value % 10) as u8;
                value /= 10;
                if value == 0 {
                    break;
                }
            }
            self.push(&digits[at..])
        }
        fn utf16(&mut self, text: &[u16]) -> &mut Self {
            for decoded in char::decode_utf16(text.iter().copied()) {
                let mut utf8 = [0u8; 4];
                let character = decoded.unwrap_or('?');
                self.push(character.encode_utf8(&mut utf8).as_bytes());
            }
            self
        }
        fn write_to(&mut self, file: Handle) {
            write_all(file, &self.bytes[..self.len]);
            self.len = 0;
        }
    }

    fn write_all(file: Handle, bytes: &[u8]) {
        let mut written = 0u32;
        // SAFETY: valid handle and buffer for the duration of the call.
        unsafe {
            WriteFile(file, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut());
        }
    }

    fn create(path: &[u16]) -> Handle {
        // SAFETY: NUL-terminated path in a live buffer.
        unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
                0,
                std::ptr::null_mut(),
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        }
    }

    /// Read memory that may not be readable, without faulting.
    fn read_usize(address: usize) -> Option<usize> {
        let mut value = 0usize;
        let mut read = 0usize;
        // SAFETY: ReadProcessMemory validates the source range itself.
        let ok = unsafe {
            ReadProcessMemory(
                GetCurrentProcess(),
                address as *const c_void,
                &mut value as *mut usize as *mut c_void,
                std::mem::size_of::<usize>(),
                &mut read,
            )
        };
        (ok != 0 && read == std::mem::size_of::<usize>()).then_some(value)
    }

    /// "name.dll+0x1234" for an address inside a loaded module.
    fn describe_address(buf: &mut Buf, address: usize) -> bool {
        let mut module: Handle = std::ptr::null_mut();
        // SAFETY: FROM_ADDRESS takes the address in place of a name; with
        // UNCHANGED_REFCOUNT nothing has to be released.
        let found = unsafe { GetModuleHandleExW(FROM_ADDRESS | UNCHANGED_REFCOUNT, address as *const u16, &mut module) };
        // The base itself is a module handle lying around, not code.
        if found == 0 || module.is_null() || module as usize == address {
            return false;
        }
        let mut name = [0u16; 260];
        // SAFETY: valid module handle and buffer length.
        let len = unsafe { GetModuleFileNameW(module, name.as_mut_ptr(), name.len() as u32) } as usize;
        let full = &name[..len.min(name.len())];
        let file = full
            .iter()
            .rposition(|&unit| unit == u16::from(b'\\'))
            .map_or(full, |slash| &full[slash + 1..]);
        buf.utf16(file).str("+").hex((address - module as usize) as u64);
        true
    }

    /// The unload trace: DLLs unloaded recently, so an address that lands
    /// in one (code that ran after its DLL was gone) can be named.
    fn write_unloaded(file: Handle, fault: usize) {
        let mut size: *mut u32 = std::ptr::null_mut();
        let mut count: *mut u32 = std::ptr::null_mut();
        let mut trace: *mut c_void = std::ptr::null_mut();
        // SAFETY: out-pointers to locals; ntdll fills them with pointers to
        // its own (static) trace.
        unsafe { RtlGetUnloadEventTraceEx(&mut size, &mut count, &mut trace) };
        let (Some(size), Some(count)) = (
            (!size.is_null()).then(|| read_usize(size as usize)).flatten().map(|v| v as u32),
            (!count.is_null()).then(|| read_usize(count as usize)).flatten().map(|v| v as u32),
        ) else {
            return;
        };
        // `trace` points at the variable that holds the array.
        let Some(array) = read_usize(trace as usize).filter(|&array| array != 0) else {
            return;
        };
        let mut buf = Buf::new();
        buf.str("--- DLLs descargadas recientemente\n").write_to(file);
        for index in 0..count.min(64) as usize {
            let entry = array + index * size as usize;
            let (Some(base), Some(image_size)) = (read_usize(entry), read_usize(entry + 8)) else {
                break;
            };
            if base == 0 {
                continue;
            }
            // ImageName: 32 UTF-16 units after BaseAddress, SizeOfImage,
            // Sequence, TimeDateStamp, CheckSum (8 + 8 + 4 + 4 + 4).
            let mut name = [0u16; 32];
            let mut read = 0usize;
            // SAFETY: as in `read_usize`.
            unsafe {
                ReadProcessMemory(
                    GetCurrentProcess(),
                    (entry + 28) as *const c_void,
                    name.as_mut_ptr() as *mut c_void,
                    64,
                    &mut read,
                );
            }
            let len = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
            buf.hex(base as u64).str(" ").hex(image_size as u64).str(" ").utf16(&name[..len]);
            if fault >= base && fault < base + image_size {
                buf.str("   <-- la dirección del fallo está AQUÍ");
            }
            buf.str("\n").write_to(file);
        }
    }

    fn write_report(file: Handle, pointers: *mut ExceptionPointers) {
        let mut buf = Buf::new();
        buf.str("LibreTracks ")
            .str(env!("CARGO_PKG_VERSION"))
            .str(" — fallo nativo\nhilo ")
            .dec(u64::from(unsafe { GetCurrentThreadId() }))
            .str("\n");
        let mut fault = 0usize;
        // SAFETY: the system hands the filter valid exception pointers.
        if let Some(record) = unsafe { pointers.as_ref() }.and_then(|pointers| unsafe { pointers.record.as_ref() }) {
            fault = record.address as usize;
            buf.str("excepción ").hex(u64::from(record.code)).str(" en ").hex(fault as u64);
            buf.str(" (");
            if !describe_address(&mut buf, fault) {
                buf.str("fuera de cualquier módulo cargado");
            }
            buf.str(")\n");
            if record.code == 0xC000_0005 && record.parameter_count >= 2 {
                let kind = match record.information[0] {
                    0 => "leer",
                    1 => "escribir",
                    8 => "EJECUTAR (DEP)",
                    _ => "acceder a",
                };
                buf.str("intentó ").str(kind).str(" ").hex(record.information[1] as u64).str("\n");
            }
        }
        buf.write_to(file);

        // A return-address scan of the top of the stack: whatever points into
        // a module is likely a caller. Read with ReadProcessMemory, so a bad
        // stack pointer cannot fault in here.
        #[cfg(target_arch = "x86_64")]
        if let Some(context) = unsafe { pointers.as_ref() }.map(|pointers| pointers.context as usize) {
            const RSP: usize = 0x98;
            if let Some(rsp) = read_usize(context + RSP) {
                buf.str("--- pila (rsp ").hex(rsp as u64).str("), direcciones dentro de módulos\n").write_to(file);
                let mut shown = 0;
                for slot in 0..512usize {
                    let Some(value) = read_usize(rsp + slot * 8) else {
                        break;
                    };
                    if value > 0x10000 && describe_address(&mut buf, value) {
                        buf.str("\n").write_to(file);
                        shown += 1;
                        if shown == 40 {
                            break;
                        }
                    } else {
                        buf.len = 0;
                    }
                }
            }
        }

        write_unloaded(file, fault);

        if let Ok(ui) = crate::infra::ui_diagnostics::try_latest() {
            buf.str("--- último estado de la interfaz\n").write_to(file);
            write_all(file, ui.as_bytes());
            write_all(file, b"\n");
        }

        // The marker for `report_previous_run`: everything before it is the
        // summary copied into errors.log.
        write_all(file, "--- trail (últimas operaciones, la más reciente al final)\n".as_bytes());
        if let Ok(trail) = super::TRAIL.try_lock() {
            for line in trail.iter() {
                write_all(file, line.as_bytes());
            }
        } else {
            write_all(file, b"(ocupado en el momento del fallo)\n");
        }
    }

    unsafe extern "system" fn on_crash(pointers: *mut ExceptionPointers) -> i32 {
        // One report per process: a second fault inside this filter, or on
        // another thread at the same time, goes straight on.
        if !ENTERED.swap(true, Ordering::AcqRel) {
            if let Some(prefix) = PREFIX.get() {
                let mut seconds = 0u64;
                GetSystemTimeAsFileTime(&mut seconds);
                // FILETIME: 100 ns since 1601 -> Unix seconds.
                let seconds = (seconds / 10_000_000).saturating_sub(11_644_473_600);
                let mut path = [0u16; 1024];
                let stem_len = prefix.len().min(path.len() - 32);
                path[..stem_len].copy_from_slice(&prefix[..stem_len]);
                let mut len = stem_len;
                let mut digits = Buf::new();
                digits.dec(seconds);
                for &digit in &digits.bytes[..digits.len] {
                    path[len] = u16::from(digit);
                    len += 1;
                }
                let with_extension = |path: &mut [u16; 1024], extension: &str| {
                    let mut end = len;
                    for unit in extension.encode_utf16() {
                        path[end] = unit;
                        end += 1;
                    }
                    path[end] = 0;
                };

                // The text first: it is what a user can read and paste, and
                // writing the dump is what is most likely to fail in here.
                with_extension(&mut path, ".txt");
                let text = create(&path);
                if text != INVALID_HANDLE {
                    write_report(text, pointers);
                    CloseHandle(text);
                }

                with_extension(&mut path, ".dmp");
                let dump = create(&path);
                if dump != INVALID_HANDLE {
                    let info = MinidumpExceptionInformation {
                        thread_id: GetCurrentThreadId(),
                        pointers,
                        client_pointers: 0,
                    };
                    MiniDumpWriteDump(
                        GetCurrentProcess(),
                        GetCurrentProcessId(),
                        dump,
                        DUMP_TYPE,
                        &info,
                        std::ptr::null(),
                        std::ptr::null(),
                    );
                    CloseHandle(dump);
                }
            }
        }
        // Let Windows Error Reporting go on as before (and any filter that
        // was there first).
        let previous = PREVIOUS.load(Ordering::Acquire);
        if !previous.is_null() {
            // SAFETY: it was returned by SetUnhandledExceptionFilter as a filter.
            let previous: Filter = std::mem::transmute(previous);
            return previous(pointers);
        }
        EXCEPTION_CONTINUE_SEARCH
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trail_keeps_only_the_newest_entries() {
        for index in 0..TRAIL_CAPACITY + 5 {
            breadcrumb(&format!("op {index}"));
        }
        let trail = TRAIL.lock().unwrap();
        assert_eq!(trail.len(), TRAIL_CAPACITY);
        assert!(trail.back().unwrap().ends_with(&format!("op {}\n", TRAIL_CAPACITY + 4)));
        assert!(!trail.iter().any(|line| line.ends_with(" op 4\n")));
    }

    /// End to end, in a child process: a crash of the kind the field report
    /// showed (code executed from data memory, DEP) must leave the text
    /// report and the minidump, and the next start must say so.
    #[cfg(windows)]
    #[test]
    fn a_native_crash_leaves_a_report_and_the_next_start_says_so() {
        const CHILD: &str = "LT_CRASH_REPORT_CHILD_DIR";
        let dir = std::env::temp_dir().join(format!("lt-crash-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "infra::crash_report::tests::crash_child", "--ignored", "--nocapture"])
            .env(CHILD, &dir)
            .status()
            .unwrap();
        assert!(!status.success(), "the child must have crashed");

        let crashes = dir.join("logs").join(CRASH_DIR);
        let reports: Vec<PathBuf> = fs::read_dir(&crashes)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        let text = reports
            .iter()
            .find(|path| path.extension().is_some_and(|ext| ext == "txt"))
            .expect("a text report");
        let dump = text.with_extension("dmp");
        assert!(fs::metadata(&dump).map(|meta| meta.len() > 10_000).unwrap_or(false), "a minidump");
        let report = fs::read_to_string(text).unwrap();
        assert!(report.contains("excepción 0x00000000c0000005"), "{report}");
        assert!(report.contains("EJECUTAR (DEP)"), "{report}");
        assert!(report.contains("fuera de cualquier módulo cargado"), "{report}");
        assert!(report.contains("--- pila"), "{report}");
        assert!(report.contains("antes del fallo"), "the trail: {report}");
        assert!(report.to_lowercase().contains("msimg32.dll"), "the unloaded DLL: {report}");

        // The child never exited cleanly: its marker is still there.
        let message = previous_run_message(&dir.join("logs").join(MARKER_FILE), &crashes)
            .expect("an unclean previous run");
        assert!(message.contains("informe:"), "{message}");
        assert!(message.contains("EJECUTAR (DEP)"), "the summary is in errors.log: {message}");
        assert!(!message.contains("antes del fallo"), "but not the trail: {message}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The crashing half of the test above; runs only as its child.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn crash_child() {
        let Some(dir) = std::env::var_os("LT_CRASH_REPORT_CHILD_DIR") else {
            return;
        };
        #[link(name = "kernel32")]
        extern "system" {
            fn SetErrorMode(mode: u32) -> u32;
            fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
            fn FreeLibrary(module: *mut std::ffi::c_void) -> i32;
        }
        // SAFETY: no "stopped working" dialog to block the parent test.
        unsafe { SetErrorMode(0x0002) };
        // A DLL loaded and unloaded, for the unloaded-modules section.
        let name: Vec<u16> = "msimg32.dll\0".encode_utf16().collect();
        // SAFETY: a system DLL with no initialisation side effects.
        unsafe {
            let module = LoadLibraryW(name.as_ptr());
            assert!(!module.is_null());
            FreeLibrary(module);
        }
        install(Path::new(&dir));
        breadcrumb("antes del fallo");
        // Heap memory is not executable: calling into it is a DEP fault,
        // the same kind as the field crash.
        let data = Box::new([0xC3u8; 16]);
        let function: extern "C" fn() = unsafe { std::mem::transmute(data.as_ptr()) };
        function();
        unreachable!("DEP must have stopped the call");
    }

    #[test]
    fn only_the_newest_reports_survive_pruning() {
        let dir = std::env::temp_dir().join(format!("lt-crash-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for seconds in [1_700_000_001u64, 1_700_000_002, 1_700_000_003, 1_700_000_004] {
            fs::write(dir.join(format!("crash-{seconds}.txt")), "x").unwrap();
            fs::write(dir.join(format!("crash-{seconds}.dmp")), "x").unwrap();
        }
        fs::write(dir.join("unrelated.txt"), "x").unwrap();
        prune_reports(&dir);
        assert!(!dir.join("crash-1700000001.txt").exists());
        assert!(!dir.join("crash-1700000001.dmp").exists());
        assert!(dir.join("crash-1700000004.dmp").exists());
        assert!(dir.join("crash-1700000002.txt").exists());
        assert!(dir.join("unrelated.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
