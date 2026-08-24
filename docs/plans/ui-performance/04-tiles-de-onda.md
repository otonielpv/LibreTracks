# 04 — Caché de tiles de waveform: presupuesto, altura real y dibujo fuera del frame

**Depende de:** 01 (hay que confirmar el pico en G4 antes de escribir código).
**Toca:** `Renderer/WaveformTileCache.ts`, `Renderer/drawTracks.ts`,
`Renderer/TimelineRenderer.ts`.
**Riesgo:** medio. Cambia lo que se ve mientras se hace zoom.
**Impacto: alto.** Es la causa candidata número uno del síntoma 2 y parte del 3.

## Problema

Ver [00-DIAGNOSTICO.md, C4](00-DIAGNOSTICO.md#c4--el-tile-de-waveform-se-invalida-entero-cada-15-de-zoom-y-se-dibuja-dentro-del-frame).

Cuatro defectos independientes en `WaveformTileCache.ts`:

| # | Defecto | Consecuencia |
| --- | --- | --- |
| a | La clave del tile incluye el zoom cuantizado a **1,5×**; al cruzar un paso, **todos** los tiles visibles se invalidan a la vez | Trabe discreto «a cierto zoom» |
| b | El tile que falta se **rasteriza dentro del frame**, sin presupuesto ni cola (`getTile` → `renderWaveformTile`, llamado desde el rAF) | 44-88 tiles en un solo frame |
| c | El tile mide **256 px de alto siempre**, aunque el carril mida 18 | 14× píxeles de más; picos finos destruidos al escalar |
| d | El LRU cuenta **tiles, no bytes**: 320 × 1024×256×4 B = **320 MiB** en el peor caso, y un solo nivel de zoom ya usa ~90 | Thrashing al ir y volver de zoom; picos de RAM |

Además, `pruneNamespaces()` existe pero **no se llama desde producción** (sólo
desde su test): no hay ninguna limpieza dirigida, sólo el LRU por conteo.

## Cambio pedido

### 1. Presupuesto en bytes, y altura del tile pegada al carril

`TILE_HEIGHT_PX` deja de ser constante y pasa a derivarse de `trackHeight`,
cuantizado a unos pocos escalones para que la caché no se fragmente
(p. ej. 32 / 64 / 128 / 256, el menor que sea ≥ `trackHeight * dpr`). La altura
elegida entra en el namespace del tile.

Efecto directo: con carriles de 18 px el tile pasa de 1 MiB a 128 KiB (**8×
menos**) y desaparece el escalado 256→18 que borra los picos.

El LRU pasa a contar bytes con un techo explícito (p. ej. 48 MiB, ajustable) en
vez de 320 entradas. Un tope en bytes es el único que da una garantía real.

### 2. La rasterización sale del frame

`getTile()` deja de rasterizar. Pasa a:

- devolver el tile si está en caché;
- si no está, **encolar** su rasterización y devolver el mejor sustituto
  disponible (ver punto 3), sin bloquear.

La cola se drena con un **presupuesto por frame** (p. ej. 4 ms, medidos con
`performance.now()`), en el rAF del `TimelineRenderer`, después de pintar. Si
queda trabajo, se marca sucio y sigue en el frame siguiente. Un frame nunca
gasta más que su presupuesto en tiles.

Prioridad de la cola: **de dentro hacia fuera desde el centro del viewport**, y
descartar peticiones de tiles que ya no son visibles cuando se drena (durante un
zoom continuo se encolan tiles de niveles que ya se abandonaron).

### 3. Nunca dejar un hueco: el sustituto

Mientras el tile bueno se rasteriza, hay que pintar algo. Por orden:

1. El tile del **nivel de zoom vecino** (ya está en caché con otro namespace),
   estirado con `drawImage`. Es exactamente lo que ya se hace hoy con
   `renderScale`, sólo que aplicado también entre niveles.
2. Si no hay ninguno, el placeholder actual.

Esto convierte el trabe en una **transición de nitidez** de uno o dos frames,
que es como se comporta Ableton: la onda aparece un poco borrosa y se afina.

Para que (1) funcione, el LRU no debe expulsar el nivel vecino justo cuando se
cruza el paso. Reservar una fracción del presupuesto para «el nivel anterior».

### 4. Revisar el paso de cuantización de zoom

`WAVEFORM_ZOOM_CACHE_STEP = 1,5` implica que el bitmap se estira hasta **+22 %**
o se encoge **−18 %** respecto a su resolución nativa. Eso es blur permanente en
la mayoría de niveles de zoom.

Con (1), (2) y (3) hechos, un paso más fino (1,25× → ±11 %) cuesta más tiles
pero cada uno es más barato y ya no se rasteriza dentro del frame. **Medirlo, no
suponerlo**: hacer el paso configurable, medir G3/G4 con 1,5 y con 1,25, y
quedarse con el que gane. Si 1,5 gana, dejarlo y anotar por qué.

### 5. Llamar a `pruneNamespaces` o borrarla

Si el LRU por bytes basta, **borrar** `pruneNamespaces` y su test (código muerto
que aparenta ser una defensa). Si se decide usarla, llamarla al final de
`drawTrackClipsLayer` con los namespaces vivos. Lo que no puede quedarse es
código de limpieza que nadie invoca.

## Criterios de aceptación

- [ ] En G4 (cruzar **un** paso de zoom), el peor frame del segundo **no supera
      el presupuesto** y `waveformTileRenderMs` se reparte entre varios frames
      en vez de concentrarse en uno. Cifras de release comparadas con
      `baseline.json`.
- [ ] En G3 (zoom continuo de 1 a 16) el fps EMA no cae por debajo del umbral
      que fije la línea base menos un margen declarado en el PR.
- [ ] `waveformTileBytes` tiene un techo duro (48 MiB) y **se respeta** en G3
      con la sesión grande. **Pendiente de medir.**
- [x] Con `trackHeight` mínimo, los tiles se rasterizan a la altura reducida.
      Cubierto por `tileHeightForLane` y por un test que compara la memoria de
      un carril de 18 px contra uno de 148: 8× menos.
- [ ] La waveform con carriles bajos se ve **mejor** que antes, no sólo más
      rápida (el escalado 256→18 desaparece). Captura antes/después en el PR.
- [ ] Nunca aparece un hueco blanco donde había onda durante un zoom rápido.
- [x] `WaveformTileCache.test.ts` ampliado: cola, presupuesto por frame,
      prioridad por cercanía al centro, purga al empezar el pintado y
      cuantización de altura. El "sustituto de nivel vecino" se resolvió de otra
      forma (envolvente de baja resolución), ver el punto 3 en state/04.md.
- [x] Hay un test que **sabe fallar**: comprueba que `getTile` no rasteriza de
      forma síncrona. Con la mutación que lo devuelve al frame, 5 tests rojos.
- [x] `pruneNamespaces` **borrada**. Con la cola auto-podable y el LRU por
      bytes no hace falta.

## Notas para el implementador

- **Empieza por (1) y (2).** Son las dos que dan el resultado; (3) es lo que lo
  hace bonito y (4) es una medición, no un cambio.
- `OffscreenCanvas` no está garantizado en todas las plataformas —
  `createTileSurface` ya cae a `document.createElement("canvas")`. El
  presupuesto por frame debe funcionar igual en las dos ramas.
- No muevas la rasterización a un Worker en este paso. Transferir
  `ImageBitmap` es viable, pero es otro riesgo y otro paso; primero demuestra
  que el presupuesto por frame basta.
- El repo ya tiene precedente de tocar el pintado del timeline con criterios
  finos de nitidez (el truco de dibujar a cámara entera y desplazar por
  subpíxel con `transform`, en `TimelineRenderer.ts` y `CanvasTimeline.tsx`). No
  lo rompas al cambiar la altura del tile: esos trucos son de la rejilla, no de
  la onda, pero comparten el canvas.
- Cuidado con el DPR: hoy `prepareCanvas` escala el contexto por
  `devicePixelRatio` pero el tile se rasteriza a 1× y se estira. Al hacer la
  altura variable, decide explícitamente si el tile se rasteriza en píxeles de
  dispositivo o de CSS, y déjalo escrito en un comentario.
