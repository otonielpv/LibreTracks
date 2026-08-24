# 06 — El timeline se dibuja por viewport, no por proyecto entero

**Depende de:** 01. Independiente del resto.
**Toca:** `TransportPanelContent.tsx` (dos líneas), `packages/shared/src/timelineMath.ts`,
`Renderer/drawBackground.ts`, `Renderer/drawTracks.ts`.
**Riesgo:** bajo. Cambios locales, con tests que ya existen.
**Impacto: medio.** No es la causa del trabe, pero es el suelo de coste que le
quita margen a todo lo demás, y es el cambio más barato del plan.

## Problema

Ver [00-DIAGNOSTICO.md, C6](00-DIAGNOSTICO.md#c6--todo-el-dibujo-del-timeline-es-oproyecto-no-oviewport).

Tres cosas, todas medidas:

**(a) La rejilla se pide para el proyecto entero.** `TransportPanelContent.tsx:5597`:

```ts
viewportStartSeconds: 0,
viewportEndSeconds: workspaceDurationSeconds,
```

La función se llama `buildVisibleTimelineGrid` y recibe «visible = todo». En un
setlist de 80 min eso son **9 600 entradas** de rejilla para pintar 16.

**(b) El memo de la rejilla nunca acierta.** En la misma llamada:

```ts
regions: buildSongTempoRegions(song),   // ← evaluado en el cuerpo del render
```

Identidad nueva en cada render → `useMemo` fallido → rejilla reconstruida
siempre. Y como `timelineGrid` cambia de identidad,
`TimelineRenderer.updateState()` marca `sceneChanged` y llama a
`markAllDirty()`: **las tres capas de canvas se repintan enteras en cada render
de React**, anulando el sistema de banderas sucias que el renderer tiene
precisamente para evitarlo.

**(c) Los bucles de dibujo recorren todo y descartan.** `drawGridLines` recorre
`grid.beats` y `grid.bars` completos por capa y por frame;
`getPrimaryRulerMarkers` hace `grid.markers.filter(...)` — **un array nuevo de
hasta 2 400 elementos en cada frame** — y `getLabelSkipDivisor` lo recorre otra
vez entero.

Medido (Node, esta máquina; WebView2 en un portátil modesto es 3-5× más lento):

```
                                        ENTRADAS   VISIBLES   drawGridLines  etiquetas
3 canciones / 12 min @ 18 px/s            1440       156+5       19,4 us      12,9 us
20 canciones / 80 min @ 18 px/s           9600       156+5       72,0 us      20,0 us
20 canciones / 80 min @ 180 px/s          9600        16+6       72,3 us      42,6 us

buildVisibleTimelineGrid, 20 canciones:  0,190 ms (como está) → 0,003 ms (por viewport)
```

## Cambio pedido

### 1. Pasar el viewport real

`TransportPanelContent` ya sabe la ventana visible: tiene `cameraXRef`,
`livePixelsPerSecondRef` y `laneViewportWidth`. Pasar
`viewportStartSeconds`/`viewportEndSeconds` de verdad, **con un margen** de un
compás a cada lado para que un pan no descubra rejilla vacía.

Ojo: cámara y zoom vivos son refs y cambian sin render, así que la rejilla no
puede depender de ellos directamente o volvería a reconstruirse siempre.
Cuantizar la ventana a bloques (p. ej. múltiplos de medio viewport) y usar
**ese** valor cuantizado como dependencia del memo: la rejilla se reconstruye
cuando el pan cruza un bloque, no en cada frame.

### 2. Memoizar `buildSongTempoRegions`

```ts
const songTempoRegions = useMemo(() => buildSongTempoRegions(song), [song]);
```

Un `useMemo` de una línea. **Este es probablemente el cambio con mejor relación
esfuerzo/beneficio de todo el plan**: elimina el repintado completo de las tres
capas en cada render de React.

Comprobar que no hay más llamadas a `buildSongTempoRegions` en cuerpos de
render o en manejadores de `pointermove` (el paso 02 se ocupa de esas últimas).

### 3. Búsqueda binaria en los bucles de dibujo

`grid.bars`, `grid.beats` y `grid.markers` están **ordenados**. Sustituir el
recorrido completo por dos búsquedas binarias que acoten el rango visible, y
recorrer sólo ese rango.

En `getPrimaryRulerMarkers`, sustituir el `filter` (que asigna) por un
recorrido con índices sobre el rango ya acotado. `getLabelSkipDivisor` puede
calcularse desde `grid.beatDurationSeconds` y `grid.barLabelStep` sin recorrer
nada, o como mucho sobre el rango visible.

### 4. Limpiar las asignaciones por frame de `drawTracks`

Todas en `Renderer/drawTracks.ts`, todas dentro del bucle de dibujo:

- `snapshot.song.tracks.filter(c => c.parentTrackId === track.id).length` — por
  carril visible y por frame (`:519`). Precalcular un `Map<trackId, childCount>`
  una vez por snapshot.
- `drawAutomationLane`: `[...cues].sort(...)` por frame. Ordenar una vez.
- `drawMidiLane`: `.filter().sort()` por frame y por pista. Agrupar una vez.
- `selectedClipIds.includes(clip.id)` por clip. Usar un `Set`.

## Criterios de aceptación

- [x] El contador `gridBuilds` (paso 01) deja de crecer con los renders.
      Test de comportamiento `src/app/timeline-grid-rebuilds.test.tsx`: fuerza
      renders del panel sin tocar la canción y exige `gridBuilds` constante.
      Con el bug reintroducido da `expected 7 to be +0`.
- [x] `TimelineRenderer` **no** marca las tres capas sucias en un render de
      React que no cambie nada relevante. Es consecuencia directa de lo
      anterior: `timelineGrid` ya no cambia de identidad, así que `updateState`
      no ve `sceneChanged`.
- [x] En la sesión grande (20 canciones), el coste JS por frame de los bucles de
      rejilla baja al menos 10×. **Medido: 99,7 µs → 1,2 µs (83×) a 18 px/s;
      95,1 µs → 0,2 µs (475×) a 180 px/s.** El propio banco comprueba que las
      dos versiones pintan el mismo número de líneas.
- [x] `timelineMath.test.ts` sigue pasando **sin cambios**.
- [x] Las etiquetas del ruler aparecen exactamente en las mismas posiciones que
      antes, con el mismo `labelSkipDivisor`.
      `Renderer/drawRulerGridLabels.test.ts` compara contra el algoritmo
      anterior reimplementado, en 5 zooms × 7 posiciones de cámara incluyendo
      los bordes. Verificado que **sabe fallar** con dos mutaciones (quitar el
      margen de 2 s del acotado; caché que no comprueba la identidad de la
      rejilla).
- [ ] Un pan rápido no descubre rejilla vacía en ningún momento, ni al principio
      ni al final del proyecto. **Pendiente de comprobación a mano en el build
      de medición** (el test cubre el acotado, no la percepción).
- [ ] No reaparece el tembleque del seguimiento del playhead a poco zoom.
      **Pendiente de comprobación a mano.** Riesgo bajo: no se tocó el cálculo
      de `x` ni el redondeo, sólo qué entradas se recorren.

## Decisión sobre el punto 1: NO se hace

El punto 1 (pasar el viewport real, cuantizado, a `useTimelineGrid`) **se cierra
sin implementar**, por la regla 7 del plan.

Con 2, 3 y 4 hechos, lo que quedaba por ganar es: construir la rejilla completa
cuesta 0,19 ms y ahora ocurre **sólo al cambiar la canción**, no por render; y
los bucles de dibujo ya son O(visible). Lo único que persiste es la memoria de
~9600 objetos de marca en un setlist de 80 minutos.

Frente a eso, el punto 1 exige cuantizar la ventana para que la cámara (que es
un ref y cambia sin render) no reconstruya la rejilla cada frame, y arrastra dos
trampas documentadas del repo: el ancho de viewport circular y el tembleque del
playhead. Riesgo real a cambio de una ganancia que ya no se mide.

Si algún día un setlist mucho mayor hace que esa memoria importe, el punto 1
sigue escrito arriba y se puede retomar.

## Notas para el implementador

- **El punto 2 solo ya justifica el paso.** Si el tiempo aprieta, haz 2 y 4,
  mide, y decide si 1 y 3 hacen falta.
- No cambies la semántica de `buildVisibleTimelineGrid`: el bucle por región,
  el redondeo a frames de timebase y los filtros de borde
  (`seconds >= region.endSeconds - 1 frame`) existen por razones de exactitud
  musical, no de rendimiento.
- La memoria del proyecto avisa de dos trampas cercanas: **medir antes de
  teorizar** (el tembleque del playhead se atribuyó a la cámara y era la
  rejilla) y **el ancho del viewport es circular** si se mide del `ruler-track`
  (hay que medirlo del `scroll-viewport` menos `HEADER_WIDTH`). Al pasar el
  viewport real a la rejilla, usa `laneViewportWidth`, que ya está bien
  calculado.
