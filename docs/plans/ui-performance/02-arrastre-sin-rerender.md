# 02 — Los arrastres del ruler dejan de re-renderizar React

**Depende de:** 01 (para poder demostrar la mejora).
**Toca:** `timeline/TimelineCanvasPane.tsx`, `timeline/useMarkerMoveDrag.ts`,
`timeline/useAutomationCueHotspots.ts`, `TransportPanelContent.tsx` (una línea).
**Riesgo:** medio. Toca el hot path del arrastre, pero el patrón destino ya
existe y está probado en el repo.
**Impacto: alto.** Es la mitad «va a tirones» del síntoma 1.

## Problema

Ver [00-DIAGNOSTICO.md, C1](00-DIAGNOSTICO.md#c1--el-arrastre-de-una-canción-hace-setstate-en-cada-pointermove).

Cuatro gestos hacen `setState` por movimiento de puntero, y cada uno re-renderiza
`TimelineCanvasPane` entero (890 líneas de JSX, 10 bucles `.map()`):

| Gesto | Estado | Fichero |
| --- | --- | --- |
| Mover región (canción) | `regionMovePreview` | `TimelineCanvasPane.tsx:841` |
| Redimensionar región | `regionResizePreview` | `TimelineCanvasPane.tsx:648`, `:718` |
| Mover marca / cue | `preview` | `useMarkerMoveDrag.ts:260` |
| Arrastrar clip **con imán (Ctrl)** | `clipDragSnapIndicatorSeconds` | `TransportPanelContent.tsx:937` |

El patrón correcto ya está escrito y documentado en este repo:
`hooks/useDragListeners.ts` escribe `clipPreviewSecondsRef` /
`clipPreviewTrackIdRef` y el canvas los lee directamente, sin pasar por React.
`PlayheadOverlay` hace lo mismo con `style.transform` desde un rAF.

## Cambio pedido

### 1. El preview vive en un ref, no en estado

Para los tres gestos del ruler, sustituir el `useState` por un ref +
notificación al bucle de dibujo:

```ts
// antes
const [regionMovePreview, setRegionMovePreview] = useState<…>(null);

// después
const regionMovePreviewRef = useRef<…>(null);   // lo lee el rAF del ruler
```

`useMarkerMoveDrag` **ya tiene** el ref espejo (`previewRef`, `:132`) para el
rAF de hotspots. Ahí el trabajo es invertir la relación: el ref pasa a ser la
fuente de verdad y el estado desaparece.

### 2. Quién pinta el preview

Hoy el preview llega al canvas por props (`regions={song.regions}` con los
valores ya sustituidos en el JSX). Debe llegar por el mismo camino que el
fantasma del clip: **el snapshot del renderer lleva el ref, y el dibujo lo
consulta en cada frame**.

`TimelineRenderer` ya tiene el mecanismo exacto para esto
(`Renderer/TimelineRenderer.ts:237`): compara la identidad de
`clipPreviewSecondsRef.current` con la del frame anterior y marca sucio cuando
cambia. Replicarlo para el preview del ruler (`CanvasTimeline` tiene su propio
bucle rAF con `sceneVersionRef`, así que ahí basta con leer el ref y comparar).

El envoltorio DOM del ruler ya se mueve con **una sola** transformación
(`overlayContentRef.current.style.transform`, `CanvasTimeline.tsx:524`), así que
los hotspots invisibles siguen en su sitio sin trabajo por elemento. Sólo hay
que mover el hotspot **arrastrado**.

### 3. Sacar el trabajo pesado del bucle de movimiento

En `updateRegionMove` se recalcula por movimiento:

```ts
buildSongTempoRegions(song)     // reconstruye + ordena
snapToTimelineGrid(...)          // vuelve a normalizar todas las regiones dentro
```

Las regiones de tempo **no cambian durante el arrastre**. Calcularlas una vez en
`beginRegionMove` y guardarlas en el estado del drag. Igual en
`useMarkerMoveDrag`.

### 4. El imán del clip

`setClipDragSnapIndicatorSeconds` es un `useState` en `TransportPanelContent`,
el componente más caro del árbol, y se llama en cada `mousemove` mientras el
imán está activo. Pasa a ref, y la línea guía la pinta el canvas (que ya sabe
dibujar `lt-marker-drop-guide` para las marcas).

### 5. `useAutomationCueHotspots` deja de escribir `left`

`element.style.left = …` invalida layout en cada frame para cada cue
(`useAutomationCueHotspots.ts:81`). Cambiar a `transform: translateX(...)` con
un `left: 0` fijo. Es una línea y quita el layout del bucle rAF.

Aprovechar para dejar de reasignar `positionsRef.current = new Map(...)` en cada
render (`useAutomationCueHotspots.ts:46`): reconstruirlo sólo cuando cambia la lista de cues.

## Criterios de aceptación

- [x] Los renders **no crecen con los movimientos del puntero**. Cubierto por
      tests unitarios en vez de sólo por el HUD, que es más barato de repetir:
      `useRegionDrag.test.tsx` exige 0 renders en 40 movimientos, y
      `useMarkerMoveDrag.test.tsx` compara 5 contra 50 movimientos y exige el
      mismo número. Verificado que ambos **saben fallar** con un `setState` por
      movimiento (`expected 40 to be +0`, `expected 50 to be 5`).
- [ ] Confirmación en el HUD sobre el build de medición, comparada con
      `baseline.json`. **Pendiente**: hay que volver a medir con G1/G2/G6.
- [ ] El preview visual sigue siendo exacto: la región/marca sigue al cursor sin
      retraso perceptible y respeta el snap a rejilla y el bypass con Shift.
- [ ] El clamp contra regiones vecinas sigue impidiendo el solape (es lo que
      protege al engine, que rechaza regiones solapadas).
- [x] `buildSongTempoRegions` **no** se llama dentro de ningún manejador de
      `pointermove`. El del arrastre de regiones sigue ahí (`useRegionDrag`),
      pero ya no cuesta un render; el de `normalizeTimelineSeekSeconds` se
      arregló en el paso 06 con el memo. **Pendiente**: sacarlo también del
      bucle de `updateRegionMove` (punto 3 de este paso, no hecho).
- [x] Los tests existentes siguen pasando: `useMarkerMoveDrag.test.tsx`,
      `markerLaneDrag.test.ts`, `markerMoveHandlers.test.ts`,
      `automationCueDragGeometry.test.ts`, `clipSnapping.test.ts`.
- [x] Hay al menos un test nuevo que **sabe fallar**: comprueba que un ciclo
      completo de `pointerdown → N × pointermove → pointerup` sobre una región
      produce **cero** renders del componente.
- [ ] Los E2E de sesión siguen verdes (`tests/e2e/session.e2e.ts`).
      **Pendiente**: sólo corren en Windows y no se han lanzado en esta tanda.

## Notas para el implementador

- **La restricción que no se puede romper** (de
  `docs/REDESIGN_transport_refs_to_stores.md`): si algo pasa a un store, debe
  ser con suscripción **fuera** de React (`store.subscribe` / `getState()`),
  nunca con un hook que dispare render por frame. Aquí ni siquiera hace falta
  store: un ref local basta, porque el consumidor es el bucle de dibujo del
  propio componente.
- No conviertas esto en «extraigamos `TimelineCanvasPane`». El fichero se queda
  donde está; sólo cambia cómo viaja el preview.
- El E2E no sirve para probar esto: el round trip de WebDriver (~600 ms) es más
  grueso que el gesto. La prueba va en vitest, simulando eventos.
- Cuidado con `setPointerCapture`: al quitar el re-render, el elemento ya no se
  recrea entre movimientos — eso es bueno, pero revisa que el `classList.add`
  /`remove` de `is-moving` sigue teniendo efecto (antes lo re-aplicaba el
  render).
