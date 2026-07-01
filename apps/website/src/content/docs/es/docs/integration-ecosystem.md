---
title: Integracion Y Ecosistema
description: Paquetes de cancion, import/export, arquitectura remote y flujo recomendado.
---

## Exportar Canciones

Despues de crear una region de cancion, exportala cuando quieras reutilizar la configuracion en futuras sesiones.

1. Crea una cancion desde una region seleccionada del timeline.
2. Haz clic derecho sobre la region creada.
3. Elige `Export Song`.

![Exportar una cancion](/screenshots/Export-Song.png)

El dialogo de exportacion te permite elegir si incluir los archivos de audio dentro del `.ltpkg`. Incluye el audio cuando necesites un paquete autocontenido para otro equipo. Dejalos fuera cuando solo quieras compartir estructura de cancion, clips, routing, marcas y ajustes de region manteniendo el paquete ligero.

## Importar Canciones Y Paquetes

Usa `Import song` desde la seccion superior `Archivo` cuando quieras traer otra cancion o paquete de sesion de LibreTracks a la sesion actual. Es util para construir un show completo desde canciones preparadas sin rehacer pistas, clips, routing, marcas y configuracion de regiones a mano.

Para la preparacion diaria, la sesion tambien admite drops externos de forma mas directa: los archivos de audio pueden entrar en el flujo de arreglo y las carpetas de Biblioteca ayudan a mantener los assets ordenados por cancion o bloque del show.

## Importar Proyectos De Reaper Y Ableton

Usa `Archivo` -> `Importar Reaper/Ableton` para convertir un proyecto de otra DAW a LibreTracks sin exportar todos los stems y reconstruir el set a mano. LibreTracks acepta archivos Reaper `.rpp` y Ableton Live `.als`.

Cuando importas dentro de una sesion abierta, el proyecto se anade despues del setlist actual. Desde la pantalla inicial vacia, `Importar Reaper/Ableton` primero pide el proyecto externo y despues pregunta donde guardar la nueva sesion `.ltsession` de LibreTracks.

Tambien puedes arrastrar un unico `.rpp` o `.als` desde el sistema operativo al timeline. El proyecto intentara caer en la posicion del drop; si eso solapara una cancion existente, LibreTracks lo coloca despues del setlist. Si lo sueltas sobre la tira de Vista Compacta, se importa como una cancion nueva al final.

La conversion conserva la estructura util para playback en directo, no cada detalle interno de la DAW:

- En Reaper, los items de audio se convierten en clips, se recrean pistas y folder tracks, se mantiene el estado basico de mezcla por pista, se importan tempo markers y cambios de compas, las `REGION`s pasan a ser canciones de LibreTracks y los `MARKER`s pasan a ser marcas de seccion dentro de esas canciones.
- En Ableton, los clips de audio del arrangement se convierten en clips sobre pistas recreadas, los locators pasan a ser marcas de seccion, se importa tempo y compas, y el arrangement se convierte en una unica cancion de LibreTracks porque los locators de Ableton son secciones, no limites de cancion.

## Exportar E Importar Sesiones Completas

Mientras que un paquete `.ltpkg` lleva una sola cancion que se fusiona en la sesion que ya tienes abierta, un archivo `.ltset` lleva la **sesion entera** —todas las canciones, la biblioteca, la automatizacion y las ondas— en un unico archivo portable. Usalo para preparar el set en el PC de casa y abrirlo tal cual en el equipo donde tocas en directo, sin tener que configurarlo todo de nuevo.

Para exportar la sesion completa, abre el menu superior `Archivo` y elige `Exportar sesion…`. El dialogo ofrece los mismos dos modos que la exportacion de canciones:

- **Completo**: incluye tambien los audios usados por tus clips, de modo que el set es autocontenido y se abre en otro PC sin los archivos originales.
- **Ligero**: solo el proyecto y las ondas; referencia los audios por su ruta. Mas pequeno, para reusar en el mismo equipo.

Un indicador de progreso muestra cuanto lleva la exportacion —util en un set completo grande, donde empaquetar todos los audios puede tardar— y puedes seguir trabajando mientras se exporta.

Para importar una sesion, elige `Importar sesion…` en el menu `Archivo`, o usa el boton **Importar sesion** de la pantalla inicial —no necesitas tener una sesion abierta primero. Selecciona el `.ltset`, elige donde guardarlo, y LibreTracks crea una carpeta de proyecto nueva y la abre como sesion fresca (reemplaza lo que tengas cargado en lugar de fusionarlo).

## Plantillas De Sesion

Usa `Archivo` -> `Guardar como plantilla…` cuando la sesion actual tenga una estructura de pistas que quieras reutilizar. Una `.lttemplate` conserva la organizacion - pistas, jerarquia de carpetas, nombres, colores y routing - y elimina a proposito clips, regiones de cancion, marcas, mapas de tempo y valores de mezcla por pista para que el siguiente proyecto empiece limpio.

Crea desde una plantilla con `Archivo` -> `Nuevo desde plantilla…`, desde el area **Plantillas** de la pantalla inicial, o eligiendo manualmente un archivo de plantilla. Es util para rigs recurrentes como stems de reuniones, cues de teatro, layouts de click/guia o cualquier show donde el routing se mantiene estable aunque cambien las canciones.

## Tipos De Archivo Y Abrir Desde El Equipo

LibreTracks registra sus propios tipos de archivo para que sean faciles de reconocer y abrir:

- `.ltsession` — un proyecto/sesion en el que estas trabajando.
- `.ltpkg` — un paquete de una sola cancion exportada.
- `.ltset` — una sesion entera exportada.
- `.lttemplate` — una plantilla reutilizable de sesion.

Tras instalar en Windows, estos archivos muestran su propio icono en el Explorador en lugar del icono blanco generico, asi distingues de un vistazo un paquete de cancion de un set completo. En macOS y Linux los tipos quedan registrados como archivos de LibreTracks, aunque alli comparten el icono de la app.

## Arquitectura Del Remote Movil

El remote controla estado; no reproduce audio. El audio permanece en el runtime desktop, lo que mantiene el rig de directo predecible y evita la complejidad de dispositivos de audio en navegador.

Los comandos remotos se envian al backend desktop y se resuelven mediante la misma logica de sesion y transporte que usa la UI desktop, los mapeos MIDI y los atajos.

![Superficie remote](/screenshots/Remote.png)

## Flujo Recomendado

Prepara audio en una DAW de produccion y despues exporta stems o importa un proyecto Reaper/Ableton como punto de partida. Organiza Biblioteca, construye o refina el timeline, configura routing de salidas, crea regiones y marcas, guarda una plantilla si el rig se va a reutilizar, define la transposicion donde haga falta, ensaya saltos, conecta MIDI y usa el remote movil para transporte o mixer durante ensayo y show.
