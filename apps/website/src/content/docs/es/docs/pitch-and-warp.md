---
title: Pitch, Warp Y El Boton T
description: Como interactuan la transposicion de region, el warp y el toggle T por pista en LibreTracks.
---

LibreTracks separa tres cosas que a menudo se confunden: el **tempo del timeline** (BPM), el **warp de region** y la **transposicion de region** (pitch). El modelo es el mismo que usa Ableton Live, asi que si has usado Warp alli el mapa mental sirve igual.

Esta pagina explica que hace cada control, como interactuan y que esperar en la rejilla del timeline.

## Los Tres Controles

### Tempo Del Timeline (BPM)

El editor de BPM en la barra superior y las marcas de tempo del timeline pertenecen al **timeline**, no a ninguna region ni pista. Definen cuantos beats caben en un segundo del arreglo renderizado.

- Editar el BPM al inicio de la cancion cambia el BPM global.
- Editar el BPM dentro de una zona gobernada por una marca de tempo actualiza esa marca.
- Tap Tempo escribe en cualquiera de los anteriores segun donde este el playhead.

Si cambias el BPM con warp activado en la region, el audio se estira en tiempo para encajar con el nuevo tempo. Si warp esta apagado, el cambio de BPM no afecta al audio existente; solo cambia la rejilla.

![Control de warp](/screenshots/Warp-Control.png)

### Warp De Region

`Warp` es una propiedad de la **region de cancion**. Al activarlo, el motor estira en tiempo cada clip que solape con esa region para que el BPM original del audio (`warp source BPM`) se alinee con el BPM efectivo del timeline.

- Al activar warp, LibreTracks guarda el BPM efectivo actual como `warp source BPM` — es el BPM al que se grabo o exporto el audio.
- La duracion visible de la region pasa a ser `duracion_fuente / (BPM_destino / BPM_fuente)`.
- El pitch se preserva. El warp por si solo no transpone nada.

Warp se implementa con el time-stretcher Bungee y corre dentro del motor de audio. Es exigente con la CPU en sesiones muy cargadas; consulta [Control En Vivo](./live-control-flow) para saber cuando activarlo.

### Transposicion De Region (Pitch)

`Region Transpose` cambia el tono de una region en semitonos, `-12` a `+12`. Su efecto visible depende de si `Warp` esta activo en esa region:

- **Warp off + transposicion ≠ 0 → Varispeed.** El pitch *es* velocidad: como acelerar o ralentizar una cinta, subir el tono acorta la duracion audible, bajarlo la alarga. El clip, la region y todas las marcas posteriores se desplazan para que la rejilla siga siendo coherente.
- **Warp on + transposicion ≠ 0 → Pitch + Warp.** Bungee transpone el pitch manteniendo la duracion fijada por el warp. Puedes cambiar de tono sin cambiar de longitud.

La nota bajo el toggle de warp lo refleja:

> Warp off: el pitch cambia la velocidad.
> Warp on: el pitch preserva la duracion.

## El Toggle T Por Pista

Cada cabecera de pista tiene un boton `T` que activa o desactiva la transposicion **para esa pista**. La semantica depende de si hay warp activo en la region donde esta el playhead:

| Estado de warp     | T activado             | T desactivado                                              |
| ------------------ | ---------------------- | ---------------------------------------------------------- |
| Warp **apagado**   | La pista sigue el pitch | La pista sigue el pitch *(el toggle T se ignora)*          |
| Warp **activado**  | La pista sigue el pitch | La pista ignora el pitch pero sigue el stretch de warp     |

¿Por que se ignora `T desactivado` con warp apagado? Porque bajo varispeed, **el pitch es la duracion**. Si el resto de la cancion se acorta y una pista mantiene su longitud original, se desincroniza al instante. Para que la rejilla sea coherente para todos, una region con pitch sin warp obliga a todas las pistas a seguir el varispeed.

Con warp activado, Bungee desacopla pitch y duracion: una pista con `T desactivado` puede sonar en su tono original y aun asi quedar alineada con el resto sobre la rejilla. Ese es el modo correcto para una pista de click, una guia o cualquier referencia que deba quedarse en su tonalidad grabada mientras el resto del show transpone.

## Tabla De Decision

El motor elige uno de tres caminos de render por clip y por bloque. No lo veras directamente, pero ayuda a explicar lo que oyes:

| Warp     | Pitch | T pista     | Camino de render | Efecto                                        |
| -------- | ----- | ----------- | ---------------- | --------------------------------------------- |
| off      | 0     | cualquiera  | Direct           | Audio original, sin DSP.                      |
| off      | ≠ 0   | activado    | Varispeed        | Cambia el pitch, cambia la duracion.          |
| off      | ≠ 0   | desactivado | Varispeed        | Igual que arriba. `T` se ignora sin warp.     |
| on       | 0     | cualquiera  | Bungee warp      | Duracion segun warp; pitch preservado.        |
| on       | ≠ 0   | activado    | Bungee ambos     | Pitch cambia, duracion la fija el warp.       |
| on       | ≠ 0   | desactivado | Bungee warp      | Sin pitch en esta pista, duracion segun warp. |

## Comportamiento De La Rejilla

`Marcas`, `bordes de region`, `marcas de tempo` y `marcas de metrica` se guardan en **tiempo fuente** (el timeline original del audio). Cuando haces clic en el timeline para crear o mover cualquiera de ellos, LibreTracks convierte tu clic del timeline visible al tiempo fuente para que la marca caiga exactamente donde apuntaste — incluso dentro o despues de una region estirada.

Esto importa cuando tienes varias regiones con distintos ratios de warp o varispeed: el ancho visible de los clips cambia, pero todo lo que coloques queda anclado a la posicion musical, no a segundos brutos.

## Flujo Practico

Para la mayoria de directos el modelo mental mas simple es:

1. Monta la sesion con el BPM grabado del tema y warp apagado.
2. Si la banda pide el tema mas rapido o mas lento sin cambiar el tono, activa `Region Warp` y edita el BPM.
3. Si la banda pide otra tonalidad, cambia `Region Transpose`. Con warp activado es un cambio de tono limpio; con warp apagado tambien acelera o ralentiza.
4. Usa el toggle `T` por pista solo con warp activado, para mantener una pista de click o guia en su tono original mientras el resto sigue la nueva tonalidad.

:::caution[Cambia el tono antes de reproducir]
Cuando es posible, ajusta la transposicion **antes de pulsar Play**. Si cambias el tono mientras la cancion ya esta sonando, el motor tiene que recolocar sus voces en segundo plano, y en equipos modestos eso puede producir pequeños cortes. En directo, hazlo entre canciones o con la reproduccion detenida.
:::
