# Fidelidad del audio preparado en arranques y saltos

12th Gen Intel(R) Core(TM) i7-12700KF; Release; una pista, warp 1,2 y tono +3; archivo preparado en pcm16; 3 repeticiones por caso.

Se compara el DSP vivo contra el archivo preparado en la misma línea de tiempo, con los manejadores reales de `CmdSeekAbsolute`, `CmdPlay` y `CmdPause`. No se exige igualdad muestra a muestra: el DSP vivo reconstruye las voces en el destino del salto y el archivo preparado conserva la historia de un render continuo, así que la fase de grano difiere por construcción. Lo que sí debe cumplirse es que llegue el mismo contenido, en el mismo instante y al mismo nivel.

| Escenario | Buffer | Nivel ref. dBFS | Nivel 0-100 ms | Desfase ms | Correlación | Fiable | Error mediano dB | p95 dB | Máx dB >-40 dBFS | Recuperación ms | Silencio vivo | Silencio preparado | Clic vivo/preparado |
| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arranque | 128 | -24.8 | -19.1 | 0.00 | 0.99986 | sí | 0.029 | 0.18 | 1.56 | 0 | 0 | 0 | 0.54 / 0.80 |
| Salto adelante | 128 | -24.4 | -24.1 | 0.00 | 0.99989 | sí | 0.036 | 0.14 | 0.65 | 0 | 0 | 0 | 0.06 / 0.06 |
| Salto atrás | 128 | -33.8 | -39.3 | 0.00 | 0.99985 | sí | 0.053 | 0.21 | 0.74 | 660 | 0 | 0 | 1.43 / 1.71 |
| Reanudación | 128 | -24.4 | -21.0 | 0.00 | 0.99995 | sí | 0.020 | 0.15 | 0.77 | 0 | 0 | 0 | 0.03 / 0.03 |
| Arranque | 512 | -24.8 | -19.1 | 0.00 | 0.99972 | sí | 0.029 | 0.23 | 2.38 | 0 | 0 | 0 | 0.69 / 0.78 |
| Salto adelante | 512 | -24.4 | -24.1 | 0.00 | 0.99986 | sí | 0.045 | 0.11 | 0.31 | 0 | 0 | 0 | 0.06 / 0.07 |
| Salto atrás | 512 | -33.7 | -39.4 | 0.00 | 0.99993 | sí | 0.013 | 0.21 | 0.82 | 0 | 0 | 0 | 1.51 / 1.62 |
| Reanudación | 512 | -24.5 | -21.0 | 0.00 | 0.99991 | sí | 0.017 | 0.13 | 2.43 | 0 | 0 | 0 | 0.03 / 0.03 |

## Los controles del mezclador siguen vivos

El archivo preparado se escribe ANTES de ganancia, panorama y enmudecido. La prueba no es que las dos rutas se parezcan —eso ya se sabe—, sino que cada una cambie de nivel **lo mismo** cuando se mueve el control: si el preparado hubiera horneado la ganancia, las dos rutas seguirían pareciéndose hasta que alguien tocara el fader.

| Control | Buffer | Canal | Efecto en vivo dB | Efecto en preparado dB | Diferencia dB |
| --- | ---: | :---: | ---: | ---: | ---: |
| Ganancia a la mitad | 128 | I | -6.02 | -6.02 | 0.00 |
| Ganancia a la mitad | 128 | D | -6.02 | -6.02 | 0.00 |
| Panorama a la izquierda | 128 | I | 0.00 | 0.00 | 0.00 |
| Panorama a la izquierda | 128 | D | -69.54 | -69.57 | 0.03 |
| Enmudecer | 128 | I | -69.67 | -69.69 | 0.03 |
| Enmudecer | 128 | D | -69.54 | -69.57 | 0.03 |
| Ganancia a la mitad | 512 | I | -6.02 | -6.02 | 0.00 |
| Ganancia a la mitad | 512 | D | -6.02 | -6.02 | 0.00 |
| Panorama a la izquierda | 512 | I | 0.00 | 0.00 | 0.00 |
| Panorama a la izquierda | 512 | D | -116.76 | -116.76 | 0.00 |
| Enmudecer | 512 | I | -118.16 | -118.16 | 0.00 |
| Enmudecer | 512 | D | -116.76 | -116.76 | 0.00 |

Los niveles son medias cuadráticas de medio segundo a cada lado del cambio, saltándose 50 ms.

El suelo de enmudecer y de panorama **no es el mismo con los dos buffers**, y no es un fallo: el mezclador suaviza ganancia, panorama y mute con un polo simple cuyo coeficiente es `num_frames / (sample_rate · 10 ms)`, e interpola por muestra dentro del bloque. Con 512 ese coeficiente se satura a 1, así que el cambio es una rampa lineal limpia de 10,67 ms y a los 50 ms ya hay silencio digital. Con 128 vale 0,27 y el nivel decae geométricamente: sigue en −92 dBFS a los 50 ms y tarda unos 55 ms en apagarse del todo. Ninguna de las dos produce clics, y la diferencia es inaudible; se deja anotada, no corregida.

**El efecto es un A/B, no una resta contra cero.** El nivel antes y después del evento no es el mismo material: con warp 1,2 las dos ventanas caen sobre trozos distintos del fixture, y ese cambio propio vale varios dB. La pasada de referencia, que hace la captura idéntica sin tocar nada, midió 8.17 / 8.20 dB en la ruta viva; cada efecto de arriba es la pasada con el control menos esa. Sin restarla, bajar la ganancia a la mitad se leía como +2,15 dB.

Enmudecer lleva las dos rutas al suelo del medidor, así que su efecto no es una cifra con sentido físico; lo que importa ahí es que las dos caigan lo mismo.


El nivel de referencia es el del archivo preparado: mediana de toda la ventana y de los primeros 100 ms. Sin él, un motor que tarda en asentarse y un evento que cae sobre silencio producen exactamente los mismos números de error.

El error en dB sólo se calcula donde la referencia supera -60 dBFS. Sin esa puerta las estadísticas las domina el silencio: dos renders a −92 y −105 dBFS se diferencian en 13 dB y son ambos silencio. Las ventanas por debajo del suelo se cuentan aparte y las dos formas de equivocarse con el silencio (una ruta muda donde la otra suena) se cuentan explícitamente en sus propias columnas.

El desfase se busca por correlación de envolvente, acotada para que un desplazamiento no pueda compararse sobre menos del 75 % de la ventana. «Fiable» es la correlación en el mejor desplazamiento: si es «no», ningún desplazamiento alineó las dos capturas y el desfase de esa fila no significa nada.

La relación de clic es el mayor salto entre muestras consecutivas en los 20 ms posteriores al fundido de salto, dividido por el percentil 99,9 de esa misma ruta ya asentada. Compara cada ruta consigo misma, así que no depende de lo abrupto que sea el material.

## Ventanas que rompieron la convergencia

Cada fila sin recuperación inmediata se desglosa aquí. Comprobar el nivel de referencia antes de leer el error: una diferencia de 3 dB a −55 dBFS está 30 dB por debajo del programa y no es lo mismo que una a −20 dBFS.

| Escenario | Buffer | ms | Referencia dBFS | Vivo dBFS | Error dB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Salto atrás | 128 | 655 | -53.2 | -57.4 | 4.18 |
| Salto atrás | 128 | 2500 | -59.6 | -63.5 | 3.94 |
| Salto atrás | 128 | 485 | -51.3 | -54.4 | 3.15 |
| Salto atrás | 128 | 320 | -48.7 | -46.9 | 1.77 |

## Alcance

Fixture con impulsos, ráfagas percusivas, barrido y silencio (90 s), pico 0.380, 113 impulsos. Una pista, una región, offsets cero, ganancia de clip unitaria y parámetros constantes. No cubre regiones múltiples, automatización, edición durante playback ni cambios de warp/tono en caliente.

Los saltos se ejecutan de forma síncrona entre dos renders para que ambas rutas recorran exactamente la misma línea de tiempo; la latencia del salto concurrente la mide `bench_streaming_playback`, no esta captura. La fuente entera reside en memoria y cualquier fallo de lectura aborta la pasada: un bloque hambriento nunca puede aparecer aquí como diferencia de fidelidad.

Banco sin dispositivo de audio, sin interfaz y sin carga térmica sostenida, sobre un PC potente. No es una emulación de Android ni demuestra ausencia de cortes en un driver real.

Captura SHA-256: ce30d714d154a30e8312621a29d041dc4709d7b06634e1b7d74f5d311777fde3

Preparador SHA-256: bf0ecb4a788e59f472ae2fc1d005c0a1c95f65623abd34bb697d583b4d7122e5

Commit: 6e456519f366682ab6f59f16fad0c0c728f228ff (árbol con cambios sin commitear)
