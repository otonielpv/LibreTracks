# Importación concurrente por la cola real

El modo `import` de `bench-audio-streaming.mjs` compara reproducción sola con
reproducción mientras se preparan cuatro fuentes nuevas. Reutiliza el mismo
Mixer, archivos de reproducción, salto inmediato y muestreo del banco de
streaming. No cambia las políticas de producción.

Las fuentes importadas son WAV PCM16 estéreo de 40 segundos a **44,1 kHz**.
La diferencia respecto a los 48 kHz del motor obliga a pasar por
`SourcePreparationQueue` → `DecodeWorkerPool` → decode/remuestreo/escritura
de caché. Cada pasada tiene un directorio de caché nuevo. Se comprueban cuatro
trabajos de decode, cuatro estados ready con peaks de la misma decodificación
y solapamiento efectivo con playback. Reutilizar accidentalmente una caché
preparada o usar la instalación nativa provoca un error, no una medida de
importación artificialmente favorable.

El hilo de control empieza a enviar los trabajos un callback antes del salto.
La mezcla no incorpora las fuentes importadas, de modo que mantiene doce
pistas y 6144 renders de pista por pasada. La preparación usa un trabajador
de decode y se comparan uno/dos trabajadores de lectura. Las ventanas son de
512 bloques con buffer 128/512, siempre con precarga inicial y sin trim. Hay
ocho configuraciones y tres repeticiones, alternando el orden.

## Qué significan los campos nuevos

- `imports_requested/completed`: la carga solicitada y terminada. Una
  importación fallida invalida la ejecución.
- `import_ms`: envío, preparación y cierre del pool; puede terminar después
  de playback. Se espera al retorno de todos los callbacks de preparación,
  no solamente al cambio de estado del trabajo a Completed.
- `import_overlap_blocks`: bloques durante los que el controlador de
  importación estaba activo, incluyendo encolado y esperas. No es tiempo
  de CPU de decode.
- `import_active_at_jump`: indica si ese trabajo seguía activo al solicitar
  el salto. Permite distinguir las pasadas donde la carga ya había terminado.
- `peak_rss_bytes`: pico del proceso hasta terminar playback, incluida la
  preparación inicial. `peak_rss_after_import_bytes`: pico después de esperar
  también la importación restante. CPU, cache, I/O y ausencias de playback se
  capturan antes de esa espera final.

## Reproducción

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_streaming_playback -j 4
node scripts/audio-perf/bench-audio-streaming.mjs native/audio-engine-v2/build-bench/Release/bench_streaming_playback.exe bench-out-engine/import-nuevo 3 import
node scripts/audio-perf/report-audio-streaming.mjs bench-out-engine/import-nuevo/results.json bench-out-engine/import-nuevo/report.md
```

Los archivos originales y caches quedan dentro de la captura; nunca se usa
ni se purga la caché de la aplicación. Las opciones fijadas por el runner
quedan en los metadatos. El modo sin argumento final sigue ejecutando la
matriz anterior de streaming y liberación de caché.

## Límites

### Resultados del 2026-09-09

Se completaron 24 ejecuciones Release: doce sin importación y doce con cuatro
importaciones, todas terminadas. Los [datos crudos](measurements/2026-09-09-import.json)
y el [informe](measurements/2026-09-09-import.md) conservan las comparaciones
dentro del mismo ejecutable; no comparar su RAM directamente con ejecutables
anteriores que enlazaban menos componentes.
La preparación estaba activa al solicitar el salto en las doce pasadas con
importación. Compilación Release y ejecución completas aprobadas; se verificó
además el rechazo de una caché reutilizada y de un informe sin solapamiento.
El modo de streaming anterior completó una pasada de sus 16 configuraciones
con el ejecutable ampliado; los scripts pasan comprobación sintáctica.

No hubo renders fuera de plazo en 12 288 bloques. No aumentaron las ausencias
de fuente frente al caso equivalente sin importación: persistieron las del
salto frío. La importación sí elevó CPU y memoria. Con un trabajador de lectura
y buffer 512, las medianas pasan de 0,141 a 0,516 segundos de CPU por ventana
y de 56,9 a 65,7 MiB de pico residente hasta terminar playback. La preparación
de cuatro archivos tardó una mediana de 0,86–1,09 segundos según configuración.

Los p95 son mixtos y las ventanas cortas: no se deduce una aceleración ni una
regresión general. Estas medidas proporcionan una carga de importación
verificada para comparar futuras políticas; se mantienen los valores de
producción y queda pendiente medir hardware modesto y saltos protegidos.

### Alcance

Se mide WAV con remuestreo, no MP3/FFmpeg, descompresión de `.ltset`, análisis
de la interfaz ni cambios de sesión tras importar. Los archivos recién
generados están en la caché del sistema operativo. El proceso no incluye UI,
dispositivo de audio, warp ni condiciones térmicas de Android.

En esta matriz el salto es inmediato. La espera de audio de destino de producción
vive en `engine_impl.cpp`, en la capa de comandos; `JumpScheduler` por sí solo
no aplica esa protección. Para medir un salto protegido fiel hay que integrar
esa ruta y la preparación de voces, sin copiar una versión aproximada al banco.
La [entrega siguiente](04-salto-protegido.md) conecta el banco a ese manejador
real. Por eso no se atribuyen las ausencias del salto frío a la experiencia de la
aplicación. Este trabajo no reabre el incidente de CPU ya resuelto.
