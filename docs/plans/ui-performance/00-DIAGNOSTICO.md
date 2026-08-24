# 00 — Diagnóstico: rendimiento y detalle de la UI del timeline

Documento de contexto compartido. **Todo agente (BUILDER o REVIEWER) debe leer
este fichero antes de tocar nada.** No contiene tareas: contiene los hechos
comprobados que justifican cada paso del plan.

Fecha: 2026-08-23. Rama: `main` (`fa4a7102`).

## Los tres síntomas reportados

1. **«Cuando muevo canciones se mueven y después de un tiempo se realiza el
   movimiento.»** — arrastrar una región (canción) por el ruler.
2. **«A cierto zoom, cuando aumento, hay como un pequeño trabe de la UI.»**
3. **«Quiero ver las waveforms a mucho zoom con más detalle.»**

Los tres tienen causa distinta y las tres están localizadas. Ninguno es «el
archivo es grande» ni «React es lento».

## Estado de la evidencia

| Tipo | Qué significa |
| --- | --- |
| **MEDIDO** | Micro-benchmark ejecutado en este repo (Node/vitest), cifras reproducibles. |
| **DERIVADO** | Aritmética sobre constantes del código (resoluciones, tamaños, umbrales). |
| **LEÍDO** | Estructura del código, verificada leyendo la ruta completa. |

Lo que **falta** es la medición dentro de la app compilada en release. Ese es el
paso [01](01-banco-de-medicion.md), y **es el primero por una razón**: este repo
ya tiene precedente de diagnósticos equivocados sacados del build de desarrollo
(ver `docs/REDESIGN_transport_refs_to_stores.md`, sección «Nota metodológica»:
picos de 90-200 ms y un p99 de IPC de 120 ms que resultaron ser artefacto del
dev server). **Ninguna cifra de este documento sobre coste real de frame debe
darse por buena hasta reproducirla en release.**

---

## C1 — El arrastre de una canción hace `setState` en cada `pointermove`

**LEÍDO.** `timeline/TimelineCanvasPane.tsx:798` (`updateRegionMove`):

```ts
drag.previewStartSeconds = nextStart;
drag.previewEndSeconds = nextEnd;
setRegionMovePreview({ regionId, startSeconds, endSeconds, deltaSeconds });
```

`setRegionMovePreview` es un `useState` de `TimelineCanvasPane`
([`:565`](../../../apps/desktop/src/features/transport/timeline/TimelineCanvasPane.tsx#L565)).
Cada evento de puntero (un ratón de 1000 Hz genera cientos por segundo; el
navegador los coalesce a ~1 por frame, pero aun así uno por frame) provoca un
render completo de ese componente: **890 líneas de JSX con 10 bucles `.map()`**
(regiones, marcas de sección, marcas de tempo, marcas de compás, carriles,
pistas visibles, cues de automatización, previews de biblioteca…).

Lo mismo hace el arrastre de marcas (`timeline/useMarkerMoveDrag.ts:260`,
`setPreview` por movimiento) y el redimensionado de regiones
(`setRegionResizePreview`, `:648` y `:718`).

**Esto es exactamente el patrón que el arrastre de clips evita a propósito.**
`hooks/useDragListeners.ts` lo dice en su cabecera:

> THIS IS THE HOT PATH. […] It writes preview positions/lanes into
> `clipPreviewSecondsRef` and `clipPreviewTrackIdRef`, which the canvas reads
> directly — the ghost is painted WITHOUT a React re-render. Never convert
> these to state.

Los arrastres del carril de clips cumplen la regla. Los arrastres del ruler
(región, marca, cue) **no**: nacieron después y fueron por el camino corto.

Coste añadido por movimiento, en la misma función:

- `buildSongTempoRegions(song)` — reconstruye y ordena las regiones de tempo
  (`TimelineCanvasPane.tsx:826` y `:889`).
- `snapToTimelineGrid(...)` — que internamente vuelve a llamar a
  `normalizeTimelineRegions` sobre todas las regiones
  (`packages/shared/src/timelineMath.ts:536`).

**Nota de alcance**: el arrastre de clips SÍ hace `setState` por movimiento
cuando el imán está activo (Ctrl/Cmd): `setClipDragSnapIndicatorSeconds` es un
`useState` de `TransportPanelContent` (`:937`). Sin imán el valor se queda en
`null` y React descarta el render; con imán, cada movimiento re-renderiza el
componente de 8321 líneas.

## C2 — Al soltar, la canción vuelve a su sitio viejo y espera al backend

**LEÍDO.** Esta es la mitad «y después de un tiempo se realiza el movimiento».

`endRegionMove` (`TimelineCanvasPane.tsx:849`) limpia el preview **antes** de
lanzar el commit:

```ts
regionMoveDragRef.current = null;
setRegionMovePreview(null);          // ← la región vuelve a region.startSeconds

if (Math.abs(finalDelta) > 1e-6 && onRegionMoveCommit) {
  onRegionMoveCommit(drag.regionId, finalDelta);   // ← async, sin optimismo
}
```

Y el commit (`TransportPanelContent.tsx:7797`) no aplica nada localmente:

```ts
void runAction(async () => {
  const nextSnapshot = await moveSongRegion(regionId, deltaSeconds);
  applyPlaybackSnapshot(nextSnapshot);
});
```

Secuencia real que ve el usuario:

```
soltar → la región SALTA a su posición original
       → IPC move_song_region (bloquea session.lock, reconstruye el engine, clona el Song 3×)
       → snapshot con project_revision+1
       → useSongViewLoader detecta la revisión nueva
       → SEGUNDO IPC: get_song_view (proyecto entero serializado)
       → setSong → re-render completo de TransportPanelContent y todo el subárbol
       → por fin la región aparece en su sitio nuevo
```

Son **dos viajes de IPC en serie más un render completo** entre soltar y ver el
resultado. El camino optimista existe en el repo
(`optimisticallyAppliedRevisionsRef`, usado por los handlers de color, de pista
y de tempo) — mover regiones, mover clips y mover marcas no lo usan.

### Corrección tras medir (2026-08-24)

La estructura de arriba es correcta, **la proporción que insinuaba no**. Medido:

```
move_song_region  627 ms   ← el 94 % del coste
get_song_view      39 ms   ← el 6 %
```

El segundo viaje existe y sobra, pero **no es el problema**. El problema es que
el primero tarda 627 ms, y eso tiene su propia causa: [C8](#c8--mover-una-canción-cuesta-96-veces-más-que-mover-un-clip).

Quitar el refetch sin tocar C8 ahorraría un 6 %. Ordenar los pasos por esa
corrección es lo que hace el paso [03](03-commit-sin-refetch.md).

## C8 — Mover una canción cuesta 96 veces más que mover un clip

**MEDIDO** (2026-08-24, build de medición, sesión de 20 canciones / 500 clips):

| Comando | llamadas | media | peor |
| --- | --- | --- | --- |
| `move_song_region` | 8 | **626,6 ms** | 648,4 ms |
| `move_clip` | 4 | **6,5 ms** | 14,0 ms |
| `get_song_view` | 15 | 39,0 ms | 130,1 ms |

Los dos mueven cosas por la línea de tiempo. Uno tarda 6,5 ms y el otro 627 ms,
de forma consistente (el peor caso apenas supera la media, así que no es
contención: es trabajo real que se hace siempre).

**La diferencia es una palabra.** Al final de `move_song_region`
(`state/regions.rs:601`):

```rust
audio.update_live_song_regions(&song)?;
self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
```

frente a `move_clip` y `move_clips_batch` (`state/arrangement.rs:66`, `:144`):

```rust
self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;
```

Y en `persist_song_update_internal` esas dos etiquetas llevan a sitios muy
distintos cuando el transporte está **parado**:

- `TimelineWindow` → **no se toca el motor**. «Timeline-only edits with
  already-known sources can stay Rust-side while idle.»
- `StructureRebuild` → `audio.upsert_song_tracks(&song)`, que recorre las 29
  pistas y los 500 clips y los empuja al motor C++. Más la llamada extra a
  `update_live_song_regions` de la línea anterior.

Mover una región traslada clips y marcas: **no añade ni quita fuentes ni
pistas**. Eso es exactamente un cambio de ventana de línea de tiempo, no una
reconstrucción estructural. `move_clips_batch`, que además reajusta regiones,
se conforma con `TimelineWindow`.

Aviso: el binario de Rust va en debug, así que los 627 ms serían menos en
producción. Pero **la razón de 96× es contra `move_clip` medido en el mismo
build**, así que la desproporción es real.

## C3 — Cada comando serializa su respuesta dos veces en Rust

**LEÍDO.** `apps/desktop/src-tauri/src/state/mod.rs:1367`, dentro de
`song_view_with_options`:

```rust
let bytes = song_view
    .as_ref()
    .map(|view| to_vec(view).map(|bytes| bytes.len()))   // serde_json::to_vec
    .transpose()?
    .unwrap_or(0);
self.perf_metrics.song_view_bytes = bytes;
```

Se serializa el `SongView` **entero a un `Vec<u8>` que se tira**, solo para
apuntar su tamaño en una métrica. Después Tauri lo vuelve a serializar para
devolverlo. Lo mismo ocurre en `snapshot()` (`mod.rs:2895`) con
`transport_snapshot_bytes` — y `snapshot()` lo devuelve **casi todos los
comandos** y lo pide el sondeo cada 250 ms durante la reproducción.

Es coste puro, sin ningún consumidor fuera del HUD de diagnóstico.

## C4 — El tile de waveform se invalida entero cada 1,5× de zoom, y se dibuja dentro del frame

**LEÍDO + DERIVADO.** `Renderer/WaveformTileCache.ts`.

```ts
export const WAVEFORM_TILE_WIDTH_PX = 1024;
const TILE_HEIGHT_PX = 256;
const WAVEFORM_ZOOM_CACHE_STEP = 1.5;
const MAX_CACHED_TILES = 320;
```

Cuatro cosas, todas medibles:

**(a) La clave del tile incluye el zoom cuantizado a pasos de 1,5×.**
`tileNamespace()` mete `renderPixelsPerSecond` en la clave. Al cruzar un límite
de 1,5× **todos los tiles visibles cambian de namespace de golpe** y hay que
volver a dibujarlos. Eso es un evento discreto que ocurre «a cierto zoom» —
encaja literalmente con el síntoma 2.

**(b) El dibujo del tile ausente ocurre DENTRO del frame.** `getTile()` llama a
`renderWaveformTile()` de forma síncrona cuando falla la caché, y `getTile()` se
llama desde `drawTrackClipsLayer` (`Renderer/drawTracks.ts:720`), que corre en el
rAF del `TimelineRenderer`. No hay presupuesto de tiempo ni cola: si en ese
frame faltan 40 tiles, se dibujan los 40 antes de devolver el control.

Cuántos tiles se invalidan de golpe (DERIVADO): con `trackHeight` mínimo (18 px,
`constants.ts`) y un viewport de 800 px caben ~44 carriles; el viewport de lanes
ronda los 1400 px, y como `renderScale ∈ [0,82, 1,22]` cada clip visible ocupa
1-2 tiles de 1024 px. **≈ 44-88 tiles a redibujar en un solo frame.** Cada tile
recorre hasta ~1024 buckets × 2 pasadas (arriba y abajo) construyendo un `Path2D`
y hace un `fill()` sobre 1024×256 px.

**(c) El tile mide 256 px de alto SIEMPRE**, aunque el carril mida 18 px:

```ts
context.drawImage(tile.canvas, x, clipTop, tile.tileWidth * renderScale, clipHeight);
```

A `trackHeight = 18` se rasterizan **14 veces más píxeles de los que se ven**, y
además el escalado 256→18 destruye los picos finos (lo que el usuario percibe
como waveform «sucia» en carriles bajos).

**(d) El presupuesto de caché está en número de tiles, no en bytes.**
`MAX_CACHED_TILES = 320` × 1024 × 256 × 4 B = **320 MiB** de superficies de
canvas en el caso peor. Y como un solo nivel de zoom ya puede necesitar ~90
tiles, tener dos o tres niveles vivos (zoom adelante y atrás) desborda el LRU:
**se expulsan tiles que hacen falta en el frame siguiente**, y el redibujado se
vuelve permanente en vez de puntual.

`pruneNamespaces()` existe (`WaveformTileCache.ts:447`) pero **no se llama desde ningún sitio de
producción** — solo desde su test. La única defensa real es el LRU por conteo.

## C5 — El detalle de la waveform tiene un techo duro en zoom ≈ 9,6 de 64

**DERIVADO** de constantes verificadas:

| Constante | Valor | Dónde |
| --- | --- | --- |
| LOD más fino | **256 frames/bucket** | `crates/libretracks-project/src/waveform.rs:25` |
| LODs disponibles | 256, 2 048, 16 384, 131 072 | idem |
| Píxeles por segundo base | 18 | `packages/shared/src/timelineMath.ts:1` |
| Zoom máximo | 64 | `features/transport/constants.ts` |

`selectWaveformLod()` elige el LOD más grueso cuyo `resolutionFrames` no supere
`framesPerPixel = sampleRate / pixelsPerSecond`. Con el LOD más fino a 256
frames y 44,1 kHz:

- Un bucket por píxel se alcanza a **172,3 px/s**, es decir **zoom ≈ 9,6**.
- **A partir de ahí el detalle deja de mejorar.** Se sigue haciendo zoom, pero
  se está estirando la misma información.
- Al zoom máximo (64 → 1152 px/s) cada bucket ocupa **6,7 px**. El renderer lo
  detecta (`shouldUseSteppedPeaks` cuando `pxPerBucket > 5`) y dibuja una
  escalera. Correcto, pero es una escalera: no hay más datos que enseñar.

A eso se suma la cuantización de (a): como el tile se dibuja al zoom cuantizado
y luego se estira con `drawImage`, **en la mayoría de niveles de zoom se está
viendo un bitmap reescalado hasta ±22 %**, no un dibujo fresco. Eso es blur
añadido sobre el techo de resolución.

**La buena noticia**: la infraestructura para arreglarlo ya existe. El motor
sabe calcular picos a cualquier resolución desde su caché PCM en disco
(`SourceManager::source_peaks`, `native/audio-engine-v2/src/sources/source_manager.cpp:1330`),
y el `.ltpeaks` guarda un `seek_index` (`waveform.rs:76`). Lo único que falta es
una variante **por ventana** en vez de por archivo entero. Ver
[05](05-detalle-de-onda.md).

## C6 — Todo el dibujo del timeline es O(proyecto), no O(viewport)

**MEDIDO.** `TransportPanelContent.tsx:5597`:

```ts
const timelineGrid = useTimelineGrid({
  durationSeconds: workspaceDurationSeconds,
  regions: buildSongTempoRegions(song),   // ← identidad nueva en CADA render
  ...
  viewportStartSeconds: 0,                          // ← no es el viewport
  viewportEndSeconds: workspaceDurationSeconds,     // ← es el proyecto entero
});
```

La función se llama `buildVisibleTimelineGrid` y recibe «visible = todo».
Además, `buildSongTempoRegions(song)` se evalúa **en el cuerpo del render**, así
que su identidad cambia siempre → el `useMemo` de `useTimelineGrid` nunca acierta
→ **la rejilla se reconstruye en cada render de `TransportPanelContent`**.

Y como `timelineGrid` cambia de identidad, `TimelineRenderer.updateState()` ve
`sceneChanged` y llama a `markAllDirty()`: **las tres capas de canvas se
repintan enteras en cada render de React**, anulando el diseño de banderas
sucias que el renderer tiene precisamente para evitarlo.

Cifras medidas (Node 20, esta máquina; un WebView2 en un portátil modesto es
3-5× más lento):

```
--- 3 canciones / 12 min ---   bars=360  beats=1080  markers=1440
    buildVisibleTimelineGrid (como está):  0,080 ms
    buildVisibleTimelineGrid (por viewport): 0,026 ms
--- 20 canciones / 80 min ---  bars=2400 beats=7200 markers=9600
    buildVisibleTimelineGrid (como está):  0,190 ms
    buildVisibleTimelineGrid (por viewport): 0,003 ms   (63× menos)
```

Y el coste **por frame** de recorrer esas listas (solo la parte JS: culling y
aritmética, sin rasterizar):

```
                                        ENTRADAS   VISIBLES   drawGridLines  etiquetas ruler
3 canciones / 12 min @ 18 px/s          1440         156+5       19,4 us        12,9 us
20 canciones / 80 min @ 18 px/s         9600         156+5       72,0 us        20,0 us
20 canciones / 80 min @ 180 px/s        9600          16+6       72,3 us        42,6 us
```

Se recorren 9 600 entradas por capa y por frame para pintar 16. `drawGridLines`
se ejecuta en dos capas (fondo del área de pistas y base del ruler), así que en
un setlist de 80 min son ~190 µs/frame de puro descarte, en una máquina rápida.

`getPrimaryRulerMarkers()` (`Renderer/drawBackground.ts:101`) además hace
`grid.markers.filter(...)` — **asigna un array nuevo de hasta 2 400 elementos en
cada frame**, y `getLabelSkipDivisor()` lo recorre entero otra vez.

**Honestidad sobre la magnitud**: esto es desperdicio real y arreglarlo es
barato (los arrays están ordenados: dos búsquedas binarias), pero **no es la
causa del trabe visible**. Es el suelo de coste que hace que todo lo demás
tenga menos margen. Se arregla porque es fácil, no porque sea el culpable.

## C7 — El subárbol del timeline no está memoizado

**LEÍDO.** `TimelineCanvasPane` recibe **74 props** en 339 líneas de JSX
(`TransportPanelContent.tsx`), no está envuelto en `memo`, y buena parte de esas
props son funciones flecha inline — así que `memo` por sí solo tampoco ayudaría.

Consecuencia: cualquier `setState` de `TransportPanelContent` (el sondeo de
transporte a 250 ms durante reproducción, cualquier cambio de estado de UI)
arrastra el render de todo el timeline.

Detalles menores de la misma familia, todos por render:

- `ref={(element) => registerAutomationHotspot(cue.id, element)}` — callback
  inline: React lo desmonta con `null` y lo vuelve a montar **en cada render**,
  para cada cue.
- `describeAutomationCue(cue, song, t)` construye una cadena por cue y render.
- `useAutomationCueHotspots` posiciona los hotspots escribiendo
  `element.style.left` en un rAF (`timeline/useAutomationCueHotspots.ts:81`).
  `left` invalida layout; `transform: translateX()` no. Es el único overlay que
  no usa el envoltorio de cámara del ruler.
- `drawTracks.ts:521` calcula `song.tracks.filter(...).length` **por carril
  visible y por frame** para contar hijos de carpeta.
- `drawAutomationLane` hace `[...cues].sort(...)` y `drawMidiLane` hace
  `.filter().sort()` en cada frame.

---

## Lo que se ha DESCARTADO

Vale tanto como lo anterior: no gastar esfuerzo aquí.

| Hipótesis | Veredicto |
| --- | --- |
| «La rejilla es cara de construir» | **No.** 0,08-0,19 ms, MEDIDO. El problema es que se reconstruye cuando no toca, no que cueste. |
| «`backdrop-filter` / `box-shadow` matan el compositor» | **No.** Los 6 `backdrop-filter` están en modales y overlays de carga, ninguno en el timeline. Las sombras del ruler son `inset`, baratas. |
| «El playhead a 60 fps re-renderiza React» | **No.** `PlayheadOverlay` escribe `style.transform` desde un rAF leyendo refs. El diseño es correcto. |
| «El arrastre de clips es lento» | **No** en el caso normal: escribe refs y el canvas los lee, sin render. **Sí** con el imán (Ctrl), por `setClipDragSnapIndicatorSeconds`. |
| «Hay que trocear `TransportPanelContent`» | **No es esto.** Ya está documentado por qué el fichero es grande y por qué partirlo no ayuda (`docs/REDESIGN_transport_refs_to_stores.md`). Ninguna causa de este documento se resuelve moviendo líneas de sitio. |
| «El autoguardado escribe en disco en cada edición» | **No.** `useAutoSave` corre por intervalo, se salta la reproducción y se salta las revisiones ya guardadas. |
| «El sondeo del transporte es demasiado frecuente» | **No por frecuencia** (250 ms tocando, 800 ms parado, con backoff si el IPC pasa de 120 ms). Sí paga la doble serialización de C3. |

---

## Mapa síntoma → causa → paso

| Síntoma | Causas | Pasos |
| --- | --- | --- |
| 1. Mover canciones va a tirones y llega tarde | C1 (render por movimiento), C2 (sin optimismo, doble IPC), C3 (doble serialización) | [02](02-arrastre-sin-rerender.md), [03](03-commit-sin-refetch.md) |
| 2. Trabe al hacer zoom | C4 (invalidación total del tile cada 1,5× + dibujo dentro del frame), C6 y C7 (el suelo de coste que quita margen) | [04](04-tiles-de-onda.md), [06](06-dibujo-por-viewport.md), [07](07-subarbol-del-timeline.md) |
| 3. Poco detalle a mucho zoom | C5 (LOD tope 256 frames), C4a (bitmap reescalado ±22 %), C4c (tile de 256 px escalado al carril) | [05](05-detalle-de-onda.md), [04](04-tiles-de-onda.md) |
