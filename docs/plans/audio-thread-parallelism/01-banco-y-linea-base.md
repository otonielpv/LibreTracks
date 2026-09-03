# 01 — Banco del callback y línea base

**Depende de:** nada. **Es el primer paso.**
**Toca:** `native/audio-engine-v2/bench/`, `native/audio-engine-v2/CMakeLists.txt`.
**Riesgo:** ninguno. No toca código de producción.

## Problema

Sin línea base no se puede demostrar que ningún paso posterior mejore nada. Y
las tablas que hay hoy en `native/audio-engine-v2/WARP_BACKEND_NOTES.md` vienen
de `bench_bungee_warp_backends`, un target que **ya no existe en el árbol**:
son cifras que nadie puede reproducir.

Además, los pasos 03/04/05 arreglan la **cola** de la distribución, no la media.
Un banco que sólo dé la media no sabrá demostrar que sirvieron para algo.

## Cambio pedido

### 1. Promocionar los dos bancos de referencia

`docs/plans/audio-thread-parallelism/bench-reference/` contiene dos ficheros ya
validados, que se compilan enlazando **directamente contra `bungee.lib`** (no
contra el engine). Muévelos a `native/audio-engine-v2/bench/` con estos nombres:

| Origen | Destino |
| --- | --- |
| `bungee_voice_cost.cpp` | `bench/bench_bungee_voice_cost.cpp` |
| `bungee_thread_scaling.cpp` | `bench/bench_bungee_thread_scaling.cpp` |

Añádelos a `CMakeLists.txt` siguiendo el patrón de los `bench_*` existentes
(bloque `if(LT_ENGINE_BUILD_BENCHES)`, alrededor de la línea 285), con el
`if(EXISTS ...)` que usan los demás. Necesitan enlazar `avrt` en Windows y
copiar `bungee.dll` junto al ejecutable, como hace `bench_prearm_vs_reactive`.

### 2. Banco nuevo del callback completo: `bench_render_callback`

Este es el que mide lo que de verdad importa: `Mixer::render` entera, no sólo
Bungee. Debe:

- Construir una `Session` sintética en memoria con **N pistas** (parámetro), una
  región con `warp_enabled` y `warp_source_bpm` configurables, y fuentes
  `PreparedSource` (audio en RAM, para que la starvation de disco no contamine
  la medida).
- Llamar a `Mixer::render` en bucle con el `block_frames` y la `sample_rate`
  que se le pasen, descartando los primeros bloques de calentamiento.
- Reportar, por configuración:
  - **avg, p50, p95, p99 y max** en µs y en % del presupuesto.
  - El **desglose por fases** que ya existe:
    `phase_load_us / phase_sched_us / phase_tracks_us / phase_post_us`
    (`mixer.h:283-292`, se leen con `exchange(0)`).
  - Los contadores `callback_over_budget_count`, `rendered_track_count`,
    `skipped_track_count` y los de `TrackRenderer::diagnostics()`.
- Aceptar por línea de comandos: `--tracks N --block F --sr R --warp 0|1
  --ratio X --semitones S --threads T --blocks B --json <ruta>`.
- Escribir el resultado en **JSON** cuando se le dé `--json`, con una entrada por
  configuración.

`--threads` puede ignorarse por ahora (sólo acepta 1); el paso 08 lo cablea.

### 3. Grabar la línea base

Ejecuta la matriz y guarda el resultado en
`docs/plans/audio-thread-parallelism/baseline.json`:

```
tracks ∈ {1, 4, 8, 16, 24, 32}
block  ∈ {128, 512}
warp   ∈ {off, on}     (ratio 1.0 y ratio 1.2 cuando warp=on)
sr     = 48000
```

Acompáñalo de un `baseline.md` legible con la tabla resumen, el modelo de CPU,
el SO y el commit exacto. **Sin esos tres datos el JSON no vale para comparar.**

## Criterios de aceptación

- [ ] C1 — `cmake --build … --target bench_render_callback` compila en
      Windows con `-DLT_ENGINE_BUILD_BENCHES=ON` y el binario se ejecuta.
- [ ] C2 — `bench_bungee_voice_cost` y `bench_bungee_thread_scaling` compilan y
      corren, y sus cifras reproducen las del diagnóstico dentro de un ±20 %
      en la misma máquina. Si no reproducen, **no lo ocultes**: anótalo en la
      bitácora, es un dato.
- [ ] C3 — `bench_render_callback --tracks 24 --block 512 --warp 1` reporta
      p95 y max además de la media, y el desglose de las cuatro fases. Pega la
      salida real en la bitácora.
- [ ] C4 — La suma de las cuatro fases está dentro del ±5 % del tiempo total
      del callback reportado. Si no cuadra, hay trabajo sin instrumentar y hay
      que decir cuál.
- [ ] C5 — `baseline.json` y `baseline.md` existen, con modelo de CPU, SO y
      hash de commit. `baseline.md` incluye la tabla `warp on` vs `warp off`
      para 24 pistas, que es el caso del usuario que originó el plan.
- [ ] C6 — El banco es **determinista en estructura**: dos ejecuciones seguidas
      dan el mismo número de pistas renderizadas, los mismos contadores de
      camino (`path_direct_count` / `path_stretched_count`) y el mismo número
      de bloques. Los tiempos varían, obviamente; los contadores no. Test o
      aserción dentro del propio banco.
- [ ] C7 — `npm run test:native` sigue pasando sin cambios de resultado.
- [ ] C8 — `LT_ENGINE_BUILD_BENCHES=OFF` (el valor por defecto) sigue
      compilando el engine sin los bancos. Verificado compilando en limpio.

## Notas para el implementador

- Los bancos de `bench-reference/` enlazan contra `bungee.lib` directamente y
  **no** contra `lt_audio_engine_v2`. Eso es a propósito: aíslan el coste de la
  librería del de nuestro código. No los conviertas en tests del engine.
- Necesitan `NOMINMAX` y `WIN32_LEAN_AND_MEAN` antes de `<windows.h>`, y los
  cabeceros de Bungee necesitan que `<vector>`, `<cmath>` y `<span>` se incluyan
  **antes** que ellos. Los ficheros de referencia ya lo hacen; no reordenes.
- `LT_BUNGEE_DIR` apunta al release desempaquetado. Si falta esa carpeta, el
  engine compila con `USE_BUNGEE=OFF` y el warp queda mudo — no es un bug de
  código. Ver `WARP_BACKEND_NOTES.md`.
- **No midas contención de hilos con relojes** en ningún test. Este banco es una
  herramienta de medida que ejecuta la persona, no un test de CI.
- Actualiza `WARP_BACKEND_NOTES.md` para que apunte a los targets que existen de
  verdad, y marca las tablas viejas como históricas con su fecha.
