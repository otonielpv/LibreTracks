# 03 — Resolver el routing fuera del hilo de audio

**Depende de:** 02 (necesitas el detector para demostrarlo).
**Toca:** `native/audio-engine-v2/src/render/mixer.cpp`,
`include/lt_engine/render/mixer.h`.
**Riesgo:** bajo. Mueve un cálculo de sitio; no cambia qué se calcula.

## Problema

Hallazgo 5.1 del diagnóstico. Por cada pista y cada bloque, en las **dos** rutas
de render (`mixer.cpp:647` y `mixer.cpp:979`):

```cpp
auto route = route_channels(resolve_effective_audio_route(track, song), num_channels,
                            render_output_channels_.data(),
                            render_output_channel_count_);
const int left_channel  = route.empty() ? 0 : route[0];
const int right_channel = route.size() > 1 ? route[1] : -1;
```

Tres costes, todos en el hilo de tiempo real:

1. `resolve_effective_audio_route` devuelve `std::string` **por valor**, y llama
   a `normalize_audio_route(std::string route)` — parámetro **por valor** — una
   vez por nivel de la cadena de carpetas.
2. `route_channels` copia otro `std::string` y devuelve un **`std::vector<int>`**,
   que siempre va al heap.
3. `find_track_in_song`, dentro de la resolución, es un `std::find_if` lineal
   comparando `std::string`.

De todo eso, lo único que sale es **dos enteros**.

El comentario que hay cinco líneas más arriba, en la misma función, documenta
que este mismo patrón ya provocó stalls medibles con la copia de `Track`, y que
se arregló entonces. Este es el hermano que quedó vivo.

## Cambio pedido

### Alcance aclarado: drenaje del scheduler dentro del callback

El guard del paso 02 demuestra que `Mixer::render` también llama a
`JumpScheduler::drain_pending()`. Esa función construía una cola temporal con
asignación en cada callback, por lo que C1 no puede llegar a cero aunque el
routing quede precalculado. El paso incluye por tanto la reutilización de esa
cola en `src/scheduler/jump_scheduler.cpp`: sigue siendo una higiene del mismo
callback, no un cambio del reloj ni de la semántica de saltos. El orden y los
resultados de los saltos deben permanecer idénticos.

### 1. Precalcular el routing en el slot de control

`TrackControlState` (`mixer.h`, ~línea 180) ya guarda estado derivado por pista
y ya lo rellena la hebra de control en `rebuild_control_slots`. Añade ahí:

```cpp
int route_left_channel  = 0;   // canal físico izquierdo, ya resuelto
int route_right_channel = -1;  // -1 = mono / sin par derecho
```

y rellénalos en el mismo sitio donde ya se calcula `parent_control_index`.

### 2. Recalcular cuando (y sólo cuando) cambie una entrada

El resultado depende de tres cosas, y las tres cambian **en la hebra de
control**:

| Entrada | Dónde cambia |
| --- | --- |
| `track.audio_to` y la cadena de padres | `set_session` → `rebuild_control_slots` |
| El mapa de canales activos | `set_active_output_channels` |
| `num_channels` del dispositivo | reconfiguración del dispositivo |

Cualquiera de los tres debe disparar el recálculo. Usa la misma disciplina de
publicación que ya emplea `set_active_output_channels`: publicar un contador a
cero, escribir, y publicar el contador nuevo con `release`.

### 3. Consumirlo en el bucle de pistas

En las dos rutas, sustituir el bloque de arriba por una lectura de los dos
enteros del slot. **Mantén el camino de respaldo**: cuando una pista no tiene
slot de control (`fallback_control_`, la ruta que existe mientras
`control_count_` es 0 durante un rebuild), hay que seguir dando un routing
correcto. Resuélvelo sin asignar: `route_channels` puede reescribirse para
escribir en dos `int&` de salida en vez de devolver un `vector`, y
`normalize_audio_route` para tomar `std::string_view`.

### 4. No cambiar el resultado

Este paso **no** cambia a qué canal sale ninguna pista. Es un movimiento de
cálculo, no un rediseño del routing.

## Criterios de aceptación

- [ ] C1 — El test del paso 02 (`test_rt_no_allocations`) queda **en verde y
      activo**: `violations().allocations == 0` tras ≥ 100 bloques de una
      sesión de ≥ 8 pistas, con warp activo y con carpetas anidadas.
- [ ] C2 — Prueba de que sabe fallar: revierte temporalmente el cambio (o mete
      un `new` en el bucle) y comprueba que C1 se pone rojo. Pega ambas salidas.
- [ ] C3 — **Equivalencia de routing exhaustiva.** Test parametrizado que, para
      cada combinación de `audio_to` que soporta `normalize_audio_route`
      (`master`, `main`, `monitor`, `inherit`, `ext:N`, `hardware:N`, `out_N`,
      `out N`, vacío, y un valor basura) y para 2, 4 y 8 canales de salida,
      compara el par de canales nuevo contra el que devuelve la implementación
      antigua. Deben coincidir en **todos** los casos.
- [ ] C4 — Herencia por carpetas: una pista con `audio_to = "inherit"` dentro de
      una carpeta con `audio_to = "ext:3"` sale por el mismo par que hoy.
      Incluye el caso de 3 niveles de anidamiento y el de una carpeta que a su
      vez hereda.
- [ ] C5 — El routing se recalcula al cambiar los canales activos: test que
      llama a `set_active_output_channels` con un mapa distinto y verifica que
      el siguiente bloque sale por los canales nuevos, **sin** rebuild de
      sesión.
- [ ] C6 — La ruta de respaldo (sin slot de control) sigue dando el routing
      correcto y **tampoco asigna**. Test que fuerza `control_count_ == 0`.
- [ ] C7 — Salida **bit-exacta** contra la implementación anterior: renderiza
      una sesión fija de ≥ 8 pistas con carpetas y routing mixto, 200 bloques,
      antes y después del cambio, y compara muestra a muestra. Cero diferencia.
- [ ] C8 — `npm run test:native` pasa. `cargo check --all-targets` pasa.

## Notas para el implementador

- `normalize_audio_route` hace `substr` y comparaciones; pasando a
  `std::string_view` desaparece la copia sin cambiar la lógica. Cuidado con el
  `return "master"` de `resolve_effective_audio_route`: un `string_view` a un
  literal está bien, pero a un temporal no.
- La SSO de MSVC salva algunas de esas cadenas del heap (`"master"` cabe), pero
  **no** el `std::vector<int>`, que asigna siempre. No te conformes con «casi
  no asigna»: el criterio C1 es cero.
- Hay **dos** sitios que hacen esto (`mixer.cpp:647` y `mixer.cpp:979`, la
  segunda dentro del camino con salto partido). Arregla los dos. El REVIEWER lo
  va a mirar.
- No aproveches para «mejorar» el formato de `audio_to` ni para tocar
  `resolve_effective_audio_route` más de lo necesario. El alcance es sacar el
  cálculo del hilo de audio.
