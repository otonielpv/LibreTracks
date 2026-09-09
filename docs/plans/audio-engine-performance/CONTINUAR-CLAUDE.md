# Relevo: rendimiento del motor de audio

Actualizado: 2026-09-09, tras la etapa de fidelidad. Lee este documento antes de
continuar y comprueba el estado real del checkout: puede haber commits
posteriores al relevo.

## Encargo y restricciones del usuario

Mejorar el motor con decisiones respaldadas por medidas, pensando en PC modestos
y móviles Android. El incidente anterior de CPU del usuario está resuelto:
**no volver a investigar ese incidente**. El equipo disponible es un
i7-12700KF potente; limitar sus hilos no emula un móvil.

El usuario ha ido autorizando implementar, medir y continuar, y ha pedido
commits al cerrar etapas. Este relevo no es una petición de activar el prototipo
en producción ni de publicar una versión.

Leer el `AGENTS.md` aplicable. Medir siempre en Release, sin builds ni tests
ejecutándose simultáneamente con el banco. Conservar datos crudos, repeticiones
y resultados desfavorables. No cambiar hilos, precarga, RAM o calidad automática
a partir del i7. No añadir lógica/estado al monolito de transporte.

## Estado comprobado del repositorio

Secuencia de trabajo hasta la fecha:

| Commit | Entrega |
| --- | --- |
| `849e8e98` | Retirada segura por generación de trabajos del pool, guard RT en trabajadores, diagnósticos y baseline A/B |
| `85ee1a54` | Banco de streaming desde archivos |
| `1eb360e7` | Importación concurrente por SourcePreparationQueue real |
| `5b665762` | Saltos mediante el handler real de SeekAbsolute |
| `5ea7bfdf` | Medidas de warp, transposición y ambos activos |
| `0fda4282` | Prototipo de preparación por pista, validación de caché y medidas |
| *(este)* | Fidelidad de arranques y saltos: banco, analizador con tests y medidas |

**De todos estos, sólo `849e8e98` cambia lo que oye un usuario.** Es una
corrección de concurrencia del pool de render. Todo lo demás es infraestructura
de medición y un prototipo que vive únicamente en la compilación del banco.
La reproducción desde audio con warp/tono preparados **no existe como función
de la aplicación**, y este trabajo no la ha acercado a existir: ha comprobado
que la sustitución sería honesta en cuatro momentos concretos.

No revertir cambios ajenos ni asumir que todo cambio encontrado pertenece a
este trabajo. Consultar `git status` y los diffs antes de editar o commitear.

## Qué está hecho y dónde leer

El [plan principal](README.md) contiene las decisiones y puertas de aceptación.
Leer después [DSP activo](05-dsp-activo.md), [audio preparado](06-audio-preparado.md)
y [fidelidad de saltos](07-fidelidad-saltos.md). Las etapas 02–04 explican el
streaming, las importaciones y el salto protegido.

La transposición sin warp utiliza varispeed en el motor actual; no confundirla
con Bungee manteniendo duración. Los bancos verifican qué ruta se ejecuta.

| Archivo | Papel |
| --- | --- |
| `native/audio-engine-v2/bench/bench_streaming_playback.cpp` | Playback desde archivo, tiempos, CPU/RAM, rutas DSP, imports y saltos |
| `native/audio-engine-v2/bench/streaming_benchmark_engine.h` | EngineImpl sin dispositivo, con los handlers reales de comandos |
| `native/audio-engine-v2/bench/bench_prepare_warp.cpp` | Preparación secuencial por pista con TrackRenderer/Bungee y verificación |
| `native/audio-engine-v2/bench/bench_fidelity_jump.cpp` | Captura una ruta y un escenario de transporte con los comandos reales |
| `scripts/audio-fidelity-fixture.mjs` | Fixture con impulsos, ráfagas, barrido y silencio |
| `scripts/audio-fidelity-analysis.mjs` | Alineación, error de nivel, convergencia, mudez y clic |
| `scripts/audio-fidelity-analysis.test.mjs` | Doce defectos inyectados que el analizador debe nombrar |
| `scripts/bench-audio-fidelity.mjs` / `report-audio-fidelity.mjs` | Matriz de fidelidad y su informe |
| `scripts/audio-prepared-cache.mjs` (+ `.test.mjs`) | Clave canónica y validación de tamaño/hash |
| `scripts/bench-audio-prepared.mjs` / `report-audio-prepared.mjs` | Matriz A/B de coste y su informe |

Las rutas son relativas a la raíz del repositorio.

## Evidencia de la última etapa

[JSON crudo](measurements/2026-09-09-fidelity.json) e
[informe](measurements/2026-09-09-fidelity.md). 24 comparaciones Release:
arranque, salto adelante, salto atrás y reanudación × buffers 128/512 ×
3 repeticiones, una pista, warp 1,2 y tono +3.

- **Desfase 0,00 ms en los ocho casos**, correlación de envolvente 0,9997–0,9999.
- Error mediano de nivel 0,013–0,053 dB.
- Ninguna ventana con una ruta muda y la otra sonando.
- La ruta viva nunca chasquea más que la preparada.
- Las tres repeticiones dieron capturas idénticas byte a byte.

La única fila que no converge de inmediato (salto atrás con buffer 128, 660 ms)
está desglosada en el propio informe: son siete ventanas sueltas de 1,3–4,2 dB
entre −48 y −60 dBFS, colas de ráfagas 30 dB por debajo del programa, repartidas
por los cuatro segundos y no concentradas tras el evento. No es un tiempo de
asentamiento del motor.

**Leer la sección «Dos veces estuvo a punto de reportar un defecto que no
existía» de la etapa 07 antes de tocar el analizador.** El banco informó de un
«transitorio de 2,9 dB» que era el evento cayendo sobre silencio digital, y el
buscador de desfase devolvía −1 s para dos capturas idénticas porque el material
musical es casi periódico. Las dos trampas son genéricas de esta clase de medida.

## Límites que no se deben perder

1. El fixture de fidelidad cubre **una región, offsets cero, ganancia de clip
   unitaria y parámetros constantes**. No demuestra regiones múltiples,
   automatización, edición durante playback ni cambios de warp/tono en caliente.
2. Gain, pan y mute deben seguir siendo controles en vivo. Están documentados
   como frontera del archivo preparado, pero **no se han medido moviéndose
   durante la reproducción preparada**.
3. La invalidación de caché está probada como función pura. **No está probado
   que un cambio de parámetros durante la reproducción no llegue a sonar desde
   caché obsoleta**: eso exige la publicación atómica que el prototipo no tiene.
4. El salto de fidelidad se ejecuta síncrono entre dos renders, a propósito, para
   que ambas rutas recorran la misma línea de tiempo. La latencia del salto
   concurrente la mide `bench_streaming_playback`.
5. Original PCM16 frente a preparado float32. Se compara la estrategia completa,
   incluido su mayor coste de disco. No reducir a PCM16 sin evaluar calidad —
   y ver la decisión pendiente de abajo, porque cambia qué formato hay que
   validar.
6. Los bancos no abren dispositivo ni incluyen UI o estrés térmico sostenido.
   Un render tardío no es un xrun medido en un driver. Nada aquí demuestra
   ausencia de cortes audibles.
7. Faltan cuotas de disco, cancelación, limpieza, sincronización con ediciones y
   publicación atómica. No hacer I/O ni hashes dentro del callback de audio.
8. Fuera de Windows falta identificar la biblioteca Bungee dinámica en el
   manifiesto. No tratarlo como contrato portable de producción.

## Decisión pendiente del usuario, antes de más fidelidad

El coste de disco no está dimensionado y determina qué hay que validar después.
Extrapolando las cifras de la etapa 06 (float32 estéreo 48 kHz = 0,384 MB/s por
pista), **una canción de 4 minutos con 12 pistas ocupa ~1,1 GB preparada**, o
~550 MB en PCM16. Y la preparación costó ~58× tiempo real en este i7: esa misma
canción serían ~49 s aquí, y varios minutos en un Android modesto.

Son estimaciones desde el i7, no medidas. Pero significan que la función no
puede ser automática y que en Android quizá exija PCM16. Si la respuesta es
PCM16, la fidelidad hay que revalidarla sobre PCM16, no sobre float32. Conviene
resolver el presupuesto antes de ampliar la matriz de fidelidad, para no validar
una ruta que después no se envía.

## Siguiente tarea concreta recomendada

**Extender la cobertura de fidelidad a lo que una sesión real tiene**, sobre el
formato que decida el presupuesto anterior:

1. Regiones múltiples, offsets de clip distintos de cero y ganancia de clip no
   unitaria. El fixture y el banco ya soportan añadirlo; hoy sólo montan una
   región y un clip.
2. Cambios de warp y de tono en caliente durante la reproducción, comprobando
   que una invalidación nunca reproduce caché obsoleta. Esto necesita la
   publicación atómica, así que probablemente sea diseño además de medida.
3. Gain, pan y mute moviéndose durante el playback preparado, para asegurar que
   siguen actuando en el mezclador y no quedaron horneados en el WAV.

Después: diseñar preparación explícita con presupuesto de disco, cancelación,
publicación segura y respuesta a ediciones. Medir preparación y playback en PC
modesto/Android real, con memoria, almacenamiento y 15–30 minutos de carga.
Si no hay dispositivo, dejar esa validación explícitamente pendiente y avanzar
en las pruebas independientes; no sustituirla por limitar núcleos del i7.

Hay además una deuda de método que sigue abierta desde el principio del plan:
**ningún render tardío del banco se ha correlacionado nunca con un corte audible
real en un driver.** Toda la cadena optimiza una métrica sustituta. Una sola
medida de punta a punta —dispositivo abierto, xrun contado por el driver, y
comprobar que el banco lo predice— daría sentido a las 200 pasadas anteriores.

## Ejecución y comprobaciones

Entorno de referencia: Windows, PowerShell, repositorio `D:\Repos\LibreTracks`.
Los binarios locales están en `native/audio-engine-v2/build-bench/Release`.
No asumir que existen en otra máquina: consultar CMake y la etapa 05 para
configurar Release con bancos y Bungee. Cada captura exige una salida nueva.

```powershell
git status --short
git log -8 --oneline
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback bench_prepare_warp bench_fidelity_jump -j 4
node --test scripts/audio-prepared-cache.test.mjs scripts/audio-fidelity-analysis.test.mjs
node scripts/bench-audio-fidelity.mjs native/audio-engine-v2/build-bench/Release/bench_fidelity_jump.exe native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/fidelidad-nueva 3
node scripts/report-audio-fidelity.mjs bench-out-engine/fidelidad-nueva/results.json bench-out-engine/fidelidad-nueva/report.md
git diff --check
```

`bench-out-engine/` está ignorado: no versionar cientos de MiB de WAV. Sí
versionar código, resultados JSON e informes.

Validación de esta etapa: compilación Release de los tres bancos, 24 pasadas
completas con capturas idénticas entre repeticiones, 13 tests de Node en verde,
y una pasada de humo de `bench_streaming_playback` para comprobar que el cambio
del arnés no lo altera. **Esta etapa no toca ningún fichero del motor** —el
diff son el objetivo de CMake, la cabecera del banco, scripts y documentación—,
así que no se han vuelto a ejecutar los 385 tests nativos ni los 75 de Rust;
ejecutarlos en cuanto se toque `native/audio-engine-v2/src`.
No presentar resultados históricos como validación de cambios futuros.

Al terminar la siguiente etapa, actualizar este relevo y el plan con lo probado,
lo descartado y lo pendiente. Explicar resultados al usuario en español, sin
prometer mejoras generales a partir de una sola máquina.
