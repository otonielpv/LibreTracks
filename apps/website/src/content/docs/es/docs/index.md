---
title: Documentacion de LibreTracks
description: Documentacion tecnica y de usuario para LibreTracks.
---

LibreTracks es una workstation de playback multitrack para musicos en vivo, directores musicales y playback engineers. Esta pensada para preparar el show con antelacion, guardar o convertir la sesion en plantilla, y tocar con routing, marcas, saltos, controles de transposicion, timeline con colores, MIDI, atajos personalizables y remote movil de forma predecible.

LibreTracks funciona en escritorio (Windows, macOS, Linux) y ahora esta disponible en Android como una beta inicial: puedes instalarlo en un movil o tablet y abrir tus sesiones con reproduccion real, importacion de audio y control tactil del timeline. La version de Android todavia esta en pruebas, asi que usala con cautela y no dependas de ella para un directo importante todavia.

![Timeline de proyecto en LibreTracks](/screenshots/Proyecto.png)

## Para Que Sirve

Usa LibreTracks cuando el show necesita audios preparados, un timeline claro, salidas dedicadas de click o cue, marcas de seccion, regiones de cancion y control en vivo desde desktop, hardware MIDI o movil.

LibreTracks no pretende ser una DAW de produccion. Produce y mezcla stems en Reaper, Ableton Live, Logic, Cubase u otra herramienta de estudio, y trae los audios preparados a LibreTracks para el rig de directo. Tambien puedes importar proyectos Reaper `.rpp` y Ableton `.als` como punto de partida cuando quieras que LibreTracks recree la estructura del arreglo en directo.

El modelo del proyecto es **song-first**: las canciones (regiones de cancion) son el contenedor principal, y los clips y pistas viven dentro de ellas. La app de escritorio ofrece dos proyecciones equivalentes de ese modelo — el [timeline lineal (vista DAW)](/es/docs/core-concepts/) para arreglar y la [Vista Compacta](/es/docs/compact-view/) para ensayar, tocar e importar/exportar canciones, paquetes `.ltpkg` y puntos de partida desde proyectos externos.

## Flujo Principal

1. Importa WAV, AIFF, MP3, FLAC u otros formatos soportados en `Biblioteca`, o importa un proyecto Reaper/Ableton para crear la base del arreglo.
2. Organiza assets con carpetas virtuales.
3. Arrastra archivos de audio, paquetes de cancion o proyectos externos a la sesion y organiza los assets entre Biblioteca y timeline.
4. Configura dispositivo de audio, frecuencia de muestreo, tamaño de buffer, salidas hardware, rutas por pista, metronomo y entrada MIDI.
5. Crea regiones de cancion, marcas, cambios de compas si hace falta y cambios de transposicion por region. Dale un tipo de seccion a las marcas para activar la [Voz Guia](/es/docs/voice-guide/).
6. Ensaya saltos de marca, Vamp, saltos de cancion, transiciones, atajos, mapeos MIDI, estados de transposicion por pista y [Remote personalizable](/es/docs/remote-control/). Anade una [pista de automatizacion](/es/docs/automation/) para disparar saltos, mute/solo, movimientos de fader, escenas de mezcla y estados de [Pads](/es/docs/ambient-pads/) automaticamente en puntos exactos.
7. Exporta canciones preparadas, una sesion completa `.ltset` o una plantilla `.lttemplate` cuando quieras reutilizar el trabajo en futuras sesiones.

![Importacion en Biblioteca](/screenshots/Library-Assets-Import.gif)

## Modelo De Seguridad En Vivo

La edicion es no destructiva. Cortar, mover, duplicar u organizar clips cambia referencias del timeline; no reescribe el audio original.

El transporte tambien es explicito. Saltos de marca, saltos de cancion, bucles Vamp, metronomo y comandos remotos se resuelven sobre el mismo estado de aplicacion y logica Rust de transporte, no con timers temporales de UI.

Las fuentes importadas grandes se preparan para reproduccion apoyada en disco. LibreTracks mantiene una cache limitada en RAM y lee por adelantado desde la cache del proyecto en disco, asi las sesiones multitrack mas grandes pueden cargar sin mantener cada fuente decodificada completa en memoria. La preparacion de audio ocurre en segundo plano, las formas de onda se cargan de forma diferida, la cache PCM se reutiliza entre sesiones cuando el archivo no ha cambiado, y los archivos en formato nativo pueden transmitirse en sitio sin pasar por la cache cuando es posible, asi reabrir proyectos grandes es mucho mas rapido. Después de una actualización que cambie el procesamiento de audio, la primera apertura puede tardar más mientras LibreTracks reconstruye la caché; después de esa preparación puntual, se reutiliza la caché guardada. Puedes revisar y limpiar la cache de decodificacion desde `Configuracion` cuando necesites liberar espacio.

La reproduccion nunca se bloquea por la preparacion: al pulsar play el transporte arranca al instante, y cualquier pista cuyo audio aun se este decodificando permanece en silencio y entra sola en cuanto esta lista, asi las pistas ya preparadas nunca quedan retenidas por una fuente nueva lenta.

Cada region de cancion puede cambiar tempo y tonalidad de forma independiente. Region Warp estira el audio para encajar con el BPM del timeline sin cambiar el tono, y Region Transpose desplaza el tono cambiando o no la duracion segun este el warp. Ademas, cada cancion puede llevar su propia nota o tonalidad, que se ajusta desde el menu contextual de la region ("Nota"), se muestra en el timeline y se transpone junto con el cambio de tono de la region. Consulta [Pitch, warp y el boton T](/es/docs/pitch-and-warp/) para la tabla de decision completa.

La edicion de clips soporta flujos al estilo Ableton: Ctrl/Cmd+click y Shift+click para seleccion multiple, arrastre en grupo con IPC agrupado, y magnets con Ctrl al arrastrar que pegan los bordes del clip al playhead, marcas, regiones y bordes de otros clips. Tambien puedes arrastrar clips verticalmente para moverlos a otra pista, validando el destino mientras arrastras. Ademas, pistas y clips pueden colorearse desde el menu contextual para leer sesiones densas mas rapido.

Las folder tracks tambien pueden actuar como dueñas del routing: las pistas hijas pueden dejar su salida en `Inherited (Folder)` para seguir automaticamente el bus de la carpeta, manteniendo la misma agrupacion visual en el timeline desktop y en el mixer remote.

La barra superior muestra un medidor de recursos en vivo con el uso actual de CPU y memoria, asi puedes ver de un vistazo cuando una sesion grande empieza a exigir mas al equipo.

LibreTracks ademas avisa dentro de la app cuando se publica una nueva version, mostrando las novedades en el idioma de la app y un acceso directo a la pagina de descargas. La comprobacion tambien se puede lanzar manualmente desde `Configuracion - General`.

## Areas Principales

- `Configuracion`: dispositivo de audio, frecuencia de muestreo, tamano de buffer, salidas hardware, metronomo, MIDI Learn, atajos de teclado personalizables y gestion de cache de decodificacion.
- `Biblioteca`: assets importados, incluidos archivos FLAC y audio traido por importaciones Reaper/Ableton, y carpetas virtuales. El estado expandido/colapsado de las carpetas se conserva entre sesiones.
- `Timeline (vista DAW)`: pistas, clips, regiones de cancion, transposicion por region, marcas, compases, edicion con rejilla, [senales de automatizacion](/es/docs/automation/) y organizacion por color. Toda la interfaz se puede ampliar y ajustar a pantallas pequenas, y el timeline puede seguir al cursor de reproduccion.
- `Vista Compacta`: proyeccion estilo Session del mismo modelo — una columna por cancion con su propio fader Master, mixer horizontal compartido abajo, drag-and-drop de audio, paquetes `.ltpkg` y proyectos `.rpp`/`.als`, y reordenacion de pistas con multi-seleccion. Los faders de pista y del mixer usan una escala en decibelios (dB) al estilo Ableton y Reaper, partiendo de 0 dB, para un control de volumen preciso; el master de cada cancion solo afecta a las pistas de esa cancion y nunca al metronomo ni a la voz guia. Ver [Vista Compacta](/es/docs/compact-view/).
- `Remote`: superficie web local personalizable mediante pestañas y widgets responsivos para transporte, saltos, Vamp, marcas, canciones, mezcla, metrónomo, guía y Pads. Incluye layouts distintos para teléfono, tablet y pantalla grande. Ver [Remote personalizable](/es/docs/remote-control/).
- `Archivo`: crear desde `.lttemplate`, importar canciones/paquetes, importar proyectos Reaper/Ableton, importar o exportar una sesion entera como `.ltset` portable, guardar plantillas y exportar canciones preparadas. Ver [Integracion Y Ecosistema](/es/docs/integration-ecosystem/).
