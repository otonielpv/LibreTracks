# LibreTracks

Prototipo de editor/reproductor multitrack de escritorio con control remoto web.

## Objetivo actual

Esta primera iteracion prepara la base tecnica del proyecto:

- Monorepo con workspaces para frontend y Rust.
- App de escritorio y app remota con estructura inicial.
- Crates de dominio, proyecto, audio y remoto.
- Documentacion de arquitectura y roadmap.
- Primer modelo de dominio compartido en Rust.

## Estructura

```txt
apps/
  desktop/    App principal Tauri + React
  remote/     Cliente web remoto
crates/
  libretracks-core/
  libretracks-project/
  libretracks-audio/
  libretracks-remote/
docs/
samples/
tests/
```

## Primeros pasos previstos

1. Completar el bootstrap real de `apps/desktop` con Tauri v2.
2. Implementar lectura/escritura de `song.json`.
3. Importar WAV y generar `Song` desde archivos.
4. Construir el transporte de audio minimo.

## Arranque rapido

1. Instala dependencias con `npm install`.
2. Levanta la UI desktop en modo web con `npm run dev:desktop`.
3. Levanta la app de escritorio completa con `npm run dev:desktop:native`.
4. Ejecuta los tests frontend con `npm run test:desktop`.
5. Genera build del frontend con `npm run build:desktop`.

En Windows, `npm run dev:desktop:native` y `npm run check:desktop:native` preparan el `PATH` local para que Tauri encuentre `cargo` y `rustc`.

Tambien puedes validar la parte Rust con `cargo test -p libretracks-core`, `cargo test -p libretracks-project` y `cargo test -p libretracks-audio`.

## Estado

Rust ya esta instalado en la maquina y los tests unitarios de `libretracks-core` y `libretracks-project` ya se han ejecutado correctamente.

El frontend desktop ya puede instalar dependencias, ejecutar tests y generar build con `npm`, y la app Tauri ya pasa `cargo check`.

En Rust ya existe persistencia de `song.json` e importacion basica de WAV para copiar archivos a `audio/`, detectar duracion y crear `Track`/`Clip` automaticamente.

Tambien existe ya un transporte minimo testeable en `libretracks-audio` con `play/pause/stop/seek`, clips activos y ganancia efectiva por pista/grupo.

La app desktop ya conecta esa UI con Tauri para importar WAVs, mostrar tracks y lanzar una primera reproduccion local con audio real.
