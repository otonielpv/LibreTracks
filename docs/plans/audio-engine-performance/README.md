# Mejoras del motor guiadas por medidas

Fecha de inicio: 2026-09-08.

El incidente de CPU anterior está cerrado por confirmación del mantenedor. Este
trabajo mejora el motor de forma preventiva, con especial atención a ordenadores
modestos y Android. El i7-12700KF disponible es una referencia potente, **no una
representación del dispositivo mínimo**.

## Criterio de aceptación

- Medir en Release. No deducir rendimiento del modo desarrollo.
- Comparar el mismo audio, buffer, frecuencia, parámetros y número de hilos.
- Separar tiempo de render, consumo total de CPU, falta de datos en caché y
  errores del dispositivo. Una duración >75% es margen reducido; >100% es un
  render tardío. Ninguna de las dos es por sí sola un xrun medido del driver.
- Guardar repeticiones y resultados crudos, no sólo la mejor pasada. Alternar
  referencia/candidato para reducir el efecto del orden y de la temperatura.
- Probar equivalencia de audio, cursores y controles con tests deterministas.
  No introducir tests que aprueban/rechazan por los tiempos del planificador.
- Una mejora del i7 no autoriza a aumentar hilos, RAM, precarga o consumo en
  móviles. Cada cambio de política necesita medidas en su clase de dispositivo.

## Primera entrega

Implementado:

1. La sección de tiempo real cubre también a los trabajadores del pool. Los
   tests pueden consultar totales de asignaciones/liberaciones de todos los
   hilos. La instrumentación no existe en el motor de producción.
2. Una prueba fuerza una asignación en cada participante sin marcar el trabajo
   desde el test. Al retirar deliberadamente la marca del trabajador, falla
   contando 1 en vez de 2. Las pruebas de equivalencia con Bungee consultan
   también estos totales, en lugar de comprobar sólo trabajo sintético.
3. Retirada segura del trabajo por generación: un trabajador debe obtener
   admisión antes de leer el job. El director cierra la admisión y espera a los
   participantes antes de reutilizar sus datos. Un despertar tardío no puede
   leer el job retirado ni la cola del bloque siguiente. El arranque captura la
   generación antes de crear el hilo para no perder la primera publicación.
4. Diagnóstico opcional de tiempo de publicación/despertar, espera final y fase
   paralela, en nanosegundos acumulados. Sólo lee relojes adicionales si
   `LIBRETRACKS_AUDIO_DIAG` está activo. Son tiempos de pared: los dos primeros
   están incluidos en el tercero y no deben sumarse de nuevo.
   Se exponen en el JSON del banco y en el registro de diagnóstico del motor,
   fuera del callback. Los totales del registro pertenecen al mezclador actual
   y pueden reiniciarse al sustituirlo.
5. `callback_deadline_miss_count` atraviesa C++ → JSON → Rust y distingue el
   umbral del 100% del contador histórico al 75%. Un snapshot de una versión
   anterior se deserializa con cero en el campo nuevo.
6. Se amplían las pruebas de equivalencia bit a bit con cambios de mute de
   carpeta y solo durante el playback.

Se probó evitar despertares cuando todo el trabajo DSP costoso estaba
silenciado. Se retiró por resultados mixtos: en el A/B intercalado, 128 muestras
y cuatro hilos pasó de p95 120,6 a 96,1 µs, pero 512 muestras y cuatro hilos pasó
de 265,2 a 335,1 µs. No se adopta una regla global a partir del caso favorable.
También se descartó una barrera que esperaba a todos los trabajadores aunque
no hubieran participado. La versión final usa admisión por generación.

**El umbral automático sigue siendo ocho pistas.** El experimento con cuatro
queda disponible exclusivamente en la compilación del banco; no está en la
biblioteca de producción, los ajustes del músico ni la política de Android.

El guard intercepta los `new`/`delete` normales del ejecutable de tests. No
demuestra ausencia de `malloc`, asignaciones alineadas o asignaciones internas
de una DLL con otro runtime, ni es un detector general de mutex o de I/O.

## Banco reproducible

### Resultado de la primera entrega

La comparación final contiene 108 ejecuciones Release intercaladas: referencia
y candidato, tres repeticiones de 256 bloques por combinación de escenario,
buffer (128/512) e hilos (1/2/4), con diagnóstico opcional desactivado.
Se conservan [referencia](measurements/2026-09-08-reference.json),
[candidato](measurements/2026-09-08-candidate.json) y
[comparación completa](measurements/2026-09-08-comparison.md).

Los resultados son mixtos: con 24 pistas warp, el p95 pasa de 645,0 a
612,9 µs con buffer 128 y cuatro hilos, pero de 1729,4 a 1811,9 µs con
buffer 512 y cuatro hilos. Algunas combinaciones también consumen más CPU.
La dispersión entre repeticiones impide afirmar una mejora general o una
reducción de consumo. La corrección de retirada del trabajo se conserva por
seguridad de concurrencia; estos datos no justifican nuevas políticas de
rendimiento. El candidato registró cero renders tardíos en 13 824 bloques
medidos, frente a uno de la referencia: una observación breve, no una garantía
de ausencia de cortes.

Validación: 385 tests nativos en Release, contrato de guard desactivado en
producción y 75 tests Rust con `--features no-link` aprobados. La retirada
del guard del trabajador hizo fallar la prueba diseñada para detectarlo;
después se restauró. El pool pasa comprobación sintáctica C++20 con el NDK
para ARM64/API 26. Esto no equivale a ejecutar ni medir el motor en Android.
Los scripts de comparación se ejecutaron con los resultados completos y el
banco Android pasó las comprobaciones de sintaxis y listado de escenarios.

### Ejecución

El banco ahora reserva suficientes frames de fuente para el ratio de warp,
incluyendo margen de lectura. Antes, un ratio >1 podía agotar la fuente antes
de terminar la ventana medida. Se añaden pistas silenciadas, contadores de
activación del pool, renders tardíos y máximo de memoria residente del proceso
(incluye preparación y pruebas previas; no es RAM exclusiva del callback).

Usar un build con `LT_ENGINE_BUILD_BENCHES=ON`, `LT_ENGINE_BUILD_TESTS=OFF`,
Bungee habilitado y configuración Release. En esta máquina ya existe:

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_render_callback -j 4
node scripts/bench-audio-render.mjs --bench native/audio-engine-v2/build-bench/Release/bench_render_callback.exe --out bench-out-engine/nueva-medida --threads 1,2,4 --blocks 512 --repeats 3
```

Antes de modificar el motor, conservar el ejecutable de referencia y sus
dependencias. Para alternar ambos binarios en cada caso:

```powershell
node scripts/bench-audio-render.mjs --bench native/audio-engine-v2/build-bench/Release/bench_render_callback.exe --reference native/audio-engine-v2/build-bench/Release/bench_render_baseline.exe --out bench-out-engine/nuevo-ab --threads 1,2,4 --cases warp-small,warp,muted --blocks 512 --repeats 3
node scripts/compare-audio-render.mjs bench-out-engine/nuevo-ab/reference-results.json bench-out-engine/nuevo-ab/results.json bench-out-engine/nuevo-ab/comparison.md
```

El directorio de salida debe ser nuevo. Los JSON registran CPU, SO, RAM,
configuración, checkout y SHA-256 de los ejecutables; con un binario antiguo,
el checkout describe el entorno de ejecución, no identifica por sí solo su
código fuente. Los logs y JSON individuales quedan en `bench-out-engine/`.
El comparador rechaza cambios de carga estructural o repeticiones incompletas.
También señala dispersión entre pasadas: una mediana favorable con mucha
variación no demuestra por sí sola una mejora estable.

`--parallel-threshold 4` sólo experimenta con el candidato del banco; no cambia
la referencia ni instala una política de producción. `--threads 1,2` permite
comparar configuraciones pequeñas sin interpretar los hilos del i7 como una
emulación de Android.
Usar `--diagnostics 0` en ambos binarios para medir el camino habitual sin los
relojes opcionales del diagnóstico; el valor por defecto es `1`, útil para
desglosar fases y espera del pool. No comparar pasadas con opciones distintas.

El banco usa PCM sintético residente a 48 kHz y callbacks espaciados. No mide
WASAPI/ASIO/Oboe, WebView, almacenamiento, importación durante playback ni
comportamiento térmico sostenido. El hilo director es el hilo normal del
ejecutable; los trabajadores usan la promoción de prioridad del motor. No
reproduce la planificación del callback de un dispositivo de audio real.
El p99 con 512 bloques representa apenas
unos pocos bloques por pasada: confirmar sus cambios con ventanas mayores.

## Puertas para las siguientes mejoras

| Cambio | Medida que debe justificarlo | Situación |
| --- | --- | --- |
| Nuevos umbrales/número de trabajadores | p95/p99, CPU total y consumo sostenido en PC modesto y Android real | No cambiar con datos del i7 solamente |
| Regulación dinámica de decode/precarga | Frames ausentes, profundidad de colas, lecturas y presión de RAM durante importación + playback | [Streaming](02-streaming.md) e [importación concurrente](03-import-concurrente.md); pendiente salto protegido y dispositivo modesto |
| Preparar warp/tono para directo | CPU evitada frente a tiempo de preparación, disco, RAM y respuesta a saltos/cambios | Pendiente de prototipo y contrato de invalidación |
| Render anticipado | Margen ganado frente a respuesta de controles y coste de invalidar colas | Posterior al prototipo anterior |
| Audio Workgroups en Apple | Pruebas y medidas en hardware Apple | Pendiente de dispositivo |

Para un PC modesto y un Android de gama baja, recoger además backend, buffer
real, RAM disponible/pico del proceso completo, temperatura y evolución de
CPU/cortes durante 15–30 minutos, con canciones y saltos reales. Incluir una
importación y lectura de almacenamiento lento. Empezar con la política actual,
incluido un solo hilo en perfiles móviles limitados. No realizar un autotuning
que cambie el número de hilos o la calidad del audio durante una actuación.

El 2026-09-08 ADB no mostró ningún dispositivo conectado. No se ha validado
rendimiento Android ni se presenta una limitación de núcleos del PC como tal.

El banco Android existente incorpora escenarios `playback-warp` (15 minutos)
y `playback-import`, recoge las etiquetas de diagnóstico de audio y conserva
el estado bruto de `thermalservice` antes/después. Son lecturas de frontera,
no mediciones continuas de temperatura ni una demostración de throttling;
algunos dispositivos no publican esa información.

```powershell
node scripts/android-bench.mjs --scenario playback-warp --out bench-out-engine/android-warp.json --notes "Release; modelo; pistas; tempo/tono; backend; buffer; hilos; alimentacion"
```
