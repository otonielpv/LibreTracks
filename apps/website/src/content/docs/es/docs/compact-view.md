---
title: Vista Compacta
description: Vista tipo Session Ableton de LibreTracks — canciones como columnas, mixer compartido, drag-and-drop, importacion y exportacion de paquetes ltpkg, seleccion multiple y reordenacion de tracks.
---

La **Vista Compacta** es una segunda proyeccion del mismo proyecto. La vista DAW (timeline lineal) y la vista compacta comparten el mismo modelo: lo que haces en una se ve inmediatamente en la otra. Cambia entre las dos con la tecla `Tab` o con el boton del icono `view_module` / `view_timeline` en la barra de herramientas.

## Cuando Usar Cada Vista

- `Vista DAW`: editar el arreglo, alinear waveforms, colocar marcas, ajustar fades, mezclar con todo a la vista.
- `Vista Compacta`: ensayar el set, saltar entre canciones, ajustar mezcla en directo, ver de un vistazo a que cancion pertenece cada clip y exportar / importar canciones rapidamente.

## La Cancion Como Objeto Base

A partir de este modelo, **una cancion (region de cancion) es el contenedor primario del proyecto**, no la pista. Cada clip vive siempre dentro de una y solo una cancion: si lo arrastras fuera del rango de su region, el motor lo rechaza para mantener la invariante. Esto tiene consecuencias practicas:

- Las canciones se pueden **reordenar, renombrar, exportar y borrar** como una unidad. Borrar una cancion elimina los clips que estaban dentro y los tempo markers ubicados en su rango.
- El **BPM efectivo** de una cancion lo decide el tempo marker mas reciente al inicio de su region; si no hay marker, se usa el BPM global del proyecto. Al crear una cancion nueva se ancla automaticamente un tempo marker a su `start` para que no herede el tempo de la cancion anterior.
- Las pistas siguen siendo el carril vertical donde viven los clips, pero ahora pueden ser **auto-creadas** cuando un asset cae en la vista compacta y removidas automaticamente cuando se vacian (mas abajo).

## Zonas De La Vista Compacta

La vista compacta tiene dos zonas verticales claramente separadas:

### 1) Strip Superior — Canciones

Cada cancion del proyecto es una **columna** horizontal. La columna esta dividida en tres partes:

- `Header` con el nombre de la cancion, su BPM efectivo, boton de Play y un fader Master por cancion con su vumetro.
- `Pila de clips` ordenada verticalmente por la posicion de la pista en el proyecto: leer de arriba a abajo coincide con lo que veras en la vista DAW cuando el playhead entra en esa cancion. Cada celda muestra el nombre del clip y la pista en la que vive.
- `Borde izquierdo` con un acento ambar pulsante cuando el playhead esta en esa cancion (independiente de la seleccion).

#### Seleccionar una cancion

Click en cualquier parte del header (que no sea Play ni el fader) **selecciona la region**. Eso enlaza los grupos `Transposicion de Region` y `Warp de Region` de la barra superior a esa cancion. Veras un borde teal completo alrededor del header. La barra ambar del playhead y el borde teal de seleccion son visualmente distintos a proposito: la ambar significa "esta sonando aqui" y la teal "esta cancion esta bindeada a los controles de region".

> El control `Master` de la barra superior **no aparece en vista compacta** porque cada columna ya tiene su propio fader Master con vumetro. Sigue accesible desde la vista DAW.

#### Boton de Play por cancion

Cada cabecera de cancion lleva un boton de Play. Su comportamiento depende del estado del transporte:

- **Transporte parado o pausado**: el boton mueve el playhead al inicio de la cancion y arranca la reproduccion inmediatamente. No espera a transiciones — es el equivalente a "tocar esta cancion ya".
- **Transporte reproduciendo**: el boton programa un salto a la cancion respetando el modo de transicion global configurado en la barra de herramientas (`Inmediato`, `Siguiente marca`, `Final de region`, etc.). Es el mismo path que el atajo `Shift+numero`.

Eso significa que en uso en directo, dar play a una cancion siempre la suena: si nada estaba sonando, arranca; si ya habia algo, hace el salto configurado.

#### Menu contextual de cancion

Click derecho en el header abre un menu con:

- `Renombrar cancion`
- `Cambiar BPM…` — inserta o reemplaza el tempo marker en el inicio de la region. No toca el BPM global del proyecto.
- `Exportar cancion` — guarda un paquete `.ltpkg` exactamente igual que el menu equivalente de la vista DAW.
- `Eliminar cancion` — destructivo. Borra la region, sus clips, los tempo markers en su rango, y purga las pistas auto-creadas que se queden sin clips.

#### Crear o importar canciones

Al final del strip hay dos botones:

- `+ Nueva cancion` — crea una cancion vacia al final del proyecto, anclada al BPM global.
- `Importar .ltpkg` — abre el File Dialog filtrado a `.ltpkg` y appendea la cancion importada al final.

Tambien puedes **arrastrar un `.ltpkg` desde el explorador del sistema** a cualquier parte del strip. Mientras arrastras veras una **columna fantasma** dashed teal a la derecha indicando donde caera, y el strip completo se ilumina ligeramente. Si el archivo no es valido (extension no soportada o mezcla de tipos), no se pinta feedback y el drop se rechaza con un mensaje en la barra de estado.

### 2) Strip Inferior — Mixer Compacto

Un mixer horizontal con una columna por pista del proyecto: nombre, M/S/T, fader vertical teal con vumetro post-fader, slider de pan azul, y selector de routing. Las pistas que son `folder` tienen un fondo mas oscuro y un borde-acento mas grueso a la izquierda; las pistas hijas muestran un `↳ Nombre Carpeta` debajo del nombre y una banda fina con el color del padre, al estilo Reaper. Si una pista tiene color asignado, ese color se usa como acento.

#### Filtro "Solo cancion activa"

En la barra superior, junto al boton de cambiar vista, aparece un boton con icono de embudo **solo en modo compacto**. Al activarlo el mixer oculta los strips de las pistas que no tienen ningun clip dentro de la cancion donde esta el playhead. Los folders ancestros de las pistas visibles se mantienen para preservar la jerarquia, asi una pista hija nunca queda huerfana sin su carpeta padre.

Reglas concretas:

- Filtro **off** (por defecto): se ve el mixer completo.
- Filtro **on** + playhead dentro de una cancion: solo se ven las pistas con clips en esa cancion + sus folders ancestros.
- Filtro **on** + playhead fuera de cualquier cancion (silencio inicial, hueco entre regiones): el filtro no recorta y se muestra todo. Al volver a entrar en una cancion se reactiva automaticamente.
- Sin canciones en el proyecto: el boton aparece deshabilitado.

El estado del filtro se conserva entre sesiones via localStorage.

#### Seleccionar pistas (multi-seleccion)

Click sobre el nombre o el `↳ Parent hint` de un strip selecciona la pista. Misma convencion que en el header de la vista DAW:

- `Click` — selecciona solo esa pista.
- `Ctrl + Click` (o `Cmd + Click`) — anade / quita esa pista de la seleccion actual.
- `Shift + Click` — selecciona el rango entre la ultima pista usada como ancla y esta.

Click sobre los controles (M/S/T, fader, pan, routing) **no** selecciona — esos controles tienen su semantica propia.

La seleccion es compartida con la vista DAW: si seleccionas una pista en el mixer compacto y vuelves a la vista DAW, esa pista sigue seleccionada en el header.

#### Reordenar pistas con drag-and-drop

Arrastra desde la cabecera de un strip (nombre o parent hint) para mover una o varias pistas. Mientras arrastras veras:

- El strip arrastrado se opaca a ~55% y queda traslado horizontalmente bajo el puntero.
- Sobre el strip de destino se pinta una **linea teal vertical** a la **izquierda** (drop antes) o a la **derecha** (drop despues).
- Si el strip de destino es un **folder** y arrastras sobre la zona central (30%–70% del ancho), el strip entero se ilumina teal: al soltar, las pistas pasan a ser hijas de ese folder.

Si tienes varias pistas seleccionadas y arrastras una de ellas, todas se mueven juntas en una sola operacion (un solo snapshot, una sola entrada en el historial).

> La misma multi-seleccion + drag funciona en el header de la vista DAW, en vertical. El backend de reordenacion (`moveTrack`) es compartido entre las dos vistas.

#### Menu contextual de pista

Click derecho sobre un strip abre el mismo menu de pista que la vista DAW (renombrar, color, insertar, borrar, mover dentro/fuera de carpeta, etc.). Lo que cambias aqui se refleja inmediatamente en la otra vista.

## Pistas Auto-Creadas Y Limpieza Automatica

Cuando arrastras audio a una columna de cancion (desde la Biblioteca o desde el SO), **cada archivo crea su propio clip y su propia pista** si no hay una donde colocarlo. Estas pistas llevan internamente un flag `auto_created: true` para diferenciarlas de las pistas que el usuario creo manualmente.

La limpieza automatica funciona asi:

- Una pista auto-creada se borra **en cuanto se queda sin clips**, independientemente de la operacion que la haya dejado vacia: borrar el clip, mover el clip a otra pista, o eliminar la cancion que la contenia.
- Las pistas creadas manualmente nunca se borran solas, aunque se queden vacias.

Esto evita la acumulacion de pistas residuales cuando experimentas con drops rapidos en la vista compacta. Si quieres conservar una pista vacia para futuros clips, creala manualmente desde el menu de pistas en lugar de dejar que se auto-genere.

## Drop De Assets Y Feedback Visual

La vista compacta acepta tres tipos de origenes para soltar audio:

| Origen | Donde se acepta | Que pasa |
|---|---|---|
| Biblioteca (drag interno) | Sobre una columna de cancion | Crea clips + auto-tracks dentro de esa cancion |
| Explorador del SO (audio) | Sobre una columna de cancion | Crea clips + auto-tracks dentro de esa cancion |
| Explorador del SO (`.ltpkg`) | Sobre cualquier parte del strip | Importa la cancion al final del proyecto |
| Cualquier archivo no soportado | — | Drop rechazado con mensaje en la barra de estado |

Durante el dragover veras feedback distinto segun el caso:

- **Audio sobre una columna**: tantos cuadros dashed teal como archivos vayas a soltar, dentro de la pila de clips de la columna. El fondo de la pila se tinta de teal suave.
- **`.ltpkg` sobre el strip**: aparece una columna fantasma al final con icono `library_music` y el texto "Importar aqui".
- **Archivo no soportado**: no se pinta nada (el sistema sabe que el drop sera rechazado).

## Snap, Iman Y Atajos

El boton de `Snap to Grid` en la barra de herramientas ahora usa un **icono de iman**, distinguible del icono de cambio de vista compacta. Cuando el snap esta off el iman aparece tachado con una diagonal.

Mas atajos relacionados:

- `Tab` — alternar entre vista DAW y vista compacta.
- `Shift + numero` — saltar a una cancion (respeta el modo de transicion global).
- En la barra de transposicion / warp del toolbar: la cancion enlazada es la que tengas seleccionada en la vista compacta (o la del playhead si no hay seleccion expresa).

## Banner De Estado

El banner de estado en la esquina inferior derecha se oculta automaticamente a los ~5 segundos despues de cada accion. Si quieres revisar un mensaje, pasa el cursor por encima antes de que desaparezca.

## Biblioteca: Estado Persistente De Carpetas

El estado expandido/colapsado de las carpetas de la Biblioteca se conserva entre sesiones. Si cierras y abres el panel de Biblioteca, las carpetas que tenias colapsadas siguen colapsadas. Las carpetas nuevas se crean siempre expandidas por defecto.

## Resumen De Invariantes Importantes

Mantenlas presentes al disenar tu workflow:

- Un clip pertenece a una sola region de cancion y nunca puede cruzar el limite final de su region.
- Borrar una cancion borra sus clips y sus tempo markers en el mismo rango.
- Una pista auto-creada se borra cuando pierde su ultimo clip. Una pista manual no.
- Un drop sobre una columna de cancion siempre crea clips dentro de esa cancion. Un `.ltpkg` siempre crea una cancion nueva al final.
- Los faders, pan, M/S/T y routing del mixer compacto son la **misma** mezcla que ven la vista DAW y el remote: cualquier cambio se propaga al instante.
