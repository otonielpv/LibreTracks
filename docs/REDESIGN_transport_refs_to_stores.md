# Rediseño pendiente: refs mutables → stores en TransportPanelContent

Estado: **no empezado**. Documento escrito el 2026-07-20 tras una sesión de
refactor que llevó el archivo de 8867 a 8371 líneas y que se paró justo aquí,
al descubrir que el trabajo restante no es mover código sino cambiar cómo se
representa el estado.

## Por qué existe este documento

`apps/desktop/src/features/transport/TransportPanelContent.tsx` sigue teniendo
~8370 líneas después de sacar todo lo que tenía una frontera limpia. La
pregunta natural —"¿por qué no se parte en componentes más pequeños?"— tiene
una respuesta concreta y medible, y merece quedar escrita para no volver a
intentar el camino equivocado.

**El archivo es grande porque sus partes comparten estado mutable de verdad, no
por descuido.** Las 102 `useRef` no son clusters separables: son un grafo denso.

## El dato que lo demuestra

Medición sobre el archivo (2026-07-20, 8371 líneas):

| Métrica | Valor |
|---|---|
| `useRef` totales | 102 |
| Refs con ≥8 usos repartidos por el archivo | 15 |
| Refs con 1–2 usos | 40 |

Las más extendidas:

```
37  songRef
21  livePixelsPerSecondRef
19  displayPositionSecondsRef
18  snapshotRef
17  cameraXRef
14  timelineDurationSecondsRef
```

Y la comprobación que mató el intento de extraer un hook `useTimelineCamera`
(el subsistema de cámara/seek/zoom, ~354 líneas contiguas):

- Refs que toca ese bloque: **27**
- De ellas, **exclusivas del bloque: 2** (`activeSongRegionIdRef`,
  `activeTempoRegionKeyRef`)
- **Compartidas con el resto del archivo: 25**

Extraerlo obligaría a pasarle 25 refs como parámetros. Eso no es una frontera:
es el mismo acoplamiento con una firma enorme por delante. Bajaría el conteo de
líneas y empeoraría el diseño.

## Qué SÍ funcionó (y por qué)

Los cortes que salieron bien en la sesión del 2026-07-20 tenían todos frontera
real — dependencias que se podían inyectar y contar con los dedos:

- `tracks/trackHeaderHandlers.ts`, `compact/compactSongHandlers.ts` — handlers
  puros con IPC, patrón `create*Handlers` (ver [[project_transport_refactor]]).
- `hooks/useLibraryState.ts`, `hooks/useSongWaveforms.ts`,
  `hooks/useMidiRawMessages.ts` — efectos autocontenidos.
- `hooks/useDragListeners.ts` — 404 líneas, el efecto más grande del archivo.

La regla que los distingue: **si el bloque toca ≤5 refs compartidas, se
extrae; si toca 25, no.**

## El rediseño real, si algún día se hace

No es "mover código a ficheros". Es cambiar la representación del estado del
timeline: que **cámara y posición dejen de vivir en refs mutables leídas desde
veinte sitios** y pasen a un store con suscripción, al estilo de
`useTimelineUIStore` / `useTransportStore` / `songStore` (este último añadido en
esa misma sesión, commit `fd0a800`).

Orden sugerido, de menos a más arriesgado:

1. `cameraXRef` + `liveZoomLevelRef` + `livePixelsPerSecondRef` → store de
   viewport. Son las que más consumidores tienen tras `songRef` y forman un
   grupo coherente (la transformación segundos↔píxeles).
2. `displayPositionSecondsRef` + `snapshotRef` + `playbackVisualAnchorRef` →
   store de posición. **Máximo cuidado**: es el hot path del playhead a 60fps.
3. El resto se vuelve extraíble solo, porque las funciones dejan de necesitar
   que les inyecten refs.

### Restricción que NO se puede romper

El playhead se mueve mutando `displayPositionSecondsRef.current` **sin
setState**, y el fantasma del drag se pinta escribiendo en
`clipPreviewSecondsRef` / `clipPreviewTrackIdRef` que el canvas lee directo. Un
intento anterior de refactor se revirtió precisamente por perder esto: al
extraer lógica se perdió la estabilidad referencial y los paneles hijos pasaron
a re-renderizar cada frame → bloqueo de UI.

Si estas refs pasan a un store, **debe ser con suscripción fuera de React**
(`store.subscribe(...)` o `getState()`), nunca con un hook que dispare render
por frame. Cualquier paso de este rediseño se valida con el PerfHud
(`Ctrl+Shift+F`) comprobando que `renderCounts` NO sube.

## Por qué no se hace ahora

Medición con el PerfHud sobre 23 s de reproducción (build de desarrollo):

```
TransportPanelContent:  7.0 renders/s
PlayheadOverlay:       12.9 renders/s
TimelineCanvasPane:     6.5 renders/s
canvasRenderEma:        0.3–0.5 ms
```

7 renders/s con el playhead corriendo es un resultado sano: el diseño de refs
está haciendo su trabajo. **No hay problema de rendimiento que justifique el
riesgo.** El usuario confirmó además que la app compilada con el instalador va
fluida.

Nota metodológica: la misma sesión registró picos de `worstFrameMs` de 90–200 ms
y un p99 de `getTransportSnapshot` de ~120 ms, y se llegó a diagnosticar un
problema de IPC. **Era un artefacto del build de desarrollo** (React en modo dev,
Vite/HMR, el propio HUD midiendo). En release no se reproduce. Cualquier
medición futura debe hacerse sobre build de release antes de sacar conclusiones
sobre el motor.

## Resumen para quien llegue nuevo

- El tamaño del archivo **no** es deuda por dejadez; es el reflejo de un estado
  compartido real.
- Los cortes fáciles ya están hechos. Lo que queda pide rediseño de
  representación, no reorganización.
- Antes de intentar extraer cualquier bloque: **cuenta cuántas de sus refs se
  usan fuera**. Si son muchas, no hay frontera ahí.
- No empieces por el conteo de líneas. Empieza por una medición que demuestre
  que hay un problema.
