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

## Estado

Todavia no se han instalado dependencias ni generado binarios. La estructura esta preparada para avanzar por milestones sin rehacer el repositorio.
