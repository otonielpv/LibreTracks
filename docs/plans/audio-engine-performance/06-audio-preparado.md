# Preparación de warp y tono por pista

Prototipo exclusivo del banco, 2026-09-09. No modifica el motor de producción,
la interfaz ni las políticas de PC/Android.

## Resultado y decisión

Se conservan [24 pasadas Release](measurements/2026-09-09-prepared.json) y el
[informe generado](measurements/2026-09-09-prepared.md). Son 12 pistas, warp 1,2
y tono +3, buffers 128/512, con/sin cuatro importaciones y tres repeticiones
alternando DSP vivo y audio preparado. Ambos usan el mismo banco y salto real
SeekAbsolute. Comparar dentro de esta captura, no contra tiempos de otro día.

Con buffer 512 sin importación, la mediana del p95 pasa de 4733,1 a 431,6 µs;
CPU de 1,484 a 0,188 s y pico residente de 100,1 a 92,9 MiB. Con importación,
CPU pasa de 2,188 a 1,094 s. Hay dispersión en algunos casos y siete renders
tardíos en vivo frente a cero preparados; no es una garantía contra cortes.

Preparar 12 pistas de 40 s cuesta 8,19/8,45 s y ocupa 175,8 MiB por variante
de buffer. El pico del preparador, incluida la verificación, es 23,3/23,4 MiB.
La segunda pasada de verificación añade 8,18/7,24 s; no está incluida en el
tiempo de preparación. Cada preparación se midió una sola vez.
Validar los hashes de los archivos antes de reproducir cuesta una mediana de
141–155 ms. Los tiempos de playback excluyen ambos costes previos.

**Decisión:** continuar estudiando preparación explícita para canciones con DSP
estable. El ahorro observado justifica el prototipo, pero el espacio en disco
impide adoptarlo automáticamente para todo proyecto, especialmente en Android.
No se cambia el número de hilos ni se extrapola consumo/batería desde este i7.

## Implementación y contrato

`bench_prepare_warp` procesa una pista cada vez con TrackRenderer y Bungee,
prefetch acotado y espera fuera del callback. Escribe WAV float32 estéreo a
48 kHz por bloques, sin cargar la canción completa. Conserva el audio anterior
a gain, pan, mute y efectos del mezclador; el fixture usa clip gain unitario.
Una segunda instancia fresca vuelve a renderizar y compara cada muestra con
el WAV decodificado: 46 080 000 muestras bit a bit por buffer, sin lecturas
ausentes durante la preparación. Esto comprueba el render continuo desde cero
y la escritura/lectura, no toda la semántica de una sesión editable.

El manifiesto sólo se publica tras terminar y verificar todas las pistas.
Su clave SHA-256 incluye contenido original, mapeo de pistas, warp, semitonos,
buffer, formato, frecuencia, duración, offsets, arquitectura y hashes de los
binarios y Bungee. Los outputs también se validan por tamaño y hash.
Cambiar esos datos requiere regenerar. El llamador debe calcular los hashes
actuales de las fuentes: el validador recibe esa especificación esperada y no
descubre cambios en fuentes por sí solo. El runner lo hace al arrancar.
Fuera de Windows falta identificar la biblioteca Bungee dinámica; no reutilizar
este contrato como caché portable de producción sin resolverlo.

Los archivos parciales de una ejecución fallida quedan sin manifiesto válido.
El prototipo no implementa cuotas, cancelación, limpieza automática, concurrencia
con ediciones ni publicación atómica para lectores de la aplicación.

## Límites y siguientes puertas

El DSP vivo reconstruye voces al saltar; el archivo preparado conserva historia
y fase del render continuo. Falta medir alineación, transitorios y diferencias
audibles en arranques/saltos antes de poder sustituir una ruta por otra.
También faltan regiones múltiples, offsets de clips, cambios de tempo/tono y
controles durante playback. La verificación actual no demuestra esos casos.

El original es PCM16 y el preparado float32 para evitar recuantización. Se mide
la estrategia completa, incluido el formato más grande. Los hashes previos
calientan la caché del SO del candidato; no se ha igualado la residencia de
ambas variantes. Hay fallos de lectura de fuente en playback de ambas rutas;
incluyen preparación de voces, y los bloques no nulos no descartan pérdidas
parciales ni clics. El banco no abre dispositivo ni mide UI o temperatura.

Antes de integración: validar fidelidad de saltos/cambios, definir cuotas y
cancelación, y repetir con almacenamiento y memoria de un PC modesto y Android
real durante una sesión sostenida. No habilitar preparación automática con
estas medidas solamente.

## Reproducción

Usar las fuentes de 60 s producidas por el banco DSP de [la etapa 05](05-dsp-activo.md).
Cada directorio de salida debe ser nuevo. Los WAV y logs quedan en la carpeta
ignorada `bench-out-engine`; sólo JSON e informes se versionan.

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback bench_prepare_warp -j 4
node scripts/audio-perf/bench-audio-prepared.mjs native/audio-engine-v2/build-bench/Release/bench_streaming_playback.exe native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/2026-09-09-dsp-final/fixtures bench-out-engine/nuevo-preparado 3
node scripts/audio-perf/report-audio-prepared.mjs bench-out-engine/nuevo-preparado/results.json bench-out-engine/nuevo-preparado/report.md
node --test scripts/audio-perf/audio-prepared-cache.test.mjs
```
