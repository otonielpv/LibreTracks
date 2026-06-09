use std::{env, fs, path::PathBuf};

fn main() {
    configure_runtime_library_search_path();
    link_macos_highsierra_shim();
    copy_native_engine_runtime();
    tauri_build::build()
}

/// Links a tiny Objective-C shim that defines the `NSHTTPCookieSameSite*`
/// constants wry/Tauri reference but which only exist on macOS 10.15+. The
/// symbols are weak, so on 10.15+ the system definition wins and this shim is
/// inert; on 10.13/10.14 dyld resolves ours and the app launches instead of
/// crashing at load (tauri-apps/tauri#14201). macOS-only — a no-op elsewhere.
fn link_macos_highsierra_shim() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let shim = "macos-compat/highsierra_cookie_symbols.c";
    println!("cargo:rerun-if-changed={shim}");
    cc::Build::new().file(shim).compile("lt_macos_highsierra_shim");

    // Belt-and-braces: also tell the linker these symbols may be undefined at
    // link time so it never marks them as hard load-time requirements against
    // Foundation. The weak shim above is what actually satisfies them on 10.13.
    for symbol in [
        "_NSHTTPCookieSameSiteLax",
        "_NSHTTPCookieSameSiteStrict",
        "_NSHTTPCookieSameSitePolicy",
    ] {
        println!("cargo:rustc-link-arg=-Wl,-U,{symbol}");
    }
}

fn configure_runtime_library_search_path() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/LibreTracks");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/libretracks-desktop");
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
