# Plan: paralelizar el render de audio y sanear el hilo de tiempo real

Origen: el 2026-09-03 un usuario reportó que al activar el **warp** en una
canción la reproducción "cruje, como arenosa", con el medidor de **Carga de
audio al 96 %**. La investigación que siguió encontró que el coste del warp es
lineal con el número de pistas, que todo el render corre en **un solo hilo**, y
que ese hilo comete tres violaciones de tiempo real que ya estaban documentadas
en el repo como causa de stalls.

Evidencia medida y hallazgos de código en
[`00-DIAGNOSTICO.md`](00-DIAGNOSTICO.md). **Todo agente debe leerlo antes de
tocar nada.**

## Qué persigue el plan

| Objetivo | Paso que lo entrega |
| --- | --- |
| Que el warp deje de saturar la CPU en sesiones grandes | 08 (~3,8x medido con 4 hilos) |
| Que desaparezcan los picos esporádicos del callback | 03, 04, 05 |
| Que activar warp sin cambiar el tempo salga gratis | 06 |
| Poder demostrar cualquiera de las tres cosas | 01, 02 |

## Pasos

| # | Paso | Depende de | Riesgo | Impacto |
| --- | --- | --- | --- | --- |
| [01](01-banco-y-linea-base.md) | Banco del callback y línea base | — | ninguno | base |
| [02](02-detector-de-violaciones-rt.md) | Detector de asignaciones en el hilo de audio | — | ninguno | base |
| [03](03-routing-sin-asignaciones.md) | Routing resuelto fuera del hilo de audio | 02 | bajo | medio |
| [04](04-busquedas-sin-cadenas.md) | Quitar las búsquedas lineales por `std::string` | 02 | bajo | medio |
| [05](05-mapa-de-voces-sin-spinlock.md) | Mapa de voces sin el spinlock global de MSVC | 02 | bajo | medio |
| [06](06-bypass-de-warp-neutro.md) | Bypass del warp con ratio 1.0 y sin transposición | 01 | bajo | **alto** |
| [07](07-buses-de-mezcla-por-pista.md) | Buses de mezcla por pista (sin cambiar de hilo) | 01 | medio | base |
| [08](08-pool-de-render.md) | Pool de trabajadores de tiempo real | 03, 04, 05, 07 | **alto** | **el más alto** |
| [09](09-politica-de-hilos.md) | Política de hilos, perfil de dispositivo y ajuste | 08 | medio | alto (UX) |

## Orden recomendado

```
01 (línea base)  ──┬─► 06  (ganancia inmediata, independiente)
                   │
                   └─► 07 ──┐
02 (detector) ──┬─► 03 ─────┤
                ├─► 04 ─────┼─► 08 ─► 09
                └─► 05 ─────┘
```

**Empieza por 01 y 02.** Sin línea base no se puede demostrar ninguna mejora, y
sin detector no se puede demostrar que 03/04/05 arreglan algo.

Los pasos 03, 04, 05 y 06 son independientes entre sí y pueden repartirse entre
agentes distintos. **08 no se empieza hasta que 03, 04, 05 y 07 estén
aprobados**: paralelizar sobre un hilo que asigna memoria y toma un spinlock
global del proceso multiplica el problema por el número de hilos en vez de
dividirlo.

## Reglas que aplican a todos los pasos

1. **Bit-exactitud como contrato.** Los pasos 07 y 08 no pueden cambiar ni una
   muestra de la salida. Es lo que hace verificable un refactor de esta
   naturaleza; ver el criterio de orden de reducción en
   [07](07-buses-de-mezcla-por-pista.md).
2. **Nada de tests que midan tiempos de hilos.** Hay dos releases tumbadas en
   este repo por eso. El rendimiento se demuestra con el banco del paso 01,
   ejecutado por la persona y anotado en la bitácora; los tests automáticos
   verifican **orden, contadores y equivalencia numérica**, nunca relojes.
3. **Verifica que un test de regresión sabe fallar** antes de darlo por bueno.
   Rómpelo a propósito y comprueba que se pone rojo.
4. **Regresión cero cuando el pool está desactivado.** Con
   `LIBRETRACKS_RENDER_THREADS=1` el motor debe comportarse exactamente como
   hoy, muestra a muestra.
5. **No tocar el hot path sin leer el diagnóstico.** Este código se mueve
   mutando refs a propósito y hay un intento previo de refactor revertido.
6. **`cargo test -p libretracks-desktop` SIEMPRE falla** por enlazado, no es
   tuyo. Usa `cargo check --all-targets` y `npm --prefix apps/desktop run test`.
7. **No crees ramas de git.** Trabaja en la rama actual.

## Harness de agentes

El bucle BUILDER/REVIEWER y cómo lanzarlo está en [`HARNESS.md`](HARNESS.md).

- **Claude Code**: `/audio-builder NN` y `/audio-reviewer NN`
  (skills en `.claude/skills/`).
- **Codex**: prompts pegables en [`prompts-codex.md`](prompts-codex.md).
- **Copilot**: `.github/prompts/audio-*.prompt.md`.

Son los mismos roles y el mismo protocolo que el plan `android-low-end`, con
otro directorio de plan y otro de bitácoras. Se separan para que ambos planes
puedan avanzar sin pisarse las bitácoras.

## Línea base

[`baseline.md`](baseline.md) y [`baseline.json`](baseline.json) son las cifras
contra las que se compara cada paso. Las produce `bench_render_callback`
(`native/audio-engine-v2/bench/`), junto a los dos bancos de Bungee con los que
se midió el diagnóstico. **Una cifra medida en otra máquina no dice nada sobre
ésta**: el `baseline.md` lleva CPU, SO y commit por ese motivo.
