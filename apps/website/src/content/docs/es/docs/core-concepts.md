---
title: Conceptos Base
description: Biblioteca, pistas, clips, marcas, cambios de compas y regiones de cancion.
---

## Biblioteca Y Assets

`Biblioteca` es el area de preparacion de audio del show. Importa uno o varios archivos y arrastralos al timeline cuando quieras empezar a organizar.

![Importar assets en Biblioteca](/screenshots/Library-Assets-Import.gif)

Las carpetas virtuales agrupan assets por cancion, set, escena, seccion o instrumentacion sin mover los archivos originales. Un flujo practico es usar una carpeta por cancion o bloque del show.

![Carpetas virtuales](/screenshots/Assets-Folder.gif)

## Audio Tracks Y Folder Tracks

- `Audio track` contiene clips y produce playback.
- `Folder track` organiza pistas hijas y permite control agrupado.

Usa folder tracks para stems relacionados como bateria, tracks de banda, coros, voces de apoyo o playback auxiliar. Usa audio tracks para lanes que contienen clips.

![Tracks y carpetas](/screenshots/Tracks-Folder.gif)

## Clips Y Edicion De Timeline

Los clips son referencias no destructivas a archivos de audio. Puedes arrastrar assets desde Biblioteca, mover clips, duplicar secciones repetidas y cortar en el cursor sin reescribir el WAV original.

![Duplicar un clip](/screenshots/DuplicateTrack.png)

`Snap to Grid` mantiene cursor, clips y ediciones alineados a divisiones musicales. Desactivalo solo cuando necesites una colocacion libre.

![Control Snap to Grid](/screenshots/Snap-To-Grid-Button.png)

## Regiones De Cancion

Las regiones de cancion definen rangos con nombre en el timeline. Permiten que una sesion contenga varias canciones o cues de show y se usan en los controles de salto de cancion.

Crea una region seleccionando una zona del timeline, haciendo clic derecho y eligiendo `Create song from selection`.

![Crear region de cancion](/screenshots/Create-Region.png)

## Marcas Y Cambios De Compas

Las marcas definen destinos musicales como Intro, Verso, Estribillo, Puente, Vamp u Outro. Se crean desde el ruler con `Create Marker`.

![Crear una marca](/screenshots/Create-Marker.gif)

Los cambios de compas mantienen correctas las operaciones por compases cuando una cancion cambia de metrica. Se crean desde el header del timeline con `Create Meter Marker`.

![Crear cambio de compas](/screenshots/Change-Time-Signature.png)
