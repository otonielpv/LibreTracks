---
title: Conceptos Base
description: Biblioteca, pistas, clips, marcas, cambios de compas y regiones de cancion.
---

## Biblioteca Y Assets

`Biblioteca` es el area de preparacion de audio del show. Importa uno o varios archivos y arrastralos al timeline cuando quieras empezar a organizar. Tambien puedes agrupar assets en carpetas virtuales y traer paquetes de cancion ya preparados al construir una sesion mas grande.

![Importar assets en Biblioteca](/screenshots/Library-Assets-Import.gif)

Las carpetas virtuales agrupan assets por cancion, set, escena, seccion o instrumentacion sin mover los archivos originales. Un flujo practico es usar una carpeta por cancion o bloque del show.

![Carpetas virtuales](/screenshots/Assets-Folder.gif)

## Audio Tracks Y Folder Tracks

- `Audio track` contiene clips y produce playback.
- `Folder track` organiza pistas hijas y permite control agrupado.

Usa folder tracks para stems relacionados como bateria, tracks de banda, coros, voces de apoyo o playback auxiliar. Usa audio tracks para lanes que contienen clips.

![Tracks y carpetas](/screenshots/Tracks-Folder.gif)

## Clips Y Edicion De Timeline

Los clips son referencias no destructivas a archivos de audio. Puedes arrastrar assets desde Biblioteca, soltar audio externo directamente en el timeline, mover clips, duplicar secciones repetidas y cortar en el cursor sin reescribir el WAV original.

Selecciona clips y usa `Ctrl + C` / `Ctrl + V` para copiarlos y pegarlos. Usa `Ctrl + D` cuando quieras duplicar los clips seleccionados directamente en la siguiente posicion del timeline.

Arrastra el borde de un clip para redimensionar su region sin cambiar el archivo de audio original. Cuando `Snap to Grid` esta activado, manten `Alt` mientras mueves el playhead para colocarlo libremente sin ajustar a la rejilla.

![Duplicar un clip](/screenshots/DuplicateTrack.png)

`Snap to Grid` mantiene cursor, clips y ediciones alineados a divisiones musicales. Desactivalo solo cuando necesites una colocacion libre.

![Control Snap to Grid](/screenshots/Snap-To-Grid-Button.png)

## Regiones De Cancion

Las regiones de cancion definen rangos con nombre en el timeline. Permiten que una sesion contenga varias canciones o cues de show y se usan en los controles de salto de cancion.

Cada region tambien guarda su propia transposicion y un toggle de warp independiente, asi el mismo arreglo puede subir o bajar por semitonos — cambiando o no la duracion — sin duplicar pistas ni clips. La interaccion exacta entre estos controles esta documentada en [Pitch, warp y el boton T](./pitch-and-warp).

Crea una region seleccionando una zona del timeline, haciendo clic derecho y eligiendo `Create song from selection`. Despues puedes ajustar `Region Transpose` y `Region Warp` desde la vista de transporte cuando la cancion necesite otra tonalidad o tempo.

![Crear region de cancion](/screenshots/Create-Region.png)

## Marcas Y Cambios De Compas

Las marcas definen destinos musicales como Intro, Verso, Estribillo, Puente, Vamp u Outro. Se crean desde el ruler con `Create Marker`.

![Crear una marca](/screenshots/Create-Marker.gif)

Los cambios de compas mantienen correctas las operaciones por compases cuando una cancion cambia de metrica. Se crean desde el header del timeline con `Create Meter Marker`.

![Crear cambio de compas](/screenshots/Change-Time-Signature.png)
