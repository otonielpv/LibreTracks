# Fidelidad del audio preparado en arranques y saltos

Etapa 2026-09-09, posterior al [prototipo de preparación](06-audio-preparado.md).
Sigue siendo trabajo de banco: no cambia el motor, la interfaz ni ninguna
política de producción.

## Por qué esta etapa antes que la integración

La verificación de la etapa 06 comparaba muestra a muestra el archivo preparado
contra un segundo render continuo **desde el frame 0**. Eso demuestra que el
render y el viaje por disco son deterministas, y nada más. En cuanto el usuario
pulsa play o salta, el DSP vivo reconstruye sus voces en el destino: el archivo
conserva la historia de un render continuo y la voz nueva no. Sustituir una ruta
por la otra sin medir esa diferencia habría sido cambiar lo que se oye a ciegas.

Se comparan cuatro momentos reales —arranque, salto adelante, salto atrás y
reanudación— con los manejadores auténticos de `CmdSeekAbsolute`, `CmdPlay` y
`CmdPause`. El arranque y la reanudación reproducen la secuencia de la
aplicación: `SeekAbsolute(posición)` y después `Play`
(`apps/desktop/src-tauri/src/audio/engine.rs::play`).

**No se exige igualdad bit a bit tras reconstruir voces.** No es la semántica
correcta: la fase de grano difiere por construcción. Lo que debe cumplirse es
que llegue el mismo contenido, en el mismo instante y al mismo nivel, y que
ninguna ruta enmudezca ni chasquee donde la otra no lo hace.

## Resultado del 2026-09-09

Se conservan los [datos originales](measurements/2026-09-09-fidelity.json) y el
[informe generado](measurements/2026-09-09-fidelity.md). Son 24 comparaciones
Release: 4 escenarios × 2 buffers × 3 repeticiones, una pista, warp 1,2 y
tono +3, con captura de las dos rutas en cada caso.

- **Desfase 0,00 ms en los ocho casos**, con correlación de envolvente entre
  0,99972 y 0,99995. El DSP vivo aterriza exactamente donde habría estado un
  render continuo, en los cuatro eventos y en los dos buffers.
- Error mediano de nivel entre **0,013 y 0,053 dB**.
- Ninguna ventana con una ruta muda y la otra sonando, en ningún caso.
- La relación de clic de la ruta viva **nunca supera a la de la preparada**
  (0,03/0,03 hasta 1,51/1,62). El fundido de 128 frames posterior al salto es
  el mismo en ambas, y ninguna introduce un salto de muestra que la otra no
  tenga.
- Las tres repeticiones produjeron capturas **idénticas byte a byte** (SHA-256
  por ruta y caso). La captura es determinista por construcción: fuente
  residente, comandos síncronos y sin concurrencia.

La única fila que no converge de inmediato es el salto atrás con buffer 128:
660 ms. El informe la desglosa. Son siete ventanas sueltas de 1,3 a 4,2 dB
repartidas por los cuatro segundos, todas con la referencia entre −48 y
−60 dBFS: las colas de las ráfagas percusivas del fixture, 30 dB por debajo del
programa. Con buffer 512 los mismos instantes aparecen y la recuperación sale 0
sólo porque el primer hueco limpio de 200 ms cae antes. **No es un tiempo de
asentamiento del motor**; es la sensibilidad de esa métrica a diferencias
inaudibles, y por eso el informe publica el nivel de referencia junto al error.

## Dos veces estuvo a punto de reportar un defecto que no existía

Conviene dejarlo escrito porque las dos trampas son genéricas de este tipo de
medida, no de este banco.

1. **El evento caía sobre silencio.** Con el anclaje inicial en el segundo 5, el
   arranque aterrizaba en la ventana de impulsos del fixture: muestras sueltas
   sobre silencio digital. La comparación informaba de un «transitorio de
   asentamiento» de 2,9 dB medido entre −52 y −140 dBFS, donde no había nada que
   comparar. Las posiciones se movieron para que los cuatro eventos caigan sobre
   material continuo, y la métrica publica ahora el nivel de referencia de los
   primeros 100 ms para que esa confusión no pueda repetirse en silencio.
2. **Las diferencias en dB sobre silencio dominaban las estadísticas.** Dos
   renders a −92 y −105 dBFS se diferencian en 13 dB y son ambos silencio. Sin
   puerta de nivel, esos picos marcaban el p95, el máximo y el tiempo de
   recuperación de todas las filas. Ahora el error sólo se calcula donde la
   referencia supera −60 dBFS, las ventanas por debajo se cuentan aparte, y las
   dos formas de equivocarse con el silencio —una ruta muda donde la otra
   suena— se cuentan en columnas propias para que la puerta no pueda tapar un
   defecto real.

## El analizador tiene que saber fallar

`scripts/audio-perf/audio-fidelity-analysis.test.mjs` inyecta doce defectos que el
analizador debe nombrar: una ruta que llega tarde, otra que llega pronto, 6 dB
de diferencia de nivel, una diferencia que converge, silencio en una sola ruta,
contenido presente sólo en una, un escalón que suena a clic, una diferencia
confinada al silencio que no debe promediarse, un nivel de referencia bajo que
debe reportarse y un desfase que la búsqueda no alcanza y debe marcar como no
fiable.

Dos de esos tests encontraron fallos reales del analizador antes de que hubiera
ninguna medida que interpretar:

- La búsqueda de desplazamiento devolvía **−1 s para dos capturas idénticas**.
  El material musical es casi periódico y cualquier múltiplo del patrón
  correlaciona igual de bien; la búsqueda aceptaba el primer empate que visitaba.
  Ahora recorre los desplazamientos por distancia creciente a cero.
- Un hueco de 0,5 s en una ruta se «explicaba» deslizando un segundo entero,
  porque una correlación sobre un tercio de los datos puede ganar a una sobre
  todos. El desplazamiento está acotado para que nunca compare menos del 75 % de
  la ventana, y la fila avisa cuando ningún desplazamiento alineó las capturas.

## Qué sigue faltando

1. Una región, offsets cero, ganancia de clip unitaria y parámetros constantes.
   No cubre regiones múltiples, automatización, edición durante playback ni
   cambios de warp/tono en caliente. La invalidación de caché está probada en
   `scripts/audio-perf/audio-prepared-cache.test.mjs`, pero **no se ha probado que un
   cambio de parámetros durante la reproducción no llegue a sonar desde caché
   obsoleta**: eso exige la publicación atómica que el prototipo no tiene.
2. Gain, pan y mute siguen sin ejercitarse durante el playback preparado. El
   archivo se escribe antes de los controles del mezclador, y esa frontera está
   documentada, pero no medida con los controles moviéndose.
   *(Resuelto después en la [etapa 09](09-controles-en-vivo.md): media ganancia
   da −6,02 dB exactos en las dos rutas.)*
3. El salto se ejecuta de forma síncrona entre dos renders para que ambas rutas
   recorran la misma línea de tiempo. La latencia del salto concurrente sigue
   siendo cosa de `bench_streaming_playback`.
4. Sigue sin dispositivo, sin interfaz, sin carga térmica sostenida y sobre un
   i7 potente. Nada de esto autoriza a activar preparación automática ni a
   extrapolar a Android.

## Reproducción

```powershell
cmake --build native/audio-engine-v2/build-bench --config Release --target bench_fidelity_jump bench_prepare_warp -j 4
node --test scripts/audio-perf/audio-fidelity-analysis.test.mjs
node scripts/audio-perf/bench-audio-fidelity.mjs native/audio-engine-v2/build-bench/Release/bench_fidelity_jump.exe native/audio-engine-v2/build-bench/Release/bench_prepare_warp.exe bench-out-engine/fidelidad-nueva 3
node scripts/audio-perf/report-audio-fidelity.mjs bench-out-engine/fidelidad-nueva/results.json bench-out-engine/fidelidad-nueva/report.md
```

El directorio de salida debe ser nuevo. El fixture (90 s) y los archivos
preparados (48 s por buffer) se generan dentro; quedan en `bench-out-engine`,
que está ignorado. La primera repetición con buffer 512 escribe además, por
escenario, tres WAV para escuchar: ruta viva, ruta preparada y su diferencia.

| Archivo | Papel |
| --- | --- |
| `native/audio-engine-v2/bench/bench_fidelity_jump.cpp` | Captura una ruta y un escenario con los comandos reales |
| `scripts/audio-perf/audio-fidelity-fixture.mjs` | Fixture con impulsos, ráfagas, barrido y silencio |
| `scripts/audio-perf/audio-fidelity-analysis.mjs` | Alineación, error de nivel, convergencia, mudez y clic |
| `scripts/audio-perf/audio-fidelity-analysis.test.mjs` | Doce defectos inyectados que el analizador debe nombrar |
| `scripts/audio-perf/bench-audio-fidelity.mjs` | Prepara, captura la matriz y compara |
| `scripts/audio-perf/report-audio-fidelity.mjs` | Valida la matriz y genera el informe |
