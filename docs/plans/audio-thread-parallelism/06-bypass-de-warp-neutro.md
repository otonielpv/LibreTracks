# 06 — No invocar a Bungee cuando el warp es la identidad

**Depende de:** 01 (para medir la ganancia). Independiente de todo lo demás.
**Toca:** `native/audio-engine-v2/src/render/pitch_resolution.cpp`,
`src/pitch/bungee_voice_manager.cpp`.
**Riesgo:** bajo-medio. El riesgo real no es el bypass, es el **cambio de camino
en caliente**; ver «La trampa» más abajo.

## Problema

Hecho 2 del diagnóstico: **el coste de una voz Bungee no depende del ratio.**
Medido a ratio 1.00 / 0.80 / 1.25: 106,4 / 107,3 / 106,7 µs por voz. Idénticos.

Y `pitch_resolution.cpp:104-111` no tiene atajo:

```cpp
if (d.warp_active) {
    d.path = ClipPathKind::Stretched;      // sin mirar el ratio
} else if (d.needs_pitch) {
    d.path = ClipPathKind::Varispeed;
} else {
    d.path = ClipPathKind::Direct;
}
```

Un usuario que activa el warp «por si acaso» y no cambia el tempo hace que
Bungee analice y resintetice **todas** las pistas para reproducir exactamente el
mismo audio, a ~1 % del presupuesto por pista. En una sesión de 24 pistas, eso
es 25 puntos de carga a cambio de nada.

`enumerate_voices` (`bungee_voice_manager.cpp:225-243`) tampoco lo mira: enrola
una voz por cada clip que solape una región con `warp_enabled`.

## Por qué es seguro decidirlo de forma estática

`resolve_warp_time_ratio` (`pitch_resolution.cpp:113-123`) calcula el BPM
objetivo con `effective_bpm_at_frame(song, region->start_frame)` — el **frame de
inicio de la región**, no el frame actual.

Es decir: **el ratio de una región es constante durante toda la región.** No
puede cambiar a mitad por un marcador de tempo. Eso convierte el bypass en una
decisión estática por región, evaluable en el momento de construir las voces, no
por bloque.

## Cambio pedido

### 1. Concepto de «warp neutro»

Una región tiene warp neutro cuando **todo** esto se cumple:

- `warp_enabled` y `warp_source_bpm > 0`, y
- `resolve_warp_time_ratio(song, ...) == 1.0` **exactamente**, y
- la transposición efectiva del clip es 0 semitonos.

En ese caso Bungee es la identidad y el clip debe ir por `Direct`.

**El ratio se compara con una tolerancia, no con `==`.** Define la tolerancia
explícitamente (por ejemplo `|ratio - 1.0| < 1e-9`) y **documenta por qué ese
número**: un ratio de 1,000001 sí deriva audiblemente en una canción larga, así
que la tolerancia debe ser mucho más estrecha que el error que acumularía. Si no
sabes justificar el valor, usa igualdad exacta de `double`.

### 2. No enrolar voces para clips neutros

En `enumerate_voices`, saltar los clips cuya región sea neutra **y** cuya
transposición efectiva sea 0. Esto ahorra la construcción y el calentamiento de
la voz, no sólo el render — que es donde están los ~160 ms de
`build_voices_ms` que menciona el histórico del repo.

### 3. La transposición cambia en caliente

`region.transpose_semitones` lo cambia el usuario mientras suena. Un clip neutro
que pasa a +2 semitonos necesita voz; uno que vuelve a 0 deja de necesitarla.

El gestor **ya** reconstruye ante cambios de sesión, y existe
`retime_existing_for_session` precisamente para no reconstruir de más (commit
`e4032e29`, y la nota `project_transpose_rebuild_desync`). Asegúrate de que el
cambio de transposición dispara el camino correcto: crear la voz que falta sin
tirar las que ya existen.

## La trampa: el cambio de camino en caliente

`Direct` y `Stretched` **no están alineados en el tiempo de la misma manera**.
La voz Bungee tiene un `feed_lead` y una latencia de ~110 ms que el renderer
compensa; el camino `Direct` lee la fuente sin compensación. Cambiar de camino
en mitad de la reproducción, en un límite de bloque, puede producir un salto
audible.

Por eso:

- La decisión se toma **al construir el mapa de voces**, no por bloque.
- `render_path_stretched` **ya** cae con elegancia cuando no hay voz para el
  clip: incrementa `pitch_missing_stream_silence_count_` y devuelve 0, o sea
  silencio. Eso **no** sirve aquí: si no hay voz porque el clip es neutro,
  tiene que sonar por `Direct`, no callarse.
- Es decir: `resolve_pitch_render_decision` y `enumerate_voices` **tienen que
  estar de acuerdo**. Si uno dice `Stretched` y el otro no enrola la voz, la
  pista enmudece. Extrae el predicado de neutralidad a **una sola función
  compartida** que llamen los dos. Esto no es opcional.

Ver también `project_region_parsers_must_mirror`: en este repo ya hubo un bug
por tener la misma regla escrita en varios sitios.

## Criterios de aceptación

- [ ] C1 — El predicado de neutralidad vive en **una sola función**, y tanto
      `resolve_pitch_render_decision` como `enumerate_voices` la llaman.
      Verificable leyendo el diff; el REVIEWER lo comprobará.
- [ ] C2 — Región con `warp_enabled`, ratio exactamente 1.0 y 0 semitonos:
      `resolve_pitch_render_decision` devuelve `ClipPathKind::Direct` y
      `enumerate_voices` no enrola voz para ese clip. Test.
- [ ] C3 — **La pista suena.** Test que renderiza esa región y compara la salida
      contra la del mismo material **sin warp activado**: bit-exacta. Es el
      criterio central: el bypass sólo es válido si el resultado es el mismo que
      no tener warp.
- [ ] C4 — Región neutra en ratio pero con transposición ≠ 0: **sí** enrola voz
      y va por `Stretched`. Test.
- [ ] C5 — Región con ratio ≠ 1.0 y 0 semitonos: **sí** enrola voz. Test con
      ratio 1.2 y con 0.8.
- [ ] C6 — Transición en caliente: reproduciendo una región neutra, el usuario
      cambia la transposición a +2. La pista sigue sonando (no hay silencio de
      un bloque, no hay `pitch_missing_stream_silence_count_` incrementado) y
      pasa a estar transpuesta. Test. **Este es el criterio con más riesgo del
      paso.**
- [ ] C7 — La transición inversa (+2 → 0) también suena y vuelve a `Direct`.
- [ ] C8 — Con `bench_render_callback --tracks 24 --warp 1 --ratio 1.0`, la
      carga cae al mismo orden que `--warp 0`. Pega la cifra antes y después
      contra `baseline.json`.
- [ ] C9 — Prueba de que sabe fallar: rompe el predicado (por ejemplo, que
      devuelva siempre `false`) y comprueba que C2 y C8 se ponen rojos.
- [ ] C10 — `npm run test:native` pasa, incluidos `warp_timing_tests.cpp` y
      `pitch_resolution_tests.cpp`, sin cambios de resultado.

## Notas para el implementador

- Cuidado con `TransposeBehavior::NeverTranspose`: hoy, con warp activo, fuerza
  `effective_semitones = 0` pero **sigue** yendo por `Stretched`, porque necesita
  el estiramiento temporal para no desincronizarse. Si el ratio es 1.0, esa
  pista **también** es neutra y también debe ir por `Direct`. Compruébalo
  explícitamente; es fácil equivocarse aquí.
- No cambies el valor del ratio ni cómo se calcula. Este paso sólo añade un
  atajo cuando ya vale 1.
- El metrónomo, la voz guía y los pads no pasan por este camino. No los toques.
