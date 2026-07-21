# Rediseño: partir state.rs en un módulo por temas

Estado: **en ejecución** (sesión 2026-07-21). Este documento guía el split de
`apps/desktop/src-tauri/src/state.rs` (14.501 líneas) en un módulo `state/` con
submódulos por tema. Escrito en el mismo espíritu que
[[REDESIGN_transport_refs_to_stores]]: medir antes de mover, no bajar líneas si
empeora el diseño.

## Progreso (2026-07-21) — COMPLETADO

`state.rs` → carpeta `state/`. `mod.rs` bajó de **14.501 a 3.285 líneas** (-77%)
en catorce commits, cada uno verificado con `cargo check --tests` verde (mismos 8
warnings de base) antes de commitear:

| Submódulo | Líneas | Contenido |
|---|---|---|
| `state/tests.rs` | 4.102 | `#[cfg(test)] mod tests` completo |
| `state/mod.rs` | 3.285 | núcleo: transporte, sync, waveform cache, tipos, utils |
| `state/regions.rs` | 1.308 | regiones, marcadores, tempo, warp/transpose/gain |
| `state/library.rs` | 1.026 | assets, carpetas, manifiesto e import a biblioteca |
| `state/arrangement.rs` | 918 | clips (move/delete/dup/split) + tracks CRUD |
| `state/automation_runtime.rs` | 812 | cues/scenes CRUD + scheduling de jumps/ramps |
| `state/external_import.rs` | 747 | import Reaper/Ableton + helpers de marcadores |
| `state/timeline_math.rs` | 740 | fns puras: downbeats, warp/varispeed, reflow |
| `state/audio_prep.rs` | 575 | carga + secuencia source-ready/prearm/prime |
| `state/session.rs` | 552 | create/save/open proyecto, plantillas, .ltset |
| `state/song_edit.rs` | 278 | helpers puros de clips/regiones (validate/append/prune) |
| `state/track_tree.rs` | 206 | helpers de jerarquía de tracks (insert/reparent/subtree) |
| `state/history.rs` | 174 | undo/redo + agrupado de historial |

Los cuatro últimos cortes fueron **reagrupación de funciones libres**: los
helpers puros que se habían quedado en `mod.rs` cuando se extrajeron los métodos
se movieron a su módulo temático (`track_tree`, `song_edit`, los libres de
`library`, y los `imported_*` a `external_import`). Se accede a ellos con
`use <mod>::*` en `mod.rs`; las 4 fns de biblioteca que `commands/` consume como
`crate::state::…` se reexportan con `pub(crate) use library::{…}`.

**Patrón validado y repetible.** Cada corte fue: promover a `pub(super)` los
campos/tipos/helpers/métodos que el bloque cruza, mover el bloque a un
`impl DesktopSession` hermano con sus propios `use`, borrar del `mod.rs`,
declarar `mod X;`, limpiar imports huérfanos hasta volver a 8 warnings.

Gotchas recurrentes:
- `tests.rs` es hermano de los submódulos, no hijo. Un método que se mueve como
  `fn` privado deja de verse desde `tests.rs`; dejarlo `pub(super)`.
- Al promover un campo/fn a `pub(super)` cuyo TIPO sigue privado, aparece el lint
  "type X is more private than the item". Promover también el tipo
  (`TransportClock`, `LibraryManifest`, `TransposeHistoryGroup`, …).
- Contar refs por nombre da falsos positivos: `Song` en un string `"Song {}"` o
  una fn llamada como `libretracks_core::foo` (no la de `super::`). Verificar con
  el warning del compilador, no solo con grep.
- Ojo con los rangos de línea tras cada corte: se desplazan. Reconfirmar la
  frontera (`sed -n`) antes de extraer, no fiarse de un grep viejo. (Una vez el
  bloque de arrangement se tragó `import_song_package*`; se sacó de vuelta.)

### Lo que se quedó en `mod.rs` (a propósito)

El **núcleo de transporte**: `play`/`pause`/`seek`/`stop`, `sync_position`,
`sync_native_scheduled_jump_if_needed`, `snapshot*`, `schedule_marker_jump`/
`schedule_region_jump`, la caché de waveforms (`WaveformMemoryCache`,
`load_waveform_summary_cached`, `reposition_audio`) y las fns libres de bajo
nivel (track-tree, clip helpers, library manifest I/O). Todo esto toca `engine` +
`transport_clock` a la vez o es el hot path del playhead: no hay frontera y
dividir empeora el diseño. Un futuro `waveforms.rs` (caché + priming) es el único
corte que aún tendría sentido; el resto es núcleo.

## Diagnóstico

`state.rs` NO tiene el problema de `TransportPanelContent`. Allí el dolor era
estado mutable compartido (un grafo de refs inseparable sin rediseñar la
representación). Aquí el dolor es distinto y **mucho más favorable de resolver**:

- La fachada de comandos Tauri ya está separada en `commands/*.rs` (wrappers
  finos: `lock → session.metodo() → map_err`). Esa capa está sana.
- **Toda la lógica cuelga de un único `impl DesktopSession` de ~6.700 líneas**
  (líneas 907–7593) que mezcla automation, waveforms, biblioteca, regiones,
  import externo, undo/redo y transporte.
- Hay ~2.700 líneas de funciones libres (post-impl) y ~4.200 de tests.

### La ventaja de Rust frente al caso del frontend

Un `impl` se puede repartir en varios archivos del mismo módulo **sin cambiar el
acoplamiento**: `impl DesktopSession` en `state/automation.rs` sigue accediendo a
`self.pending_automation_jump` exactamente igual. No es un rediseño de
representación, es reparto físico. Bajo riesgo.

### Mapa de acoplamiento (accesos a campos privados dentro del impl, 6.688 líneas)

| Campo(s) | Accesos | Cluster |
|---|---|---|
| `self.engine` | 108 | transversal (transporte/audio) |
| `self.pending_automation_jump/active_*/run_counts` | 45 | automation |
| `self.song_dir/song_file_path` | 44 | persistencia/carga |
| `self.automation` | 35 | automation |
| `self.perf_metrics` | 34 | métricas |
| `self.transport_clock` | 27 | transporte |
| `self.undo_stack/redo_stack/live_history_*` | 27 | historial |
| `self.waveform_cache` | 14 | waveforms |

Los clusters ya están **físicamente contiguos** en el archivo. Cada uno toca un
subconjunto acotado de campos → frontera real para un `impl` split.

## Estrategia

Convertir `state.rs` → `state/mod.rs` + submódulos. Reglas:

1. **La superficie `state::X` no cambia.** Todo lo que hoy consumen `commands/`
   y `lib.rs` (`state::slugify`, `state::list_library_assets`,
   `state::DesktopState`, etc.) se mantiene accesible vía `pub(crate) use` en
   `mod.rs`. Los consumidores externos no ven ningún cambio.
2. **Visibilidad de campos.** Los campos de `DesktopSession` que un submódulo
   necesite pasan de privados a `pub(super)` (o se mantiene el struct + Default
   en `mod.rs` y los métodos se mueven; los campos deben ser al menos
   `pub(super)` para que los `impl` hermanos los vean).
3. **Cada paso compila (`cargo build`) y pasa `npm run test:native` antes del
   siguiente.** Commits pequeños. Seguridad primero.

## Orden de ejecución (de menor a mayor riesgo)

1. **Tests fuera** — mover `mod tests` (~4.177 líneas) a `state/tests.rs`.
   Riesgo casi nulo, quita el 29% del archivo. `#[cfg(test)] mod tests;` en
   mod.rs, `use super::*;` en el submódulo.
2. **Funciones libres puras** — sin `self`, agrupadas por tema:
   - `state/library.rs` — manifests, import a biblioteca, carpetas virtuales.
   - `state/timeline_math.rs` — regiones/tempo/warp/downbeats/varispeed sobre
     `Song` (el grupo más grande de funciones puras, ~30 fns).
   - `state/track_tree.rs` — insert/reparent/subtree/jerarquía.
   - `state/sessions.rs` — plantillas, listado de sesiones/plantillas.
3. **Métodos del impl por tema** (`impl DesktopSession` en cada submódulo):
   - `state/automation_runtime.rs` — cues, jumps, mix ramps, scenes.
   - `state/external_import.rs` — import Reaper/Ableton (~500 líneas contiguas).
   - `state/regions.rs` — CRUD de regiones/marcadores/tempo.
   - `state/waveforms.rs` — cola, caché, priming.
4. **Núcleo** — lo que queda en `mod.rs`: struct, Default, transporte, play/
   pause/seek, snapshot, sync. El hot path se queda junto y explícito.

## Restricción que NO se puede romper

`sync_position` / `snapshot*` / `runtime_transport_position` son el camino de
sincronización con el motor a intervalo. No dividir por dividir: si un método
toca `engine` + `transport_clock` + `automation` a la vez, es núcleo y se queda
en `mod.rs`. La medición de acoplamiento manda, igual que en el caso del
frontend.

## Verificación

- Baseline registrada antes de tocar nada (`npm run test:native`).
- Cada commit: `cargo build -p libretracks-desktop` + suite native verde.
- Cero cambios de comportamiento esperados: es reparto, no reescritura.
