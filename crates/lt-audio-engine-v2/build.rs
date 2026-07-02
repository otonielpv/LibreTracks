// build.rs — links the pre-built (or CMake-built) C++ engine shared library.
//
// Environment variables:
//   LT_ENGINE_V2_LIB_DIR   path to directory containing lt_audio_engine_v2.{dll,so,dylib}
//                           Defaults to native/audio-engine-v2/build/Release on Windows.
//
// Features:
//   no-link   Skip linking entirely (for `cargo test --features no-link`).

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LT_ENGINE_V2_LIB_DIR");
    println!("cargo:rerun-if-changed=build.rs");

    // Skip linking when the no-link feature is active, or when targeting
    // Android: the C++ engine is not built for the NDK yet, so ffi.rs swaps
    // in the same stubs the no-link feature uses.
    let no_link = std::env::var("CARGO_FEATURE_NO_LINK").is_ok()
        || std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android");
    if no_link {
        return;
    }

    let lib_dir = std::env::var("LT_ENGINE_V2_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
            manifest
                .ancestors()
                .nth(2) // crates/lt-audio-engine-v2 → repo root
                .unwrap()
                .join("native/audio-engine-v2/build/Release")
        });

    if lib_dir.exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=dylib=lt_audio_engine_v2");
        match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
            Ok("linux") => {
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/LibreTracks");
                println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/libretracks-desktop");
            }
            Ok("macos") => {
                // Inside the .app bundle the executable lives at
                // Contents/MacOS/ and dylibs must be in Contents/Frameworks/.
                // The other rpaths cover `cargo run` (dylib next to binary)
                // and being loaded by another module (dylib next to loader).
                println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
                println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
                println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
            }
            _ => {}
        }
    } else {
        println!(
            "cargo:warning=lt-audio-engine-v2: C++ library not found at {}. \
             Run CMake first or set LT_ENGINE_V2_LIB_DIR. \
             Use --features no-link to skip linking for unit tests.",
            lib_dir.display()
        );
    }
}
