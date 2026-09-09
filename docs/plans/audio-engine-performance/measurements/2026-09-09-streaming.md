# Streaming desde archivos: línea base

12th Gen Intel(R) Core(TM) i7-12700KF; Release; 3 repeticiones; 12 pistas WAV PCM16 estéreo a 48 kHz; 512 bloques por pasada.

Cada pasada arranca en el segundo 5 y salta inmediatamente al segundo 30 a mitad de la ventana. La precarga cubre únicamente el arranque. Trim invoca la liberación de caché antes del salto; no simula toda la presión de memoria del sistema.

Las cifras temporales son medianas de percentiles por pasada. Los frames ausentes se suman sobre fuentes y repeticiones; no son duración de silencio del máster ni xruns del driver. La memoria del proceso es su máximo residente desde el arranque, incluida preparación; la caché se muestrea cada 16 callbacks.

| Fill workers | Buffer | Trim | Precarga | Preparación ms | p95 µs | p99 µs | Frames ausentes inicio / salto | Render tardío | Pico proceso MiB | CPU s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 128 | 0 | 0 | 0.00 | 57.6 | 109.3 | 4608 / 4608 | 0 | 35.8 | 0.031 |
| 1 | 128 | 0 | 1 | 1.34 | 66.5 | 119.9 | 0 / 4608 | 0 | 35.8 | 0.031 |
| 1 | 128 | 1 | 0 | 0.00 | 61.9 | 119.8 | 4608 / 4608 | 0 | 26.8 | 0.047 |
| 1 | 128 | 1 | 1 | 1.22 | 60.7 | 123.7 | 0 / 4608 | 0 | 26.7 | 0.016 |
| 1 | 512 | 0 | 0 | 0.00 | 163.7 | 255.7 | 18432 / 18432 | 0 | 54.0 | 0.078 |
| 1 | 512 | 0 | 1 | 1.22 | 151.9 | 298.4 | 0 / 18432 | 0 | 54.0 | 0.094 |
| 1 | 512 | 1 | 0 | 0.00 | 154.8 | 261.3 | 18432 / 18432 | 0 | 35.9 | 0.063 |
| 1 | 512 | 1 | 1 | 1.56 | 178.7 | 353.6 | 0 / 18432 | 0 | 35.8 | 0.125 |
| 2 | 128 | 0 | 0 | 0.00 | 52.5 | 143.7 | 4608 / 4608 | 0 | 36.2 | 0.063 |
| 2 | 128 | 0 | 1 | 1.17 | 74.1 | 151.9 | 0 / 4608 | 0 | 36.3 | 0.063 |
| 2 | 128 | 1 | 0 | 0.00 | 58.2 | 142.2 | 4608 / 4608 | 0 | 27.0 | 0.000 |
| 2 | 128 | 1 | 1 | 1.41 | 63.1 | 110.7 | 0 / 5888 | 0 | 27.1 | 0.047 |
| 2 | 512 | 0 | 0 | 0.00 | 180.3 | 314.6 | 18432 / 18432 | 0 | 54.3 | 0.094 |
| 2 | 512 | 0 | 1 | 1.22 | 172.4 | 296.4 | 0 / 18432 | 0 | 54.3 | 0.141 |
| 2 | 512 | 1 | 0 | 0.00 | 172.1 | 345.2 | 18432 / 18432 | 0 | 36.4 | 0.047 |
| 2 | 512 | 1 | 1 | 1.42 | 190.9 | 343.8 | 0 / 18432 | 0 | 36.2 | 0.078 |

CPU s mide tiempo total del proceso durante la ventana, incluyendo lecturas y muestreo. Los buffers diferentes implican ventanas de distinta duración; comparar CPU s únicamente entre ventanas iguales.

En Windows el contador de CPU tiene resolución gruesa frente a estas ventanas cortas: un valor 0 no demuestra consumo nulo. Para evaluar ahorro sostenido hacen falta ventanas mayores.

Límites: archivos recién escritos y caché del SO caliente, un solo hilo de render a prioridad normal, sin dispositivo de audio, interfaz, importación concurrente ni validación térmica. El salto evita deliberadamente la espera del JumpScheduler de producción. Uno o dos trabajadores del i7 no equivalen a un móvil Android.

Ejecutable SHA-256: 362efc824a64e7a83264d8bd0fbf5ad688357139685a31f920b0c28e84a9f9b4

Commit del entorno: 849e8e98cebbe35c97862468f0add31127e2d555; el JSON incluye los cambios locales y hashes de los archivos de audio.
