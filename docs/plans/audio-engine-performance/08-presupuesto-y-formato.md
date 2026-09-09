# Presupuesto de disco y formato del audio preparado

Etapa 2026-09-09, posterior a [fidelidad de saltos](07-fidelidad-saltos.md).
Sigue siendo trabajo de banco: no cambia el motor, la interfaz ni ninguna
política de producción.

## Por qué esta etapa antes que ampliar la fidelidad

El coste de la estrategia era un único punto —12 pistas de 40 s en float32,
etapa 06— del que se extrapolaba todo lo demás, y esa extrapolación decidía si
la función puede existir en un móvil. Peor: decidía **en qué formato** habría
que revalidar la fidelidad. Validar float32 y enviar PCM16 no habría demostrado
nada sobre lo que suena.

Así que primero se mide el presupuesto como tasa, después se decide el formato,
y sólo entonces tiene sentido ampliar la matriz de fidelidad.

## Resultado del 2026-09-09

[Datos originales](measurements/2026-09-09-budget.json) e
[informe](measurements/2026-09-09-budget.md). 12 preparaciones Release:
1 y 4 pistas × float32 y PCM16 × 3 repeticiones con el orden alternado,
240 s de línea de tiempo por pista, warp 1,2 y tono +3.

### Disco: exacto y transferible

| Formato | MiB por pista-minuto | Canción de 4 min con 12 pistas preparadas |
| --- | ---: | ---: |
| float32 | 21,97 | 1,03 GiB |
| PCM16 | 10,99 | 0,51 GiB |

La cifra es idéntica con 1 y con 4 pistas, así que es una tasa de verdad y sirve
para estimar una sesión. **Se multiplica por las pistas con warp o tono, no por
todas**: una pista sin DSP no necesita prepararse.

Esto confirma la extrapolación que se hizo desde la etapa 06 y la sustituye por
una medida. No cambia la conclusión: la preparación no puede ser automática.

### Tiempo: no es una tasa

Entre 0,74 y 1,00 s por pista-minuto (60–80× tiempo real) en este i7, pero el
informe incluye las doce pasadas en orden con los GiB que el lote llevaba
escritos, y la deriva se ve: la misma combinación (PCM16, 4 pistas) pasó de 0,88
a 1,00 y a 1,44 s por pista-minuto según el lote acumulaba 0,47, 0,64 y 1,76 GiB.
Las pasadas de una sola pista se mantienen planas.

**Preparar una sesión entera de una vez se ralentiza a sí misma**, y en un disco
lento el efecto será mayor, no menor. Cualquier diseño de preparación explícita
tiene que contar con eso; una estimación lineal del tiempo total sería optimista.

## PCM16 no es una concesión nueva

La caché de decodificación del escritorio **ya guarda 16 bits en un WAV**
(`cache_sample_format` en `native/audio-engine-v2/src/sources/source_manager.cpp`),
tomando como referencia explícita la caché de Ableton, con el razonamiento ya
aceptado de que «int16 es de sobra para reproducir». El float32 sólo se activa
con `LIBRETRACKS_CACHE_FLOAT=1` para depurar, y el formato entra en la clave de
caché para que cambiarlo regenere en vez de reutilizar.

La pregunta, por tanto, no es si se puede bajar a 16 bits, sino si el audio
preparado tiene algo que la caché de decodificación no tenía.

### El ruido no

Los dos archivos preparados salen del mismo render determinista, así que su
diferencia **es** exactamente la cuantización: **−102,3 dBFS**, un suelo plano,
**79,8 dB por debajo del programa** con material a −22,5 dBFS. Cero muestras
recortadas.

### El techo sí

El fixture tiene pico −8,4 dBFS y el archivo preparado sale a **−5,1 dBFS**:
el warp y el tono añadieron **3,3 dB de pico**. La caché de decodificación
guarda material de origen; el preparado guarda material **después** del DSP.

Con este material no se recorta nada, pero implica que un stem por encima de
unos −3,3 dBFS llegaría al techo del formato, y ahí el recorte no es ruido
inaudible sino distorsión. El riesgo no es hipotético: el motor ya se topó con
él en la caché de decodificación, donde libsndfile **envolvía** las muestras que
pasaban de ±1 (−1,002 → +32694) hasta que se activó `SFC_SET_CLIPPING`; se
encontró en un stem de guitarra acústica a fondo de escala
(`source_manager.cpp`, junto a la escritura de la caché).

El preparador del banco recorta en vez de envolver —lo escribe a mano con
`std::clamp`, no vía libsndfile— y **cuenta cuántas veces lo hace**. Ese contador
es el que tiene que vigilar cualquier integración futura.

## La fidelidad se mantiene en PCM16

Se repitió la matriz completa de la etapa 07 contra un archivo preparado en
PCM16: [datos](measurements/2026-09-09-fidelity-pcm16.json) e
[informe](measurements/2026-09-09-fidelity-pcm16.md).

Los ocho casos dan **el mismo resultado que en float32**: desfase 0,00 ms,
correlación 0,9997–0,9999, error mediano 0,013–0,053 dB, ninguna ventana muda y
ningún clic exclusivo de la ruta viva. Las únicas diferencias están en la tercera
cifra de la relación de clic. **Enviar PCM16 no cambia ninguna conclusión de la
etapa anterior.**

## Decisión

Para audio preparado, **PCM16 con margen vigilado**:

1. Es el formato que la aplicación ya usa para audio cacheado, por la misma
   razón y con el mismo referente.
2. Halva el disco, que es el único recurso que impide plantearlo en Android.
3. No degrada nada medible: ni el ruido, ni la fidelidad de arranques y saltos.
4. Su único riesgo real es el techo, y es medible, contable y ya conocido por
   este repositorio.

Lo que **no** decide esta etapa: si la función debe existir. 0,51 GiB por canción
sigue siendo mucho para un móvil modesto, y sigue sin haber una sola medida en
un dispositivo así.

## Qué sigue faltando

1. Ninguna medida en PC modesto ni Android real. Los MiB se trasladan; los
   segundos no, y la deriva por acumulación de escrituras será peor allí.
2. Falta política de margen: qué hacer cuando el contador de recorte se dispara.
   Reducir el nivel del preparado y compensar al reproducir cambia la frontera
   con el mezclador y hay que diseñarlo, no improvisarlo.
3. Sigue faltando lo que dejó abierto la etapa 07: regiones múltiples, offsets,
   cambios de warp/tono en caliente con publicación atómica, y gain/pan/mute
   moviéndose durante el playback preparado.
4. Cuotas de disco, cancelación y limpieza siguen sin existir.

## Reproducción

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_prepare_warp bench_fidelity_jump -j 4
node --test scripts/audio-perf/audio-wav.test.mjs scripts/audio-perf/audio-fidelity-analysis.test.mjs scripts/audio-perf/audio-prepared-cache.test.mjs
node scripts/audio-perf/bench-audio-budget.mjs native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/presupuesto-nuevo 240 3
node scripts/audio-perf/report-audio-budget.mjs bench-out-engine/presupuesto-nuevo/results.json bench-out-engine/presupuesto-nuevo/report.md
node scripts/audio-perf/bench-audio-fidelity.mjs native/audio-engine-v2/build-bench/Release/bench_fidelity_jump.exe native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/fidelidad-pcm16 3 pcm16
node scripts/audio-perf/report-audio-fidelity.mjs bench-out-engine/fidelidad-pcm16/results.json bench-out-engine/fidelidad-pcm16/report.md
```

El directorio de salida debe ser nuevo. El presupuesto escribe ~2 GiB de WAV en
`bench-out-engine`, que está ignorado. Medir sin nada más ejecutándose: los
tiempos ya se degradan por sí solos dentro del propio lote.

| Archivo | Papel |
| --- | --- |
| `native/audio-engine-v2/bench/bench_prepare_warp.cpp` | Prepara en float32 o PCM16 y cuenta las muestras recortadas |
| `scripts/audio-perf/audio-wav.mjs` (+ `.test.mjs`) | Lector de los WAV del banco y estadísticas de error |
| `scripts/audio-perf/bench-audio-budget.mjs` | Matriz de formatos y tamaños con orden alternado |
| `scripts/audio-perf/report-audio-budget.mjs` | Valida la matriz y genera el informe |
