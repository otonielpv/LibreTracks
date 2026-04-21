# Import Performance Debug

## Objetivo

Dejar una forma reproducible de medir el coste real de:

- importar varios WAV
- abrir una sesion pesada
- hacer polling del transporte en idle
- comprobar si las waveforms vuelven a tocar disco o no

## Fixture de estres

Genera 8 pistas WAV largas con:

```powershell
node .\scripts\generate-stress-wavs.mjs --out .\samples\stress-import --tracks 8 --seconds 150
```

Parametros utiles:

- `--tracks 8`
- `--seconds 150`
- `--sample-rate 44100`
- `--channels 2`

El script escribe WAV PCM 16-bit en streaming para no depender de assets versionados enormes.

## Instrumentacion disponible

### Desktop perf snapshot

El backend desktop expone `get_desktop_performance_snapshot`.

Campos clave:

- `copyMillis`
- `wavAnalysisMillis`
- `waveformWriteMillis`
- `songSaveMillis`
- `transportSnapshotBuildMillis`
- `songViewBuildMillis`
- `waveformCacheHits`
- `waveformCacheMisses`
- `transportSnapshotBytes`
- `songViewBytes`
- `lastReactRenderMillis`
- `cachedWaveforms`

### Audio runtime snapshot

Sigue disponible `get_audio_debug_snapshot` para tiempos del runtime nativo, reinicios y estado del playhead.

## Bateria manual recomendada

### 1. Importacion

- Arrancar desktop.
- Importar los WAV generados desde `samples/stress-import`.
- Anotar `copyMillis`, `wavAnalysisMillis`, `waveformWriteMillis` y `songSaveMillis`.

### 2. Primera carga visual

- Nada mas terminar la importacion, pedir `get_desktop_performance_snapshot`.
- Confirmar que `songViewBytes` es claramente mayor que `transportSnapshotBytes`.
- Confirmar que `cachedWaveforms` coincide con el numero de clips importados.

### 3. Idle polling

- Dejar la sesion abierta 10 segundos sin tocar nada.
- Comprobar que `waveformCacheMisses` no sigue creciendo.
- Confirmar que el payload de `get_transport_snapshot` se mantiene pequeno via `transportSnapshotBytes`.

### 4. Reproduccion

- Pulsar `Play`.
- Revisar `get_audio_debug_snapshot` y confirmar `lastRestart.reason = initial_play`.
- Durante reproduccion, seguir consultando `get_desktop_performance_snapshot` y confirmar que no suben los misses de waveform.

## Criterio esperado

- `get_transport_snapshot` ya no arrastra la cancion completa ni las waveforms.
- las waveforms se cargan una vez por revision de proyecto
- el polling idle no provoca lecturas nuevas de waveform
- la importacion paga copia + analisis + escritura una sola vez por archivo
