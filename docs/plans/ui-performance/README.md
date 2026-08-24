# Plan: rendimiento y detalle de la UI del timeline

Origen: el 2026-08-23 el usuario reporta tres síntomas en el timeline de
escritorio — mover canciones va a tirones y el movimiento «se realiza» tarde, un
trabe al hacer zoom a cierto nivel, y falta de detalle en las waveforms a mucho
zoom.

Diagnóstico completo, con lo medido, lo derivado y **lo descartado**, en
[`00-DIAGNOSTICO.md`](00-DIAGNOSTICO.md).

## Resumen en una frase

Los tres síntomas tienen causas distintas y localizadas: **los arrastres del
ruler pasan por React en vez de por refs**, **el commit de una edición cuesta
dos viajes de IPC en serie y un render completo**, **la caché de tiles de onda
se invalida entera cada 1,5× de zoom y rasteriza dentro del frame**, y **el LOD
más fino de la waveform tiene 256 frames por bucket, así que por encima de zoom
≈ 9,6 no hay más detalle que enseñar**.

## Pasos

| # | Paso | Depende de | Riesgo | Impacto |
| --- | --- | --- | --- | --- |
| [01](01-banco-de-medicion.md) | Banco de medición: línea base en release | — | ninguno | **base** |
| [02](02-arrastre-sin-rerender.md) | Los arrastres del ruler dejan de re-renderizar React | 01 | medio | **alto** (síntoma 1) |
| [03](03-commit-sin-refetch.md) | Commit optimista y un solo IPC | 01 | medio-alto | **alto** (síntoma 1) |
| [04](04-tiles-de-onda.md) | Tiles de onda: presupuesto, altura real, dibujo fuera del frame | 01 | medio | **alto** (síntomas 2 y 3) |
| [05](05-detalle-de-onda.md) | Detalle real a mucho zoom: picos por ventana | 04 | medio | **alto** (síntoma 3) |
| [06](06-dibujo-por-viewport.md) | Dibujar por viewport, no por proyecto entero | 01 | bajo | medio (**el más barato**) |
| [07](07-subarbol-del-timeline.md) | Aislar el subárbol del timeline | 02, 03, 06 | medio-alto | a determinar |

## Orden recomendado

```
01 (línea base)  ─┬─→  02  ─┬─→  07 (sólo si la medición lo justifica)
                  ├─→  03  ─┤
                  ├─→  06  ─┘
                  └─→  04  ──→  05
```

**Empieza por 01.** Sin línea base en release no se puede demostrar ninguna
mejora, y este repo ya se equivocó una vez diagnosticando desde el build de
desarrollo.

Después hay dos caminos independientes que pueden llevarse en paralelo:

- **Camino A — interacción** (`02 → 03 → 06 → 07`): ataca el síntoma 1 y el
  suelo de coste. Todo en el frontend.
- **Camino B — onda** (`04 → 05`): ataca los síntomas 2 y 3. Cruza a C++ en el
  paso 05.

Si sólo hay tiempo para tres cosas: **02, 03 y el punto 2 del paso 06** (un
`useMemo` de una línea). Ésas tres son la mayor parte del alivio percibido.

## Reglas que aplican a todos los pasos

1. **Medir con el build de medición.** Las cifras salen de
   `npm run profile:desktop:native` (frontend de producción + engine C++ Release
   + Rust debug), nunca de `tauri:dev`. Un build de release **no sirve**: el
   PerfHud sólo se monta cuando `cfg!(debug_assertions)` es true, y Tauri 2 sólo
   habilita DevTools en debug. El detalle y lo que ese build deja pesimista
   están en [`PROTOCOLO.md`](PROTOCOLO.md). Precedente de por qué el dev server
   no vale: `docs/REDESIGN_transport_refs_to_stores.md`, «Nota metodológica».
2. **Ningún preview de arrastre pasa por `setState`.** Se escriben refs que el
   canvas lee. Es la regla que ya cumple `hooks/useDragListeners.ts` y la que
   los arrastres del ruler rompen.
3. **Estabilidad referencial es un criterio de aceptación, no un detalle.**
   Cualquier paso que toque el hot path se valida con el PerfHud comprobando que
   `renderCounts` no sube y `canvasRenderEma` no sube. Perder esto fue lo que
   tumbó el intento de refactor anterior.
4. **No hay tests que dependan de temporización de hilos.** Hay precedente de
   dos releases tumbadas por eso (`project_ltset_lock_test_timing`).
5. **Verifica que un test de regresión sabe fallar** antes de darlo por bueno.
   Y recuerda que el E2E (round trip de WebDriver ~600 ms) es demasiado grueso
   para probar nada de este plan: las pruebas van en vitest.
6. **Nada de trabajo pesado bajo `session.lock`.** Analizar ondas bajo el lock
   ya congeló la UI 10,9 s una vez; está documentado en el propio código
   (`state/mod.rs`, comentario de `load_waveforms`).
7. **Si la medición mata una hipótesis, se cierra el paso y se dice.** Un paso
   cerrado con «medido, no hacía falta» vale tanto como uno implementado. El
   paso 07 está escrito explícitamente para poder terminar así.
8. **Regresión cero en Android.** El engine es el mismo. `cargo check` de
   escritorio **no** compila el código `cfg(target_os = "android")`: compila
   para Android antes de cerrar cualquier paso que lo toque (paso 05).
9. **Si `fileSizeBudget.test.ts` falla, la opción por defecto es extraer, no
   subir el límite.**

## Cómo medir

El protocolo (build, sesiones de referencia, los seis gestos y cómo leer cada
número) está en [`PROTOCOLO.md`](PROTOCOLO.md). La instrumentación ya está en
el árbol: `Ctrl+Shift+F` abre el HUD y `window.__lt_perf.plan()` imprime las
tablas del plan.

## Bitácora

Cada paso deja su registro en `state/NN.md`, igual que el plan de Android. El
registro debe incluir **las cifras de release antes y después**; sin eso el paso
no está terminado.
