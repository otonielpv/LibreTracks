---
title: Conceptos Base
description: Pistas, marcas, tempo, compases y regiones de cancion en LibreTracks.
---

## Audio Tracks Y Folder Tracks

LibreTracks tiene dos tipos de pista en el modelo:

- `Audio` contiene clips y produce playback.
- `Folder` organiza pistas hijas y permite control agrupado.

Usa pistas de audio para stems, cues, count-ins y archivos de playback. Usa folder tracks cuando varias pistas pertenecen juntas, por ejemplo bateria, stems de banda, coro, backing vocals o cues del show.

Las folder tracks participan en el calculo de mezcla efectiva. Las relaciones padre/hijo permiten resolver ganancia, mute y solo agrupados sin que la UI tenga que poseer las reglas de audio.

## Clips Y Edicion No Destructiva

Cada clip apunta a un archivo fuente y guarda posicion en timeline, offset de fuente, duracion, ganancia y fades opcionales. Un corte crea nuevas referencias al mismo WAV. Un movimiento cambia posicion. Un duplicado crea otra referencia.

El WAV fuente no se reescribe con operaciones de cortar, mover o duplicar.

## Section Markers

Las section markers definen destinos musicales en el timeline: Intro, Verse, Chorus, Bridge, Vamp, Outro y puntos similares. El modelo soporta un campo opcional `digit` para atajos numericos.

En la build desktop actual, los atajos `0-9` se resuelven por orden de marca en el timeline. El modelo ya soporta digitos explicitos, pero la UI aun no expone un control dedicado para asignarlos.

## Tempo Markers

Una cancion tiene BPM base y puede contener tempo markers. El tempo permite al transporte calcular limites de compas para saltos cuantizados y Vamp.

Los cambios de tempo se guardan como datos de marca en vez de inferirse del contenido de los clips durante el playback.

## Time Signature Markers

Las canciones tambien tienen un compas base y time signature markers opcionales. Estas marcas afectan los calculos de rejilla musical y hacen que las operaciones por compases funcionen correctamente cuando cambia la metrica.

## Song Regions

Las song regions definen rangos con nombre en un unico timeline. Asi una sesion puede contener varias canciones o bloques de show sin forzar cada cancion a un proyecto separado.

Las regiones se usan en los controles de salto de cancion, incluyendo moverse a otra region al instante, tras un numero de compases o al final de la region actual.
