---
title: Conceptos Base
description: La cancion como unidad de trabajo, biblioteca, pistas, clips, marcas, cambios de compas y regiones de cancion.
---

## Las Canciones — La Unidad Sobre La Que Trabajas

LibreTracks esta construido alrededor de la **cancion** como unidad de trabajo. Un proyecto es una secuencia de canciones; todo lo demas — clips, tempo markers, cambios de compas, marcas de seccion — vive *dentro* de una cancion. No hay "audio suelto" flotando en el proyecto: cada clip pertenece a exactamente una cancion, y el motor lo enforza en cada edicion.

Esto es lo mas importante de interiorizar antes de leer el resto. Cuando piensas en canciones:

- Añadir material al show significa **crear o importar una cancion** - desde audio, un `.ltpkg` o un proyecto Reaper/Ableton - y no tratar el proyecto como pistas sueltas.
- Reordenar el setlist significa **mover canciones**, lo que arrastra sus clips, marcas, tempo y cambios de compas de forma atomica.
- Tempo, tonalidad y ganancia master son **propiedades por cancion** (`Region Warp`, `Region Transpose`, fader master por cancion), no globales.
- Hacer copia o compartir una pieza del show significa **exportar un `.ltpkg`** de una o varias canciones, que se puede importar en cualquier otro proyecto.
- Llevarte el **show entero** entre ordenadores significa **exportar un `.ltset`** de la sesion completa, que se abre como sesion nueva en el equipo destino. Ver [Integracion Y Ecosistema](./integration-ecosystem#exportar-e-importar-sesiones-completas).

La referencia sobre como se comportan las canciones como contenedores — limites, BPM efectivo, transpose, warp — esta en la seccion [Regiones De Cancion](#regiones-de-cancion--el-contenedor-principal) mas abajo. El flujo orientado a canciones en si (canciones como columnas, drag-and-drop de audio y paquetes, mixer por cancion) vive en [Vista Compacta](./compact-view).

## Biblioteca Y Assets

`Biblioteca` es el area de preparacion de audio del show. Importa uno o varios archivos, incluidos FLAC ademas de fuentes habituales como WAV, AIFF y MP3, y arrastralos al timeline cuando quieras empezar a organizar. Tambien puedes agrupar assets en carpetas virtuales y traer paquetes de cancion ya preparados al construir una sesion mas grande.

![Importar assets en Biblioteca](/screenshots/Library-Assets-Import.gif)

Las carpetas virtuales agrupan assets por cancion, set, escena, seccion o instrumentacion sin mover los archivos originales. Un flujo practico es usar una carpeta por cancion o bloque del show.

![Carpetas virtuales](/screenshots/Assets-Folder.gif)

Las importaciones de proyectos Reaper `.rpp` y Ableton `.als` usan el mismo modelo song-first: el audio fuente se anade a Biblioteca, mientras que pistas, clips, marcas, tempo, compas y regiones de cancion importadas se colocan directamente en la sesion.

## Audio Tracks Y Folder Tracks

- `Audio track` contiene clips y produce playback.
- `Folder track` organiza pistas hijas y permite control agrupado.

Usa folder tracks para stems relacionados como bateria, tracks de banda, coros, voces de apoyo o playback auxiliar. Usa audio tracks para lanes que contienen clips.

Las folder tracks tambien pueden ser las duenas del routing del grupo. Las pistas hijas pueden quedarse en `Inherited (Folder)` para que la carpeta decida si todo va a `Master` o a una salida de cue, algo util para buses de click, guia o monitores.

![Tracks y carpetas](/screenshots/Tracks-Folder.gif)

Usa el menu contextual de pista para insertar audio tracks o folder tracks. Si abres ese menu sobre una carpeta, la pista nueva se crea dentro; si lo abres sobre una pista normal, se inserta como hermana despues de esa pista.

### Pistas Auto-Creadas

Las pistas que el sistema creo automaticamente — normalmente porque soltaste un archivo de audio sobre una zona vacia en la [Vista Compacta](./compact-view) — llevan un flag interno `auto_created`. Se comportan como cualquier otra pista al editar, pero **se borran automaticamente cuando pierden su ultimo clip**. Las pistas creadas a mano nunca se borran solas, aunque queden vacias. Este comportamiento mantiene el proyecto limpio mientras experimentas con drops rapidos, sin comprometerte a conservar cada carril que tuvo brevemente un clip.

## Clips Y Edicion De Timeline

Los clips son referencias no destructivas a archivos de audio. Puedes arrastrar assets desde Biblioteca, soltar audio externo directamente en el timeline, mover clips, duplicar secciones repetidas y cortar en el cursor sin reescribir el WAV original.

Selecciona clips y usa `Ctrl + C` / `Ctrl + V` para copiarlos y pegarlos. Usa `Ctrl + D` cuando quieras duplicar los clips seleccionados directamente en la siguiente posicion del timeline.

Usa `S` para partir el clip o los clips seleccionados en el playhead. Es una edicion no destructiva: el archivo original no cambia, LibreTracks solo escribe nuevas referencias de clip.

Arrastra el borde de un clip para redimensionar su region sin cambiar el archivo de audio original. Cuando `Snap to Grid` esta activado, manten `Alt` mientras mueves el playhead para colocarlo libremente sin ajustar a la rejilla.

Pistas y clips tambien pueden colorearse desde el menu contextual. Si seleccionas varias pistas, puedes aplicar el mismo color de una sola vez para organizar shows grandes por cancion, bloque o funcion.

![Duplicar un clip](/screenshots/DuplicateTrack.png)

`Snap to Grid` mantiene cursor, clips y ediciones alineados a divisiones musicales. Desactivalo solo cuando necesites una colocacion libre.

![Control Snap to Grid](/screenshots/Snap-To-Grid-Button.png)

## Regiones De Cancion — El Contenedor Principal

La region de cancion es el **contenedor principal** de un proyecto LibreTracks. La sesion contiene canciones; las canciones contienen clips; los clips viven en pistas. Cada clip pertenece a una sola region de cancion y no puede cruzar su limite final — el motor rechaza cualquier movimiento que rompa esa invariante.

Consecuencias practicas:

- Las canciones se pueden **reordenar, renombrar, exportar y borrar** como una unidad. Borrar una cancion elimina los clips de dentro y los tempo markers en su mismo rango, y purga las pistas auto-creadas que se queden vacias.
- El **BPM efectivo** de una cancion lo decide el tempo marker mas reciente al inicio de la region; si no hay marker, se usa el BPM global del proyecto. Al crear una cancion vacia se ancla automaticamente un tempo marker a su `start` para que no herede el tempo de la cancion anterior.
- Cada region tambien guarda su propia transposicion y un toggle de warp independiente, asi el mismo arreglo puede subir o bajar por semitonos — cambiando o no la duracion — sin duplicar pistas ni clips. La interaccion exacta entre estos controles esta documentada en [Pitch, warp y el boton T](./pitch-and-warp).

Crea una region seleccionando una zona del timeline, haciendo clic derecho y eligiendo `Create song from selection`. Tambien puedes crear una cancion vacia desde el boton `+ Nueva cancion` de la Vista Compacta, importar un paquete `.ltpkg` previamente exportado o importar un proyecto Reaper/Ableton como una o varias canciones. Despues puedes ajustar `Region Transpose` y `Region Warp` desde la vista de transporte cuando la cancion necesite otra tonalidad o tempo.

Las `REGION`s de Reaper se convierten en canciones separadas de LibreTracks dentro del setlist. Los `MARKER`s de Reaper y los locators de Ableton se convierten en marcas de seccion dentro de una cancion, y un arrangement de Ableton se importa como una unica cancion que abarca el arreglo.

### Mover una cancion completa

En la vista DAW puedes arrastrar la banda con el nombre de la cancion (la franja amarilla encima de las pistas) para desplazar la cancion entera por el timeline. El gesto translada region, clips, tempo markers, marcas de seccion y cambios de compas todo al mismo tiempo, manteniendo la musica intacta — solo cambia su posicion absoluta en el proyecto.

Reglas:

- El gesto se inicia haciendo click izquierdo y arrastrando el centro de la banda. Los bordes siguen siendo handles de redimensionado.
- Si `Snap to Grid` esta activo, el inicio de la cancion se ajusta al downbeat mas cercano. Mantén `Shift` durante el drag para colocarla libremente sin snap.
- Si soltar ahi haria que la cancion solape con otra, el movimiento se rechaza con un mensaje claro y la cancion vuelve a su posicion original. Mueve o reordena la otra cancion antes.
- Todo va en una sola transaccion atomica: un solo snapshot, una sola entrada de undo.

![Crear region de cancion](/screenshots/Create-Region.png)

### Partir una cancion

Usa `Shift + S`, o el menu contextual de la cancion, para partir la cancion bajo el playhead. LibreTracks crea una segunda region para la mitad derecha, mueve el limite de forma atomica y parte cualquier clip que cruce el corte para que cada lado siga perteneciendo a una sola cancion.

Para el flujo completo orientado a canciones — canciones como columnas, fader Master por cancion, drag-and-drop de audio, paquetes y proyectos externos, y multi-seleccion de pistas en el mixer — ver [Vista Compacta](./compact-view).

## Marcas Y Cambios De Compas

Las marcas definen destinos musicales como Intro, Verso, Estribillo, Puente, Vamp u Outro. Se crean desde el ruler con `Create Marker`.

![Crear una marca](/screenshots/Create-Marker.gif)

Los cambios de compas mantienen correctas las operaciones por compases cuando una cancion cambia de metrica. Se crean desde el header del timeline con `Create Meter Marker`.

![Crear cambio de compas](/screenshots/Change-Time-Signature.png)
