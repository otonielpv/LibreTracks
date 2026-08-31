//! Where LibreTracks keeps its data on Android.
//!
//! Tauri's `app_data_dir()` resolves to the app's INTERNAL files directory
//! (`/data/user/0/<pkg>/files`). Sessions are folders holding gigabytes of
//! audio, so they belong in `getExternalFilesDir()` instead: still the app's
//! own sandbox, so it needs no permission and Google Play asks nothing about
//! it, while Android and desktop file-transfer tools treat it as app-specific
//! external storage. Internal and external storage can still share the same
//! physical volume, so this is an access-policy choice rather than a promise
//! of additional capacity.
//!
//! Tauri exposes no path API for it, so we ask Android ourselves through the
//! JavaVM that tao publishes — the same route [`super::android_audio_devices`]
//! takes to reach AudioManager. Returns `None` when the external volume is
//! unmounted, and callers then keep the internal directory, which always
//! works. Sessions already sitting in the internal folder stay readable: see
//! `state::legacy_project_roots`.

#![cfg(target_os = "android")]

use std::path::PathBuf;
use std::sync::OnceLock;

use jni::objects::{JObject, JString};
use jni::JavaVM;

/// Cached for the process because the primary app-specific external directory
/// is stable for the lifetime of the process and the lookup costs a JNI attach.
static EXTERNAL_FILES_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The app's external files directory, or `None` if Android would not give us
/// one (unmounted volume, or the JNI lookup failed).
pub fn external_files_dir() -> Option<PathBuf> {
    EXTERNAL_FILES_DIR
        .get_or_init(|| match query_external_files_dir() {
            Ok(dir) => {
                eprintln!("[LT_STORAGE] external files dir: {}", dir.display());
                Some(dir)
            }
            Err(error) => {
                // Not fatal: the caller falls back to internal storage.
                eprintln!("[LT_STORAGE] no external files dir ({error}); using internal");
                None
            }
        })
        .clone()
}

fn query_external_files_dir() -> Result<PathBuf, String> {
    // JavaVM + application Context, published by tao's Android bootstrap.
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // context.getExternalFilesDir(null): null asks for the root of the app's
    // external files dir rather than one of Android's typed subfolders
    // (Music/, Movies/…), which would put the sessions somewhere the media
    // scanner walks.
    let dir = env
        .call_method(
            &context,
            "getExternalFilesDir",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[(&JObject::null()).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getExternalFilesDir: {e}"))?;
    if dir.is_null() {
        return Err("getExternalFilesDir returned null".to_string());
    }

    let path = env
        .call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(|e| format!("getAbsolutePath: {e}"))?;
    let path: JString = path.into();
    let path = env
        .get_string(&path)
        .map_err(|e| format!("get_string: {e}"))?
        .to_string_lossy()
        .into_owned();

    Ok(PathBuf::from(path))
}
