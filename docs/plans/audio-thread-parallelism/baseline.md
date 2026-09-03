# Línea base del callback de audio

Cifras contra las que se compara cada paso del plan. Las produce
`bench_render_callback --matrix`; el JSON completo está en
[`baseline.json`](baseline.json).

## Condiciones de la medida

| Dato | Valor |
| --- | --- |
| Commit | `5bb6b36b0d6dac89e33249610c07dfd6cd9ee3be` |
| CPU | Intel Core i7-12700KF (12 núcleos / 20 hilos, 8 P + 4 E) |
| RAM | 31,8 GB |
| SO | Windows 11 Pro 10.0.26200 |
| Compilador | MSVC 2022, configuración Release |
| Motor | `LT_ENGINE_USE_BUNGEE=ON`, Bungee 2.4.24 |
| Sample rate | 48 000 Hz |
| Bloques medidos | 600 por fila, tras 150 de calentamiento |
| Fases | `LIBRETRACKS_AUDIO_DIAG=1` |

**Sin estos tres datos —CPU, SO y commit— el JSON no vale para comparar.** Una
cifra de otro paso medida en otra máquina no dice nada sobre ésta.

## El caso del reporte: 24 pistas, buffer 512

Es la configuración que originó el plan (un usuario con la carga de audio al
96 %).

| warp | ratio | avg | p95 | p99 | max | avg % presupuesto |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| off | — | 86,2 µs | 99,5 | 164,5 | 369,9 | **0,8 %** |
| on | 1.0 | 3268,4 µs | 4053,5 | 4999,0 | 5706,2 | **30,6 %** |
| on | 1.2 | 2996,3 µs | 3364,8 | 3659,7 | 4255,6 | **28,1 %** |

Tres cosas que confirma esta tabla, ya a nivel de `Mixer::render` entera y no
sólo de Bungee aislado:

1. **Activar el warp multiplica el coste por ~38.** De 0,8 % a 30,6 %.
2. **El ratio no importa.** 1.0 y 1.2 cuestan lo mismo (la diferencia está
   dentro del ruido entre ejecuciones). Es la evidencia directa de que el
   [paso 06](06-bypass-de-warp-neutro.md) ahorra el coste completo a quien
   activa el warp sin cambiar el tempo.
3. **Casi todo el coste está en la fase `tracks`**: 3263,9 µs de 3268,4. Las
   fases cubren el 99,9 % del callback, así que no hay trabajo sin
   instrumentar.

## Matriz completa

Media, en % del presupuesto del buffer.

### Buffer 512 (10,67 ms de presupuesto)

| pistas | warp off | warp on 1.0 | warp on 1.2 |
| ---: | ---: | ---: | ---: |
| 1 | 0,1 % | 1,2 % | 1,2 % |
| 4 | 0,1 % | 4,8 % | 4,6 % |
| 8 | 0,3 % | 9,5 % | 9,9 % |
| 16 | 0,6 % | 19,4 % | 18,8 % |
| 24 | 0,8 % | 30,6 % | 28,1 % |
| 32 | 1,2 % | 41,5 % | 43,4 % |

### Buffer 128 (2,67 ms de presupuesto)

| pistas | warp off | warp on 1.0 | warp on 1.2 |
| ---: | ---: | ---: | ---: |
| 1 | 0,1 % | 1,2 % | 1,2 % |
| 4 | 0,2 % | 4,8 % | 4,7 % |
| 8 | 0,3 % | 9,6 % | 9,4 % |
| 16 | 0,6 % | 20,4 % | 19,8 % |
| 24 | 0,9 % | 32,6 % | 29,8 % |
| 32 | 1,2 % | 47,9 % | 42,7 % |

El coste en % del presupuesto es prácticamente el mismo con 128 que con 512:
confirma que **subir el tamaño de buffer no baja la carga**, sólo da más
margen a los picos.

## La cola, que es lo que van a mover los pasos 03/04/05

La media esconde el problema real. Con buffer de 128 y 24 pistas warpeadas:

| | valor | % del presupuesto (2667 µs) |
| --- | ---: | ---: |
| avg | 869 µs | 32,6 % |
| p95 | 1835 µs | 68,8 % |
| p99 | 2325 µs | **87,2 %** |
| max | 2689 µs | **100,8 %** |

Es decir: con una media del 33 %, **el peor bloque ya se pasa del presupuesto**.
Esto es en una máquina de 20 hilos y ociosa. En la del usuario del reporte, con
la media al 96 %, la cola está muy por encima del 100 % de forma constante — que
es exactamente lo que se oye como crujido.

Los pasos 03, 04 y 05 no van a mover apenas la columna `avg`. **Se juzgan por
p95, p99 y max.**

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

Una fila suelta, con el detalle de fases:

```
bench_render_callback.exe --tracks 24 --block 512 --warp 1
```
