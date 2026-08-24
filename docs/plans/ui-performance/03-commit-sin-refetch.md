# 03 — Soltar y ver el cambio: primero el coste real, luego el optimismo

> **Reordenado tras la medición del 2026-08-24.** Este paso se escribió creyendo
> que el coste eran «dos viajes de IPC en serie». Medido: `move_song_region`
> tarda **627 ms** y `get_song_view` **39 ms**. El segundo viaje es el 6 %.
> El punto 0 de abajo es nuevo y es el que vale; el resto sigue siendo válido
> pero secundario.

**Depende de:** 01. Independiente de 02 (pueden ir en paralelo, pero el síntoma
sólo desaparece del todo con los dos).
**Toca:** `TransportPanelContent.tsx` (commit de región/clip/marca),
`hooks/useSongViewLoader.ts`, `apps/desktop/src-tauri/src/state/mod.rs`.
**Riesgo:** medio-alto. Toca la coherencia frontend↔backend.
**Impacto: alto.** Es la mitad «y después de un tiempo se realiza» del síntoma 1.

## Problema

Ver [00-DIAGNOSTICO.md, C2 y C3](00-DIAGNOSTICO.md#c2--al-soltar-la-canción-vuelve-a-su-sitio-viejo-y-espera-al-backend).

Al soltar una canción arrastrada:

```
pointerup
  → setRegionMovePreview(null)      ← LA REGIÓN SALTA A SU SITIO VIEJO
  → await moveSongRegion(...)        ← IPC 1: bloquea session.lock, 3 clones del Song,
                                       reconstruye el engine, doble serialización
  → applyPlaybackSnapshot            ← revisión +1
  → useSongViewLoader dispara
  → await getSongView(...)           ← IPC 2: proyecto entero, doble serialización
  → setSong                          ← render completo del árbol
  → por fin la región se ve movida
```

Dos viajes de IPC **en serie** y un render completo entre el gesto y el
resultado. El salto atrás intermedio es lo que hace que se perciba como «se
mueve, y luego se mueve de verdad».

El repo ya tiene el mecanismo para evitar el segundo viaje —
`optimisticallyAppliedRevisionsRef`, que `useSongViewLoader` consulta para
saltarse el refetch— pero sólo lo usan los handlers de color, de pista y de
tempo. Mover regiones, clips y marcas no.

## Cambio pedido

### 0. Que mover una canción deje de reconstruir la estructura entera

**Éste es el 94 % del coste.** Ver
[C8 del diagnóstico](00-DIAGNOSTICO.md#c8--mover-una-canción-cuesta-96-veces-más-que-mover-un-clip).

`move_song_region` termina con `AudioChangeImpact::StructureRebuild`
(`state/regions.rs:601`); `move_clip` y `move_clips_batch` usan
`TimelineWindow`. Con el transporte parado, la primera etiqueta dispara
`audio.upsert_song_tracks(&song)` — las 29 pistas y los 500 clips empujados al
motor C++ — y la segunda no toca el motor.

Mover una región traslada clips y marcas: no añade ni quita fuentes ni pistas.

**Lo que hay que hacer, en este orden:**

1. **Medir antes de cambiar.** Instrumenta `persist_song_update_internal` para
   registrar cuánto tarda la rama de `upsert_song_tracks`. Si no son la mayor
   parte de los 627 ms, el culpable es otro (candidatos:
   `snap_regions_after_to_downbeats`, los tres clones del `Song`,
   `update_live_song_regions`) y hay que seguir el rastro antes de tocar la
   etiqueta.
2. Sólo si la medición lo confirma, bajar `move_song_region` a
   `TimelineWindow`.

**Cuidado — esto no es un cambio cosmético.** Hay precedente en el repo de
desincronizar el motor al tocar esta clasificación:
`project_region_parsers_must_mirror` (tres sitios parsean regiones; si uno omite
un campo, los edits en caliente resetean estado del motor) y
`project_transpose_rebuild_desync` (reconstruir la voz en vez de retimarla).

Criterios propios de este sub-paso:

- Reproducir a mano: mover una canción **mientras suena**, con warp activado en
  esa región y en la siguiente, y comprobar que el clic y la voz guía siguen en
  su sitio.
- Mover una canción a una posición que **colisione** con la siguiente (el
  camino de cascada + `snap_regions_after_to_downbeats`) y comprobar que el
  resultado es idéntico antes y después del cambio.
- Un test que compare el `Song` resultante de `move_song_region` con la etiqueta
  vieja y con la nueva: deben ser iguales. Si no lo son, la etiqueta no era sólo
  una optimización y hay que parar.

### 1. No limpiar el preview hasta que el modelo ya lo refleje

Hoy `endRegionMove` limpia el preview y **después** lanza el commit. Invertir:
el preview sobrevive al `pointerup` y se limpia cuando el `song` ya trae la
posición nueva. El patrón ya existe para clips —
`clipPreviewClearAfterRevisionRef` guarda a partir de qué `projectRevision`
puede soltarse el preview (`useDragListeners.ts:376`). Reutilizarlo.

Esto solo ya elimina el salto atrás, aunque el resto tarde.

### 2. Commit optimista para mover región

`moveSongRegion` traslada región + clips + marcas de dentro por `deltaSeconds`.
Es una transformación **cerrada y trivial de aplicar en el frontend**: sumar el
delta a `startSeconds`/`endSeconds` de la región y a las posiciones de todo lo
que caiga dentro. Aplicar ese parche a `song` con `setSong`, registrar la
revisión devuelta en `optimisticallyAppliedRevisionsRef` y dejar que
`useSongViewLoader` se salte el refetch.

Mismo tratamiento para `moveClip` / `moveClipsBatch` (cambian
`timelineStartSeconds` y, en su caso, `trackId`) y para el movimiento de marcas.

**Cuidado — el backend hace más que trasladar.** `move_clip` en
`state/arrangement.rs:25` también ejecuta `ensure_region_covers_clip`,
`prune_empty_regions`, `prune_auto_created_empty_tracks` y
`refresh_song_duration`. Si el parche optimista se aplica cuando cualquiera de
esas cascadas se dispara, el frontend queda desincronizado.

**Regla de seguridad**: el backend debe **decir** si hubo cascada. Añadir al
`TransportSnapshot` un campo tipo `structural_side_effects: bool` (o un
`applied_delta` explícito). Si es `true`, el frontend **no** registra la
revisión como optimista y hace el refetch como hoy. El camino rápido sólo se
toma cuando es seguro, y el lento sigue siendo la red de seguridad.

### 3. Quitar la doble serialización en Rust

Dos sitios, tres líneas cada uno:

```rust
// state/mod.rs:1367 — song_view_with_options
let bytes = song_view.as_ref().map(|view| to_vec(view).map(|b| b.len()))…;
self.perf_metrics.song_view_bytes = bytes;

// state/mod.rs:2895 — snapshot()
self.perf_metrics.transport_snapshot_bytes = to_vec(&snapshot).map(|b| b.len())…;
```

Serializan la respuesta entera a un `Vec<u8>` que se descarta, sólo para anotar
su tamaño. Tauri la vuelve a serializar después. `snapshot()` lo devuelven casi
todos los comandos y lo pide el sondeo cada 250 ms mientras se reproduce.

Opciones, en orden de preferencia:

1. **Ponerlo detrás del flag de diagnóstico que ya existe.** El bloque de al
   lado ya usa `jump_debug_logging_enabled()`; el conteo de bytes es igual de
   opcional.
2. Si se quiere el dato siempre, calcular el tamaño con un `serde` que cuente
   bytes sin materializarlos (un `io::Write` que solo suma). Sigue costando
   recorrer la estructura, pero no reserva memoria.

**Opción 1 salvo que alguien defienda lo contrario.** Es un contador de
diagnóstico, no telemetría de producto.

### 4. Un solo IPC para el caso general (si 2 no cubre todo)

Cuando el parche optimista no sea posible, el commit debería poder devolver el
`SongView` junto al snapshot en **la misma** respuesta, en vez de obligar a un
segundo viaje. `session.song_view_with_options()` ya existe y el comando ya
tiene el lock cogido: es añadir el campo, no trabajo nuevo.

Hacerlo **opcional** (`?include_song_view=true`) para no engordar todas las
respuestas.

## Criterios de aceptación

- [ ] Al soltar una canción arrastrada **no hay salto atrás**: la región se
      queda donde se soltó. Verificable a ojo y con un test que compruebe que el
      preview no se limpia antes de que el modelo lo refleje.
- [ ] **`move_song_region` baja de forma medida.** Línea base:
      **626,6 ms de media, 648,4 ms el peor**, contra 6,5 ms de `move_clip`
      en el mismo build. Cifras nuevas en el PR, del mismo build de medición.
- [ ] `editCommitMs` (métrica del paso 01) en G1 baja de forma **medida**, con
      las dos sesiones de referencia. Cifras en el PR.
- [ ] En el camino rápido, `get_song_view` **no se llama** tras mover una
      región/clip/marca. Verificable con un contador o un log.
- [ ] Cuando el backend reporta efectos estructurales, el frontend **sí** hace
      el refetch. Hay un test que cubre ese caso (p. ej. mover un clip que
      obliga a extender su región).
- [ ] Tras 20 movimientos encadenados sin recargar, `song` en el frontend es
      **idéntico** al que devuelve `get_song_view`. Test de deriva: aplicar N
      parches optimistas y comparar contra la verdad del backend. **Este es el
      criterio que impide que el paso introduzca corrupción silenciosa.**
- [ ] `to_vec` ya no se ejecuta en el camino caliente. `cargo check
      --all-targets` limpio y los tests de `libretracks-desktop` en el estado
      conocido (recuerda: `cargo test -p libretracks-desktop` falla siempre por
      link, no es tuyo — usa `cargo check --all-targets` + los tests del front).
- [ ] Deshacer/rehacer sigue funcionando después de una serie de movimientos
      optimistas.

## Notas para el implementador

- La memoria del proyecto avisa: *las acciones de automatización deben escribir
  el modelo Rust, no sólo el motor*. Aquí es al revés y el riesgo es el gemelo:
  **el parche optimista escribe el modelo del frontend, y el de Rust es la
  verdad**. Si divergen, gana Rust. El test de deriva es lo que lo garantiza.
- No hagas optimista el `undo`/`redo`: ahí la cascada es la norma, no la
  excepción.
- `applyPlaybackSnapshot` tiene lógica delicada de reanclaje visual durante la
  reproducción (`TransportPanelContent.tsx:3205`). No la toques al añadir el
  campo nuevo al snapshot.
- **`move_song_region` hace más que trasladar**, ya comprobado
  (`state/regions.rs:423`): mover a la derecha contra otra canción **empuja en
  cascada** las siguientes, y después
  `realign_regions_after_warp_tempo_change` **re-encaja cada una a su compás 1**.
  Mover a la izquierda contra otra canción se rechaza. Es decir: el resultado
  final **no** es «start + delta» salvo en el caso sin colisión.

  Por tanto, para regiones el optimismo sólo es válido cuando no hay colisión, y
  aun así el re-snap puede cambiar el valor exacto. **Recomendación:** para el
  movimiento de región, empezar sólo por el punto 1 (no limpiar el preview
  antes de tiempo) y el punto 4 (un solo IPC). El parche optimista completo
  déjalo para clips y marcas, donde la transformación sí es cerrada. Si mides
  que con eso ya basta, no añadas el resto.
- Es preferible un camino rápido pequeño y correcto que uno amplio y dudoso.
