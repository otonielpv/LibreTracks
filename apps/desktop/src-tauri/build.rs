use std::{env, fs, path::PathBuf};

fn main() {
    configure_runtime_library_search_path();
    embed_common_controls_manifest_in_tests();
    copy_native_engine_runtime();
    tauri_build::build()
}

/// Da al arnes de tests el mismo manifest de Common Controls 6 que
/// `tauri_build` le pone al ejecutable real.
///
/// Sin esto, en Windows `cargo test -p libretracks-desktop` no llega ni a
/// `main`: muere con STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) antes de ejecutar
/// un solo test, asi que los ~250 tests de este crate no corrian. El motivo es
/// que `rfd` importa `TaskDialogIndirect`, que solo existe en la version 6 de
/// comctl32 (la de WinSxS); la de System32 es la 5.82 y no lo exporta. Quien
/// elige entre las dos es el manifest del ejecutable, y el arnes de tests no
/// heredaba el del binario.
///
/// Solo bajo la feature `no-link`, que es exactamente como se compilan los
/// tests (`npm run test:native:nolink`). Cargo no sabe distinguir "el binario
/// de test de la lib" del binario de verdad al pasar argumentos al enlazador
/// (`rustc-link-arg-tests` solo vale para targets `[[test]]`, y este crate no
/// tiene), asi que la feature hace de discriminante: el ejecutable que se
/// distribuye nunca la lleva y conserva el manifest de `tauri_build` sin
/// duplicar el recurso (CVT1100 si se duplica).
///
/// El unico caso que esto rompe es enlazar el BINARIO con `no-link`
/// (`cargo build --features libretracks-desktop/no-link`), que daria CVT1100.
/// No tiene sentido hacerlo -- seria la app con el motor mudo -- y por eso los
/// dos sitios que compilan los tests pasan `--lib`: `npm test` (scripts/
/// test-all.mjs) y `npm run test:native:nolink`.
fn embed_common_controls_manifest_in_tests() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_NO_LINK");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
        || env::var("CARGO_FEATURE_NO_LINK").is_err()
    {
        return;
    }

    let Ok(out_dir) = env::var("OUT_DIR").map(PathBuf::from) else {
        return;
    };
    let manifest_path = out_dir.join("libretracks-tests.manifest");
    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
    if fs::write(&manifest_path, MANIFEST).is_err() {
        return;
    }

    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
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
