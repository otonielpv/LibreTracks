// build.rs — links the pre-built (or CMake-built) C++ engine shared library.
//
// Environment variables:
//   LT_ENGINE_V2_LIB_DIR   path to directory containing lt_audio_engine_v2.{dll,so,dylib,a}
//                           Defaults to native/audio-engine-v2/build/Release on Windows.
//
// Features:
//   no-link   Skip linking entirely (for `cargo test --features no-link`).

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LT_ENGINE_V2_LIB_DIR");
    println!("cargo:rerun-if-changed=build.rs");
    // Declared unconditionally so rustc's unexpected_cfgs lint knows the cfg
    // exists on every platform, not just Android builds that set it.
    println!("cargo::rustc-check-cfg=cfg(lt_engine_android_link)");

    // Skip linking when the no-link feature is active.
    if std::env::var("CARGO_FEATURE_NO_LINK").is_ok() {
        return;
    }

    // iOS embeds the engine and its C dependencies into the application as
    // static archives. Unlike Android, falling back to a stub is never allowed:
    // a successful IPA build must contain the real C ABI implementation.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        link_ios_static_engine();
        return;
    }

    // Android: link the NDK-built engine when it exists (see
    // docs/ANDROID_PORT.md for the cmake invocation), and fall back to the
    // no-link stubs when it doesn't — so a checkout without the engine build
    // still compiles the app (silent engine). The emitted cfg is what flips
    // ffi.rs between the real extern block and the stubs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let abi_dir = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "build-android-arm64",
            Ok("x86_64") => "build-android-x86_64",
            _ => return, // other ABIs: stubs
        };
        let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let lib_dir = manifest
            .ancestors()
            .nth(2) // crates/lt-audio-engine-v2 → repo root
            .unwrap()
            .join("native/audio-engine-v2")
            .join(abi_dir);
        println!("cargo:rerun-if-changed={}", lib_dir.display());
        println!("cargo:rerun-if-env-changed=LT_ENGINE_ANDROID_REQUIRE_LINK");
        let so_path = lib_dir.join("liblt_audio_engine_v2.so");
        if so_path.exists() {
            println!("cargo:rustc-cfg=lt_engine_android_link");
            println!("cargo:rustc-link-search=native={}", lib_dir.display());
            println!("cargo:rustc-link-lib=dylib=lt_audio_engine_v2");
        } else if std::env::var_os("LT_ENGINE_ANDROID_REQUIRE_LINK").is_some() {
            // Guardrail for distributable builds: falling back to the silent
            // stub engine here would ship an APK with no audio, no waveforms,
            // and an empty device list — and it would do so WITHOUT any error.
            // A release build sets this env var so a missing engine .so (e.g.
            // a CI build-dir-name mismatch) fails loudly instead. The name is
            // `build-android-<arch>` keyed off CARGO_CFG_TARGET_ARCH; make sure
            // whatever built the engine put the .so exactly there.
            panic!(
                "LT_ENGINE_ANDROID_REQUIRE_LINK is set but the NDK-built engine \
                 was not found at {}. The APK would silently ship the no-op stub \
                 engine. Build the engine into that exact directory before linking.",
                so_path.display()
            );
        }
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

fn link_ios_static_engine() {
    let lib_dir = std::env::var("LT_ENGINE_V2_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            panic!("LT_ENGINE_V2_LIB_DIR must point to the staged iOS static engine archives")
        });
    let engine = lib_dir.join("liblt_audio_engine_v2.a");
    let sndfile = lib_dir.join("libsndfile.a");
    if !engine.is_file() || !sndfile.is_file() {
        panic!(
            "iOS audio engine link set is incomplete: expected {} and {}",
            engine.display(),
            sndfile.display()
        );
    }

    println!("cargo:rerun-if-changed={}", engine.display());
    println!("cargo:rerun-if-changed={}", sndfile.display());
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=lt_audio_engine_v2");
    println!("cargo:rustc-link-lib=static=sndfile");
    println!("cargo:rustc-link-lib=c++");

    // Static archives do not carry their framework dependencies. These are
    // the Apple frameworks used by JUCE's iOS CoreAudio backend, libsndfile,
    // and the AVAudioSession bridge compiled into the engine.
    for framework in [
        "Accelerate",
        "AudioToolbox",
        "AVFoundation",
        "CoreAudio",
        "CoreMIDI",
        "Foundation",
        "Security",
        "UIKit",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-ObjC");
}
