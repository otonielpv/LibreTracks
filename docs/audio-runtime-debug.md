# Audio Runtime Debug

## Objetivo

Esta guia deja una base reproducible para medir el runtime de audio desktop mientras avanzamos el plan de `PLAN_DESARROLLO_MOTOR_AUDIO.md`.

## Variables de entorno

- `LIBRETRACKS_AUDIO_DEBUG=1`
  Activa el resumen interno de metricas del runtime.
- `LIBRETRACKS_AUDIO_LOG_COMMANDS=1`
  Registra en stderr los comandos que recibe el hilo de audio.

Se pueden combinar:

```powershell
$env:LIBRETRACKS_AUDIO_DEBUG="1"
$env:LIBRETRACKS_AUDIO_LOG_COMMANDS="1"
```

## Snapshot de depuracion

El runtime desktop expone el comando Tauri `get_audio_debug_snapshot`.

Campos clave:

- `commandCount`: numero de comandos procesados por el hilo de audio.
- `lastCommand`: ultimo comando recibido y su razon si aplica.
- `lastRestart`: tiempo del ultimo restart, clips programados, sinks activos y archivos abiertos.
- `lastSync`: tiempo del ultimo ajuste incremental de mezcla.
- `lastStop`: tiempo y numero de sinks detenidos.
- `playhead`: estimacion interna del playhead vista desde el hilo de audio.
  Incluye `running`, `anchorPositionSeconds`, `estimatedPositionSeconds`, `songDurationSeconds`, `anchorAgeMs` y `lastStartReason`.
  No es sample-accurate, pero sirve para comparar el runtime con el snapshot del transporte desktop y detectar desfases.
- `runtimeState`: estado resumido del runtime tras la ultima operacion relevante.
  Incluye `cachedAudioBuffers` para ver cuantas fuentes siguen preparadas en memoria para el proyecto actual.

## Snapshot de transporte

El comando Tauri `get_transport_snapshot` ahora devuelve `lastDriftSample` cuando ya se registro una muestra relevante.

Campos clave:

- `event`: evento que capturo la muestra. Hoy cubre `play`, `seek`, `jump` y `song_end`.
- `transportPositionSeconds`: posicion estimada por el reloj desktop.
- `enginePositionSeconds`: posicion logica del `AudioEngine`.
- `runtimeEstimatedPositionSeconds`: posicion estimada por el runtime si estaba disponible.
- `transportMinusEngineSeconds`: diferencia firmada entre reloj desktop y engine.
- `runtimeMinusTransportSeconds`: diferencia firmada entre runtime y reloj desktop.
- `runtimeMinusEngineSeconds`: diferencia firmada entre runtime y engine.
- `maxObservedDeltaSeconds`: mayor desviacion absoluta observada entre las referencias disponibles para esa muestra.

La muestra se conserva en el snapshot hasta que otro evento clave la reemplace o se cargue una nueva cancion.

## Sesiones manuales recomendadas

### 1. Reproduccion inicial

- Abrir un proyecto con varios WAV.
- Lanzar `play`.
- Confirmar que `lastRestart.reason` sea `initial_play`.
- Revisar `scheduledClips`, `activeSinks` y `openedFiles`.
- Revisar `get_transport_snapshot.lastDriftSample.event == "play"`.

### 2. Mezcla en vivo

- Con la sesion reproduciendo, mover volumen de pista o grupo varias veces.
- Alternar mute rapidamente.
- Confirmar que aumente `commandCount` y que `lastSync` cambie sin que aparezca un nuevo `lastRestart`.

### 3. Seek en caliente

- Ejecutar varios seeks consecutivos durante reproduccion.
- Confirmar que `lastRestart.reason` pase a `seek`.
- Comparar `playhead.estimatedPositionSeconds` frente a `get_transport_snapshot.lastDriftSample.runtimeEstimatedPositionSeconds` y `positionSeconds`.
- Comparar `elapsedMs` entre proyectos pequenos y grandes.

### 4. Saltos musicales

- Programar un salto inmediato.
- Programar un salto a final de seccion.
- Confirmar que el salto inmediato registre `immediate_jump` y que un resync del transporte registre `transport_resync` si hubo reconstruccion.
- Revisar si `playhead.lastStartReason` cambia a `transport_resync` cuando el runtime tiene que rehacerse tras ejecutar un salto en marcha.
- Confirmar que `get_transport_snapshot.lastDriftSample.event == "jump"` despues de ejecutar el salto.

### 5. Cambios de timeline

- Mover un clip activo o cercano al cursor.
- Duplicar o borrar un clip.
- Verificar si el restart queda marcado como `timeline_window` o `structure_rebuild`.

## Umbrales operativos provisorios para desktop

Mientras sigamos sobre `rodio` y coordinacion desktop, tomamos estos umbrales como referencia practica:

- `transportMinusEngineSeconds`: idealmente <= `0.005` s. Si supera `0.010` s, hay un problema de reanclaje local.
- `runtimeMinusTransportSeconds` y `runtimeMinusEngineSeconds`: aceptables hasta `0.020` s en eventos normales de `play`, `seek` y `jump`.
- `maxObservedDeltaSeconds`: vigilar entre `0.020` s y `0.050` s. Por encima de `0.050` s ya es desfase perceptible en desktop y debe investigarse.
- `song_end`: se admite una muestra final con runtime ya parado, pero la posicion estimada del runtime deberia quedar cerca del final de la cancion antes de reiniciar el transporte a `0`.

Estos umbrales no pretenden ser sample-accurate. Sirven para decidir si la ruta actual sigue siendo operativamente aceptable o si la Fase 6 necesita acelerar una migracion de backend.

## Bateria automatizada actual

La cobertura automatizada relevante para el motor queda repartida entre:

- `cargo test -p libretracks-audio`
  Valida transporte logico, secciones, cuantizacion, saltos y ganancias efectivas.
- `cargo test -p libretracks-desktop`
  Valida coordinacion desktop, reloj de transporte, persistencia y regresiones de snapshots.

Escenarios de regresion ya cubiertos:

- reloj de transporte pausado vs en marcha
- seek que no acumula tiempo anterior
- seek repetido durante reproduccion
- salto pendiente que caduca tras cambios `TransportOnly`
- salto ejecutado que reancla transporte y runtime
- limpieza correcta al llegar al final de la cancion
- mezcla incremental y coalescencia de `sync_song`

## Objetivo operativo actual

Mientras el backend siga siendo `rodio` mas coordinacion desktop, el objetivo realista es:

- no introducir reinicios globales para cambios `MixOnly`
- mantener `play`, `pause`, `stop`, `seek` y saltos en estados consistentes
- usar `playhead.estimatedPositionSeconds`, `positionSeconds` y `lastDriftSample` del transporte para detectar desfases antes de redisenar el backend
- reservar un mixer propio por bloques para el momento en que las metricas y pruebas de estres demuestren que la ruta actual ya no alcanza

## Notas

- El build de escritorio puede requerir un `CARGO_TARGET_DIR` limpio si Tauri reutiliza artefactos de otro repositorio.
- Estas metricas son deliberadamente basicas: sirven para localizar el coste actual antes de profundizar en cache, clock y mezcla incremental.
