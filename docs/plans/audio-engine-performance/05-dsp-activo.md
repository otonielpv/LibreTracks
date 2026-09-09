# Warp y transposición activos

El modo `dsp` compara cuatro rutas reales: directa, warp a 1,2×, transposición
de +3 semitonos sin warp y warp a 1,2× con +3 semitonos. En el motor actual la
transposición sin warp usa **varispeed**, por lo que cambia también la velocidad
de consumo de fuente; no se fuerza Bungee para aparentar una carga distinta
de la que ejecuta la aplicación.

Todas las variantes usan doce pistas, un hilo de render, un trabajador de
lectura, un trabajador de decode, caché de 64 MiB, buffers 128/512 y cero/cuatro
importaciones. Hay 16 configuraciones y tres repeticiones. Se fija un número
pequeño de trabajadores para comparar costes; esto no emula un móvil.

Los WAV de reproducción e importación duran 60 segundos. El banco comprueba
que quede fuente suficiente para consumir la razón de warp o varispeed hasta
el final de la ventana, con margen adicional de lectura DSP. Importar sigue
usando 44,1 kHz → 48 kHz y una caché nueva por pasada.

## Preparación y validación de carga

Se prepara el inicio en el segundo 5 mediante el comando detenido real en
**todas** las variantes, incluida directa, antes de empezar a medir. Así las
voces no arrancan con una posición preparada para el segundo 0. Durante la
ventana de 512 bloques se solicita el salto protegido al segundo 30. La
importación empieza un callback antes de solicitar ese salto.

El banco comprueba exactamente 6144 renders de pista. Warp y warp+tono deben
tener doce voces Bungee al inicio y final, 6144 renders estirados, producción
de frames estirados y ninguna voz ausente. Varispeed debe ejecutar 6144 renders
por su ruta y no tener voces Bungee. El informe valida además la configuración
y que estén todas las repeticiones. Un fallo conserva el JSON individual y
detiene la captura: no se presenta una ruta incorrecta como rendimiento válido.

La primera tentativa detectó precisamente eso: la comprobación esperaba
Bungee para transposición sin warp, pero el motor ejecutaba varispeed. Se
corrigió la expectativa del banco y el cálculo de longitud/posición de fuente,
sin cambiar el comportamiento del motor.

## Cómo interpretar los contadores

- `missing_source_frames` suma los fallos de lectura de todas las fuentes
  durante la ventana. Con DSP, incluye también las lecturas de preparación de
  voces del hilo de control. No equivale a frames de salida silenciados.
- `zero_output_blocks` cuenta bloques totalmente a cero. Su ausencia no
  demuestra que no haya pérdidas parciales, clics ni desalineación.
- `missing_voice_blocks` sí identifica renders estirados que no tenían voz.
- `stretched_source_frames` / `stretched_output_frames` permite comprobar la
  razón de consumo efectiva del warp.
- `stretched_feed_gap_frames` incluye la discontinuidad intencionada del salto;
  su total aquí no prueba un fallo durante reproducción continua.
- `startup_seek_ms` es la preparación inicial dentro de `prepare_ms`.
  `command_seek_ms` mide el manejador del salto durante playback. No sumarlos
  como si fueran dos fases de un mismo salto.

La primera captura DSP conservó el nombre `warp_ratio` para la razón de consumo
de fuente, también con varispeed. El emisor posterior separa `source_ratio` de
`warp_ratio`; el informe acepta ambos formatos y `warp_enabled` los desambigua.
No se modifican las cifras de la captura original.

## Reproducción y alcance

### Resultado del 2026-09-09

Completadas 48 ejecuciones Release. Se conservan los [datos originales](measurements/2026-09-09-dsp.json)
y el [informe](measurements/2026-09-09-dsp.md). Warp y warp+tono verificaron
doce voces activas y 6144 renders estirados por pasada; no se detectaron voces
ausentes ni bloques de salida completamente nulos.

Se registraron **73 renders fuera de plazo**, todos en variantes con warp,
entre 24 576 bloques medidos. La ruta directa y varispeed no registraron
ninguno. Son renders tardíos del banco; no xruns medidos de un dispositivo.
Con buffer 512 y sin importación, las medianas de p95 fueron 527 µs en directo,
8080 µs con warp, 670 µs con varispeed y 8645 µs con warp+tono. El presupuesto
del bloque era 10 667 µs. Los tiempos presentan dispersión, señalada en el
informe; no se interpreta un caso más rápido con importación como beneficio
de importar ni como argumento para aumentar trabajadores.

El siguiente prototipo prioritario es preparar warp/tono para directo y
comparar CPU evitada frente a tiempo de preparación, disco, RAM e invalidación
al cambiar parámetros. Esta matriz no justifica cambiar los umbrales actuales
ni permite atribuir a Android el comportamiento observado en el i7.

Validación: compilación Release, 48 pasadas completas, rechazo de un informe
con voces ausentes y de otro con una repetición eliminada. Después de separar
los nombres `source_ratio` y `warp_ratio` en el JSON se recompiló y se ejecutó
una pasada adicional de varispeed y otra de warp+tono; no se incluyeron en las
48 medidas originales. Los scripts pasan comprobación sintáctica.

### Comandos

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback -j 4
node scripts/audio-perf/bench-audio-streaming.mjs native/audio-engine-v2/build-bench/Release/bench_streaming_playback.exe bench-out-engine/dsp-nuevo 3 dsp
node scripts/audio-perf/report-audio-dsp.mjs bench-out-engine/dsp-nuevo/results.json bench-out-engine/dsp-nuevo/report.md
```

Build Release con Bungee y libsndfile. Se mantienen las limitaciones del banco:
archivos recién escritos y caché del SO caliente, sin dispositivo, UI ni prueba
térmica. El presupuesto de caché se fuerza a 64 MiB sobre el perfil del i7; no
se convierte su política de precarga ni su rendimiento en los de Android.
No se modifica ninguna política de producción a partir de esta matriz.
