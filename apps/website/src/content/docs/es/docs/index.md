---
title: Documentacion de LibreTracks
description: Documentacion tecnica y de usuario para LibreTracks.
---

LibreTracks es una workstation desktop de playback multitrack para musicos en vivo, directores musicales y playback engineers. Esta construida con audio en Rust, una shell desktop React/Tauri y un remote web local.

La regla clave de diseno es la separacion: React presenta la sesion y las herramientas de edicion, mientras Rust gestiona transporte, audio, persistencia, validacion, comandos remotos y planificacion de saltos.

## Para Que Sirve

LibreTracks sirve para playback e interaccion en vivo. Permite preparar WAV, organizar clips en un timeline, rutear stems y click, crear marcas de seccion, definir regiones de cancion y adaptar el show en tiempo real.

No pretende sustituir una DAW de produccion para componer, grabar, usar cadenas de plug-ins o mezclar discos. Usa Reaper, Ableton Live, Logic, Cubase u otra DAW para producir y trae los WAV preparados a LibreTracks para el rig de directo.

## Mapa Del Codigo

- `apps/desktop` contiene la UI React, timeline canvas, stores Zustand, localizacion y llamadas Tauri.
- `apps/desktop/src-tauri` contiene el puente nativo, estado de app, ajustes, MIDI, servidor remote y coordinacion del runtime de audio.
- `crates/libretracks-core` define proyectos, canciones, pistas, clips, marcas, tempo, compases, regiones, routing y validacion.
- `crates/libretracks-audio` resuelve transporte, clips activos, ganancias efectivas, saltos, Vamp, transiciones y metronomo.
- `crates/libretracks-project` gestiona `song.json`, assets de biblioteca, paquetes e inspeccion de WAV.
- `crates/libretracks-remote` define el protocolo remote y sirve mensajes de estado/control para el navegador movil.

## Formato Actual

El proyecto es WAV-first. La importacion y la documentacion de playback asumen WAV como formato fiable para directo.

## Modelo De Seguridad En Vivo

La edicion es no destructiva. Cortar, mover y duplicar clips cambia referencias del timeline como `timelineStartSeconds`, `sourceStartSeconds` y `durationSeconds`; no reescribe el archivo de audio original.

El control en vivo tambien es explicito. Los saltos viven como estado de transporte, no como timers de UI, asi que los mismos conceptos estan disponibles desde desktop, MIDI Learn y remote.
