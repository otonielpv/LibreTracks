---
title: Control En Vivo
description: Saltos, Vamp, transiciones, MIDI y remote.
---

## Logica De Saltos A Marcador

LibreTracks soporta tres disparadores de salto:

- `Immediate` salta en cuanto se acepta el comando.
- `Next Marker` espera al siguiente limite de seccion.
- `After X Bars` planifica el salto en un limite musical usando tempo y compas.

Esta es una diferencia central frente a configurar una DAW tradicional con acciones o macros. El salto es comportamiento nativo del transporte y esta disponible desde desktop, MIDI, atajos y remote.

Los saltos pendientes pueden cancelarse antes de ejecutarse.

## Vamp

Vamp mantiene el playback en bucle mientras la banda, la escena o una intervencion necesita mas tiempo.

LibreTracks soporta dos modos:

- `Section` repite la seccion actual.
- `Bars` repite un numero fijo de compases.

Pulsar Vamp de nuevo sale del bucle. El estado activo de Vamp forma parte del snapshot de playback para mantener sincronizados desktop y remote.

## Saltos De Cancion

Los saltos de cancion apuntan a song regions. Son utiles cuando un timeline contiene un set completo, una sesion de ensayo o varios cues de show.

Los controles actuales soportan saltos inmediatos, saltos tras un numero configurado de compases y saltos al final de la region actual.

## Transiciones De Cancion

El modo de transicion controla como pasa el playback entre regiones:

- `Clean cut` cambia directamente.
- `Fade out` desvanece el playback actual antes de la transicion.

Usa clean cuts para paradas duras o cues teatrales ensayados. Usa fade-outs cuando la siguiente region debe entrar con un traspaso mas suave.

## MIDI Learn

MIDI Learn asigna notas o mensajes CC a acciones en vivo. Mapeos practicos incluyen Play, Stop, saltos de marcador, saltos de cancion, Vamp, modo global de salto, transicion de cancion y ajuste de compases.

Los ajustes desktop guardan el dispositivo MIDI seleccionado y los mapeos para preparar el rig antes del ensayo.
