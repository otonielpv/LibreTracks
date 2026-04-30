---
title: Routing Y Metronomo
description: Routing a Master, salidas externas y metronomo interno.
---

## Strings De Routing

Las pistas guardan su destino en `audioTo`. El parser del core resuelve rutas comunes:

- `master` y `main` van al par estereo principal.
- `monitor` va a los canales 2-3 si hay al menos cuatro canales de hardware; si no, cae al par principal.
- `ext:0` va al canal fisico 0.
- `ext:2-3` va a un par fisico estereo usando indices externos base cero.

El parser tambien acepta nombres de hardware como `out 1` u `out_1`, convirtiendolos al canal base cero correspondiente.

## Master Vs. Salidas Fisicas

Usa `Master` para playback musical que debe seguir la mezcla principal. Usa salidas externas para material que debe evitar la mezcla principal: click, count-ins, cues habladas o guias.

El panel de ajustes desktop controla que canales de salida estan activos. Luego las cabeceras de pista pueden elegir la ruta.

## Metronomo

LibreTracks incluye un metronomo sintetizado. No necesita importar un archivo de audio separado.

El modelo de ajustes guarda:

- Si el metronomo esta activo.
- Volumen del metronomo.
- Ruta de salida del metronomo.

El runtime de audio aplica estos ajustes de forma independiente al playback de clips, lo que permite mantener el click separado del bus Master.

## Patron De Routing En Vivo

Una configuracion habitual:

- Stems de playback a `Master`.
- Click y cues a una salida externa como `ext:2-3`.
- Metronomo a la misma salida de cue u otro canal dedicado.

Ensaya siempre con la misma interfaz y mapa de canales que usaras en escenario.
