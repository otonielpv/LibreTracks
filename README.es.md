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
- En Linux (Debian/Ubuntu), instala los paquetes de sistema de Tauri:
  `sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- Microsoft Visual C++ Build Tools en Windows
- Windows 10/11 SDK en Windows para el enlazado MSVC
- LLVM/Clang con `libclang.dll` en Windows para las crates que usan bindgen

Para ejecutar el target nativo en Windows, `scripts/desktop-native.ps1` comprueba el linker de MSVC y las librerías del SDK. En la práctica, necesitas Visual Studio Build Tools con la carga `Desktop development with C++` antes de ejecutar la app Tauri nativa. Los scripts raíz `npm run *:desktop:native` ahora enrutan automáticamente a ese helper en Windows y ejecutan directamente en Linux/macOS.

Si `cargo check` despues avisa de que bindgen no puede encontrar `libclang`, instala LLVM y apunta `LIBCLANG_PATH` al directorio que contiene `libclang.dll` (por ejemplo `C:\Program Files\LLVM\bin`). Si `winget install -e --id LLVM.LLVM` no termina en tu equipo, instala LLVM manualmente con el instalador oficial o usa otro gestor de paquetes como Chocolatey.

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

# Tests Rust del workspace
cargo test
```

Otros comandos útiles durante desarrollo:

```bash
# Chequeo nativo de Rust mediante el lanzador nativo multiplataforma
npm run check:desktop:native

# Tests frontend y lint/typecheck
npm run test:desktop
npm run lint

# Tests Rust desktop headless
cargo test --locked -p libretracks-desktop -- --test-threads=1
```

El launcher nativo de escritorio compila `native/audio-engine-v2`, define `LT_ENGINE_V2_LIB_DIR` y despues inicia/chequea/compila la app Tauri contra el motor C++ v2.


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
