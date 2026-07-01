---
title: Control En Vivo
description: Saltos de marca, Vamp, saltos de cancion, transiciones, atajos y remote.
---

## Modos De Salto De Marca

LibreTracks soporta tres comportamientos de salto:

- `Immediate`: salta al instante.
- `At next marker`: espera al siguiente limite de seccion.
- `After X bars`: programa el salto tras el numero de compases configurado.

Es comportamiento nativo del transporte, asi que la misma logica esta disponible desde desktop, atajos, mapeos MIDI y remote.

![Modos de salto de marca](/screenshots/Marker-Jump-Modes.png)

Con la [Voz Guia](./voice-guide) activada, un salto armado a una marca con tipo se anuncia y se cuenta antes de ejecutarse, para que la banda oiga la seccion destino y entre junta en el downbeat.

## Vamp

`Vamp` mantiene la reproduccion en un bucle musical mientras la banda, la accion de escenario o una intervencion necesita mas tiempo. `Vamp Mode` puede repetir la `Section` actual o un numero fijo de `Bars`. Pulsa `Vamp` de nuevo para salir.

![Configuracion de Vamp](/screenshots/Vamp-Config.png)

## Saltos De Cancion Y Transiciones

Los saltos de cancion apuntan a regiones de cancion. Son utiles cuando una sesion contiene un set completo, una sesion de ensayo o varios cues.

El disparador puede ser inmediato, tras un numero de compases o al final de la cancion/region actual.

`Song Transition` controla como pasa la cancion actual a la siguiente:

- `Clean cut`: cambia directamente.
- `Fade out`: desvanece la reproduccion actual antes del salto.

![Configuracion de saltos de cancion](/screenshots/Song-Jump-Config.png)

## Atajos

La mayoria de atajos del timeline se pueden reasignar desde `Configuracion` -> `Atajos`. El panel agrupa acciones por transporte, edicion, proyecto, vista y navegacion, y permite editar, quitar o restaurar bindings sin tocar un archivo de configuracion.

Atajos por defecto utiles:

- `Space`: alterna `Play` / `Pause`
- `Shift + Space`: detener
- `Home`: ir al inicio
- `S`: partir el clip o los clips seleccionados en el playhead
- `Shift + S`: partir la cancion bajo el playhead
- `Delete`: borrar la seleccion actual, incluida una region de cancion seleccionada
- `F2`: renombrar la cancion, pista o marca seleccionada
- `Ctrl + C` / `Ctrl + V` / `Ctrl + D`: copiar, pegar y duplicar
- `Ctrl + A`: seleccionar todos los clips
- `Left` / `Right`: desplazar clips seleccionados una subdivision de snap
- `Esc`: cancelar un salto pendiente o limpiar la seleccion
- `0-9`: arma un salto a la marca correspondiente
- `Shift + 0-9`: arma un salto a la region de cancion seleccionada

Si armas el destino equivocado, pulsa `Esc` inmediatamente.

## Transposicion Y Warp En Vivo

`Region Transpose`, `Region Warp` y el toggle `T` por pista deciden como suena cada clip y como se desplaza la rejilla del timeline. La interaccion entre los tres sigue el modelo de Ableton Live — consulta [Pitch, Warp y el boton T](./pitch-and-warp) para la tabla de decision completa y el comportamiento de la rejilla.

En directo, la regla practica:

- Cambia de tonalidad entre canciones o con la reproduccion detenida cuando puedas — recolocar el pitch en pleno playback puede generar picos breves de CPU en equipos modestos.
- Activa `Region Warp` cuando la banda pida cambio de tempo sin cambio de tono, o cuando necesites cambios de pitch que preserven la duracion del clip.
- Usa el toggle `T` por pista solo con warp activado, para mantener una pista de click o guia en su tono original mientras el resto del tema transpone.

## Remote Movil

Abre `Remote` en la app desktop y escanea el codigo QR o abre la URL mostrada desde un movil o tablet en la misma red local.

![Panel de conexion remote](/screenshots/Remote.png)

El remote incluye transporte, saltos de marca, saltos de cancion, Vamp, modo de transicion, navegacion entre regiones, controles de transposicion y una vista de mixer para volumen, paneo, mute y solo.

La vista de mixer ahora se comporta mas como una superficie util de directo: mantiene el movimiento de volumen y paneo fluido mientras arrastras, muestra medidores por pista, ofrece una accion rapida para centrar el paneo y replica la agrupacion por color de las carpetas para identificar grupos mejor desde el movil.

![Mixer remote](/screenshots/Remote_Mixer.png)
