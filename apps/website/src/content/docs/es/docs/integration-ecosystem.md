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

## Importar Canciones Y Paquetes

Usa `Import song` desde la seccion superior `Archivo` cuando quieras traer otra cancion o paquete de sesion de LibreTracks a la sesion actual. Es util para construir un show completo desde canciones preparadas sin rehacer pistas, clips, routing y marcas a mano.

## Arquitectura Del Remote Movil

El remote controla estado; no reproduce audio. El audio permanece en el runtime desktop, lo que mantiene el rig de directo predecible y evita la complejidad de dispositivos de audio en navegador.

Los comandos remotos se envian al backend desktop y se resuelven mediante la misma logica de sesion y transporte que usa la UI desktop, los mapeos MIDI y los atajos.

![Superficie remote](/screenshots/Remote.png)

## Flujo Recomendado

Prepara audio en una DAW de produccion, exporta stems, importalos en LibreTracks, organiza Biblioteca, construye el timeline, configura routing de salidas, crea regiones y marcas, ensaya saltos, conecta MIDI y usa el remote movil para transporte o mixer durante ensayo y show.
