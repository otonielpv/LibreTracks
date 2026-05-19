use std::{env, fs, path::PathBuf};

fn main() {
    copy_native_engine_runtime();
    tauri_build::build()
}

fn copy_native_engine_runtime() {
    println!("cargo:rerun-if-env-changed=LT_ENGINE_V2_LIB_DIR");

    let Ok(lib_dir) = env::var("LT_ENGINE_V2_LIB_DIR").map(PathBuf::from) else {
        return;
    };
    if !lib_dir.is_dir() {
        return;
    }

    let Ok(out_dir) = env::var("OUT_DIR").map(PathBuf::from) else {
        return;
    };
    let Some(profile_dir) = out_dir
        .ancestors()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "debug" || name == "release")
        })
        .map(PathBuf::from)
    else {
        return;
    };

    let Ok(entries) = fs::read_dir(&lib_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_framework_bundle(&path) {
            if let Some(file_name) = path.file_name() {
                let _ = copy_dir_all(&path, &profile_dir.join(file_name));
            }
            continue;
        }
        if !path.is_file() || !is_runtime_library(&path) {
            continue;
        }
        if let Some(file_name) = path.file_name() {
            let _ = fs::copy(&path, profile_dir.join(file_name));
        }
    }
}

fn is_runtime_library(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "dll" | "dylib" | "so"
            )
        })
        .unwrap_or(false)
}

fn is_framework_bundle(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("framework"))
        .unwrap_or(false)
}

fn copy_dir_all(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
