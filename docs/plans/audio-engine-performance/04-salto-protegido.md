# Medición del salto protegido de producción

El banco dispone del modo `jump`, que compara el cambio inmediato del reloj
con `EngineImpl::dispatch_command(CmdSeekAbsolute)`. El manejador ejecutado
es el de producción: petición urgente del destino, preparación de voces,
espera del audio inicial, precarga más amplia, cambio de posición y fundido.
No se copia esa lógica al banco ni se modifica la política del motor.

`StreamingBenchmarkEngine` conecta los subsistemas sin abrir un dispositivo.
Su acceso a `EngineImpl` sólo existe con `LT_ENGINE_BENCHMARK_HOOKS`, definido
por el build de benchmarks. El hilo de control se crea antes de medir y
ejecuta el comando cuando se solicita el salto; mientras espera el destino,
el hilo de render continúa reproduciendo la posición anterior.

Para buffers 128/512, el dispositivo sin abrir proporciona el mismo mínimo
de 4096 frames del gate de producción (`max(4096, buffer * 8)`). El banco
rechaza buffers mayores: no simula un buffer negociado con un dispositivo.
Esta versión requiere Bungee. Las pistas de la matriz son directas, sin warp
ni transposición: se llama al constructor de mapas de voces, pero todavía
no se mide el coste de preparar voces DSP activas. La [matriz siguiente](05-dsp-activo.md)
añade esa carga.

## Matriz y métricas

Se mantienen doce pistas, 48 kHz, buffers 128/512, uno/dos trabajadores de
lectura, un hilo de render y caché de 64 MiB. Siempre hay precarga inicial.
Se cruzan comando protegido sí/no e importación de cuatro fuentes sí/no,
con tres repeticiones: 48 ejecuciones. Todas las variantes usan el mismo
ejecutable y el mismo montaje de subsistemas.

`command_seek_ms` mide la ejecución del manejador, excluyendo la espera para
despertar el hilo de control, JSON, IPC y UI. `jump_applied_block` es el primer
callback, relativo a la petición, al final del cual el reloj ya está en el
destino. Tiene resolución de bloque y no es la latencia de salida del driver.
Se exige que el destino llegue a aplicarse dentro de la ventana medida.

Las ausencias antes/después se separan por el instante de **petición**, no por
el de aplicación. Mientras el gate espera, las ausencias de la posición vieja
también contarían: se contabiliza toda la transición. El campo histórico
`jump_recovery_blocks` busca ocho bloques sin ausencias desde la petición y
sólo sirve para el salto inmediato; en el protegido puede describir audio de
la posición anterior. No se usa para concluir que el destino estaba listo.

## Reproducción

### Resultado del 2026-09-09

Completadas 48 ejecuciones Release. Los [datos](measurements/2026-09-09-jump.json)
y el [informe](measurements/2026-09-09-jump.md) muestran cero frames ausentes
en las 24 pasadas protegidas, frente a ausencias en las 24 inmediatas.
No hubo renders fuera de plazo en los 24 576 bloques medidos. La ejecución
del manejador duró entre 1,68 y 3,15 ms; el destino se observó como máximo
dos callbacks después de solicitarlo.

La preparación no es gratuita: con buffer 512, un trabajador de lectura e
importación activa, el pico residente mediano hasta terminar playback pasó
de 71,2 a 82,7 MiB. Los p95 variaron en ambos sentidos. Se mantiene la política
actual; estos resultados verifican la protección existente y su coste, sin
justificar cambios automáticos para Android.

La compilación Release y las 48 comprobaciones de carga terminaron bien.
Una comprobación sintáctica ARM64 del NDK rechaza el acceso privado del banco
sin `LT_ENGINE_BENCHMARK_HOOKS` y lo acepta con el flag: no se expone esa
entrada en producción. Esto no es una validación de rendimiento Android.
En el JSON archivado se corrigió únicamente una descripción heredada que
llamaba inmediato a todo salto; la corrección consta en metadatos y no cambió
ninguna fila medida.

### Comandos

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback -j 4
node scripts/bench-audio-streaming.mjs native/audio-engine-v2/build-bench/Release/bench_streaming_playback.exe bench-out-engine/jump-nuevo 3 jump
node scripts/report-audio-streaming.mjs bench-out-engine/jump-nuevo/results.json bench-out-engine/jump-nuevo/report.md
```

No se inicia el dispositivo, la UI, la preparación automática de todos los
destinos ni el ajuste del working set de `initialize()`. La caché del SO está
caliente. No extrapolar estos resultados a Android, almacenamiento lento,
warp, salto programado a fin de región o latencia completa desde la interfaz.
Se está evaluando la protección existente, no atribuyendo al banco una mejora
de rendimiento de la aplicación.
