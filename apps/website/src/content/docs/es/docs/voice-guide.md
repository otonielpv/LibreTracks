---
title: Voz Guia
description: Anuncios de seccion hablados, avisos dinamicos y conteo de entrada antes de las marcas y los saltos programados.
---

La **Voz Guia** anuncia la seccion que viene y te da la entrada antes de cada marca, igual que la app Playback de iPad guia a una banda. Cuando el cursor se acerca a una marca con tipo —o cuando un salto programado esta a punto de ejecutarse— una voz dice la seccion ("Coro", "Verso 2", "Puente") y cuenta los beats del compas previo ("1, 2, 3, 4") para que la banda entre junta en el downbeat. Tambien puede dar **avisos dinamicos** —instrucciones cortas habladas como "Sube Intensidad", "Toda La Banda", "Entra Bateria" o "Sube Tono"— en los momentos donde los coloques.

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

## Marcas: Secciones, Avisos y Personalizadas

Cada marca del timeline es de uno de tres tipos. Al crear una marca (clic derecho en el timeline → `Crear marca…`) eliges su tipo de entrada, asi nace ya tipada y con nombre:

- **Secciones** — la estructura de la cancion (Intro, Verso, Pre Coro, Coro, Puente, Breakdown, Solo, Outro y mas). Se anuncian por su nombre y llevan conteo, y son los destinos a los que navegas y saltas.
- **Avisos** (avisos dinamicos) — instrucciones cortas habladas que ocurren *dentro* de una seccion, no la marcan: "Sube Intensidad", "Toda La Banda", "Entra Bateria", "Pausa", "Sostener", "Suave", "Ultima Vez", "Final Grande", "Sube/Baja Tono", y las llamadas por instrumento ("Bateria", "Bajo", "Guitarra", "Teclado"). Un aviso es un anuncio puntual —sin conteo— y **no** es un destino de navegacion.
- **Personalizada** — una marca sin tipo y sin nombre hablado. Sigue sirviendo para navegacion y saltos, solo que en silencio.

Tambien puedes cambiar el tipo de una marca existente: clic derecho y elige `Tipo de marca…`, luego elige del submenu **Secciones ▸** o **Avisos ▸**. Los avisos viven en su propio carril justo encima del de secciones, asi que un aviso y una seccion que compartan posicion quedan separados y ambos visibles y editables.

Las secciones con grabaciones numeradas —**Verso**, **Coro**, **Puente**, **Pre Coro**— abren otro menu donde puedes elegir la seccion simple o una variante numerada (Verso 1–6, Coro 1–4, …). Solo se ofrecen las variantes que existen en el banco de voces, asi que nunca veras un "Verso 8" sin audio.

![Menu de variante de seccion](/screenshots/Marker-Section-Variant.gif)

Las marcas se colorean segun su tipo en el timeline. Las marcas **Personalizadas** pueden llevar un color propio: clic derecho en una marca Personalizada y elige `Color…` para escoger un preset o un color a medida (las secciones y los avisos mantienen el color de su tipo).

## Como Se Ubica La Señal

El compas previo a la marca lleva un **conteo completo** ("1, 2, 3, 4" en 4/4). El **nombre de la seccion se ubica para terminar justo en el downbeat** de ese conteo, de modo que el nombre acaba justo antes del "1" y nunca se pisa con el conteo —sin importar cuanto dure el nombre. Un nombre corto empieza mas tarde; uno largo ("Verso dos") empieza antes.

```
            [ Verso dos ]  uno  dos  tres  cuatro
                          └──── compas de conteo ────┘  → aqui entra el Verso 2
```

El conteo sigue el **compas (time signature)** de la cancion, incluidos los cambios de metrica a mitad de cancion. En 3/4 la voz cuenta "1, 2, 3"; en 5/4, "1, 2, 3, 4, 5". (Los compases compuestos como 6/8 cuentan cada subdivision por ahora.)

## Avisos Dinamicos

Un **aviso** colocado lejos de cualquier seccion suena como anuncio puntual en su propia posicion —hablado justo cuando llegas a el, sin conteo.

Cuando un aviso cae en (o justo antes de) el downbeat de una seccion, se **encadena en el anuncio** entre el nombre de la seccion y el conteo, asi la banda oye la seccion, luego la instruccion, y luego el conteo aterrizando en el beat:

```
            [ Coro ] [ Sube Intensidad ]  uno  dos  tres  cuatro
                                          └──── compas de conteo ────┘  → aqui entra el Coro
```

Varios avisos en el mismo downbeat se dicen en orden ("Ultima Vez", "Final Grande", …). El conteo nunca se desplaza —siempre aterriza exactamente en el downbeat de la seccion.

## Saltos Programados

La voz guia tambien cubre los **saltos de marca programados**. Cuando armas un salto a una seccion —al final de la region actual, despues de un numero de compases, o en la siguiente marca— la voz anuncia la seccion **destino** y te cuenta hacia el momento en que el salto se ejecuta; luego el salto ocurre en el downbeat. Oyes a donde vas a ir antes de llegar.

Los **avisos pegados al destino del salto** tambien se anuncian — salta a un "Solo" que tiene un aviso "Guitarra" en su downbeat y oyes "Solo, Guitarra, 1, 2, 3, 4" antes de que el salto ocurra. El aviso se dice una sola vez, en el compas previo; **no** se repite cuando luego la reproduccion pasa por la posicion real del aviso.

Si un salto deja muy poco tiempo de aviso (por ejemplo, un salto a solo un compas), el **conteo siempre suena** para que tengas la entrada ritmica; el nombre hablado se anade solo cuando cabe en el espacio restante.

Consulta [Control en vivo](/es/docs/live-control-flow/) para armar saltos de marca y configurar su modo de disparo.

## Consejos

- Combina la voz guia con el [metronomo](/es/docs/audio-routing-metronome/) en el mismo bus de monitor, o separalos en salidas de hardware distintas cuando necesites control independiente en la mezcla de monitoreo.
- Pon 2 compases de aviso en tempos rapidos si 1 compas se siente justo.
- Deja en *Personalizada* las marcas que no quieras anunciar — siguen sirviendo para navegacion y saltos, solo que sin nombre hablado.
- Usa **avisos** para las indicaciones de arreglo (subir intensidad, parar la banda, cambio de tono) sin saturar tus marcas de seccion — pon un aviso justo en el downbeat de una seccion y se dira justo antes del conteo.
- En el **remote** solo aparecen las secciones: la lista de salto y la cinta del timeline muestran la estructura de la cancion, mientras los avisos quedan fuera (se llaman por voz, no se navega a ellos).
