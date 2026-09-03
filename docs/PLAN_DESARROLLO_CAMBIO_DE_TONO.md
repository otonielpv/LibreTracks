# Plan completo: transposición real de audio por canción/región

## Objetivo de la feature

Permitir que el usuario pueda **transponer el audio real** de una canción/región por semitonos desde la app desktop y desde la app remote, manteniendo el tempo original, con baja latencia, persistencia en proyecto/exportación/importación y feedback visual claro.

La base del repo encaja bien con este diseño porque ya existen `SongRegion`, `Track`, `SongView`, comandos remote y un runtime de audio con `PlaybackClipPlan` y readers de clips. Actualmente `SongRegion` solo contiene `id`, `name`, `start_seconds` y `end_seconds`, y `Track` no tiene aún una opción para participar o no en la transposición. 

---

# Decisiones de producto cerradas

## 1. Unidad de transposición

La transposición se aplica por **región/canción**, usando `SongRegion`.

```text
SongRegion.transpose_semitones
```

Rango permitido:

```text
-12 .. +12
```

No habrá un “tono global” por ahora. Cada región tendrá su propio valor.

## 2. Control desde remote

La app remote solo podrá cambiar el tono si hay una región seleccionada.

```text
Si no hay región seleccionada:
- no se cambia nada
- se muestra algo como "Selecciona una canción/región para cambiar el tono"
```

Si la región seleccionada es la que está sonando, el cambio debe aplicarse **inmediatamente**.

## 3. Persistencia

El tono debe persistir en:

```text
- guardado normal de canción/proyecto
- exportación de canción/región
- importación de canción/región
```

El código actual ya guarda el `Song` completo dentro de `SongDocument`, llamando a `validate_song(song)` y serializando el modelo con `serde_json`, así que añadir el campo al modelo persistente es la ruta correcta. 

## 4. Opción por pista para no transponer

No se hará detección automática por nombre.

Cada pista tendrá una opción explícita:

```text
Track.transpose_enabled: bool
```

Regla:

```text
true  → la pista se transpone si la región tiene transpose_semitones != 0
false → la pista nunca se transpone
```

Default para proyectos antiguos:

```text
true
```

Esta opción también debe persistirse en exportación/importación.

## 5. DSP

No implementaremos un pitch-shifter propio desde cero en v1.

Se implementará una abstracción propia y se usará una librería externa como backend inicial, preferiblemente **Signalsmith Stretch**, porque está pensada para pitch/time stretching y existe como librería C++11/header-only con wrappers Rust disponibles. ([GitHub][1])

Arquitectura:

```text
LibreTracks audio runtime
        ↓
PitchShiftEngine trait
        ↓
Signalsmith backend
```

Así el runtime queda desacoplado del algoritmo concreto.

---

# PR 1 — Modelo persistente, validación y compatibilidad legacy

## Objetivo

Añadir los datos necesarios al modelo principal sin tocar todavía el DSP.

## Cambios en `crates/libretracks-core/src/model.rs`

Añadir a `SongRegion`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongRegion {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,

    #[serde(default)]
    pub transpose_semitones: i32,
}
```

Añadir a `Track`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub parent_track_id: Option<String>,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,

    #[serde(default = "default_true")]
    pub transpose_enabled: bool,

    #[serde(default = "default_audio_to", alias = "outputBusId")]
    pub audio_to: String,
}

fn default_true() -> bool {
    true
}
```

## Validación

En `crates/libretracks-core/src/validation.rs`:

```rust
pub const MIN_TRANSPOSE_SEMITONES: i32 = -12;
pub const MAX_TRANSPOSE_SEMITONES: i32 = 12;
```

Validar todas las regiones:

```rust
if region.transpose_semitones < MIN_TRANSPOSE_SEMITONES
    || region.transpose_semitones > MAX_TRANSPOSE_SEMITONES
{
    return Err(ValidationError::InvalidRegionTranspose {
        region_id: region.id.clone(),
        transpose_semitones: region.transpose_semitones,
    });
}
```

## Migraciones legacy

Actualizar migraciones antiguas.

En `migrate_v3_song`, ahora se crea una región manualmente; debe incluir:

```rust
transpose_semitones: 0,
```

Actualmente esa migración crea `SongRegion` desde el título y la duración del documento antiguo, así que este punto es obligatorio para que compile y para mantener compatibilidad. 

## Tests PR 1

Añadir tests:

```text
- SongRegion legacy sin transpose_semitones deserializa como 0.
- Track legacy sin transpose_enabled deserializa como true.
- transpose_semitones = -12 es válido.
- transpose_semitones = +12 es válido.
- transpose_semitones = -13 falla.
- transpose_semitones = +13 falla.
```

---

# PR 2 — SongView, modelos TypeScript y API compartida

## Objetivo

Exponer los nuevos campos a desktop y remote.

Actualmente `SongView` expone `regions` y `tracks`, pero `SongRegionSummary` no incluye transposición y `TrackSummary` no incluye `transpose_enabled`. 

## Cambios Rust

En `apps/desktop/src-tauri/src/models/view.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRegionSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub transpose_semitones: i32,
}
```

En `TrackSummary`:

```rust
pub transpose_enabled: bool,
```

Actualizar los mappers de `Song -> SongView`.

## Cambios TypeScript

En `packages/shared/src/models.ts`:

```ts
export type SongRegionSummary = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  transposeSemitones: number;
};

export type TrackSummary = {
  id: string;
  name: string;
  kind: string;
  parentTrackId?: string | null;
  depth: number;
  hasChildren: boolean;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  audioTo: string;
  transposeEnabled: boolean;
};
```

Helper compartido:

```ts
export function formatTransposeSemitones(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : `${value}`;
}
```

---

# PR 3 — Comandos desktop para editar transposición

## Objetivo

Permitir editar:

```text
- transpose_semitones de una región
- transpose_enabled de una pista
```

## Comando para región

En `apps/desktop/src-tauri/src/commands/timeline.rs`:

```rust
#[tauri::command]
pub fn update_song_region_transpose(
    region_id: String,
    transpose_semitones: i32,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    state
        .with_session(|session, audio| {
            session.update_song_region_transpose(&region_id, transpose_semitones, audio)
        })
        .map_err(|error| error.to_string())
}
```

En `DesktopSession`:

```rust
pub fn update_song_region_transpose(
    &mut self,
    region_id: &str,
    transpose_semitones: i32,
    audio: &AudioController,
) -> Result<TransportSnapshot, DesktopError> {
    validate_transpose_semitones(transpose_semitones)?;

    let mut song = self
        .engine
        .song()
        .cloned()
        .ok_or(DesktopError::NoSongLoaded)?;

    let region = song
        .regions
        .iter_mut()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

    region.transpose_semitones = transpose_semitones;

    self.persist_song_update(
        song,
        audio,
        AudioChangeImpact::TransportOnly,
        true,
    )?;

    Ok(self.snapshot())
}
```

En la primera fase puede usar `TransportOnly`; cuando el DSP esté listo, el mismo método debe notificar al audio runtime.

## Comando para pista

```rust
#[tauri::command]
pub fn update_track_transpose_enabled(
    track_id: String,
    transpose_enabled: bool,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    state
        .with_session(|session, audio| {
            session.update_track_transpose_enabled(&track_id, transpose_enabled, audio)
        })
        .map_err(|error| error.to_string())
}
```

## Wrappers TS

En `apps/desktop/src/features/transport/desktopApi.ts`:

```ts
export async function updateSongRegionTranspose(
  regionId: string,
  transposeSemitones: number,
): Promise<TransportSnapshot> {
  return invokeCommand("update_song_region_transpose", {
    regionId,
    transposeSemitones,
  });
}

export async function updateTrackTransposeEnabled(
  trackId: string,
  transposeEnabled: boolean,
): Promise<TransportSnapshot> {
  return invokeCommand("update_track_transpose_enabled", {
    trackId,
    transposeEnabled,
  });
}
```

---

# PR 4 — UI desktop

## Objetivo

Añadir edición y feedback visual en la aplicación desktop.

## Timeline

En la renderización de regiones, mostrar badge si:

```ts
region.transposeSemitones !== 0
```

Ejemplo visual:

```text
Intro
+2 st
```

o:

```text
Intro  +2
```

Archivos probables:

```text
apps/desktop/src/features/transport/Renderer/drawBackground.ts
apps/desktop/src/features/transport/Renderer/drawForeground.ts
apps/desktop/src/features/transport/CanvasTimeline.tsx
apps/desktop/src/features/transport/TimelineToolbar.tsx
apps/desktop/src/features/transport/TimelineTopbar.tsx
```

## Toolbar / Topbar

Cuando haya región seleccionada:

```text
Transpose: [-]  +2  [+]  Original
```

Reglas:

```text
- Botón - decrementa hasta -12.
- Botón + incrementa hasta +12.
- Original pone 0.
- Si no hay región seleccionada, controles deshabilitados.
```

## Track header

En cada pista, añadir toggle:

```text
Transponer: Sí / No
```

O compacto:

```text
♪ On / Off
```

Tooltip recomendado:

```text
Esta pista se verá afectada por los cambios de tono de la región.
```

Si está desactivado:

```text
Esta pista no se transpondrá aunque la canción/región cambie de tono.
```

## i18n

Añadir textos en español e inglés:

```ts
transpose: "Transpose" / "Transponer"
transposeEnabled: "Transpose enabled" / "Transposición activada"
transposeDisabled: "Transpose disabled" / "Transposición desactivada"
original: "Original" / "Original"
semitones: "Semitones" / "Semitonos"
selectRegionToTranspose: "Select a region to transpose" / "Selecciona una región para cambiar el tono"
```

---

# PR 5 — Remote: comando y UI de cambio en caliente

## Objetivo

Permitir cambiar la transposición desde la app remote, solo sobre la región seleccionada.

El sistema remote ya tiene `RemoteCommand`, incluyendo saltos a región y comandos live de mezcla, así que el patrón a seguir es añadir un nuevo comando serializable. 

## Comando remote

En `crates/libretracks-remote/src/lib.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RemoteCommand {
    // existentes...

    UpdateRegionTranspose {
        region_id: String,
        transpose_semitones: i32,
    },
}
```

Payload esperado:

```json
{
  "cmd": "updateRegionTranspose",
  "regionId": "region_bridge",
  "transposeSemitones": 2
}
```

## Bridge desktop

En `apps/desktop/src-tauri/src/remote.rs`, dentro de `run_remote_command_bridge`:

```rust
RemoteCommand::UpdateRegionTranspose {
    region_id,
    transpose_semitones,
} => {
    session.update_song_region_transpose_live(
        region_id,
        *transpose_semitones,
        &state.audio,
    )
}
```

El remote poller ya publica `transportSnapshot` y `songView` cuando cambia `project_revision`, por lo que la ruta live debe incrementar revisión y producir actualización visual remota. 

## UI remote

En `apps/remote/src/App.tsx`:

```tsx
if (!selectedRegion) {
  return <p>Selecciona una canción/región para cambiar el tono.</p>;
}
```

Controles:

```tsx
<button disabled={value <= -12} onClick={() => changeTranspose(value - 1)}>
  -1
</button>

<span>{formatTransposeSemitones(value)}</span>

<button disabled={value >= 12} onClick={() => changeTranspose(value + 1)}>
  +1
</button>

<button onClick={() => changeTranspose(0)}>
  Original
</button>
```

Importante:

```text
- No cambiar automáticamente la región actual si no está seleccionada.
- Si hay región seleccionada y está sonando, el cambio aplica inmediatamente.
- Remote no edita Track.transpose_enabled en v1.
```

---

# PR 6 — Exportación/importación de canción/región

## Objetivo

Que `transpose_semitones` y `transpose_enabled` viajen correctamente en paquetes/exportaciones/importaciones.

El repo ya tiene un flujo `export_region_as_package` que construye un manifest con `tracks`, `clips`, markers y metadatos. También importa ese manifest y reconstruye tracks, clips y una nueva región importada. 

## Export

En `crates/libretracks-project/src/package.rs`, al construir el manifest:

```rust
let manifest = SongPackageManifest {
    song_title: region.name.clone(),
    base_bpm: song.bpm,
    base_time_signature: song.time_signature.clone(),
    duration_seconds: region_duration,
    region_transpose_semitones: region.transpose_semitones,
    tracks,
    clips: clips.clone(),
    section_markers,
    tempo_markers,
    time_signature_markers,
    library_meta,
};
```

Añadir al manifest:

```rust
#[serde(default)]
region_transpose_semitones: i32,
```

Los tracks se clonan desde el song original, así que si `Track` ya tiene `transpose_enabled`, el export debe conservarlo automáticamente. Aun así, debe añadirse test explícito.

## Import

Actualmente el import reconstruye pistas copiando campos concretos y fuerza `audio_to: "master"`. Al añadir `transpose_enabled`, debe copiarse también desde el track del manifest. 

Cambiar a:

```rust
next_song.tracks.push(Track {
    id: track_id.clone(),
    name: track.name.clone(),
    kind: track.kind,
    parent_track_id: None,
    volume: track.volume,
    pan: track.pan,
    muted: false,
    solo: false,
    transpose_enabled: track.transpose_enabled,
    audio_to: "master".to_string(),
});
```

Cuando se cree la región importada, ahora debe preservar el tono exportado. Actualmente crea una `SongRegion` nueva con `id`, `name`, `start_seconds` y `end_seconds`; ahí debe añadirse `transpose_semitones`. 

```rust
next_song.regions.push(SongRegion {
    id: format!("region_import_{}", timestamp_suffix()),
    name: manifest.song_title.clone(),
    start_seconds: insert_at_seconds,
    end_seconds: insert_at_seconds + manifest.duration_seconds,
    transpose_semitones: manifest.region_transpose_semitones,
});
```

## Validación

Al importar:

```text
- si region_transpose_semitones falta → 0
- si está fuera de -12..+12 → error claro
- si track.transpose_enabled falta → true
```

## Tests PR 6

```text
- Export/import conserva región +2.
- Export/import conserva región -5.
- Export/import conserva región 0.
- Export/import conserva Track.transpose_enabled = false.
- Export/import conserva Track.transpose_enabled = true.
- Manifest legacy sin region_transpose_semitones importa como 0.
- Manifest legacy sin track.transpose_enabled importa como true.
- Manifest corrupto con +13 falla.
- Manifest corrupto con -13 falla.
```

---

# PR 7 — Audio runtime: transportar la intención de pitch al plan de reproducción

## Objetivo

Hacer que el motor de audio sepa qué transposición aplicar a cada clip.

Actualmente `PlaybackClipPlan` contiene `clip_id`, `track_id`, `file_path`, `clip_gain`, `timeline_start_frame`, `duration_frames`, fades y `source_start_seconds`, pero no tiene información de pitch. 

Añadir:

```rust
pub(crate) transpose_semitones: i32,
```

Resultado:

```rust
pub(crate) struct PlaybackClipPlan {
    pub(crate) clip_id: String,
    pub(crate) track_id: String,
    pub(crate) file_path: PathBuf,
    pub(crate) clip_gain: f32,
    pub(crate) timeline_start_frame: u64,
    pub(crate) duration_frames: u64,
    pub(crate) fade_in_frames: u64,
    pub(crate) fade_out_frames: u64,
    pub(crate) source_start_seconds: f64,
    pub(crate) transpose_semitones: i32,
}
```

## Resolver transposición efectiva

Crear helper Rust:

```rust
fn region_at_position(song: &Song, position_seconds: f64) -> Option<&SongRegion> {
    song.regions.iter().find(|region| {
        position_seconds >= region.start_seconds
            && position_seconds < region.end_seconds
    })
}

fn effective_transpose_for_track_at_position(
    song: &Song,
    track_id: &str,
    position_seconds: f64,
) -> i32 {
    let Some(track) = song.tracks.iter().find(|track| track.id == track_id) else {
        return 0;
    };

    if !track.transpose_enabled {
        return 0;
    }

    region_at_position(song, position_seconds)
        .map(|region| region.transpose_semitones)
        .unwrap_or(0)
}
```

## Dividir clips por fronteras de región

Esto es crítico.

Si un clip largo cruza varias regiones, no se puede aplicar un único pitch a todo el clip. Hay que partir el plan en subplanes.

Ejemplo:

```text
Clip: 0s..300s

Región A: 0s..100s    transpose 0
Región B: 100s..200s  transpose +2
Región C: 200s..300s  transpose -1
```

Debe producir:

```text
Plan 1: 0s..100s    transpose 0
Plan 2: 100s..200s  transpose +2
Plan 3: 200s..300s  transpose -1
```

Implementar helper:

```rust
fn split_clip_by_region_boundaries(
    song: &Song,
    clip: &Clip,
    track: &Track,
    sample_rate: u32,
) -> Vec<PlaybackClipPlan>
```

Reglas:

```text
- Mantener la misma file_path.
- Ajustar timeline_start_frame.
- Ajustar duration_frames.
- Ajustar source_start_seconds para que cada subplan lea la parte correcta del archivo.
- Si track.transpose_enabled == false, todos los subplanes salen con transpose_semitones = 0.
- Si no hay regiones, usar transpose 0.
```

## Tests PR 7

```text
- Clip dentro de región +2 produce plan +2.
- Clip dentro de región 0 produce plan 0.
- Clip que cruza 3 regiones produce 3 planes.
- Clip que cruza región +2 pero track.transpose_enabled=false produce plan 0.
- source_start_seconds se ajusta correctamente al partir el clip.
- duration_frames total de subplanes equivale a duración original.
```

---

# PR 8 — DSP abstraction + backend Signalsmith

## Objetivo

Implementar pitch-shift real sin acoplar el runtime a una librería concreta.

## Crear módulo

```text
native/audio-engine-v2/include/lt_engine/pitch/pitch_processor.h
```

## Trait

```rust
pub(crate) trait PitchShiftEngine: Send {
    fn set_transpose_semitones(&mut self, semitones: i32);
    fn process_block(
        &mut self,
        input_interleaved: &[f32],
        output_interleaved: &mut Vec<f32>,
    ) -> Result<(), PitchShiftError>;
    fn reset(&mut self);
    fn latency_samples(&self) -> usize;
}
```

## Implementaciones

```rust
pub(crate) struct BypassPitchShiftEngine;

pub(crate) struct SignalsmithPitchShiftEngine {
    // wrapper interno
}
```

Factory:

```rust
pub(crate) enum PitchShiftBackend {
    Bypass,
    Signalsmith,
}

pub(crate) fn create_pitch_shift_engine(
    backend: PitchShiftBackend,
    sample_rate: u32,
    channels: usize,
    transpose_semitones: i32,
) -> Box<dyn PitchShiftEngine> {
    if transpose_semitones == 0 {
        return Box::new(BypassPitchShiftEngine::new());
    }

    match backend {
        PitchShiftBackend::Bypass => Box::new(BypassPitchShiftEngine::new()),
        PitchShiftBackend::Signalsmith => {
            Box::new(SignalsmithPitchShiftEngine::new(sample_rate, channels, transpose_semitones))
        }
    }
}
```

## Reglas de rendimiento

```text
- Procesar por bloques, no sample-a-sample.
- Tamaño inicial recomendado: 128 o 256 frames.
- Bypass total si transpose_semitones == 0.
- Bypass total si track.transpose_enabled == false.
- Evitar asignaciones en el audio thread.
- Prealocar buffers.
- No bloquear el audio thread.
```

## Cambio de pitch sin cambiar tempo

No se permite implementar la transposición cambiando la velocidad de lectura del archivo, porque eso cambia el tempo. El pitch-shift debe mantener duración y BPM.

## Dependencia

Primera opción:

```text
Signalsmith Stretch
```

Se debe integrar detrás del trait. No usar llamadas directas a Signalsmith fuera de `pitch.rs`.

## Tests PR 8

```text
- Bypass devuelve misma cantidad de samples.
- Bypass no altera samples.
- Engine con +2 mantiene duración aproximada del bloque.
- set_transpose_semitones cambia el ratio interno.
- reset limpia buffers internos.
```

Los tests de calidad sonora no deberían depender de comparación exacta sample-a-sample; usar tolerancias y propiedades generales.

---

# PR 9 — Integrar DSP en StreamingClipReader / mixer

## Objetivo

Aplicar pitch-shift en la reproducción real.

El sitio natural está cerca del reader de clips. Actualmente `StreamingClipReader` mantiene la fuente, consumer, sample rate, frames emitidos, declick y EOF; ahí debe añadirse el engine o una capa de procesamiento por bloque. 

## Añadir estado

```rust
pub(crate) struct StreamingClipReader {
    // existente...

    transpose_semitones: i32,
    pitch_engine: Box<dyn PitchShiftEngine>,
    pitch_input_buffer: Vec<f32>,
    pitch_output_buffer: Vec<f32>,
    pitch_output_cursor: usize,
}
```

## Bypass

Si `transpose_semitones == 0`:

```text
- no crear Signalsmith
- no procesar DSP
- usar ruta actual
```

## Procesamiento por bloques

Flujo:

```text
Streaming worker / audio buffer
        ↓
input block interleaved stereo
        ↓
PitchShiftEngine
        ↓
output buffer
        ↓
mix_into_with_channel_gains
```

## Estéreo/fase

Mantener canales procesados de forma conjunta, no dos pitch-shifters mono independientes, para reducir problemas de fase estéreo.

## Cambios inmediatos

Añadir método interno:

```rust
fn set_transpose_semitones_live(&mut self, semitones: i32)
```

Este método debe:

```text
- actualizar semitones
- cambiar/bypassear engine
- aplicar declick/crossfade corto
```

Crossfade recomendado:

```text
5–20 ms
```

---

# PR 10 — Comando live del audio runtime

## Objetivo

Que cambios desde desktop/remote afecten la reproducción inmediatamente.

## Nuevo comando runtime

```rust
pub(crate) enum AudioRuntimeCommand {
    // existentes...

    UpdateRegionTranspose {
        region_id: String,
        transpose_semitones: i32,
    },

    UpdateTrackTransposeEnabled {
        track_id: String,
        transpose_enabled: bool,
    },
}
```

## AudioController

```rust
pub fn update_region_transpose_live(
    &self,
    region_id: &str,
    transpose_semitones: i32,
) -> Result<(), AudioRuntimeError>
```

```rust
pub fn update_track_transpose_enabled_live(
    &self,
    track_id: &str,
    transpose_enabled: bool,
) -> Result<(), AudioRuntimeError>
```

## Comportamiento esperado

Si la región modificada está actualmente sonando:

```text
- aplicar pitch nuevo a los readers activos afectados
- sin reiniciar transporte
- sin salto de posición
- con declick/crossfade
```

Si la región no está sonando:

```text
- actualizar modelo
- el siguiente plan usará el nuevo valor
```

## Undo/redo

Los cambios remote deben entrar en undo/redo, pero agrupados.

Implementar agrupación por ventana temporal:

```text
Si llegan cambios consecutivos de transpose para la misma región dentro de 500–1000 ms,
se agrupan en una sola entrada de historial.
```

Ejemplo:

```text
+1, +2, +3 en un segundo
→ un solo undo vuelve al valor original
```

---

# PR 11 — Export rendered audio, si existe o se añade

## Objetivo

Distinguir exportación editable de renderizado de audio.

## Export editable

Debe conservar metadata:

```text
SongRegion.transpose_semitones
Track.transpose_enabled
```

## Export renderizado

Debe aplicar audio real transpuesto.

Regla:

```text
Si se exporta WAV/stems/render, el resultado debe sonar con la transposición efectiva aplicada.
```

Si no existe export renderizado todavía, dejar test pendiente o issue técnico:

```text
TODO: rendered audio export must use the same audio planning and PitchShiftEngine path as playback.
```

---

# PR 12 — Pruebas de integración y QA musical

## Tests Rust core

```text
- legacy region default transpose 0
- legacy track default transpose_enabled true
- valid range -12..+12
- invalid range fails
- serialization roundtrip preserves transpose_semitones
- serialization roundtrip preserves transpose_enabled
```

## Tests project/package

```text
- export/import region +2
- export/import region -5
- export/import track transpose_enabled=false
- legacy package defaults region transpose to 0
- legacy package defaults track transpose_enabled to true
- invalid package with +13 fails
```

## Tests remote

```text
- updateRegionTranspose deserializes
- missing selected region does not send command
- +1 button sends selected region id
- Original sends 0
- value clamps at -12/+12
```

## Tests desktop UI

```text
- selected region shows transpose controls
- no selected region disables controls
- non-zero region shows badge
- zero region hides badge
- track header exposes transpose toggle
```

## Tests audio runtime

```text
- track transpose disabled bypasses DSP
- region 0 bypasses DSP
- region +2 creates pitch engine
- clip crossing regions is split
- live region transpose changes active reader
- live change does not reset transport position
```

## QA manual

Probar con:

```text
- canción completa con click, drums, bass, keys
- click con transpose_enabled=false
- keys/bass con transpose_enabled=true
- cambiar de 0 a +2 mientras suena
- cambiar de +2 a -2 mientras suena
- volver a Original
- exportar región +2
- importar región +2
- confirmar que el badge aparece tras importar
```

---

# Orden recomendado de implementación

Yo lo ejecutaría así:

```text
PR 1: Modelo persistente + validación + legacy defaults.
PR 2: SongView + TS models.
PR 3: Comandos desktop.
PR 4: UI desktop + feedback visual.
PR 5: Remote command + remote UI.
PR 6: Export/import editable.
PR 7: Audio plan con transpose_semitones + split por regiones.
PR 8: PitchShiftEngine abstraction + Signalsmith backend.
PR 9: Integración en reader/mixer.
PR 10: Live runtime updates + declick.
PR 11: Rendered audio export aplica pitch.
PR 12: QA y tests finales.
```

---

# Prompt maestro para Copilot

```text
Implement real-time per-region audio transposition in LibreTracks.

Product requirements:
- Transpose real audio, not only metadata.
- Control is by semitones.
- Valid range: -12 to +12.
- No global transpose.
- Each SongRegion has a persisted transpose_semitones: i32, default 0.
- The remote app can change the selected region transpose live.
- The remote must only change transpose when a region is selected.
- If no region is selected, remote must show a message and not send a command.
- If the selected region is currently playing, the change must apply immediately.
- Changes from remote must be persisted and included in undo/redo.
- Rapid consecutive transpose changes for the same region should be grouped into one undo step.
- Timeline and remote UI must show clear visual feedback when a region transpose is non-zero.
- Each Track has a persisted transpose_enabled: bool, default true.
- Do not auto-detect click/metronome/guide tracks by name.
- The user explicitly controls transpose_enabled per track from desktop UI.
- Remote does not need to edit transpose_enabled in v1.
- If track.transpose_enabled is false, that track must bypass pitch shifting.
- Export/import must preserve SongRegion.transpose_semitones and Track.transpose_enabled.
- Legacy songs/packages without these fields must default to transpose_semitones=0 and transpose_enabled=true.
- Invalid imported transpose outside -12..+12 must fail with a clear error.
- Rendered audio export, if present, must render the transposed audio, not just metadata.
- Low latency and smooth live operation are more important than offline render quality.

Technical direction:
- Do not implement a custom pitch-shifting DSP algorithm from scratch for v1.
- Add LibreTracks' own PitchShiftEngine trait.
- Use an external backend initially, preferably Signalsmith Stretch.
- Keep the audio runtime backend-agnostic.
- Do not implement pitch by changing playback speed, because tempo must remain unchanged.
- Process audio by small blocks, not sample-by-sample.
- Bypass DSP completely when transpose_semitones == 0 or track.transpose_enabled == false.
- Add short declick/crossfade, around 5–20 ms, when changing transpose live.

Implementation tasks:
1. Add SongRegion.transpose_semitones with serde default 0.
2. Add Track.transpose_enabled with serde default true.
3. Add validation for transpose range -12..+12.
4. Update legacy migrations to fill transpose_semitones=0.
5. Update SongView and TrackSummary/SongRegionSummary.
6. Update TypeScript shared models.
7. Add update_song_region_transpose Tauri command.
8. Add update_track_transpose_enabled Tauri command.
9. Add desktop API wrappers.
10. Add desktop region transpose controls.
11. Add desktop track transpose_enabled toggle.
12. Add timeline badge for non-zero region transpose.
13. Add RemoteCommand::UpdateRegionTranspose.
14. Add remote UI controls: -1, +1, Original.
15. Ensure remote requires selected region.
16. Update export_region_as_package manifest to include region_transpose_semitones.
17. Ensure exported tracks include transpose_enabled.
18. Ensure package import preserves region_transpose_semitones.
19. Ensure package import preserves track.transpose_enabled.
20. Add transpose_semitones to PlaybackClipPlan.
21. Split long clips by SongRegion boundaries so each sub-plan has the right transpose.
22. Add PitchShiftEngine trait.
23. Add BypassPitchShiftEngine.
24. Add SignalsmithPitchShiftEngine backend.
25. Integrate pitch processing in StreamingClipReader or the nearest appropriate audio source layer.
26. Add AudioRuntimeCommand::UpdateRegionTranspose.
27. Add AudioRuntimeCommand::UpdateTrackTransposeEnabled.
28. Apply live updates without restarting transport.
29. Add declick/crossfade on live pitch changes.
30. Add tests for model, validation, package export/import, remote command, UI, audio plan splitting, bypass behavior and live update.
```

---

# Criterios de aceptación finales

La feature se considera completa cuando:

```text
1. Puedo seleccionar una región en desktop y ponerla en +2.
2. La región muestra visualmente +2.
3. El audio real suena +2 semitonos sin cambiar tempo.
4. Puedo cambiar de +2 a -1 mientras suena y el cambio se oye inmediatamente.
5. Puedo cambiar el tono desde remote solo si hay región seleccionada.
6. Si no hay región seleccionada en remote, no se envía comando.
7. Puedo marcar una pista como "no transponer".
8. Esa pista no cambia de tono aunque la región esté en +2.
9. El proyecto guarda estos valores.
10. Exportar e importar la canción/región conserva el tono y la opción de pista.
11. Undo/redo funciona con cambios de tono.
12. El rango queda limitado a -12..+12.
13. Los proyectos antiguos siguen abriendo correctamente.
```

[1]: https://github.com/Signalsmith-Audio/signalsmith-stretch?utm_source=chatgpt.com "Signalsmith Stretch: C++ pitch/time library"
