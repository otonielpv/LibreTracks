---
title: Voz Guia
description: Anuncios de seccion hablados y conteo de entrada antes de las marcas y los saltos programados.
---

La **Voz Guia** anuncia la seccion que viene y te da la entrada antes de cada marca, igual que la app Playback de iPad guia a una banda. Cuando el cursor se acerca a una marca con tipo —o cuando un salto programado esta a punto de ejecutarse— una voz dice la seccion ("Coro", "Verso 2", "Puente") y cuenta los beats del compas previo ("1, 2, 3, 4") para que la banda entre junta en el downbeat.

Es una senal de **monitoreo**: como el metronomo, la voz no pasa por la cadena de audio de la cancion. Elige su propia salida en configuracion: el bus de monitor legacy, la salida principal o un canal de hardware concreto.

![Configuracion de la voz guia](/screenshots/Voice-Guide-Settings.png)

## Activar La Voz Guia

Abre `Configuracion` y entra a la pestana `Voz guia`:

- **Voz guia** — encendido/apagado general.
- **Idioma** — `Español` o `English`. Al cambiarlo se recarga el banco de voces correspondiente.
- **Salida de la voz guia** — a donde se enruta la senal hablada. Puede ser distinta de la salida del metronomo.
- **Compases de aviso** — cuantos compases antes de la marca se cuenta (por defecto `1`).
- **Conteo** — cuando esta activo, se cuentan los beats restantes tras el nombre de la seccion. Apagalo para oir solo el nombre.
- **Volumen de la voz** — nivel de la senal hablada respecto a la musica.

El banco de voces incluido viene en espanol e ingles. Las marcas sin grabacion para su tipo (o en *Custom*) reproducen solo el conteo, sin nombre hablado.

## Tipos De Seccion En Las Marcas

Para que la voz guia anuncie una marca, esta necesita un **tipo de seccion**. Haz clic derecho en una marca del timeline y elige `Tipo de seccion…`, luego selecciona la seccion (Intro, Verso, Pre Coro, Coro, Puente, Breakdown, Solo, Outro y mas). La marca se colorea segun su tipo en el timeline.

Las secciones con grabaciones numeradas —**Verso**, **Coro**, **Puente**, **Pre Coro**— abren un segundo menu donde puedes elegir la seccion simple o una variante numerada (Verso 1–6, Coro 1–4, …). Solo se ofrecen las variantes que existen en el banco de voces, asi que nunca veras un "Verso 8" sin audio.

![Menu de variante de seccion](/screenshots/Marker-Section-Variant.gif)

## Como Se Ubica La Señal

El compas previo a la marca lleva un **conteo completo** ("1, 2, 3, 4" en 4/4). El **nombre de la seccion se ubica para terminar justo en el downbeat** de ese conteo, de modo que el nombre acaba justo antes del "1" y nunca se pisa con el conteo —sin importar cuanto dure el nombre. Un nombre corto empieza mas tarde; uno largo ("Verso dos") empieza antes.

```
            [ Verso dos ]  uno  dos  tres  cuatro
                          └──── compas de conteo ────┘  → aqui entra el Verso 2
```

El conteo sigue el **compas (time signature)** de la cancion, incluidos los cambios de metrica a mitad de cancion. En 3/4 la voz cuenta "1, 2, 3"; en 5/4, "1, 2, 3, 4, 5". (Los compases compuestos como 6/8 cuentan cada subdivision por ahora.)

## Saltos Programados

La voz guia tambien cubre los **saltos de marca programados**. Cuando armas un salto a una seccion —al final de la region actual, despues de un numero de compases, o en la siguiente marca— la voz anuncia la seccion **destino** y te cuenta hacia el momento en que el salto se ejecuta; luego el salto ocurre en el downbeat. Oyes a donde vas a ir antes de llegar.

Si un salto deja muy poco tiempo de aviso (por ejemplo, un salto a solo un compas), el **conteo siempre suena** para que tengas la entrada ritmica; el nombre hablado se anade solo cuando cabe en el espacio restante.

Consulta [Control en vivo](./live-control-flow) para armar saltos de marca y configurar su modo de disparo.

## Consejos

- Combina la voz guia con el [metronomo](./audio-routing-metronome) en el mismo bus de monitor, o separalos en salidas de hardware distintas cuando necesites control independiente en la mezcla de monitoreo.
- Pon 2 compases de aviso en tempos rapidos si 1 compas se siente justo.
- Deja en *Custom* las marcas que no quieras anunciar — siguen sirviendo para navegacion y saltos, solo que sin nombre hablado.
