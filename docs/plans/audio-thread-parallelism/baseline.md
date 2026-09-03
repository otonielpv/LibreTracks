# Línea base del callback de audio

Cifras contra las que se compara cada paso del plan. Las produce
`bench_render_callback --matrix`; el JSON completo está en
[`baseline.json`](baseline.json).

## Condiciones de la medida

| Dato | Valor |
| --- | --- |
| Commit | `27ad5697` |
| CPU | Intel Core i7-12700KF (12 núcleos / 20 hilos, 8 P + 4 E) |
| RAM | 31,8 GB |
| SO | Windows 11 Pro 10.0.26200 |
| Compilador | MSVC 2022, configuración Release |
| Motor | `LT_ENGINE_USE_BUNGEE=ON`, Bungee 2.4.24 |
| Sample rate | 48 000 Hz |
| Bloques medidos | 600 por fila, tras 150 de calentamiento |
| Fases | `LIBRETRACKS_AUDIO_DIAG=1` |
| Carga de fondo | **máquina de trabajo real**: VS Code, Chrome, RustDesk activos |

**Sin estos datos —CPU, SO y commit— el JSON no vale para comparar.** Una cifra
de otro paso medida en otra máquina no dice nada sobre ésta.

## Antes de comparar nada: cuánto se mueve esto solo

Cinco pasadas seguidas de la **misma** configuración (24 pistas, buffer 512,
warp on), mismo binario, misma máquina, sin tocar nada entre ellas:

| pasada | avg | p95 | max |
| ---: | ---: | ---: | ---: |
| 1 | 3188 µs | 3613 | 7186 |
| 2 | 3341 | 4081 | 10155 |
| 3 | 3346 | 4452 | 11493 |
| 4 | 3213 | 3748 | 8872 |
| 5 | 3146 | 3609 | 7371 |

| métrica | dispersión entre pasadas |
| --- | ---: |
| **avg** | **6,2 %** |
| p95 | ~23 % |
| **max** | **~60 %** |

De aquí salen las reglas de uso, y no son opcionales:

1. **Compara `avg`.** Es la única columna reproducible. Un paso que afirme una
   mejora **menor del 10 %** sobre `avg` no la ha demostrado: está dentro del
   ruido.
2. **`p95` es indicativo, no probatorio.** Sirve para ver una tendencia grande
   (los pasos 03/04/05 deberían moverlo mucho o nada), no para afinar.
3. **`max` no se compara jamás.** Es un único bloque, y refleja lo que hacía el
   planificador del SO ese instante, no el código. Está en la tabla porque
   ayuda a detectar que algo va muy mal, no como métrica.
4. **Mide con la máquina en el mismo estado.** La matriz completa deriva hacia
   arriba conforme avanza (36 configuraciones seguidas calientan la CPU): la
   fila de 24 pistas sale en 4006 µs dentro de la matriz y en 3247 µs de media
   medida suelta. Comparar filas **dentro de una misma pasada** de la matriz es
   más fiable que comparar una fila entre pasadas distintas.

> Mejora pendiente si esto llega a molestar: un `--repeat N` que ejecute cada
> configuración N veces y publique la mediana. No se ha hecho porque triplica el
> tiempo de la matriz y con la regla del 10 % sobre `avg` basta para todos los
> pasos del plan.

## El caso del reporte: 24 pistas, buffer 512

Es la configuración que originó el plan (un usuario con la carga de audio al
96 %).

| warp | ratio | avg | p95 | avg % presupuesto |
| --- | ---: | ---: | ---: | ---: |
| off | — | 99,5 µs | 161,5 | **0,9 %** |
| on | 1.0 | 4005,8 µs | 6093,4 | **37,6 %** |
| on | 1.2 | 3774,9 µs | 5963,4 | **35,4 %** |

Tres cosas que confirma, ya a nivel de `Mixer::render` entera y no sólo de
Bungee aislado:

1. **Activar el warp multiplica el coste por ~40.** De 0,9 % a 37,6 %. La
   diferencia es tan grande que ninguna consideración de ruido la toca.
2. **El ratio no importa.** 1.0 y 1.2 caen dentro del ±6 % de dispersión, o sea
   son indistinguibles. Es la evidencia directa de que el
   [paso 06](06-bypass-de-warp-neutro.md) ahorra el coste **completo** a quien
   activa el warp sin cambiar el tempo.
3. **Casi todo el coste está en la fase `tracks`**: 4000,6 µs de 4005,8. Las
   fases cubren el 100,0 % del callback, así que no hay trabajo sin
   instrumentar.

## Matriz completa

Media, en % del presupuesto del buffer.

### Buffer 512 (10,67 ms de presupuesto)

| pistas | warp off | warp on 1.0 | warp on 1.2 |
| ---: | ---: | ---: | ---: |
| 1 | 0,1 % | 1,8 % | 1,8 % |
| 4 | 0,3 % | 6,3 % | 5,9 % |
| 8 | 0,3 % | 12,0 % | 11,2 % |
| 16 | 0,5 % | 22,8 % | 21,4 % |
| 24 | 0,9 % | 37,6 % | 35,4 % |
| 32 | 2,1 % | 48,1 % | 49,0 % |

### Buffer 128 (2,67 ms de presupuesto)

| pistas | warp off | warp on 1.0 | warp on 1.2 |
| ---: | ---: | ---: | ---: |
| 1 | 0,1 % | 1,7 % | 1,4 % |
| 4 | 0,2 % | 6,5 % | 5,1 % |
| 8 | 0,3 % | 11,7 % | 10,2 % |
| 16 | 0,8 % | 26,4 % | 29,7 % |
| 24 | 0,9 % | 46,3 % | 48,7 % |
| 32 | 1,3 % | 50,2 % | 51,6 % |

El coste en % del presupuesto es del mismo orden con 128 que con 512: **subir el
tamaño de buffer no baja la carga**, sólo da más margen a los picos.

## El suelo de resolución del desglose por fases

`Mixer::render` marca las fases con `duration_cast<microseconds>` —trunca a µs
enteros— y hay cuatro marcas por bloque. Eso deja un déficit sistemático de
~1-2 µs por bloque que **no es trabajo sin instrumentar, es redondeo**.

Da igual en un bloque de 4000 µs (0,04 %) y se lo come todo en uno de 1,8 µs
(66 %). Por eso el banco reporta `n/a` por debajo de **100 µs por bloque** y en
el JSON escribe `phase_coverage_pct: null`, en vez de publicar el error del
reloj disfrazado de hallazgo. Las filas de pocas pistas sin warp caen ahí.

Por encima de ese suelo el déficit queda por debajo del ±5 % que pide el
criterio C4 del paso: 4 marcas × 1 µs de error máximo = 4 µs, y 4/100 = 4 %.

## Cómo reproducirla

```powershell
cmake -S native/audio-engine-v2 -B native/audio-engine-v2/build-bench `
      -DLT_ENGINE_USE_BUNGEE=ON -DLT_BUNGEE_DIR=<release de bungee> `
      -DLT_ENGINE_BUILD_BENCHES=ON
cmake --build native/audio-engine-v2/build-bench --config Release `
      --target bench_render_callback

$env:LIBRETRACKS_AUDIO_DIAG = "1"
native/audio-engine-v2/build-bench/Release/bench_render_callback.exe `
    --matrix --json docs/plans/audio-thread-parallelism/baseline.json
```

`LIBRETRACKS_AUDIO_DIAG` tiene que estar en el entorno **antes** de arrancar el
proceso: el motor la lee una sola vez, al construir el `Mixer`. El banco lo
intenta poner por su cuenta como conveniencia, y avisa si las fases vienen
vacías en vez de reportar ceros como si fueran datos.

El banco comprueba el determinismo estructural de **cada** configuración —dos
pasadas, contadores idénticos— antes de medir nada, y aborta con código 3 si
alguna difiere. Una fila que no renderice las mismas pistas por los mismos
caminos dos veces seguidas no vale como línea base.

Una fila suelta, con el detalle de fases:

```
bench_render_callback.exe --tracks 24 --block 512 --warp 1
```
