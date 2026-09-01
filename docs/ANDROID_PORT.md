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
  (crea por nombre en el `getExternalFilesDir()/songs` privado de la app, sin
  permisos de almacenamiento y con saneado de nombre),
  `start_open_project_from_path` y `list_default_sessions` (ordenadas por
  mtime). El flujo con diálogos de desktop queda intacto.
- **`MobileLanding`**: en Android la landing muestra "Crear" (formulario de
  nombre inline, valida duplicados) + lista "Tus sesiones". El mismo
  componente se reutiliza `embedded` en un modal "Sesiones…" accesible desde
  el menú Archivo cuando ya hay una sesión abierta.
  - **Borrar sesión** (papelera de cada fila → confirmación →
    `delete_session_at`): en el teléfono no hay gestor de archivos, así que
    una sesión importada por error se quedaba ocupando el almacenamiento para
    siempre. El comando borra la CARPETA, valida que sea una sesión, que esté
    dentro de `getExternalFilesDir()/songs` (o del root heredado) y que no sea
    la que está abierta.
  - **Nombre de una sesión importada**: sale del último componente del
    *document id* SAF, no del id entero
    (`platform/document_name.rs`). Un `.ltset` cogido de Descargas llega como
    `raw:/storage/emulated/0/Download/x.ltset`, y usarlo tal cual creaba
    carpetas llamadas `raw--storage-emulated-0-Download-x`.
  - **Scroll del modal**: el cuerpo del modal es el ÚNICO scroller
    (`.lt-mobile .lt-sessions-modal` en `styles.css`). La tarjeta de la
    landing trae el suyo con `overscroll-behavior: contain` y ahí dentro nunca
    desborda, así que se tragaba el gesto sin poder moverse: sólo respondía la
    barra de desplazamiento.
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
# NDK 28.2, JDK 21, targets rust android (rustup target add ...-linux-android)
$env:NDK_HOME = "$env:LOCALAPPDATA\Android\Sdk\ndk\28.2.13676358"
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
$ndk = "$env:LOCALAPPDATA\Android\Sdk\ndk\28.2.13676358"
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
  Decoders: libsndfile + dr_mp3/dr_flac (sin FFmpeg ni vcpkg) +
  **MediaCodec del sistema** para todo lo demás (ver abajo).
- **Selección de dispositivo de salida (2026-08-24)**: la lista de salidas
  en Android se construye en DOS capas y hay que entender la división antes
  de tocarla.
  - El backend Oboe sólo conoce la **ruta por defecto de AAudio**:
    `list_devices()` devuelve UNA entrada virtual con id vacío ("predeterminado
    del sistema"). Los endpoints reales (altavoz, cascos, interfaz USB,
    Bluetooth) están detrás de `AudioManager.getDevices()`, que es API sólo de
    Java: se lee por JNI en `platform/android_audio_devices.rs` y los ids son
    el `AudioDeviceInfo.getId()` entero, que viaja tal cual hasta
    `AudioStreamBuilder::setDeviceId()`.
  - Las dos capas se juntan en `platform::append_platform_output_devices`, y
    **toda** enumeración del engine tiene que pasar por ahí: la lista de
    Ajustes (`AudioController::list_devices`) y la sonda "¿sigue estando mi
    dispositivo guardado?" de `apply_settings`. Cuando sólo lo hacía
    `engine_v2_list_devices` — un comando que el frontend no llama nunca — una
    interfaz USB enchufada era invisible en Ajustes y la selección guardada se
    borraba en cada arranque. Lo vigila
    `settings/audioDeviceEnumeration.test.ts`.
  - **Cambio de ruta en caliente**: AAudio nunca migra un stream abierto al
    endpoint nuevo; lo desconecta (`onErrorAfterClose`) y espera que la app
    abra otro. El backend Oboe lo publica como `fallback_active()`, y quien
    reabre es el watchdog de dispositivo que ya existía para desktop
    (`AudioController::device_watchdog_tick`, ~2×/s → `RecoverOutputDevice`).
    Con "predeterminado del sistema" seleccionado, esa reapertura cae sola en
    la interfaz recién enchufada. A diferencia de desktop NO hay reloj de
    respaldo: el transporte se queda quieto esos ~2 s en vez de seguir en
    silencio.
  - La salida es **estéreo fija** (`kOutputChannels`), así que la enumeración
    recorta el número de canales a 2 aunque la interfaz anuncie 4 u 8. Si
    algún día el backend rinde más canales, hay que subir las dos cosas
    juntas.
- **Bungee en Android (pitch/warp real, 2026-07-03)**: upstream no publica
  binario Android, así que se compila DE FUENTE con el NDK (estático + PIC,
  sin .so extra en el APK). Receta (repo en `D:\Repos\bungee`, tag v2.4.24 —
  la MISMA versión que el SDK de escritorio):

  ```
  cmake -S D:\Repos\bungee -B D:\Repos\bungee\build-android-<abi> -G Ninja ^
    -DCMAKE_MAKE_PROGRAM=<sdk>\cmake\3.22.1\bin\ninja.exe ^
    -DCMAKE_TOOLCHAIN_FILE=<ndk>\build\cmake\android.toolchain.cmake ^
    -DANDROID_ABI=arm64-v8a|x86_64 -DANDROID_PLATFORM=android-24 ^
    -DCMAKE_BUILD_TYPE=Release -DBUNGEE_BUILD_SHARED_LIBRARY=OFF ^
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUNGEE_VERSION=2.4.24
  cmake --build ... --target bungee_library pffft
  ```

  Layout del SDK android (en `D:\Repos\bungee-android-sdk`, machine-local):
  `include/bungee/*.h` + `android-arm64-v8a/{libbungee.a,libpffft.a}` +
  `android-x86_64/{...}`. El CMake del engine tiene rama `elseif(ANDROID)`
  que espera exactamente eso (y enlaza libpffft.a aparte porque el estático
  de bungee no lo arrastra). Configurar el engine con
  `-DLT_ENGINE_USE_BUNGEE=ON -DLT_BUNGEE_DIR=D:/Repos/bungee-android-sdk`.
  Verificado en emulador: región con warp activo (100→120 BPM) reproduce
  por el camino Bungee (`str+=` en el diag, ~2,6 ms/callback con 3 voces,
  cero over_budget, sin crash — el warm_voice de siempre aplica). Bench de
  voces máximas en el Oppo PENDIENTE.
- **Formatos no-WAV (MediaCodec NDK)**: `mediacodec_decoder.cpp` implementa
  `AudioDecoder` sobre `AMediaExtractor` + `AMediaCodec` (link `mediandk`,
  solo `if(ANDROID)` en `src/sources/CMakeLists.txt`) — el equivalente móvil
  de la ruta FFmpeg de escritorio: AAC/M4A, OGG/Vorbis, Opus, 3GP… se
  decodifican con los códecs del SO y se cachean como PCM (estilo Ableton),
  cero bytes extra de binario. El dispatch de `make_decoder` en Android
  manda a MediaCodec todo lo que no sea WAV/AIFF (libsndfile) ni MP3/FLAC
  (dr_libs). GOTCHA que costó una tarde: `AMediaExtractor_setDataSource(path)`
  FALLA en silencio con rutas privadas de la app (pasa por el resolver de
  media HTTP/content) — hay que abrir el fd uno mismo y usar
  `AMediaExtractor_setDataSourceFd` (el extractor lo dupea). Los fallos de
  open se registran como `[LT_MEDIACODEC]` en `lt_audio_debug.log`.
  Verificado en emulador x86_64: import m4a (AAC) + ogg (Vorbis) desde el
  picker → decode por códec del sistema → caché PCM → playback con hits y
  cero starvation.
- **Foreground service + audio focus (2026-07-03)**: `AudioPlaybackService`
  (tipo `mediaPlayback`) arranca con MainActivity y vive toda la sesión de
  app — sin él, Android congela el proceso cacheado al apagar pantalla o
  cambiar de app y el AAudio muere a mitad de canción. Audio focus GAIN
  pedido una vez (pausa Spotify y cía al arrancar); en PÉRDIDA de focus NO
  se pausa nada a propósito (en directo, auto-pausarse por una llamada es
  peor que dejar que el SO nos atenúe). Verificado en emulador: el diag log
  sigue creciendo con `mWakefulness=Asleep` (pantalla apagada) y con la app
  en background (procState=FGS). Pendientes: pedir POST_NOTIFICATIONS en
  runtime (API 33+, sin ella la notificación fija puede quedar oculta,
  el servicio corre igual) y, a futuro, atar la notificación al estado real
  del transporte vía plugin Tauri.
- **Pantalla completa (MainActivity)**: con edge-to-edge la barra de estado
  robaba TODOS los toques de la franja superior (menú FILE y transporte
  intocables). Modo inmersivo (swipe revela las barras) +
  FLAG_KEEP_SCREEN_ON para no dormir el dispositivo en directo.
- Verificado en emulador: engine inicializa (thread pools según hardware),
  carga sesiones, decodifica WAVs y genera `.ltpeaks`.
- **Waveforms: RESUELTO (2026-07-03)** — el "bug de la doble raíz de caché"
  era un artefacto de la era stub: sin engine enlazado,
  `lt_audio_engine_source_cache_dir()` (stub) devuelve "" y
  `decoding_cache_root()` de Rust caía al fallback `temp_dir()/LibreTracks`
  (= `cache/LibreTracks/` en Android, TMPDIR es el cache dir de la app),
  mientras builds posteriores con engine usaban `cache/`. Con el engine
  enlazado ambos lados resuelven `cache/` siempre; verificado por CDP que
  `get_song_view` embebe los summaries y el canvas los pinta.
  `cache/LibreTracks/` que quede en un dispositivo es residuo inofensivo.
  (Moraleja de la sesión de diagnóstico: los archivos de prueba sintéticos
  —tonos con decay— pintan waveforms EN FORMA DE TRIÁNGULOS que se
  confunden con un placeholder; el placeholder real es un rect plano con
  texto "ANALYZING WAVEFORM…".)

## Audio validado en hardware real (Oppo A5, gama baja 2020)

Playback limpio confirmado con multitracks reales de estudio. La cadena de
diagnóstico que llevó ahí (documentada por si reaparece):

1. Underruns → buffer AAudio: pedir `setBufferCapacityInFrames` ANTES de
   abrir (la capacidad por defecto era 2 bursts y recortaba en silencio el
   `setBufferSizeInFrames` posterior).
2. Distorsión en picos con mezcla caliente → AAudio no tiene limitador
   (Windows shared-mode sí): soft-clip (rodilla -3 dBFS, tanh) en la
   frontera Oboe.
3. **Crackles horneados en la caché (el "petardeo")**: masters calientes
   resampleados 44.1→48 hacen overshoot de ±1.0 (ringing normal), y
   libsndfile SIN `SFC_SET_CLIPPING` los ENVUELVE al escribir la caché
   int16 (-1.002 → +32694) → chasquidos a fondo de escala en los
   transitorios, grabados en disco. Fix: clipping activado en ambos
   escritores de caché. **Latente también en desktop.**
   Verificación: extraer `cache/source-cache/*.wav` del dispositivo
   (release lleva `isDebuggable=true` de momento) y analizar deltas
   muestra a muestra.
4. Telemetría: Android arranca con `LIBRETRACKS_AUDIO_DIAG=1` (no hay
   shell para setearlo); volcado cada 500 ms en `lt_audio_debug.log`.

Bugs abiertos anotados: source mudo tras cambiar SR hasta reiniciar
(carrera de re-preparación, pariente del bug de desktop de cambio de
dispositivo).

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
2. **Ficheros**: los picks de archivos usan Storage Access Framework; las
   sesiones viven en `getExternalFilesDir()/songs`. El siguiente paso es un
   portal persistente de import/export basado en `ACTION_OPEN_DOCUMENT_TREE`.
3. **UI táctil**: la UI de escritorio carga pero no está pensada para táctil ni
   pantallas pequeñas; probablemente convenga una vista tipo "performance"
   (transporte + secciones + mezcla) antes que el timeline completo.
4. **iOS**: ampliar los `cfg(target_os = "android")` a `mobile`/iOS, generar
   `gen/apple` con `tauri ios init` (requiere macOS), y revisar `rfd`/`midir`
   allí (CoreMIDI sí existe en iOS).

## Modificaciones manuales en `gen/android`

`gen/android` lo genera Tauri (`npx tauri android init`) y una regeneración
**sobrescribe** estos cambios. Si eso ocurre, hay que reaplicarlos:

### `app/src/main/java/com/libretracks/desktop/MainActivity.kt`

| Qué | Por qué |
| --- | --- |
| `hideSystemBars()` + `onWindowFocusChanged` | ColorOS pierde el modo inmersivo al recuperar el foco y la barra de estado se come los taps de la barra superior |
| `FLAG_KEEP_SCREEN_ON` | No dormir a mitad de una actuación |
| `startForegroundService(AudioPlaybackService)` | Que la reproducción sobreviva a la pantalla apagada |
| `installVoiceGuideAssets()` | El decoder nativo necesita rutas `fopen`-ables |
| **`onTrimMemory` / `onLowMemory` → `nativeOnTrimMemory`** | Android avisa antes de matar; ignorarlo reinició el sistema del Oppo al importar 2 GB. Ver `docs/plans/android-low-end/03-presion-de-memoria.md` |

El puente de memoria es JNI directo (`private external fun nativeOnTrimMemory`),
resuelto por nombre contra
`Java_com_libretracks_desktop_MainActivity_nativeOnTrimMemory` en
`src/platform/android_memory.rs`. **Si se renombra la clase o el paquete Kotlin,
hay que renombrar también esa función de Rust** o el enlace falla en tiempo de
ejecución con `UnsatisfiedLinkError` (capturado y registrado, no fatal).

No pasa por el WebView a propósito: bajo presión real el proceso de la WebView
es él mismo candidato a que lo maten, así que un aviso que tenga que atravesarlo
es un aviso que podemos no recibir nunca.

### `app/src/main/java/com/libretracks/desktop/AudioPlaybackService.kt`

Servicio en primer plano + foco de audio. Fichero entero añadido a mano.
