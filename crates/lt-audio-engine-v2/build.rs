// build.rs — links the pre-built (or CMake-built) C++ engine shared library.
//
// Environment variables:
//   LT_ENGINE_V2_LIB_DIR   path to directory containing lt_audio_engine_v2.{dll,so,dylib}
//                           Defaults to native/audio-engine-v2/build/Release on Windows.

use std::path::PathBuf;

fn main() {
    let lib_dir = std::env::var("LT_ENGINE_V2_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
            manifest
                .ancestors()
                .nth(2)  // crates/lt-audio-engine-v2 → repo root
                .unwrap()
                .join("native/audio-engine-v2/build/Release")
        });

    if lib_dir.exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=dylib=lt_audio_engine_v2");
    } else {
        // The C++ build hasn't run yet — emit a warning but don't hard-fail
        // so `cargo check` still works without a full C++ build.
        println!(
            "cargo:warning=lt-audio-engine-v2: C++ library not found at {}.  \
             Run CMake first or set LT_ENGINE_V2_LIB_DIR.",
            lib_dir.display()
        );
    }

    println!("cargo:rerun-if-env-changed=LT_ENGINE_V2_LIB_DIR");
    println!("cargo:rerun-if-changed=build.rs");
}
