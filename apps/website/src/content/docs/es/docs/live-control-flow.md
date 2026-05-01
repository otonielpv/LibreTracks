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

- `Space`: alterna `Play` / `Pause`
- `Esc`: cancela un salto pendiente
- `0-9`: arma un salto a la marca correspondiente
- `Shift + 0-9`: arma un salto a la region de cancion seleccionada

Si armas el destino equivocado, pulsa `Esc` inmediatamente.

## Remote Movil

Abre `Remote` en la app desktop y escanea el codigo QR o abre la URL mostrada desde un movil o tablet en la misma red local.

![Panel de conexion remote](/screenshots/Remote.png)

El remote incluye transporte, saltos de marca, saltos de cancion, Vamp, modo de transicion y una vista de mixer para volumen, paneo, mute y solo.

![Mixer remote](/screenshots/Remote_Mixer.png)
