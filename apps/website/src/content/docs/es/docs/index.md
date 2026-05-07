---
title: Documentacion de LibreTracks
description: Documentacion tecnica y de usuario para LibreTracks.
---

LibreTracks es una workstation desktop de playback multitrack para musicos en vivo, directores musicales y playback engineers. Esta pensada para preparar el show con antelacion, guardar la sesion y tocar con routing, marcas, saltos, controles de transposicion, MIDI y remote movil de forma predecible.

![Timeline de proyecto en LibreTracks](/screenshots/Proyecto.png)

## Para Que Sirve

Usa LibreTracks cuando el show necesita audios preparados, un timeline claro, salidas dedicadas de click o cue, marcas de seccion, regiones de cancion y control en vivo desde desktop, hardware MIDI o movil.

LibreTracks no pretende ser una DAW de produccion. Produce y mezcla stems en Reaper, Ableton Live, Logic, Cubase u otra herramienta de estudio, y trae los audios preparados a LibreTracks para el rig de directo.

## Flujo Principal

1. Importa audio en `Biblioteca`.
2. Organiza assets con carpetas virtuales.
3. Arrastra archivos de audio o paquetes de cancion a la sesion y organiza los assets entre Biblioteca y timeline.
4. Configura dispositivo de audio, frecuencia de muestreo, tamaño de buffer, salidas hardware, rutas por pista, metronomo y entrada MIDI.
5. Crea regiones de cancion, marcas, cambios de compas si hace falta y cambios de transposicion por region.
6. Ensaya saltos de marca, Vamp, saltos de cancion, transiciones, atajos, mapeos MIDI, estados de transposicion por pista y remote movil.
7. Exporta canciones o paquetes preparados cuando quieras reutilizarlos en futuras sesiones.

![Importacion en Biblioteca](/screenshots/Library-Assets-Import.gif)

## Modelo De Seguridad En Vivo

La edicion es no destructiva. Cortar, mover, duplicar u organizar clips cambia referencias del timeline; no reescribe el audio original.

El transporte tambien es explicito. Saltos de marca, saltos de cancion, bucles Vamp, metronomo y comandos remotos se resuelven sobre el mismo estado de aplicacion y logica Rust de transporte, no con timers temporales de UI.

## Areas Principales

- `Configuracion`: dispositivo de audio, frecuencia de muestreo, tamano de buffer, salidas hardware, metronomo y MIDI Learn.
- `Biblioteca`: assets importados y carpetas virtuales.
- `Timeline`: pistas, clips, regiones de cancion, transposicion por region, marcas, compases y edicion con rejilla.
- `Remote`: superficie web local para transporte, saltos, Vamp, transposicion y mixer.
- `Archivo`: importar canciones/paquetes y exportar canciones preparadas.
