//! Where LibreTracks keeps its data on Android.
//!
//! Tauri's `app_data_dir()` resolves to the app's INTERNAL files directory
//! (`/data/user/0/<pkg>/files`). Sessions are folders holding gigabytes of
//! audio, so they belong in `getExternalFilesDirs()` instead: still the app's
//! own sandbox, so it needs no permission and Google Play asks nothing about
//! it, while Android and desktop file-transfer tools treat it as app-specific
//! external storage. Internal and external storage can still share the same
//! physical volume, so this is an access-policy choice rather than a promise
//! of additional capacity.
//!
//! Tauri exposes no path API for it, so we ask Android ourselves through the
//! JavaVM that tao publishes — the same route [`super::android_audio_devices`]
//! takes to reach AudioManager. Returns nothing when every external volume is
//! unmounted, and callers then keep the internal directory, which always
//! works. Sessions already sitting in the internal folder stay readable: see
//! `state::legacy_project_roots`.

#![cfg(target_os = "android")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jni::objects::{JObject, JObjectArray, JString, JValue};
use jni::{JNIEnv, JavaVM};

/// Every app-specific external directory Android gives us, primary first.
///
/// Cached, because the lookup costs a JNI attach and the session paths ask for
/// it often. But **not for the whole process**: a USB stick on OTG comes and
/// goes while the app is open, and a list read once at startup neither showed
/// a stick plugged in later nor dropped one pulled out. The Settings panel
/// calls [`refresh_external_files_dirs`] every time it asks, which is the
/// moment the user is looking. Whether the chosen volume is *usable* is never
/// cached — see [`selected_external_files_dir`].
static EXTERNAL_FILES_DIRS: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);

/// All the volumes, in Android's order: index 0 is the primary (built-in)
/// storage and the rest are removable — that is the documented contract of
/// `getExternalFilesDirs`. Removable covers both a microSD card and a USB
/// stick; [`volume_description`] is what tells them apart.
///
/// Empty when Android gives us nothing at all (every volume unmounted, or the
/// JNI lookup failed); callers then keep internal storage.
pub fn external_files_dirs() -> Vec<PathBuf> {
    let Ok(mut cached) = EXTERNAL_FILES_DIRS.lock() else {
        return Vec::new();
    };
    if cached.is_none() {
        *cached = Some(query_and_log_external_files_dirs().unwrap_or_default());
    }
    cached.clone().unwrap_or_default()
}

/// Ask Android again which volumes are mounted, and return the fresh list.
///
/// On a failed lookup the previous list stays: forgetting the primary volume
/// because one JNI call hiccuped would send new sessions to internal storage.
pub fn refresh_external_files_dirs() -> Vec<PathBuf> {
    if let Some(fresh) = query_and_log_external_files_dirs() {
        if let Ok(mut cached) = EXTERNAL_FILES_DIRS.lock() {
            *cached = Some(fresh);
        }
    }
    external_files_dirs()
}

fn query_and_log_external_files_dirs() -> Option<Vec<PathBuf>> {
    match query_external_files_dirs() {
        Ok(dirs) => {
            for (index, dir) in dirs.iter().enumerate() {
                eprintln!(
                    "[LT_STORAGE] external files dir #{index}: {}",
                    dir.display()
                );
            }
            Some(dirs)
        }
        Err(error) => {
            // Not fatal: the caller falls back to internal storage.
            eprintln!("[LT_STORAGE] no external files dirs ({error}); using internal");
            None
        }
    }
}

/// The app's PRIMARY external files directory, or `None` if Android would not
/// give us one (unmounted volume, or the JNI lookup failed).
pub fn external_files_dir() -> Option<PathBuf> {
    external_files_dirs().first().cloned()
}

/// Can we actually write sessions here right now?
///
/// A volume Android listed at startup can be gone by the time the user opens a
/// session (they pulled the card). `getExternalFilesDirs` creates the directory
/// while the volume is mounted, so the cheap existence check is a good proxy;
/// the `create_dir_all` covers the first run on a card whose folder was wiped.
fn volume_is_usable(dir: &Path) -> bool {
    dir.is_dir() || std::fs::create_dir_all(dir).is_ok()
}

/// The volume the user chose, falling back the way the user expects.
///
/// `selected` is the absolute path stored in the settings (`None` = "whatever
/// Android calls primary"). Order of preference:
///
/// 1. The chosen volume, if Android still lists it AND it is usable now.
/// 2. The primary volume, if usable. **Degrading, not failing**: a card pulled
///    out on the way to a gig must not stop the app from opening.
/// 3. `None`, and the caller keeps internal storage, exactly as it did before
///    this became configurable.
pub fn selected_external_files_dir(selected: Option<&str>) -> Option<PathBuf> {
    let volumes = external_files_dirs();
    let picked = super::storage_volumes::pick_volume(&volumes, selected, volume_is_usable);
    if picked.is_some() && !selected_volume_is_available(selected) {
        eprintln!(
            "[LT_STORAGE] chosen volume is unavailable, falling back to: {}",
            picked.map(|dir| dir.display().to_string()).unwrap_or_default()
        );
    }
    picked.cloned()
}

/// Is the volume the user chose the one actually in use right now?
///
/// The UI uses this to say "la tarjeta no está, se está usando la memoria
/// interna" instead of silently lying about where the sessions land.
pub fn selected_volume_is_available(selected: Option<&str>) -> bool {
    super::storage_volumes::selected_is_available(
        &external_files_dirs(),
        selected,
        volume_is_usable,
    )
}

/// Usable and total bytes of the filesystem holding `dir`, via `java.io.File`.
///
/// `None` when Android cannot answer (it returns 0 for a path it cannot stat,
/// which we report as "unknown" rather than as "full").
pub fn volume_space(dir: &Path) -> Option<(u64, u64)> {
    query_volume_space(dir)
        .map_err(|error| {
            eprintln!(
                "[LT_STORAGE] volume_space({}) failed: {error}",
                dir.display()
            )
        })
        .ok()
        .filter(|(_, total)| *total > 0)
}

/// El nombre que Android le da al volumen que contiene `dir`: «Tarjeta SD
/// SanDisk», «Unidad USB Kingston»… el mismo que enseña su gestor de
/// archivos, y ya traducido.
///
/// Existe porque el orden de `getExternalFilesDirs` sólo dice «el 0 es el
/// interno»; lo demás es «extraíble», y un pendrive por OTG también lo es. Con
/// la etiqueta fija «Tarjeta SD», un pendrive salía como tarjeta.
///
/// `None` si Android no sabe decirlo; la UI cae a un nombre genérico.
pub fn volume_description(dir: &Path) -> Option<String> {
    query_volume_description(dir)
        .map_err(|error| {
            eprintln!(
                "[LT_STORAGE] volume_description({}) failed: {error}",
                dir.display()
            )
        })
        .ok()
        .flatten()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn query_volume_description(dir: &Path) -> Result<Option<String>, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let result = query_volume_description_with(&mut env, &context, dir);
    if result.is_err() {
        super::android_content_uri::clear_pending_exception(&mut env);
    }
    result
}

fn query_volume_description_with(
    env: &mut JNIEnv,
    context: &JObject,
    dir: &Path,
) -> Result<Option<String>, String> {
    // context.getSystemService("storage") -> StorageManager
    let service_name = env
        .new_string("storage")
        .map_err(|e| format!("new_string: {e}"))?;
    let manager = env
        .call_method(
            context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service_name)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getSystemService: {e}"))?;
    if manager.is_null() {
        return Ok(None);
    }

    let path = env
        .new_string(dir.to_string_lossy().as_ref())
        .map_err(|e| format!("new_string: {e}"))?;
    let file = env
        .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&path)])
        .map_err(|e| format!("new File: {e}"))?;

    // StorageManager.getStorageVolume(File) — API 24, nuestro minSdk.
    let volume = env
        .call_method(
            &manager,
            "getStorageVolume",
            "(Ljava/io/File;)Landroid/os/storage/StorageVolume;",
            &[JValue::Object(&file)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getStorageVolume: {e}"))?;
    if volume.is_null() {
        return Ok(None);
    }

    let description = env
        .call_method(
            &volume,
            "getDescription",
            "(Landroid/content/Context;)Ljava/lang/String;",
            &[JValue::Object(context)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getDescription: {e}"))?;
    if description.is_null() {
        return Ok(None);
    }
    let description: JString = description.into();
    let value = env
        .get_string(&description)
        .map_err(|e| format!("get_string: {e}"))?
        .to_string_lossy()
        .into_owned();
    Ok(Some(value))
}

fn query_volume_space(dir: &Path) -> Result<(u64, u64), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    let path = env
        .new_string(dir.to_string_lossy().as_ref())
        .map_err(|e| format!("new_string: {e}"))?;
    let file = env
        .new_object(
            "java/io/File",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&path)],
        )
        .map_err(|e| format!("new File: {e}"))?;

    let free = call_long(&mut env, &file, "getUsableSpace")?;
    let total = call_long(&mut env, &file, "getTotalSpace")?;
    Ok((free, total))
}

fn call_long(env: &mut JNIEnv, file: &JObject, method: &str) -> Result<u64, String> {
    env.call_method(file, method, "()J", &[])
        .and_then(|value| value.j())
        .map(|value| value.max(0) as u64)
        .map_err(|e| format!("{method}: {e}"))
}

fn query_external_files_dirs() -> Result<Vec<PathBuf>, String> {
    // JavaVM + application Context, published by tao's Android bootstrap.
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // context.getExternalFilesDirs(null) — PLURAL. The singular returns only
    // the primary volume; the plural returns every one the device has, so a
    // phone with a microSD slot finally shows its card. Both live inside the
    // app's sandbox, so neither costs a permission nor anything to declare to
    // Play. `null` asks for the root of the app's external files dir rather
    // than one of Android's typed subfolders (Music/, Movies/…), which would
    // put the sessions somewhere the media scanner walks.
    let array = env
        .call_method(
            &context,
            "getExternalFilesDirs",
            "(Ljava/lang/String;)[Ljava/io/File;",
            &[(&JObject::null()).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getExternalFilesDirs: {e}"))?;
    if array.is_null() {
        return Err("getExternalFilesDirs returned null".to_string());
    }
    let array: JObjectArray = array.into();
    let length = env
        .get_array_length(&array)
        .map_err(|e| format!("get_array_length: {e}"))?;

    let mut dirs = Vec::new();
    for index in 0..length {
        let dir = env
            .get_object_array_element(&array, index)
            .map_err(|e| format!("get_object_array_element({index}): {e}"))?;
        // Android puts a null in the array for a volume that is currently
        // unmounted. Skipping it is the same degradation the singular lookup
        // already did, and the entries that ARE there stay usable.
        if dir.is_null() {
            eprintln!("[LT_STORAGE] volume #{index} is unmounted");
            continue;
        }
        match absolute_path(&mut env, &dir) {
            Ok(path) => dirs.push(PathBuf::from(path)),
            Err(error) => eprintln!("[LT_STORAGE] volume #{index}: {error}"),
        }
    }

    if dirs.is_empty() {
        return Err("no mounted external volumes".to_string());
    }
    Ok(dirs)
}

fn absolute_path(env: &mut JNIEnv, dir: &JObject) -> Result<String, String> {
    let path = env
        .call_method(dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(|e| format!("getAbsolutePath: {e}"))?;
    let path: JString = path.into();
    let value = env
        .get_string(&path)
        .map_err(|e| format!("get_string: {e}"))?
        .to_string_lossy()
        .into_owned();
    Ok(value)
}
