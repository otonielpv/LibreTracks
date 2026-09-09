# Los controles del mezclador sobre el audio preparado

Etapa 2026-09-09, posterior a [presupuesto y formato](08-presupuesto-y-formato.md).
Sigue siendo trabajo de banco: no cambia el motor ni ninguna política.

## Lo que faltaba comprobar

El plan afirma desde la etapa 06 que «se prepara antes de los controles del
mezclador, así que ganancia, pan y mute deben seguir siendo controles en vivo».
Nunca se había medido, y al montar la prueba resultó que la afirmación es más
frágil de lo que parece: `TrackRenderer` **sí** multiplica ganancia
(`effective_gain = pista × clip`), y el mezclador le pasa `1.0f` como
`track_gain_override` justamente para no aplicarla dos veces. El preparador hace
lo mismo, así que la ganancia de pista no se hornea — pero la de **clip** sí,
por diseño, porque es una edición y no un control en vivo.

La prueba correcta no es «¿se parecen las dos rutas?». Un archivo preparado con
la ganancia horneada seguiría pareciéndose perfectamente a la ruta viva hasta
que alguien tocara el fader. La pregunta es **cuánto cambia de nivel cada ruta
por separado** cuando se mueve el control.

## Resultado del 2026-09-09

[Datos originales](measurements/2026-09-09-fidelity-controls.json) e
[informe](measurements/2026-09-09-fidelity-controls.md). La matriz completa son
ahora 8 escenarios × 2 buffers × 2 rutas × 3 repeticiones, con el archivo
preparado en PCM16.

| Control | Efecto en vivo | Efecto en preparado | Diferencia |
| --- | ---: | ---: | ---: |
| Ganancia a la mitad | −6,02 dB | −6,02 dB | 0,00 dB |
| Panorama a la izquierda (canal derecho) | al suelo | al suelo | ≤ 0,03 dB |
| Enmudecer (ambos canales) | al suelo | al suelo | ≤ 0,03 dB |

−6,02 dB es exactamente el valor de media ganancia, y es un número que un
resultado equivocado no puede acertar por casualidad. **Los tres controles
actúan igual sobre las dos rutas.** Los escenarios de transporte de la etapa 07
siguen dando desfase 0,00 ms y error mediano de 0,013 a 0,053 dB.

## El efecto es un A/B, no una resta contra cero

La primera versión de esta medida informó de que **bajar la ganancia a la mitad
subía el nivel 2,15 dB**. No era el motor: con warp 1,2 las dos ventanas de
medio segundo a cada lado del evento caen sobre trozos distintos del fixture
—ráfagas antes, barrido después— y ese cambio propio del material vale más de
8 dB.

La corrección es un escenario `none` que hace la captura idéntica sin tocar
nada. El efecto de cada control es su pasada menos esa referencia, dentro de la
misma repetición y el mismo buffer, así que el cambio del material se cancela.
Sin esa referencia la tabla de arriba habría publicado tres cifras sin sentido.

## Una asimetría anotada y no corregida

El suelo de enmudecer y de panorama no es el mismo con los dos buffers: a los
50 ms del cambio, con 512 ya hay silencio digital y con 128 quedan −92 dBFS.

La causa está en `mixer.cpp`: ganancia, panorama y mute se suavizan con un polo
simple de coeficiente `num_frames / (sample_rate · 10 ms)`, interpolado por
muestra dentro del bloque. Con 512 el coeficiente se satura a 1, así que el
cambio es una rampa lineal limpia de 10,67 ms. Con 128 vale 0,27 y el nivel
decae geométricamente, tardando unos 55 ms en apagarse del todo.

Ninguna de las dos produce clics y la diferencia es inaudible. **Se deja
anotada, no corregida:** es el hot path del audio y una asimetría cosmética
entre configuraciones no justifica tocarlo.

## Qué sigue faltando

1. Regiones múltiples, offsets de clip distintos de cero y ganancia de clip no
   unitaria. El fixture sigue montando una región y un clip.
2. **La clave de la caché preparada no incluye la ganancia de clip ni la
   disposición de clips** (`scripts/audio-perf/audio-prepared-cache.mjs`). Como el
   preparador sí hornea la ganancia de clip, editarla no invalidaría el archivo.
   Es un fallo del contrato y hay que arreglarlo antes de que la función exista.
3. Cambios de warp/tono en caliente con publicación atómica.
4. Cuotas de disco, cancelación y limpieza.
5. Ninguna medida en PC modesto ni Android real.

## Reproducción

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_fidelity_jump bench_prepare_warp -j 4
node --test scripts/audio-perf/audio-fidelity-analysis.test.mjs
node scripts/audio-perf/bench-audio-fidelity.mjs native/audio-engine-v2/build-bench/Release/bench_fidelity_jump.exe native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/controles-nuevo 3 pcm16
node scripts/audio-perf/report-audio-fidelity.mjs bench-out-engine/controles-nuevo/results.json bench-out-engine/controles-nuevo/report.md
```
