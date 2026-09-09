# Herramientas de medida del motor de audio

Todo esto es instrumentación del plan
[`docs/plans/audio-engine-performance/`](../../docs/plans/audio-engine-performance/README.md).
**No forma parte del producto**: ningún ejecutable de LibreTracks importa nada
de aquí. Vive junto al repositorio porque cada archivo es el paso de
reproducción de una medida ya publicada, y borrarlo dejaría esa medida sin
poder repetirse.

Los ejecutables que acompañan a estos scripts están en
`native/audio-engine-v2/bench/` y sólo se compilan con
`-DLT_ENGINE_BUILD_BENCHES=ON`.

## Qué hay

| Archivo | Etapa | Papel |
| --- | --- | --- |
| `bench-audio-render.mjs`, `compare-audio-render.mjs` | 01 | A/B del callback de render completo, con referencia y candidato alternados |
| `bench-audio-streaming.mjs`, `report-audio-streaming.mjs` | 02–04 | Streaming desde archivo, importación concurrente y salto protegido |
| `report-audio-dsp.mjs` | 05 | Informe de las cuatro rutas DSP (directa, warp, varispeed, warp+tono) |
| `audio-prepared-cache.mjs` | 06 | Clave canónica y validación de la caché preparada |
| `bench-audio-prepared.mjs`, `report-audio-prepared.mjs` | 06 | A/B de CPU entre DSP vivo y audio preparado |
| `audio-fidelity-fixture.mjs` | 07 | Fixture con impulsos, ráfagas, barrido y silencio |
| `audio-fidelity-analysis.mjs` | 07–09 | Alineación, error de nivel, convergencia, mudez, clic y respuesta a controles |
| `bench-audio-fidelity.mjs`, `report-audio-fidelity.mjs` | 07–09 | Matriz de fidelidad de transporte y de controles del mezclador |
| `audio-wav.mjs` | 08 | Lector de los WAV del banco y estadísticas de error |
| `bench-audio-budget.mjs`, `report-audio-budget.mjs` | 08 | Presupuesto de disco y comparación de formatos |

Los `.test.mjs` los ejecuta `npm test` junto al resto de suites. No prueban
producto: prueban que el analizador **sabe fallar**. Un banco cuyo analizador
está roto no da error, da medidas que parecen buenas — y aquí ya pasó dos veces
(ver la etapa 07).

## Cómo se usan

Cada etapa del plan lleva su bloque de comandos exacto en su propio documento.
Reglas comunes a todas:

- Compilar en **Release**, y medir sin builds ni tests corriendo a la vez.
- El directorio de salida tiene que ser **nuevo**; los scripts se niegan a
  sobrescribir una captura anterior.
- Las salidas voluminosas van a `bench-out-engine/`, que está ignorado. Al
  plan se suben sólo el JSON crudo y el informe.
