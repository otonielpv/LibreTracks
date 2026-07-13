---
title: Automatizaciones
description: Una pista de automatización que dispara saltos, mezcla, escenas y cambios completos de Pads en puntos exactos durante la reproducción.
---

La pista de **Automatizaciones** te deja colocar **señales** en el timeline que disparan una o varias acciones en un punto exacto durante la reproducción. Úsala para programar una canción que corra sola: saltar a una sección, quitar una pista, mover un fader, recuperar una escena de mezcla o esperar un instante antes del siguiente movimiento.

Cada señal vive en su propia pista de automatización y se muestra como un diamante en el timeline en el momento en que se dispara.

![Pista de automatización](/screenshots/Automation-Track.png)

## Añadir Una Pista De Automatización

Abre el menú de automatización desde la zona de transporte y elige **Añadir pista de automatización**. Haz clic derecho en cualquier punto del carril (o usa **Crear automatización aquí**) para colocar una nueva señal en esa posición.

## Editar Una Señal

Haz clic izquierdo en el diamante de una señal para abrir el editor; al pasar el cursor por encima verás un resumen rápido de todo lo que hace. Una señal es una pequeña lista ordenada de acciones — pulsa **Añadir acción** para construirla. Acciones disponibles:

- **Saltar a…** — salta a una región de canción, a una marca o a una posición exacta. La transición puede ser instantánea o un fundido de salida de unos segundos. Un salto siempre es la última acción de la señal.
- **Silenciar / activar pista** — activa o desactiva el mute de una pista.
- **Solo / quitar solo de pista** — activa o desactiva el solo de una pista.
- **Volumen / pan** — fija el volumen (0–100) y el pan (L‑100 / R+100) de una pista, con un tiempo de **suavizado** opcional para que el cambio sea gradual en vez de instantáneo.
- **Aplicar escena** — recupera una [escena de mezcla](#escenas-de-mezcla) guardada para reconfigurar varias pistas a la vez.
- **Controlar Pads** — activa o desactiva la voz ambiental y recupera pack, tonalidad, volumen y routing. Los cambios de tono o pack conservan la posición del bucle y usan el mismo crossfade continuo que el control manual. Consulta [Pads de ambiente](/es/docs/ambient-pads/).
- **Esperar** — pausa los segundos indicados antes de que corra la siguiente acción.

![Editor de señal de automatización](/screenshots/Automation-Cue-Editor.gif)

## Repeticiones

Por defecto, una señal se dispara cada vez que el cursor llega a ella. Activa **Limitar repeticiones** para acotar cuántas veces se ejecuta (por ejemplo, tomar un salto solo las dos primeras pasadas). Una señal que ya agotó sus repeticiones se muestra como apagada en el carril.

## Escenas De Mezcla

Una **escena de mezcla** es un conjunto guardado de ajustes por pista — volumen, pan, mute y solo — que puedes aplicar al instante desde una acción **Aplicar escena**. Abre **Gestionar escenas de mezcla…** para crear escenas, nombrarlas y elegir qué pistas controla cada una.

![Escenas de mezcla](/screenshots/Mix-Scenes.gif)

Las escenas son ideales para grandes movimientos de mezcla en un cambio de sección — por ejemplo, bajar la banda a solo click y voz en un breakdown, y restaurar la mezcla completa en la siguiente señal.

## Consejos

- Combina una señal de salto con la [Voz Guía](/es/docs/voice-guide/) para que la sección destino se anuncie y se cuente la entrada antes de que el salto se dispare.
- Usa un **suavizado** corto en los cambios de volumen/pan para evitar clics cuando un fader se mueve durante la reproducción.
- Usa **Controlar Pads** para preparar una modulación o la textura de la siguiente canción sin cortar la cama ambiental.
- Consulta [Control en vivo](/es/docs/live-control-flow/) para armar saltos manualmente desde el transporte, los atajos y el remote.
