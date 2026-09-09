//! Free space on the volume that will hold a path.
//!
//! Extracted from `session_package`, which needed it to refuse an import before
//! writing the first byte. The prepared-render store needs the same answer for
//! the same reason, and two copies of a platform `unsafe` block is one too many.

use std::path::Path;

/// Free bytes on the volume that will hold `path`, or `None` when we cannot
/// tell.
///
/// `None` means "proceed anyway": refusing on a failed stat would block the
/// caller on filesystems we simply cannot measure, which is worse than the risk
/// of running out. Callers treat it as unknown, never as zero.
///
/// Walks up to the nearest existing ancestor, because the destination directory
/// usually does not exist yet when the caller asks.
pub fn free_space_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    loop {
        if probe.exists() {
            return free_space_of_existing_dir(probe);
        }
        probe = probe.parent()?;
    }
}

#[cfg(windows)]
fn free_space_of_existing_dir(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available: u64 = 0;
    // SAFETY: the string is NUL-terminated and outlives the call, and the two
    // null pointers are the documented way to ask for only the first field.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(unix)]
fn free_space_of_existing_dir(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs only reads through the borrowed C string, and the buffer
    // is fully initialised by the call before we read it.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(path.as_ptr(), &mut stat) != 0 {
            return None;
        }
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
}
