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
  remote del `beforeDevCommand`/`beforeBuildCommand` y anula
  `bundle.resources` (DLLs de Windows, dist del remote, etc. no van al APK).
  `vite.config.ts` respeta `TAURI_DEV_HOST` para `tauri android dev` contra
  dispositivo real.

## UX/flujos Android (fase 2)

Todo condicionado por `isAndroidApp` (`packages/shared/src/desktopApi.ts`,
detección por user-agent) en frontend y por comandos nuevos sin diálogo en
Rust:

- **Sesiones sin diálogos nativos**: comandos `start_create_song_named`
  (crea por nombre en `<app_data>/songs`, con saneado de nombre),
  `start_open_project_from_path` y `list_default_sessions` (ordenadas por
  mtime). El flujo con diálogos de desktop queda intacto.
- **`MobileLanding`**: en Android la landing muestra "Crear" (formulario de
  nombre inline, valida duplicados) + lista "Tus sesiones". El mismo
  componente se reutiliza `embedded` en un modal "Sesiones…" accesible desde
  el menú Archivo cuando ya hay una sesión abierta.
- **Menú Archivo en Android**: solo "Sesiones…" y "Guardar" (el resto de
  entradas dependen de diálogos rfd). Guardar no usa diálogo y funciona.
- **Import de audio**: el botón Importar de la Librería usa el file chooser
  del WebView (`mobileFilePicker.ts`, `<input type=file>` → bytes; multi-
  select soportado por el `onShowFileChooser` de wry) y el pipeline
  compartido de placeholders, importando BYTES porque en Android los
  ficheros viven tras `content://`. **Gotcha**: el chooser solo abre dentro
  de la ventana de gesto del tap — el pick debe ser lo primero de
  `handleImportLibraryFromDialog`, sin `await`s antes.
- **Multi-audio → timeline sin drag-and-drop** (verificado end-to-end):
  1. Tras importar N ficheros, prompt "¿Añadir los N audios al timeline?"
     → cada uno crea su pista en el playhead (`create_clips_with_auto_tracks`).
  2. En la Librería, en Android el tap alterna selección (sin Ctrl/Shift) y
     aparece una barra inferior "Añadir al timeline (N)" + limpiar. El
     pointer-drag de librería a timeline está desactivado en Android
     (pelea con el scroll táctil).
- **Ocultado en Android**: medidor CPU/RAM del topbar (y su polling 1 Hz),
  tabs de Settings Atajos/MIDI/MIDI Learn, check de updates (la
  distribución es APK), botón "Abrir carpeta de logs" (queda "Copiar log"),
  hints de atajos en menús contextuales, botón Remote.
- **Viewport**: `user-scalable=no` en `index.html` para que el pinch-zoom
  del WebView no rompa el drag de clips/faders (sin efecto en desktop).
- **Orientación**: `sensorLandscape` en el `AndroidManifest.xml` (gen/android)
  — un DAW en vertical no se puede manejar; se permiten ambas rotaciones
  horizontales.
- **Layout móvil (CSS)**: `main.tsx` pone la clase `lt-android` en `<html>`
  y la sección final de `styles.css` (scoped, cero impacto desktop) compacta
  todo al patrón de DAW móvil: topbar en una banda densa (TAP/Click/Guide
  solo icono, readout BAR+TIMECODE siempre visible, sin duplicados de
  tempo/compás), sidenav como rail de iconos, toolbar de saltos/vamp como
  UNA fila de chips con scroll horizontal (sin summaries ni contadores), y
  los popovers de configuración convertidos en bottom-sheets fijos con
  controles táctiles. El timeline pasa de ~45% a ~80% del alto útil.
- **Ruler compacto (94px vs 122px desktop)**: los carriles `LANE_*` de
  `Renderer/drawBackground.ts` son dependientes de plataforma (regiones/cues
  18px, secciones 22px, tempo 26px); dibujo y hit-testing derivan de los
  mismos exports. `RULER_HEIGHT` (TimelineCanvasPane) y el CSS `.lt-android`
  (incluido el `grid-template-rows` del pane, ojo: si no se toca queda una
  banda negra muerta) deben moverse SIEMPRE juntos. La fila del logo se
  fusiona con la banda de transporte (logo oculto, FILE inline). Chrome
  total sobre el primer track: ~38% del alto en un móvil apaisado.

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

## Engine NDK (milestone 1 HECHO — spike de compilación)

El engine C++ **compila y corre en Android** sin cambios de código fuente:

```powershell
# Por ABI (x86_64 emulador / arm64-v8a dispositivo). CMake >=3.25 del
# sistema + ninja del SDK. FetchContent descarga libsndfile/r8brain/nlohmann.
$ndk = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.1.12297006"
$ninja = "$env:LOCALAPPDATA\Android\Sdk\cmake\3.22.1\bin\ninja.exe"
cd native/audio-engine-v2
cmake -S . -B build-android-x86_64 -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" `
  "-DCMAKE_TOOLCHAIN_FILE=$ndk\build\cmake\android.toolchain.cmake" `
  -DANDROID_ABI=x86_64 -DANDROID_PLATFORM=android-24 -DCMAKE_BUILD_TYPE=Release `
  -DLT_ENGINE_USE_JUCE=OFF -DLT_ENGINE_USE_BUNGEE=OFF `
  -DLT_ENGINE_USE_FFMPEG=OFF -DLT_ENGINE_USE_LIBSNDFILE=ON
cmake --build build-android-x86_64
# Copiar a jniLibs (gitignored):
#   gen/android/app/src/main/jniLibs/x86_64/liblt_audio_engine_v2.so
#   gen/android/app/src/main/jniLibs/arm64-v8a/  (desde build-android-arm64)
```

- `build.rs` del crate FFI enlaza la `.so` cuando existe (emite el cfg
  `lt_engine_android_link`); sin ella, stubs silenciosos como antes.
- **Milestone 2 HECHO — backend Oboe (audio real)**: añade
  `-DLT_ENGINE_USE_OBOE=ON` al configure de arriba (JUCE y Oboe son
  excluyentes). `audio_device_manager_oboe.cpp` abre un stream AAudio
  float estéreo (Usage::Media, LowLatency+Shared, buffer=2 bursts) y
  puentea el render planar del engine al buffer intercalado de Oboe con
  scratch pre-asignado. Verificado en emulador: stream `started` en
  dumpsys, el reloj del transporte avanza desde callbacks reales, y un
  tempo marker en mitad de la canción se aplica en vivo.
  Bungee sigue OFF: upstream no publica binario Android; pitch/warp =
  passthrough hasta compilarlo de fuente con clang. Decoders: libsndfile +
  dr_mp3/dr_flac (sin FFmpeg ni vcpkg).
- **Pantalla completa (MainActivity)**: con edge-to-edge la barra de estado
  robaba TODOS los toques de la franja superior (menú FILE y transporte
  intocables). Modo inmersivo (swipe revela las barras) +
  FLAG_KEEP_SCREEN_ON para no dormir el dispositivo en directo.
- Verificado en emulador: engine inicializa (thread pools según hardware),
  carga sesiones, decodifica WAVs y genera `.ltpeaks`.
- **Bug conocido (milestone 3)**: hay DOS raíces de caché en el dispositivo
  (`cache/LibreTracks/waveform-cache` y `cache/waveform-cache`): Rust y C++
  resuelven la ruta en momentos distintos y el lector no encuentra los picos
  recién generados → los clips se quedan con placeholder. La generación en
  sí funciona.

## Roadmap (siguiente trabajo)

1. **Milestone 2 — backend Oboe**: dispositivo de audio real detrás de la
   abstracción `src/devices` (SR nativa del dispositivo, burst size AAudio)
   → metrónomo y playback sonando. Después: unificar la raíz de la caché de
   decodificación (bug de arriba), empaquetado automático de la .so, audio
   focus + foreground service, y Bungee de fuente para pitch/warp.

   **El modelo de streaming desde disco NO cambia en Android** — de hecho es
   más correcto ahí que en desktop: el almacenamiento es flash (lecturas
   aleatorias rápidas; la starvation del BlockCache que vimos en PCs con HDD
   es mucho menos probable) y la RAM es el recurso escaso en móvil, así que
   precargar sesiones enteras en memoria sería peor. Lo que sí cambia con el
   port del engine:
   - **Capa de dispositivo**: Oboe/AAudio en vez de WASAPI/DirectSound/ASIO,
     con la SR nativa del dispositivo (típicamente 48 kHz) para evitar el
     resampler del sistema, y buffers ajustados al burst size que reporta
     AAudio.
   - **Caché de decodificación** (`LT_DECODING_CACHE`): apuntarla al
     cache dir de la app (Android puede purgarlo, y no cuenta como datos).
   - **Ciclo de vida**: audio focus (pausar si llama alguien), foreground
     service para reproducir con pantalla apagada, y Doze.
   - **Bench de Bungee en ARM**: el presupuesto de 9+ voces está validado en
     x86; hay que medir en un móvil real (NEON en ARM suele rendir bien,
     pero el techo térmico es real).
2. **Ficheros**: sustituir los picks cancelados del shim por
   `tauri-plugin-dialog` (soporta móvil) + Storage Access Framework, y decidir
   dónde viven las sesiones (`app_data_dir`).
3. **UI táctil**: la UI de escritorio carga pero no está pensada para táctil ni
   pantallas pequeñas; probablemente convenga una vista tipo "performance"
   (transporte + secciones + mezcla) antes que el timeline completo.
4. **iOS**: ampliar los `cfg(target_os = "android")` a `mobile`/iOS, generar
   `gen/apple` con `tauri ios init` (requiere macOS), y revisar `rfd`/`midir`
   allí (CoreMIDI sí existe en iOS).
