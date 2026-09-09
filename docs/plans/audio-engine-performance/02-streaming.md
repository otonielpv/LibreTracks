# Banco de streaming desde archivos

El siguiente paso añade `bench_streaming_playback`, que instala archivos
nativos mediante `SourceManager::try_install_native_file` y ejecuta el Mixer
completo con lectura asíncrona. No modifica la política de producción.

La matriz usa doce WAV estéreo PCM16 a 48 kHz, cache de 64 MiB, uno/dos
trabajadores de lectura y buffers 128/512. El render sigue en un solo hilo.
Cada pasada mide 512 bloques: empieza en el segundo 5 y salta al segundo 30
a mitad de la ventana. Los archivos duran 40 segundos para que ninguna
fuente se agote. Los doce archivos ocupan unos 88 MiB; se generan por bloques
de un segundo sin materializar toda la sesión en RAM.

Se comparan arranque en frío de la caché del motor y arranque con precarga
explícita del bloque inicial. Se contabiliza el tiempo de preparación. Otra
variante llama a `release_cached_blocks_under_pressure(1)` antes del salto,
registrando los bytes liberados. Esto ejercita la recuperación de la caché;
no reproduce una notificación de memoria del sistema ni todo su efecto.

Los resultados separan:

- Frames de fuente ausentes antes/después del salto, bloques afectados y
  primer grupo de ocho bloques consecutivos sin ausencias tras el salto.
  Ese primer grupo no garantiza que el resto de la pasada esté libre de
  ausencias: el total posterior sigue siendo necesario.
- Duración del render p50/p95/p99/máximo y bloques que exceden su plazo.
- Lecturas, frames leídos, máximo de lectura, errores de apertura/lectura,
  cola final y máximo de cola muestreado.
- Memoria de caché muestreada, capacidad y máximo residente del proceso
  completo, incluida la preparación. CPU total del proceso durante playback.

Los frames ausentes se suman sobre las fuentes: no dividir simplemente entre
48 000 para atribuir una duración de silencio al máster. Tampoco son xruns
del dispositivo. El muestreo de caché/cola cada 16 callbacks y el cálculo de
energía ocurren fuera de `Mixer::render`, pero consumen tiempo de la ventana;
mantener esa cadencia al comparar.

El ejecutable falla ante archivos inválidos/cortos, errores de I/O, falta de
lecturas reales, audio completamente nulo/no finito, número inesperado de
pistas renderizadas o error al guardar JSON. Los tiempos y las ausencias se
registran como observaciones, sin un umbral temporal de PASS/FAIL.

## Reproducción

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback -j 4
node scripts/audio-perf/bench-audio-streaming.mjs native/audio-engine-v2/build-bench/Release/bench_streaming_playback.exe bench-out-engine/streaming-nuevo 3
node scripts/audio-perf/report-audio-streaming.mjs bench-out-engine/streaming-nuevo/results.json bench-out-engine/streaming-nuevo/report.md
```

Requiere build Release con `LT_ENGINE_BUILD_BENCHES=ON` y libsndfile. El
directorio de captura debe ser nuevo. Se guardan resultados individuales,
logs, hash del ejecutable, hash de cada WAV, configuración, equipo, commit y
cambios locales. El orden de escenarios se invierte en repeticiones alternas.
No ejecutar compilaciones ni otras pruebas durante las medidas.

## Límites y decisión pendiente

### Medida del 2026-09-09

Completadas 48 ejecuciones Release: 16 configuraciones y tres repeticiones.
Se conservan [datos crudos](measurements/2026-09-09-streaming.json) e
[informe](measurements/2026-09-09-streaming.md).
Compilación Release y validaciones estructurales aprobadas. Se comprobó además
el rechazo de argumentos incompletos, fuentes ausentes/demasiado cortas y una
captura con una repetición eliminada; los scripts pasan comprobación sintáctica.

La precarga produjo cero frames ausentes antes del salto en las 24 pasadas
que la usaron. Las 24 sin precarga registraron ausencias al inicio. El coste
mediano de preparación por configuración fue de 1,17–1,56 ms. Todos los
saltos inmediatos a caché fría registraron ausencias; duplicar trabajadores
de lectura no las eliminó. No hubo renders fuera de plazo en los 24 576
bloques medidos. Esto demuestra por qué ambos contadores son necesarios,
sin trasladar estos resultados al salto protegido de la aplicación.

Los máximos residentes medianos por configuración estuvieron entre 26,7 y
54,3 MiB. Son cifras de este ejecutable pequeño, no del proceso completo de
LibreTracks con UI, importación y warp. La resolución del contador de CPU
de Windows es demasiado gruesa en algunas pasadas cortas para deducir
ahorro energético de sus diferencias.

La decisión es mantener las políticas actuales. El banco ya permite medir
el efecto de preparar un destino y de liberar caché, pero hace falta añadir
la cola de preparación real y el gate de salto para evaluar cambios de
producto. Tampoco se cambia el número de trabajadores basándose en el i7.

### Alcance

La caché del motor empieza fría en cada proceso; **la del sistema operativo
está caliente** tras generar los archivos. No se expulsa la caché del SO.
El director tiene prioridad normal y no hay backend de dispositivo ni UI.
El salto es inmediato mediante el reloj: evita deliberadamente el gate de
la capa de comandos, por lo que mide recuperación tras discontinuidad, no la
latencia de un salto solicitado desde la aplicación.

La [siguiente entrega](03-import-concurrente.md) añade importación concurrente
por la cola de preparación real. Siguen pendientes warp, almacenamiento lento
y dispositivos modestos reales. Esta matriz permite
observar precarga y recuperación, pero no basta para adoptar regulación
dinámica ni aumentar hilos/RAM. La comprobación Android sigue pendiente.
