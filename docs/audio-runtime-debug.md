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

## Sesiones manuales recomendadas

### 1. Reproduccion inicial

- Abrir un proyecto con varios WAV.
- Lanzar `play`.
- Confirmar que `lastRestart.reason` sea `initial_play`.
- Revisar `scheduledClips`, `activeSinks` y `openedFiles`.

### 2. Mezcla en vivo

- Con la sesion reproduciendo, mover volumen de pista o grupo varias veces.
- Alternar mute rapidamente.
- Confirmar que aumente `commandCount` y que `lastSync` cambie sin que aparezca un nuevo `lastRestart`.

### 3. Seek en caliente

- Ejecutar varios seeks consecutivos durante reproduccion.
- Confirmar que `lastRestart.reason` pase a `seek`.
- Comparar `playhead.estimatedPositionSeconds` frente a `get_transport_snapshot.positionSeconds` para medir el desfase observado.
- Comparar `elapsedMs` entre proyectos pequenos y grandes.

### 4. Saltos musicales

- Programar un salto inmediato.
- Programar un salto a final de seccion.
- Confirmar que el salto inmediato registre `immediate_jump` y que un resync del transporte registre `transport_resync` si hubo reconstruccion.
- Revisar si `playhead.lastStartReason` cambia a `transport_resync` cuando el runtime tiene que rehacerse tras ejecutar un salto en marcha.

### 5. Cambios de timeline

- Mover un clip activo o cercano al cursor.
- Duplicar o borrar un clip.
- Verificar si el restart queda marcado como `timeline_window` o `structure_rebuild`.

## Notas

- El build de escritorio puede requerir un `CARGO_TARGET_DIR` limpio si Tauri reutiliza artefactos de otro repositorio.
- Estas metricas son deliberadamente basicas: sirven para localizar el coste actual antes de profundizar en cache, clock y mezcla incremental.
