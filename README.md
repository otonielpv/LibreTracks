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
3. Ejecuta los tests frontend con `npm run test:desktop`.
4. Genera build del frontend con `npm run build:desktop`.

Nota: el frontend desktop ya arranca con Vite, pero Tauri todavia no puede ejecutarse aqui porque falta instalar Rust (`cargo` y `rustc`).

## Estado

Hay tests unitarios Rust escritos en `libretracks-core` y `libretracks-project`, pero en esta maquina todavia no se pueden ejecutar porque falta instalar Rust.

El frontend desktop ya puede instalar dependencias, ejecutar tests y generar build con `npm`. El siguiente objetivo es conectar esa UI con Tauri y el dominio real.
