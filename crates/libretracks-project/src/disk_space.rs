//! Free space on the volume that will hold a path.
//!
//! Extracted from `session_package`, which needed it to refuse an import before
//! writing the first byte. The prepared-render store needs the same answer for
//! the same reason, and two copies of a platform `unsafe` block is one too many.

use std::io;
use std::path::Path;

use crate::ProjectError;

/// Whether an I/O error means "the volume is full". `StorageFull` covers the
/// usual codes; the raw ones are a fallback for platforms where std leaves
/// them as `Other` (ENOSPC = 28 on Unix, ERROR_DISK_FULL = 112 and
/// ERROR_HANDLE_DISK_FULL = 39 on Windows).
pub fn is_disk_full(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::StorageFull {
        return true;
    }
    match error.raw_os_error() {
        #[cfg(unix)]
        Some(28) => true,
        #[cfg(windows)]
        Some(112 | 39) => true,
        _ => false,
    }
}

/// Refuse to start writing `needed_bytes` (plus `headroom_bytes`) into the
/// volume holding `path` when it clearly does not fit. Unknown free space
/// proceeds, as documented on [`free_space_bytes`].
///
/// The reported figure includes the headroom, so the message never reads
/// "needs 2.0 GB, 2.5 GB available".
pub fn ensure_free_space(path: &Path, needed_bytes: u64, headroom_bytes: u64) -> Result<(), ProjectError> {
    let Some(free_bytes) = free_space_bytes(path) else {
        return Ok(());
    };
    check_free_space(needed_bytes, headroom_bytes, free_bytes)
}

/// Pure half of [`ensure_free_space`], testable without a filesystem.
pub(crate) fn check_free_space(needed_bytes: u64, headroom_bytes: u64, free_bytes: u64) -> Result<(), ProjectError> {
    let required = needed_bytes.saturating_add(headroom_bytes);
    if free_bytes >= required {
        return Ok(());
    }
    Err(ProjectError::InsufficientSpace {
        needed_bytes: required,
        free_bytes,
    })
}

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

/// Largest file FAT12/16/32 can hold: 4 GiB minus one byte.
pub const FAT_MAX_FILE_BYTES: u64 = u32::MAX as u64;

/// The largest single file the volume holding `path` accepts, when it has a
/// limit we know of: FAT (the usual format of pendrives and SD cards). exFAT,
/// NTFS, APFS, ext4… return `None`.
///
/// Matters because Windows answers a write past 4 GiB on FAT with the same
/// "not enough space on the disk" as a full disk, so a 5 GB export to a
/// pendrive with 50 GB free looked like a space problem.
pub fn max_file_size_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    loop {
        if probe.exists() {
            return is_fat_volume(probe).then_some(FAT_MAX_FILE_BYTES);
        }
        probe = probe.parent()?;
    }
}

/// Refuse to write a file of `size_bytes` where the filesystem cannot hold
/// one that big. Unknown filesystems proceed.
pub fn ensure_file_fits_volume(path: &Path, size_bytes: u64) -> Result<(), ProjectError> {
    match max_file_size_bytes(path) {
        Some(limit_bytes) if size_bytes > limit_bytes => {
            Err(ProjectError::FileTooLargeForVolume { size_bytes, limit_bytes })
        }
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn is_fat_volume(dir: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn GetVolumePathNameW(file_name: *const u16, volume_path: *mut u16, length: u32) -> i32;
        fn GetVolumeInformationW(
            root_path_name: *const u16,
            volume_name: *mut u16,
            volume_name_size: u32,
            serial_number: *mut u32,
            max_component_length: *mut u32,
            file_system_flags: *mut u32,
            file_system_name: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
    }

    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut root = [0u16; 1024];
    let mut fs_name = [0u16; 64];
    // SAFETY: both input strings are NUL-terminated and outlive the calls; the
    // output buffers are sized as passed, and the optional outputs are null.
    unsafe {
        if GetVolumePathNameW(wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) == 0 {
            return false;
        }
        if GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        ) == 0
        {
            return false;
        }
    }
    let end = fs_name.iter().position(|&c| c == 0).unwrap_or(fs_name.len());
    let name = String::from_utf16_lossy(&fs_name[..end]);
    // "FAT", "FAT32" (also "FAT12"/"FAT16"); never "exFAT", which has no 4 GiB cap.
    name.eq_ignore_ascii_case("FAT") || name.to_ascii_uppercase().starts_with("FAT")
}

/// macOS/iOS name every FAT variant "msdos" (exFAT is "exfat").
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn is_fat_volume(dir: &Path) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: statfs only reads the borrowed C string and fully initialises
    // the buffer before we read it; f_fstypename is NUL-terminated.
    unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        if libc::statfs(path.as_ptr(), &mut stat) != 0 {
            return false;
        }
        CStr::from_ptr(stat.f_fstypename.as_ptr()).to_bytes() == b"msdos"
    }
}

/// Linux/Android: FAT reports MSDOS_SUPER_MAGIC (exFAT has its own magic).
#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
fn is_fat_volume(dir: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    const MSDOS_SUPER_MAGIC: i64 = 0x4d44;
    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: as in `statvfs_free_space`.
    unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        if libc::statfs(path.as_ptr(), &mut stat) != 0 {
            return false;
        }
        #[allow(clippy::unnecessary_cast)]
        let magic = stat.f_type as i64;
        magic == MSDOS_SUPER_MAGIC
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

/// macOS and iOS: what the system says can be written, purgeable space
/// included, which is the figure Finder and Settings show. statvfs leaves out
/// what the OS frees on demand (local Time Machine snapshots, iCloud caches),
/// so with it an export could be refused while Finder said there was room.
/// statvfs stays as the fallback when Foundation cannot answer.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn free_space_of_existing_dir(dir: &Path) -> Option<u64> {
    important_usage_capacity(dir).or_else(|| statvfs_free_space(dir))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
fn free_space_of_existing_dir(dir: &Path) -> Option<u64> {
    statvfs_free_space(dir)
}

/// `NSURLVolumeAvailableCapacityForImportantUsageKey` of the volume holding
/// `dir`: the space available for something the user asked for, counting what
/// the system will purge to make room.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn important_usage_capacity(dir: &Path) -> Option<u64> {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        NSNumber, NSString, NSURLVolumeAvailableCapacityForImportantUsageKey, NSURL,
    };

    let path = dir.to_str()?;
    // Called from worker threads with no pool of their own.
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let mut value: Option<Retained<AnyObject>> = None;
        // SAFETY: the key is a Foundation constant, and its documented value
        // type is NSNumber, which is checked by the downcast before reading.
        unsafe {
            url.getResourceValue_forKey_error(
                &mut value,
                NSURLVolumeAvailableCapacityForImportantUsageKey,
            )
        }
        .ok()?;
        let number = value?.downcast::<NSNumber>().ok()?;
        u64::try_from(number.longLongValue()).ok()
    })
}

#[cfg(unix)]
fn statvfs_free_space(dir: &Path) -> Option<u64> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_space_check_reports_the_figure_with_headroom() {
        assert!(check_free_space(100, 10, 110).is_ok());
        match check_free_space(100, 10, 109) {
            Err(ProjectError::InsufficientSpace { needed_bytes, free_bytes }) => {
                assert_eq!((needed_bytes, free_bytes), (110, 109));
            }
            other => panic!("expected InsufficientSpace, got {other:?}"),
        }
    }

    #[test]
    fn the_frontend_can_parse_the_space_error() {
        // formatTransportError.ts matches this exact wording.
        let message = ProjectError::InsufficientSpace { needed_bytes: 3, free_bytes: 2 }.to_string();
        assert_eq!(message, "insufficient disk space: needs 3 bytes, 2 available");
    }

    #[test]
    fn the_frontend_can_parse_the_file_size_error() {
        let message = ProjectError::FileTooLargeForVolume { size_bytes: 5, limit_bytes: 4 }.to_string();
        assert_eq!(message, "file too large for this volume: 5 bytes, limit 4");
    }

    #[test]
    fn an_ordinary_volume_has_no_file_size_limit() {
        // The temp folder is NTFS/APFS/ext4 on every machine that runs this.
        let dir = std::env::temp_dir();
        assert_eq!(max_file_size_bytes(&dir), None);
        assert!(ensure_file_fits_volume(&dir.join("big.ltset"), 10 * FAT_MAX_FILE_BYTES).is_ok());
    }

    #[test]
    fn disk_full_is_recognised_by_kind_and_by_raw_code() {
        assert!(is_disk_full(&io::Error::from(io::ErrorKind::StorageFull)));
        #[cfg(unix)]
        assert!(is_disk_full(&io::Error::from_raw_os_error(28)));
        #[cfg(windows)]
        assert!(is_disk_full(&io::Error::from_raw_os_error(112)));
        assert!(!is_disk_full(&io::Error::from(io::ErrorKind::NotFound)));
    }
}
