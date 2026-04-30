---
title: Integracion Y Ecosistema
description: Remote, paquetes, portabilidad de proyecto y flujo de trabajo.
---

## Remote Movil

LibreTracks desktop puede publicar un remote web local para moviles y tablets.

Abre `Remote` en la app desktop y escanea el codigo QR. La app tambien muestra URLs locales por IP y hostname `.local`. El movil o tablet debe estar en la misma red local que el ordenador.

El remote expone transporte, saltos de marcador, Vamp, transiciones de cancion y una vista de mixer para volumen, pan, mute y solo.

## Arquitectura Remote

El remote controla estado. No reproduce audio. El audio permanece en el runtime desktop, lo que mantiene el rig predecible y evita la complejidad de dispositivos de audio en navegador.

Los comandos remotos llegan al backend desktop, donde se resuelven mediante la misma logica de sesion y transporte que usa la UI desktop.

## Paquetes LibreTracks

LibreTracks soporta paquetes `.ltpkg` para mover canciones o sesiones preparadas entre contextos.

Usa paquetes cuando quieras:

- Traer otra cancion preparada a la sesion actual.
- Compartir una cancion entre maquinas de ensayo y show.
- Construir un timeline completo a partir de material ya preparado.

La capa de proyecto gestiona la importacion de paquetes y mantiene la persistencia en `song.json` con sus assets de biblioteca.

## Flujo Recomendado

Prepara el audio en una DAW de produccion, exporta stems WAV, importalos en LibreTracks, crea marcas y regiones, configura routing, ensaya los saltos y conecta MIDI y remote para el control del show.
