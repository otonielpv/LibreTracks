# 07 — Aislar el subárbol del timeline de los renders del panel

**Depende de:** 02, 03 y 06 (los tres quitan renders; este mide lo que queda).
**Toca:** `TransportPanelContent.tsx`, `timeline/TimelineCanvasPane.tsx`.
**Riesgo:** medio-alto por naturaleza (es el refactor que ya salió mal una vez).
**Impacto:** a determinar. **Este paso puede terminar en «no se hace».**

## Por qué este paso va el último y con una advertencia

`docs/REDESIGN_transport_refs_to_stores.md` documenta un intento previo de
refactor que **se revirtió** porque al extraer lógica se perdió la estabilidad
referencial y los paneles hijos pasaron a re-renderizar cada frame → bloqueo de
UI. Y concluye, con medición:

> 7 renders/s con el playhead corriendo es un resultado sano […] **No hay
> problema de rendimiento que justifique el riesgo.**

Esa medición es de julio de 2026 y de la sesión de capturas, que es pequeña.
Este paso existe para **volver a medirla** con la sesión grande y con los pasos
02/03/06 ya hechos, y decidir con datos si queda algo por hacer.

**Si tras 02, 03 y 06 el HUD dice que los renders restantes no cuestan, este
paso se cierra escribiendo eso en el estado y no se toca código.** Cerrar un
paso con «medido, no hace falta» es un resultado válido y preferible a un
refactor especulativo.

## Problema (si sigue existiendo tras 02/03/06)

Ver [00-DIAGNOSTICO.md, C7](00-DIAGNOSTICO.md#c7--el-subárbol-del-timeline-no-está-memoizado).

`TimelineCanvasPane` recibe **74 props** en 339 líneas de JSX, no está en `memo`,
y buena parte de esas props son funciones flecha inline — así que `memo` a secas
tampoco serviría. Cualquier `setState` de `TransportPanelContent` arrastra el
render de todo el timeline.

Detalles menores de la misma familia, éstos sí baratos de arreglar y sin riesgo:

- `ref={(element) => registerAutomationHotspot(cue.id, element)}` — callback
  inline: React lo llama con `null` y luego con el elemento **en cada render**,
  para cada cue.
- `describeAutomationCue(cue, song, t)` construye una cadena por cue y render.
- `positionsRef.current = new Map(...)` en el cuerpo de
  `useAutomationCueHotspots` (`:46`), en cada render.

## Cambio pedido

### 0. Medir primero (obligatorio antes de escribir código)

Con 02, 03 y 06 ya integrados, repetir el protocolo del paso 01 y registrar:

- `renderCounts` de `TransportPanelContent`, `TimelineCanvasPane`,
  `TimelineTrackCanvas` y `PlayheadOverlay`, parado y reproduciendo, en las dos
  sesiones.
- El coste real de esos renders (`worstFrameMs` correlacionado con ellos).

**Umbral de decisión, declarado antes de mirar los números:** si en la sesión
grande, reproduciendo, `TimelineCanvasPane` re-renderiza más de ~10 veces por
segundo **y** eso se correlaciona con frames por encima del presupuesto, se
sigue. Si no, se para.

### 1. Lo barato y sin riesgo (hacerlo pase lo que pase)

- Estabilizar el callback de `ref` con `useCallback` por cue, o cambiar a un
  patrón de `data-cue-id` + una sola consulta al DOM, para que React no
  desmonte y remonte cada ref en cada render.
- Memoizar `describeAutomationCue` por cue.
- Reconstruir `positionsRef` sólo cuando cambia la lista de cues.

### 2. Si la medición lo justifica: reducir la superficie de props

Antes de tocar nada, **contar**: de las 74 props, cuántas cambian de identidad
en un render que no cambia nada del timeline. Ésa es la cifra que dice si vale
la pena, igual que el conteo de refs que mató el intento de extraer
`useTimelineCamera` (27 refs tocadas, 25 compartidas → no había frontera).

Si el conteo dice que sí, la dirección **no** es partir el componente: es que
las props dejen de cambiar de identidad.

- Los ~40 manejadores inline se agrupan en un objeto estable creado una sola vez
  con `useMemo`, leyendo estado volátil por getters/refs — el patrón
  `create*Handlers(deps)` que ya está validado en este repo
  (`tracks/trackHeaderHandlers.ts`, `compact/compactSongHandlers.ts`,
  `colors/colorHandlers.ts`) y que `CLAUDE.md` señala como el camino correcto.
- Con las props estables, `memo` sobre `TimelineCanvasPane` empieza a servir.

### 3. Lo que NO se hace en este paso

- **No** se convierten `cameraXRef` / `displayPositionSecondsRef` en stores. Ese
  es el rediseño de `REDESIGN_transport_refs_to_stores.md`, tiene su propio
  documento, y su restricción («suscripción fuera de React, nunca un hook que
  dispare render por frame») sigue vigente.
- **No** se parte `TransportPanelContent` en componentes. Ya está medido y
  escrito por qué no hay frontera.

## Criterios de aceptación

- [ ] **La medición del punto 0 está en el PR**, con las dos sesiones, antes de
      cualquier cambio de código más allá del punto 1. Incluye el umbral de
      decisión y qué se decidió.
- [ ] El punto 1 está hecho y no cambia comportamiento visible.
- [ ] Si se hizo el punto 2: `renderCounts` de `TimelineCanvasPane` baja de
      forma medida y **`canvasRenderEma` NO sube**. Esta segunda condición es la
      que detecta el fallo del intento anterior (perder estabilidad referencial
      y acabar repintando cada frame).
- [ ] Si se hizo el punto 2: el arrastre de clips, el de regiones, el imán, el
      seguimiento del playhead y el drop de biblioteca siguen funcionando. Los
      E2E de sesión verdes.
- [ ] Si se decidió **no** hacer el punto 2: el estado del paso lo dice con las
      cifras que lo respaldan, y el paso se cierra. **Esto cuenta como paso
      completado.**
- [ ] `fileSizeBudget.test.ts` pasa. Si salta, **extraer, no subir el límite**.

## Notas para el implementador

- La regla del repo para saber si un bloque se puede extraer está en
  `docs/REDESIGN_transport_refs_to_stores.md`: **cuenta cuántas de sus refs se
  usan FUERA del bloque; si son muchas, no hay frontera ahí**. Aplícala antes de
  mover una sola línea.
- No empieces por el conteo de líneas. Empieza por la medición que demuestre que
  hay un problema. Ese consejo está escrito en el documento anterior y este paso
  existe para respetarlo, no para saltárselo con más ceremonia.
- Si al medir descubres que el render que sobra viene de un sitio inesperado
  (p. ej. el sondeo del transporte publicando un objeto nuevo en el store),
  arregla **eso** y cierra el paso. Es el mejor resultado posible.
