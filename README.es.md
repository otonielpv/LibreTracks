# LibreTracks

![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)

LibreTracks es una DAW y estacion de reproduccion multitrack para directo, construida con Audio Engine v2 en C++ y una shell de escritorio en React/Tauri. El monorepo actual esta centrado en edicion no destructiva, saltos musicales entre secciones, importacion de audio y una frontera nativa que separa claramente la UI del audio realtime.

## Apoya LibreTracks

LibreTracks es gratuito y se mantiene en tiempo personal. Si te resulta util, puedes hacer una donacion voluntaria para apoyar mantenimiento, pruebas, documentacion, releases y desarrollo continuo.

La donacion no desbloquea funciones extra, soporte prioritario, acceso anticipado, compromisos de roadmap ni ninguna otra contraprestacion. Es simplemente una forma de apoyar el proyecto.

[Apoyar LibreTracks en Ko-fi](https://ko-fi.com/otonielpv)

## Capturas de pantalla
| Captura | Captura |
| --- | --- |
| Inicio<br>![Pantalla de inicio](./screenshots/Inicio.png) | Sesion vacia<br>![Sesion vacia](./screenshots/Vacio.png) |
| Proyecto<br>![Vista del proyecto](./screenshots/Proyecto.png) | Conexion remote<br>![Conexion remote](./screenshots/Remote.png) |
| Mixer remote<br>![Mixer remote](./screenshots/Remote_Mixer.png) |  |


## Architecture Overview

LibreTracks se divide en dos capas principales:

- `apps/desktop` es el frontend de escritorio. Usa React, stores con Zustand y renderizado por canvas para el timeline, el ruler, las marcas y las formas de onda.
- `apps/desktop/src-tauri` es el puente nativo. Expone comandos Tauri, mantiene el estado desktop, aplica ajustes de audio y conecta la UI con el runtime en Rust.
- `crates/libretracks-core` contiene el modelo de dominio y las validaciones de canciones, tracks, clips, marcas, buses y tempo.
- `crates/libretracks-audio` contiene la lógica de transporte y mezcla. Resuelve clips activos, ganancia efectiva por pista, `play`/`pause`/`seek`/`stop`, metronomo, vamp, transiciones de cancion y saltos musicales.
- `crates/libretracks-project` gestiona persistencia de proyecto, `song.json`, assets de librería, importacion de paquetes LibreTracks e importación/probing de WAV mediante `symphonia`.
- `native/audio-engine-v2` contiene el motor C++ de reproduccion, capa de dispositivo, scheduler, renderer, preparacion de fuentes, pipeline de pitch y diagnosticos.

Esta separacion es intencional: el frontend decide como presentar y editar la sesion; Rust mantiene la orquestacion de app/backend y la persistencia; C++ mantiene la reproduccion realtime.

## Prerequisites

El flujo desktop asume estas dependencias instaladas:

- Node.js `>= 20`
- Rust stable toolchain con `cargo` y `rustc`
- En Linux (Debian/Ubuntu), instala los paquetes de sistema para Tauri y el motor de audio C++:
  ```bash
  sudo apt install -y \
    cmake build-essential pkg-config \
    libasound2-dev \
    libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
  ```
- En macOS, instala las herramientas de compilación con [Homebrew](https://brew.sh). CoreAudio viene incluido en el sistema, así que no hace falta ningún paquete de audio extra:
  ```bash
  brew install cmake pkg-config ffmpeg
  ```
  Las Xcode Command Line Tools (`xcode-select --install`) proporcionan el compilador Apple Clang. FFmpeg está activado por defecto en macOS (añade importación de M4A/AAC); consulta la nota de macOS más abajo si prefieres omitirlo.
- Microsoft Visual C++ Build Tools en Windows
- Windows 10/11 SDK en Windows para el enlazado MSVC
- LLVM/Clang con `libclang.dll` en Windows para las crates que usan bindgen

Para ejecutar el target nativo en Windows, `scripts/desktop-native.ps1` comprueba el linker de MSVC y las librerías del SDK. En la práctica, necesitas Visual Studio Build Tools con la carga `Desktop development with C++` antes de ejecutar la app Tauri nativa. Los scripts raíz `npm run *:desktop:native` ahora enrutan automáticamente a ese helper en Windows y ejecutan directamente en Linux/macOS.

Si `cargo check` despues avisa de que bindgen no puede encontrar `libclang`, instala LLVM y apunta `LIBCLANG_PATH` al directorio que contiene `libclang.dll` (por ejemplo `C:\Program Files\LLVM\bin`). Si `winget install -e --id LLVM.LLVM` no termina en tu equipo, instala LLVM manualmente con el instalador oficial o usa otro gestor de paquetes como Chocolatey.

### Backend de pitch Bungee (descarga del SDK)

[Bungee](https://github.com/bungee-audio-stretch/bungee) (MPL-2.0) es el backend de pitch/warp que se usa para cambios de tempo y de tono. **No está incluido en el repo** — descargas el SDK precompilado una vez y lo descomprimes en `vendor/bungee/`. El launcher nativo lo solicita por defecto (`LIBRETRACKS_ENGINE_V2_BUNGEE=1`), y en macOS el bundle de Tauri referencia `bungee.framework` de forma explícita, así que **un clon nuevo no compilará en macOS hasta que el SDK esté en su sitio**.

Descarga el release `v2.4.24` y descomprímelo de forma que existan `vendor/bungee/include/bungee/Bungee.h` y la carpeta de binarios de tu plataforma:

```bash
mkdir -p vendor/bungee
curl -fSL -o /tmp/bungee.tgz \
  https://github.com/bungee-audio-stretch/bungee/releases/download/v2.4.24/bungee-v2.4.24.tgz
tar -xzf /tmp/bungee.tgz -C vendor/bungee
```

El archivo incluye todas las plataformas (`apple-mac/bungee.framework`, `linux-x86_64/libbungee.so`, `linux-aarch64/libbungee.so`, `windows-x86_64/bungee.dll`, etc.); el launcher elige la correcta. El framework de macOS es un binario universal (x86_64 + arm64). Alternativamente, apunta `LT_BUNGEE_DIR` a un SDK descomprimido en otro sitio, o colócalo en `~/Downloads/bungee-v2.4.24`.

Para compilar **sin** Bungee (las voces de pitch/warp se compilan como stubs no-op), define `LIBRETRACKS_ENGINE_V2_BUNGEE=0`. Ten en cuenta que en macOS también debes quitar la entrada `bungee.framework` de `apps/desktop/src-tauri/tauri.conf.json` (`bundle.macOS.frameworks`), ya que ahí se referencia de forma incondicional.

### Nota de arquitectura en macOS (Intel vs Apple Silicon)

El launcher nativo compila el motor C++ como binario universal (`x86_64;arm64`) por defecto. En un **Mac solo Intel**, el slice `arm64` falla al enlazar porque Homebrew instala FFmpeg únicamente para tu arquitectura nativa (`x86_64`), produciendo errores como:

```
ld: warning: ignoring file '.../ffmpeg/.../libavformat.dylib': found architecture 'x86_64', required architecture 'arm64'
ld: symbol(s) not found for architecture arm64
```

Fuerza un build de una sola arquitectura que coincida con tu máquina definiendo `CMAKE_OSX_ARCHITECTURES` antes de ejecutar el target nativo:

```bash
# Macs Intel
CMAKE_OSX_ARCHITECTURES=x86_64 npm run dev:desktop:native

# Macs Apple Silicon
CMAKE_OSX_ARCHITECTURES=arm64 npm run dev:desktop:native
```

Para dejarlo permanente, añade la línea correspondiente a tu perfil de shell (por ejemplo `~/.zshrc`):

```bash
echo 'export CMAKE_OSX_ARCHITECTURES=x86_64' >> ~/.zshrc   # usa arm64 en Apple Silicon
```

Si cambiaste la arquitectura tras un build fallido, borra primero el directorio de build obsoleto para que CMake reconfigure de forma limpia:

```bash
rm -rf native/audio-engine-v2/build-bungee-on-ffmpeg
```

Alternativamente, omite FFmpeg por completo (pierdes importación de M4A/AAC; mantienes WAV/FLAC/MP3/OGG vía libsndfile + dr_libs) — esto también elimina la necesidad de `pkg-config`/`ffmpeg`:

```bash
LIBRETRACKS_ENGINE_V2_FFMPEG=0 npm run dev:desktop:native
```

## Getting Started

Instala las dependencias desde la raíz del repositorio:

```bash
npm install
```

Comandos útiles a nivel raíz:

```bash
# UI desktop en modo Vite
npm run dev:desktop

# App de escritorio completa con Tauri + Rust
npm run dev:desktop:native

# Bundle de producción del frontend desktop
npm run build:desktop

# Chequeo nativo de Rust mediante el lanzador nativo multiplataforma
npm run check:desktop:native

# Lint / typecheck (TypeScript) en desktop, remote y shared
npm run lint
```

El launcher nativo de escritorio compila `native/audio-engine-v2`, define `LT_ENGINE_V2_LIB_DIR` y despues inicia/chequea/compila la app Tauri contra el motor C++ v2.

## Tests

Toda la batería de tests se lanza desde la raíz del repositorio. Consulta
[`docs/testing.md`](docs/testing.md) para la referencia completa.

**Qué comando lanzar según lo que hayas tocado:**

| Tocaste… | Lanza |
| --- | --- |
| Frontend (React/TS), `shared`, `remote` | `npm test` (+ `npm run lint`) |
| Lógica de sesión Rust (`state.rs`, `models/`) | además `npm run test:native:nolink` |
| El motor de audio C++ (`native/audio-engine-v2/`) | además `npm run test:native` |
| Todo, antes de una release | `npm run test:full` |

**Los comandos:**

```bash
# Suite rápida — corre en cualquier sitio, sin toolchain nativo.
# Cubre: shared (vitest), frontend desktop (vitest), frontend remote
# (vitest) y los crates Rust puros (core, project, audio, remote).
npm test

# Tests Rust del motor SIN compilar C++ (stub en memoria del engine).
# Cubre la suite de sesión/estado de libretracks-desktop + bindings de
# lt-audio-engine-v2. Algunos casos que necesitan el motor real se omiten.
npm run test:native:nolink

# Motor real: compila el motor C++, ejecuta los 163 tests C++ del DSP
# (la señal fiable) y luego los tests Rust enlazados contra él.
npm run test:native

# Verificación completa — encadena la suite rápida + la del motor real y
# muestra un único resumen PASS/FAIL agregado. Úsalo antes de una release.
npm run test:full
```

También puedes lanzar un solo nivel por separado:

```bash
npm run test:shared      # packages/shared
npm run test:desktop     # frontend de apps/desktop
npm run test:remote      # frontend de apps/remote
cargo test -p libretracks-core   # o -project / -audio / -remote
```

> **Nota sobre los niveles nativos:** `npm run test:native` y `npm run test:full`
> enlazan el motor de audio **real**, así que los tests Rust que dependen de un
> dispositivo de audio fallan en una máquina sin tarjeta de sonido (o con ella
> ocupada). Son informativos — los **163 tests C++ del DSP son la señal fiable**
> del motor y el código de salida del comando depende de ellos, no de los tests
> de dispositivo de audio.


## Control Remote (Desktop + Movil)

LibreTracks ahora incluye un flujo de acceso remoto integrado en la UI desktop:

1. Abre `Remote` desde la navegacion lateral.
2. En la tarjeta `Conectar remote movil`, escanea el codigo QR o abre una de las URLs generadas (`IP` o `hostname .local`) desde el navegador de tu movil/tablet.
3. Asegurate de que desktop y movil esten en la misma red.

La superficie web remota refleja acciones en vivo desde desktop y expone controles de transporte, controles de salto y una vista dedicada de mixer para ajustes rapidos de volumen/mute/solo durante ensayos y show.

El remote tambien expone los controles nuevos de directo: `Vamp`, ajustes de salto de marca, ajustes de salto de cancion y modo de transicion de cancion. Es util como superficie compacta cuando el operador desktop necesita seguir centrado en el timeline.

La transposicion por region de cancion tambien esta disponible, y los tracks exponen un toggle para activar o desactivar la transposicion de tono desde la misma vista de transporte.

## Project Structure

```txt
.
├─ apps/
│  ├─ desktop/             Aplicación principal de escritorio con React + Tauri
│  │  ├─ src/              UI, stores Zustand, i18n y renderizado canvas del timeline
│  │  └─ src-tauri/        Host nativo Tauri, comandos, runtime de audio y wiring con CPAL
│  └─ remote/              Cliente web remoto para superficies de control secundarias
├─ crates/
│  ├─ libretracks-core/    Modelo de dominio compartido, validación y tipos base
│  ├─ libretracks-project/ I/O de proyecto, persistencia de canción e importación WAV con Symphonia
│  ├─ libretracks-audio/   Motor lógico de audio, transporte, activación de clips y saltos
│  └─ libretracks-remote/  Protocolo remoto y utilidades backend
├─ docs/                   Notas de arquitectura, depuración y roadmap
├─ samples/                Material de ejemplo y canciones demo
├─ scripts/                Helpers de desarrollo, incluido el bootstrap nativo de Windows
├─ tests/                  Superficies e2e e integración
├─ Cargo.toml              Manifest del workspace Rust
└─ package.json            Manifest del workspace JavaScript y scripts raíz
```

## Notas para Desarrollo

- La app es WAV-first en el estado actual del proyecto.
- El routing de pistas parte de los buses `main` y `monitor`.
- El transporte soporta saltos inmediatos, saltos a la siguiente marca y saltos cuantizados por compases.
- Las etiquetas de UI salen de `apps/desktop/src/shared/i18n/en.ts` y `es.ts`; la documentación debe reutilizar esos textos exactos al describir la interfaz.
