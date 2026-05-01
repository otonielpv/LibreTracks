---
title: Documentacion de LibreTracks
description: Documentacion tecnica y de usuario para LibreTracks.
---

LibreTracks es una workstation desktop de playback multitrack para musicos en vivo, directores musicales y playback engineers. Esta pensada para preparar el show con antelacion, guardar la sesion y tocar con routing, marcas, saltos, MIDI y remote movil de forma predecible.

![Timeline de proyecto en LibreTracks](/screenshots/Proyecto.png)

## Para Que Sirve

Usa LibreTracks cuando el show necesita audios preparados, un timeline claro, salidas dedicadas de click o cue, marcas de seccion, regiones de cancion y control en vivo desde desktop, hardware MIDI o movil.

LibreTracks no pretende ser una DAW de produccion. Produce y mezcla stems en Reaper, Ableton Live, Logic, Cubase u otra herramienta de estudio, y trae los audios preparados a LibreTracks para el rig de directo.

## Flujo Principal

1. Importa audio en `Biblioteca`.
2. Organiza assets con carpetas virtuales.
3. Arrastra assets al timeline y crea audio tracks o folder tracks.
4. Configura dispositivo de audio, salidas hardware, rutas por pista, metronomo y entrada MIDI.
5. Crea regiones de cancion, marcas y cambios de compas si hace falta.
6. Ensaya saltos de marca, Vamp, saltos de cancion, transiciones, atajos, mapeos MIDI y remote movil.
7. Exporta canciones o paquetes preparados cuando quieras reutilizarlos en futuras sesiones.

![Importacion en Biblioteca](/screenshots/Library-Assets-Import.gif)

## Modelo De Seguridad En Vivo

La edicion es no destructiva. Cortar, mover, duplicar u organizar clips cambia referencias del timeline; no reescribe el audio original.

El transporte tambien es explicito. Saltos de marca, saltos de cancion, bucles Vamp, metronomo y comandos remotos se resuelven sobre el mismo estado de aplicacion y logica Rust de transporte, no con timers temporales de UI.

## Areas Principales

- `Configuracion`: dispositivo de audio, salidas hardware, metronomo y MIDI Learn.
- `Biblioteca`: assets importados y carpetas virtuales.
- `Timeline`: pistas, clips, regiones de cancion, marcas, compases y edicion con rejilla.
- `Remote`: superficie web local para transporte, saltos, Vamp y mixer.
- `Archivo`: importar canciones/paquetes y exportar canciones preparadas.
