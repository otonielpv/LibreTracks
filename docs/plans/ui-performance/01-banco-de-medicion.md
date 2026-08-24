# 01 — Banco de medición: línea base en release

**Depende de:** nada. **Es el primer paso y es obligatorio.**
**Toca:** `apps/desktop/src/features/transport/perf/perfMetrics.ts`,
`perf/PerfHud.tsx`, `docs/plans/ui-performance/baseline.json` (nuevo).
**Riesgo:** ninguno (instrumentación opt-in, no toca lógica).
**Impacto:** base. Sin él ningún paso posterior puede demostrar nada.

## Por qué existe este paso

Este repo ya se equivocó una vez midiendo en desarrollo. De
`docs/REDESIGN_transport_refs_to_stores.md`:

> La misma sesión registró picos de `worstFrameMs` de 90-200 ms y un p99 de
> `getTransportSnapshot` de ~120 ms, y se llegó a diagnosticar un problema de
> IPC. **Era un artefacto del build de desarrollo.** […] Cualquier medición
> futura debe hacerse sobre build de release antes de sacar conclusiones.

Y la memoria del proyecto lo repite: *el PerfHud en dev da picos de frame/IPC
falsos; sólo los `renderCounts` son fiables en dev*.

Además hay precedente de teorizar antes de medir y acertar en la causa
equivocada: el tembleque del seguimiento del playhead se atribuyó a la cámara y
resultó ser el `Math.round` de las líneas de rejilla.

**Regla del plan: ninguna afirmación de rendimiento entra en un PR sin cifras
de release.**

## Qué falta en el HUD actual

`perfMetrics.ts` ya mide: fps (EMA), peor frame del último segundo, contadores
de render por componente, IPC de `getTransportSnapshot` (EMA), hueco
snapshot→commit, y coste de pintado del canvas (EMA + peor del segundo).

Falta exactamente lo que hace falta para este plan:

| Métrica nueva | Para qué |
| --- | --- |
| `waveformTileRenders` (contador monotónico) + `waveformTileRenderMs` (EMA y peor del segundo) | Ver el pico de C4 al cruzar un paso de zoom de 1,5×. |
| `waveformTileCacheSize` (tiles vivos) y `waveformTileBytes` (estimado) | Ver el thrashing del LRU y los 320 MiB del caso peor. |
| `gridBuilds` (contador) | Demostrar C6: la rejilla se reconstruye por render. |
| `pointerMoveRenders` — renders provocados dentro de un arrastre | Demostrar C1 y luego que baja a 0. |
| `editCommitMs` — de `pointerup` a que el cambio es visible | Demostrar C2. Es **la métrica que le importa al usuario**. |

`editCommitMs` es la importante y merece detalle: se arranca un temporizador en
el `pointerup` del arrastre y se para cuando el render que ya muestra la
posición nueva se ha confirmado (`useEffect` sin deps tras el `setSong`
correspondiente). Sin ese número, «va más rápido» es una opinión.

## Cambio pedido

### 1. Métricas nuevas en `perfMetrics.ts`

Mismo patrón que las existentes: `recordX()` que es un no-op barato cuando el
HUD está apagado, valores en variables de módulo, lectura por snapshot desde el
HUD a 1 Hz. **No introducir ningún render de React por métrica.**

### 2. Puntos de instrumentación

- `WaveformTileCache.getTile()` — envolver la rama de fallo de caché.
- `WaveformTileCache` — exponer `size` y bytes estimados.
- `useTimelineGrid` — contar construcciones reales del memo.
- Los tres arrastres del ruler y el de clips — marcar inicio/fin de gesto.
- El commit de cada edición — `editCommitMs`.

### 3. Protocolo de medición reproducible

Un fichero `docs/plans/ui-performance/PROTOCOLO.md` con los gestos exactos, para
que dos personas midan lo mismo:

1. Sesión de referencia: la de capturas (3 canciones / 57 marcas). **Usar
   siempre una copia** y matar el proceso que deja el puerto 3030 ocupado.
2. Build: `npm run profile:desktop:native`, no `tauri:dev` **ni**
   `build:desktop:native` — ver PROTOCOLO.md, «Por qué ese build».
3. Gestos, 5 repeticiones cada uno, transporte **parado** y luego **tocando**:
   - G1: arrastrar la 2ª canción 8 compases a la derecha y soltar.
   - G2: arrastrar una marca de sección 4 compases.
   - G3: rueda de zoom de zoom 1 a zoom 16 en un movimiento continuo.
   - G4: rueda de zoom cruzando **un solo** paso de 1,5× (aísla C4a).
   - G5: pan horizontal de 10 s de timeline.
   - G6: arrastrar un clip con y sin Ctrl (imán).
4. Volcar el snapshot del HUD a `baseline.json` (añadir un botón «copiar JSON»
   al HUD, o `window.__ltPerf()` en consola).

### 4. Segunda sesión de referencia, grande

La sesión de capturas es pequeña. C6 y C4 escalan con el tamaño del proyecto, así
que hace falta un caso grande y **reproducible**: un setlist de **20 canciones ×
4 min** con 25 pistas, generado por script (`scripts/`), no a mano. Guardar el
generador en el repo.

## Criterios de aceptación

- [x] Las 5 métricas nuevas aparecen en el HUD y son cero/no-op con el HUD
      apagado. Verificado leyendo el código, no solo mirando la pantalla.
- [x] `PROTOCOLO.md` existe y describe los 6 gestos con precisión suficiente
      para repetirlos.
- [x] Existe el script generador del setlist grande y produce una sesión
      abrible. Verificado por `crates/libretracks-project/tests/perf_session_fixture.rs`,
      que carga la sesión generada con `load_song`.
- [ ] **`baseline.json` está commiteado con cifras de un build de release**, con
      las dos sesiones, los 6 gestos y transporte parado/tocando. Incluye modelo
      de CPU y resolución de pantalla.
- [ ] El `baseline.json` contiene, como mínimo, evidencia numérica de C1
      (renders por `pointermove` > 0 en G1/G2), C2 (`editCommitMs` en G1) y C4
      (pico de `waveformTileRenderMs` en G4).
- [x] La instrumentación no aparece en `fileSizeBudget.test.ts` como regresión
      de tamaño de fichero — si el presupuesto salta, **extraer, no subir el
      límite**. `TimelineCanvasPane.tsx` quedó intacto: la detección de gestos
      se hizo en los listeners de ventana justamente por eso.

## Notas para el implementador

- Si al medir G4 resulta que el pico de tiles **no** aparece, dilo y para: el
  paso 04 pierde su justificación y hay que buscar la causa real del trabe de
  zoom antes de escribir código. Este plan prefiere una hipótesis muerta a una
  optimización sin evidencia.
- No midas contención de hilos por temporización: hay precedente de dos
  releases tumbadas por eso (`project_ltset_lock_test_timing`).
- **El HUD NO existe en un build de release.** `is_debug_build()` es
  `cfg!(debug_assertions)` y `App.tsx` sólo monta el PerfHud cuando eso es
  true; Tauri 2 tampoco habilita DevTools en release (falta la feature
  `devtools` en `Cargo.toml`). Por eso el plan mide con
  `npm run profile:desktop:native` (`tauri build --debug`): frontend de
  producción, engine C++ Release, Rust debug. Lo único pesimista son los
  tiempos de IPC del lado Rust; compara siempre profile contra profile.
