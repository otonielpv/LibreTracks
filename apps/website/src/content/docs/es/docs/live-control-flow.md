---
title: Control en vivo
description: "Cómo moverse por el repertorio en directo con LibreTracks: saltos a marcas y canciones, cuándo ocurren, Vamp, transiciones, atajos de teclado, pedal MIDI y el Remote."
---

En directo casi todo se reduce a tres preguntas: **a dónde** saltas, **cuándo**
ocurre el salto y **cómo** suena el cambio. LibreTracks resuelve las tres igual
desde el teclado, la [Vista Live](/es/docs/live-view/), un pedal MIDI o el
[Remote](/es/docs/remote-control/): todos programan el mismo salto.

## Saltar a una marca

Un clic en una marca de sección (o su tecla numérica) **programa** el salto. El
ajuste *Salto de marca* de la barra de herramientas decide cuándo ocurre:

![Ajustes del salto de marca](/guide/desktop/toolbar-marker-jump-panel.png)

- **Inmediato**: al momento.
- **Tras X compases**: cuando pasan los compases que elijas.
- **En la siguiente marca**: al llegar la siguiente sección, para que el cambio
  caiga al principio de una frase.

Mientras espera, **Cancelar salto** se ilumina; <kbd>Esc</kbd> o un clic en la
misma marca lo anulan. Con la [voz guía](/es/docs/voice-guide/) encendida, la
banda oye la sección de destino y la cuenta de entrada antes del salto.

## Vamp: repetir hasta que haga falta

**Vamp** repite un tramo en bucle mientras la banda alarga un final, alguien
habla o hace falta más tiempo. Elige qué se repite:

![Ajustes de Vamp](/guide/desktop/toolbar-vamp-panel.png)

- **Sección**: la sección en la que está el cursor.
- **Compases**: el número de compases que pongas.

Vuelve a pulsar **Vamp** para salir; la canción sigue desde ahí.

## Pasar a otra canción

Los botones **Anterior** y **Siguiente**, <kbd>Mayús</kbd>+número, la Vista Live
o el Remote saltan de canción. *Transición de canción* decide cuándo y cómo:

![Ajustes de la transición de canción](/guide/desktop/toolbar-song-jump-panel.png)

- **Cuándo**: inmediato, al final de la canción, tras unos compases o en la
  siguiente marca.
- **Cómo**: **Corte limpio** o **Fade out** de la canción que suena.

Si prefieres que la reproducción se pare entre canciones, activa *Pausar al
terminar cada canción* en Configuración › General.

## Atajos

Todos se pueden cambiar en **Configuración › Atajos** (ver
[Configuración](/es/docs/interface/settings/#atajos)). Los de fábrica:

| Tecla | Acción |
| --- | --- |
| <kbd>Espacio</kbd> | Reproducir / pausar |
| <kbd>Mayús</kbd>+<kbd>Espacio</kbd> | Detener (vuelve al principio) |
| <kbd>Inicio</kbd> | Ir al inicio |
| <kbd>0</kbd> … <kbd>9</kbd> | Saltar a la 1.ª … 10.ª marca de la sesión, por orden de tiempo y contando también los avisos (otra vez la misma tecla cancela) |
| <kbd>Mayús</kbd>+<kbd>0</kbd> … <kbd>9</kbd> | Saltar a la canción nº 1 … 10 |
| <kbd>Esc</kbd> | Cancelar un salto pendiente o quitar la selección |
| <kbd>S</kbd> | Cortar los clips seleccionados en el cursor |
| <kbd>Mayús</kbd>+<kbd>S</kbd> | Partir la canción en el cursor |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> | Copiar / pegar clips |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicar |
| <kbd>Supr</kbd> o <kbd>Retroceso</kbd> | Borrar la selección (clips, pistas o canción) |
| <kbd>F2</kbd> | Renombrar la canción, pista o marca seleccionada |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Deshacer |
| <kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>Z</kbd> o <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Rehacer |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Seleccionar todos los clips |
| <kbd>←</kbd> / <kbd>→</kbd> | Desplazar los clips seleccionados una división |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>S</kbd> | Guardar / guardar como |
| <kbd>Tab</kbd> / <kbd>Mayús</kbd>+<kbd>Tab</kbd> | Cambiar de vista: DAW, Compacta, Live (y al revés) |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Agrandar, reducir o restablecer la interfaz |
| <kbd>B</kbd> | Vídeo: negro inmediato |

**Fade out y parar** (apagar la canción con un fundido y parar; ver
[Fade out y parar](/es/docs/interface/main-screen/#fade-out-y-parar)) y las
acciones de vídeo *fundido a negro*, *pantalla de reposo* y *activar salida*
no tienen tecla de fábrica, para que no se disparen sin querer en directo;
asígnalas tú si las usas.

Si programas el salto equivocado, pulsa <kbd>Esc</kbd> enseguida.

## Con un pedal MIDI

Cualquier acción de esta página se puede asignar a un pedal o a un botón de tu
controlador: saltar a la marca 3, siguiente canción, Vamp, cancelar salto…
Ver [MIDI](/es/docs/tasks/midi/).

## Desde el móvil: el Remote

Abre **Remote** en la barra lateral, escanea el QR con el móvil o la tablet
(misma Wi‑Fi) y la banda tiene en la mano el transporte, los saltos, el Vamp,
el tono y la mezcla. Ver [Remote personalizable](/es/docs/remote-control/).

## Cambiar de tono en directo

Haz los cambios de tono **antes de dar a Play** o entre canciones: cambiarlo
mientras suena obliga al motor a recolocar sus voces y, en equipos modestos,
puede producir pequeños cortes. Cómo combinar tono, warp y el botón **T** está
en [Cambio de tono, warp y el botón T](/es/docs/pitch-and-warp/).
