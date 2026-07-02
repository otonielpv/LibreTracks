# Port a Android (rama `android-port`)

Estado del port de LibreTracks a Android con Tauri 2 mobile. iOS queda
deliberadamente abierto: la misma estructura (`lib.rs` + `mobile_entry_point`)
sirve para iOS; solo habría que ampliar los `cfg(target_os = "android")` a
iOS cuando toque.

## Qué hay hecho

- **`src-tauri` reestructurado al patrón móvil de Tauri 2**: la app vive en
  `src/lib.rs` (`libretracks_desktop_lib::run()`, anotada con
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`); `src/main.rs` es un
  wrapper fino para desktop. `Cargo.toml` añade el target `[lib]` con
  `crate-type = ["staticlib", "cdylib", "rlib"]`.
- **Proyecto Android generado** en `apps/desktop/src-tauri/gen/android`
  (`npx tauri android init`). Los artefactos de build los ignora el
  `.gitignore` que genera el propio Tauri.
- **APK debug compilado** para `aarch64` y `x86_64` (emulador).
- **Config por plataforma**: `tauri.android.conf.json` quita el build del
  remote del `beforeBuildCommand` y anula `bundle.resources` (DLLs de
  Windows, dist del remote, etc. no van al APK). `vite.config.ts` respeta
  `TAURI_DEV_HOST` para `tauri android dev` contra dispositivo real.

## Qué se excluye en Android (por diseño o por ahora)

| Área | Estado | Mecanismo |
| --- | --- | --- |
| App remote (servidor embebido) | Excluida por diseño: en el móvil la app *es* el dispositivo | `libretracks-remote` es dependencia solo-desktop; `remote_android.rs` stub; botón oculto en `SideNav` vía `isAndroidApp` |
| Engine de audio C++ (v2) | **Stub silencioso** hasta portarlo al NDK | `lt-audio-engine-v2/src/ffi.rs`: los stubs de `no-link` se activan con `target_os = "android"`; `build.rs` no enlaza |
| MIDI (`midir`) | Sin backend Android | `midi_android.rs` stub (0 dispositivos) |
| Diálogos nativos (`rfd`) | Sin backend Android | `src/file_dialog.rs`: shim con la misma API; en Android todo pick devuelve `None` (= cancelado) |

`sysinfo`, `reqwest` (rustls), y el resto de crates compilan para Android sin
cambios.

## Cómo compilar / probar

```powershell
# Requisitos ya presentes en esta máquina: Android SDK (ANDROID_HOME),
# NDK 27.1, JDK 21, targets rust android (rustup target add ...-linux-android)
$env:NDK_HOME = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.1.12297006"
cd apps/desktop
npx tauri android build --apk --debug --target aarch64   # dispositivo real
npx tauri android build --apk --debug --target x86_64    # emulador
# APK: src-tauri/gen/android/app/build/outputs/apk/universal/debug/

# Dev con hot-reload en dispositivo (misma red):
npx tauri android dev
```

## Roadmap (siguiente trabajo)

1. **Audio real**: portar `native/audio-engine-v2` al NDK. JUCE (que ya usamos
   para dispositivos) soporta Android vía Oboe/OpenSL, así que la vía es
   compilar el engine + Bungee + FFmpeg con el toolchain NDK (vcpkg tiene
   triplets `arm64-android`/`x64-android`) y cargar la `.so` como hasta ahora.
   El warm-loop de Bungee y el resto del contrato FFI no cambian.
2. **Ficheros**: sustituir los picks cancelados del shim por
   `tauri-plugin-dialog` (soporta móvil) + Storage Access Framework, y decidir
   dónde viven las sesiones (`app_data_dir`).
3. **UI táctil**: la UI de escritorio carga pero no está pensada para táctil ni
   pantallas pequeñas; probablemente convenga una vista tipo "performance"
   (transporte + secciones + mezcla) antes que el timeline completo.
4. **iOS**: ampliar los `cfg(target_os = "android")` a `mobile`/iOS, generar
   `gen/apple` con `tauri ios init` (requiere macOS), y revisar `rfd`/`midir`
   allí (CoreMIDI sí existe en iOS).
