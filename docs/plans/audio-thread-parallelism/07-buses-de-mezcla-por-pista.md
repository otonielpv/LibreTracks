# 07 — Buses de mezcla por pista (sin cambiar de hilo todavía)

**Depende de:** 01.
**Toca:** `native/audio-engine-v2/src/render/mixer.cpp`,
`include/lt_engine/render/mixer.h`.
**Riesgo:** medio. Es un refactor del bucle más caliente del motor.
**Sigue siendo de un solo hilo al terminar.** Ese es el punto.

## Problema

Bloqueante B1 del diagnóstico. `mixer.h:228-230`:

```cpp
static constexpr int kMaxBlockFrames = 4096;
float mix_l_[kMaxBlockFrames] = {};
float mix_r_[kMaxBlockFrames] = {};
float* mix_[2] = { mix_l_, mix_r_ };
```

**Un único bus**, reutilizado pista a pista: se limpia, se renderiza la pista
dentro, se miden picos y RMS, y se acumula en la salida con ganancia y pan. Es
*el* punto de serialización: dos pistas no pueden renderizarse a la vez porque
escriben en el mismo sitio.

## Por qué es un paso propio, sin hilos

Separar «cambiar la disposición de los datos» de «cambiar quién los calcula» es
lo que hace auditable el paso 08. Al terminar este paso, el motor hace
exactamente lo mismo que hoy, muestra a muestra, con los datos colocados de
forma que el paso 08 sólo tenga que repartir el bucle.

Si se hicieran juntos y la salida cambiara, no habría forma de saber si el
culpable es la disposición o la concurrencia.

## El contrato de bit-exactitud

Éste es el punto de diseño más importante del plan, y condiciona el paso 08.

Hoy la acumulación es, en orden de pista ascendente:

```cpp
output_channels[left_channel][output_offset + f] += out_l;
```

La suma de flotantes **no es asociativa**: cambiar el orden cambia el
redondeo. Si el paso 08 reparte pistas entre trabajadores y cada uno acumula en
un bus parcial, el resultado depende de cuántos hilos haya, y entonces:

- No se puede escribir un test de equivalencia serie-vs-paralelo.
- Cada usuario oye un audio ligeramente distinto según su CPU.

**Por eso este paso impone la regla:**

> Cada pista escribe en **su propio** bus, indexado por su ranura de renderer.
> La reducción final recorre las ranuras **en orden ascendente** y acumula en la
> salida. El orden de la suma es idéntico al de hoy y **no depende de cuántos
> hilos la calculen**.

Eso hace que el paso 08 sea bit-exacto por construcción, y su test de
equivalencia, trivial y contundente.

## Cambio pedido

### 1. Un bus por ranura de renderer

Sustituir `mix_l_`/`mix_r_` por un vector de buses paralelo a `renderers_` y
`track_meters_`, reservado en `prepare_render_resources` (hebra de control, con
la disciplina de publicación que ya usa: crecer con el contador a 0, publicar
con `release`).

**Dimensionado**: `kMaxBlockFrames` es 4096; a 256 ranuras eso son 8 MB, que es
inaceptable en móvil. Dimensiona al **tamaño de bloque negociado con el
dispositivo**, no al máximo teórico, y redimensiona cuando el dispositivo se
reconfigure (que ya es un evento de hebra de control). A 512 frames y 256
ranuras son 1 MB, que sí es aceptable.

Documenta el número al que llegues y justifícalo. Consulta
`core/device_profile.h` si el presupuesto tiene que depender del perfil.

### 2. Reestructurar el bucle en dos fases

```
Fase A (por pista, en orden):   limpiar su bus → renderer.render(...) → medidores
Fase B (reducción, en orden):   por cada ranura, aplicar ganancia/pan/routing
                                y acumular en output_channels
```

La fase A es lo que el paso 08 repartirá entre hilos. La fase B se queda en el
director **siempre**, y debe recorrer las ranuras en orden ascendente.

**Todo lo que hoy está en el bucle tiene que quedar clasificado en A o en B.**
En particular:

| Trabajo | Fase | Por qué |
| --- | --- | --- |
| Suavizado de ganancia/pan/mute/solo (`control->current_*`) | A | es estado por pista |
| Picos y RMS de la propia pista | A | dependen sólo de su bus |
| Medidores de carpeta (`update_ancestor_folder_meters`) | **B** | acumulan entre pistas |
| `left_only_source` / `right_only_source` | A | derivan de sus propios picos |
| Ganancia/pan por muestra y acumulación en la salida | B | escribe en el buffer compartido |

Mover los medidores de carpeta a la fase B es lo que evita que el paso 08 tenga
que resolver la carrera del bloqueante B2 en el camino caliente. El CAS del
paso 04 se queda igualmente como red de seguridad.

### 3. El camino con salto partido

Hay **dos** llamadas a `render_timeline_span` (`mixer.cpp:793` y `:838`) para el
bloque partido por un salto, y **un segundo bucle de pistas** casi duplicado
alrededor de `mixer.cpp:954`. Los dos tienen que quedar con la misma estructura
de dos fases. Si puedes unificarlos en una sola función, mejor; si no, di en la
bitácora por qué no.

## Criterios de aceptación

- [ ] C1 — **Bit-exactitud.** Sesión fija de ≥ 16 pistas con carpetas anidadas,
      routing mixto (`master`, `monitor`, `ext:3`), solo y mute activos, warp
      activo en una región y pitch en otra: 500 bloques renderizados antes y
      después del cambio, comparados muestra a muestra. **Cero diferencia**, no
      «diferencia despreciable».
- [ ] C2 — La misma comparación con el bloque partido por un salto programado a
      mitad. Cero diferencia.
- [ ] C3 — Los valores de `track_meters_` (pistas y carpetas) y de los medidores
      maestro y de región son idénticos bloque a bloque.
- [ ] C4 — La fase B recorre las ranuras en **orden ascendente** y eso está
      escrito como comentario en el código, citando este documento. Un
      `static_assert` no aplica; lo verifica el REVIEWER leyendo.
- [ ] C5 — Presupuesto de memoria: el total de los buses con 64 ranuras y el
      tamaño de bloque por defecto es **≤ 1 MB**. Reporta el número real.
- [ ] C6 — Redimensionado: cambiar el tamaño de buffer del dispositivo en
      caliente no produce lectura fuera de rango ni silencio. Test que
      reconfigura entre bloques.
- [ ] C7 — `Mixer::render` sigue sin asignar memoria: el test del paso 02 sigue
      en verde. (Los buses se reservan en la hebra de control.)
- [ ] C8 — Prueba de que sabe fallar: cambia la fase B para recorrer las ranuras
      en orden **descendente** y comprueba que C1 se pone rojo. Si sigue verde,
      tu comparación no es bit-exacta y no vale. Pega ambas salidas.
- [ ] C9 — `bench_render_callback --tracks 24 --warp 1` no empeora más de un
      5 % respecto a `baseline.json`. Este paso no busca ganar rendimiento, pero
      tampoco puede perderlo.
- [ ] C10 — `npm run test:native` pasa. `cargo check --all-targets` pasa.

## Notas para el implementador

- C8 es el criterio que da valor a todos los demás. Una comparación
  «bit-exacta» mal escrita (con tolerancia, o comparando sólo el primer bloque)
  pasa siempre y no protege de nada.
- `renderers_[ti]->render(...)` ya recibe el bus como parámetro `out`. El cambio
  en la fase A es qué puntero se le pasa, no cómo funciona el renderer. No
  toques `TrackRenderer`.
- El comentario de `mixer.cpp:614-617` explica por qué se pasa
  `track_gain_override=1.0f` en vez de copiar el `Track`. Esa razón sigue
  valiendo; no la deshagas al reestructurar.
- No cambies el suavizado de 10 ms de ganancia/pan ni el cálculo de
  `settled_silent`. Ese `settled_silent` es lo que hace que una pista muteada no
  pague el coste de Bungee (`track_renderer.cpp:456-465`), y es una propiedad
  valiosa.
- No toques el hot path del playhead ni los listeners de arrastre. Están fuera
  del engine, pero `docs/REDESIGN_transport_refs_to_stores.md` explica por qué
  un refactor previo se revirtió; el espíritu aplica.
