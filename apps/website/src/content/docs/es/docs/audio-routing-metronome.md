---
title: Routing Y Metronomo
description: Dispositivo de audio, salidas externas, rutas por pista, metronomo y MIDI.
---

## Dispositivo De Audio

Abre `Configuracion`, elige el `Dispositivo de audio` correcto y verifica la salida antes del ensayo y antes del show. `Predeterminado del sistema` sigue la salida del sistema operativo, pero una interfaz dedicada suele ser mas segura para directo.

![Configuracion de audio](/screenshots/Configuracion-Audio.gif)

## Salidas Hardware

Activa las salidas fisicas que quieras usar en `Configuracion > Audio`. Desde la cabecera de cada pista puedes rutear a `Master` o directamente a destinos `Ext. Out` mono o estereo.

![Menu de routing de pista](/screenshots/Track-Audio-Route.png)

Routing habitual:

- Stems y playback musical a `Master`.
- Click, count-ins, cues habladas o guias a una salida externa de cue.
- Salidas de cue independientes del fader de Master.

## Rutas Internas

Internamente, las pistas guardan su destino en `audioTo`.

- `master` y `main` van al par estereo principal.
- `monitor` va a canales 2-3 si hay al menos cuatro canales hardware; si no, vuelve al par principal.
- `ext:0` va al canal fisico 0.
- `ext:2-3` va a un par estereo fisico usando indices externos desde cero.

## Metronomo

LibreTracks incluye metronomo integrado, asi que no hace falta importar un archivo de click. Activa `Metronomo` desde la barra superior y despues elige salida y volumen en ajustes.

![Activar metronomo](/screenshots/Activate-Click.png)

![Configuracion de metronomo](/screenshots/Click-Config.png)

## Hardware MIDI

Elige un `Dispositivo de entrada MIDI` en `Configuracion`. Usa `Refrescar dispositivos MIDI` si conectaste el controlador despues de abrir la app.

`MIDI Learn` asigna notas o mensajes CC a controles de directo como `Play`, `Stop`, `Vamp`, modos de salto de marca, disparadores de salto de cancion, modo de transicion y controles de numero de compases.

![Configuracion MIDI](/screenshots/Midi-Config.gif)
