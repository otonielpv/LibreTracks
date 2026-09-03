# 09 — Política de hilos, perfil de dispositivo y ajuste de usuario

**Depende de:** 08 aprobado.
**Toca:** `include/lt_engine/core/thread_policy.h`, el snapshot del motor, los
comandos de Tauri, y el panel de Ajustes del escritorio.
**Riesgo:** medio. Un valor por defecto malo empeora la experiencia de mucha
gente a la vez.

## Problema

El paso 08 deja el pool funcionando pero por defecto en 1 hilo. Decidir cuántos
usar no es trivial:

- **Más hilos no siempre es mejor.** En un portátil de 4 hilos lógicos, cuatro
  hilos a prioridad Pro Audio compiten con el WebView de la UI y con los hilos
  de decodificación: la app se vuelve pegajosa y, si el planificador desaloja a
  un trabajador, el audio cruje más que antes.
- **`thread_policy.h` dice explícitamente** que la frecuencia de CPU y el tipo
  de núcleo (P vs E) **no son consultables de forma portable**, y que por eso
  sólo se usan núcleos lógicos y RAM. Esa honestidad hay que respetarla: no
  inventes detección de P-cores.
- Los móviles son big.LITTLE por defecto y tienen presupuesto térmico. El
  diagnóstico del plan `android-low-end` documenta un Snapdragon 665 con 4 A73
  + 4 A53 donde más hilos no dio throughput.

Todos los DAW profesionales resuelven esto igual: un valor por defecto
conservador **y un ajuste visible**.

## Cambio pedido

### 1. `WorkerRole::Render` en `thread_policy.h`

Añadir el rol nuevo al enum existente (`thread_policy.h:42`) y su función de
recomendación, en el mismo estilo y con el mismo tipo de comentario justificando
los números que ya tienen `Decode`, `Fill` y `Waveform`.

Punto de partida propuesto (**ajústalo con lo que midas, y actualiza este
documento si cambias**):

| Perfil | Hilos de render |
| --- | --- |
| Escritorio, ≥ 8 núcleos lógicos | 4 |
| Escritorio, 4-7 núcleos lógicos | 2 |
| Escritorio, ≤ 3 núcleos lógicos | 1 (pool desactivado) |
| `RoomyHandheld` | 2 |
| `Handheld` | 1 |
| `Constrained` | 1 (pool desactivado) |

Razonamiento del tope en 4: el banco del diagnóstico da 3,8x con 4 hilos y sólo
5,9x con 8, con una máquina ociosa de 20 hilos. La ganancia marginal del quinto
hilo en adelante no compensa el riesgo del rezagado ni robarle núcleos a la UI.
**No subas de 4 sin una medida que lo justifique en una máquina con la UI
abierta.**

Reutiliza `DeviceClass` de `core/device_profile.h`; ya distingue
`Constrained` / `Handheld` / `RoomyHandheld`.

### 2. Override por entorno

`LIBRETRACKS_RENDER_THREADS` gana siempre a todo, como hacen los demás roles.
Ya lo usa el paso 08; aquí sólo hay que documentarlo en
`docs/audio-runtime-debug.md`.

### 3. NO hay ajuste de usuario. Corregido tras revisarlo

**Este apartado pedía un selector «Hilos de procesado» en Ajustes → Audio.
Estaba mal planteado y se retira.**

Lo que hacen de verdad los DAW de referencia es más variado de lo que daba por
supuesto:

| DAW | Qué expone |
| --- | --- |
| Reaper | Número de hilos explícito (auto / 1..N) |
| Logic Pro | «Processing Threads»: Automatic / 1..N |
| Ableton Live | Sólo un **interruptor** («Multicore Rendering»), no un número |
| Cubase | Interruptor + nivel de ASIO-Guard, no un número |

Ninguno le pide a un músico que elija una cifra como control principal, y los
dos que exponen el número van en automático por defecto. «Hilos de procesado» es
jerga de ingeniero: quien lo lea no tiene forma de evaluar si le conviene 2 o 4,
y si se equivoca empeora justo en directo, que es cuando no hay arreglo.

En su lugar:

- **Automático y punto.** Decide `lt_recommend_render_threads_for()`.
- **`LIBRETRACKS_RENDER_THREADS` como escotilla de soporte.** Si a un usuario le
  va mal, se le dice que la ponga a 1 por teléfono. Resuelve el caso real sin
  publicar un mando que el 99 % no debe tocar.
- **Los hilos activos en el medidor, de SOLO LECTURA.** Eso sí aporta: un
  reporte podrá decir «4 hilos y sigue al 90 %» en vez de dejarnos adivinando,
  que es exactamente lo que pasó con el log del 96 %.

## Criterios de aceptación

- [ ] C1 — `lt_recommend_worker_threads(WorkerRole::Render)` devuelve la tabla
      de arriba. Test parametrizado que fija **cada** fila, inyectando el número
      de núcleos y el perfil (como ya hace `lt_recommend_worker_threads_for`).
- [ ] C2 — Los otros tres roles (`Decode`, `Fill`, `Waveform`) devuelven
      **exactamente** los mismos valores que antes de este paso, para todas las
      combinaciones ya cubiertas por sus tests. Añadir un rol no puede mover los
      existentes.
- [ ] C3 — `LIBRETRACKS_RENDER_THREADS` gana al perfil y al ajuste de usuario.
      Test.
- [ ] C4 — Un valor inválido (`0`, `-1`, `"abc"`, `999`) cae al recomendado sin
      romper ni crear 999 hilos. Test.
- [ ] C5 — **RETIRADO.** No hay ajuste de usuario que cambiar. La capacidad de
      cambiar hilos en caliente sin cortar el audio ya la cubre el C8 del paso
      08.
- [ ] C6 — **RETIRADO.** Sin ajuste no hay nada que persistir ni que traducir.
- [ ] C7 — En `Constrained`, el pool queda desactivado aunque el usuario tenga
      guardado un valor mayor de una sesión anterior en otro dispositivo. Test.
- [ ] C8 — Prueba de que sabe fallar: cambia un valor de la tabla de C1 y
      comprueba que el test se pone rojo. Un test parametrizado que compara
      contra el propio cálculo en vez de contra constantes fijadas no vale.
- [ ] C9 — El snapshot expone `render_threads_active` y el medidor puede
      mostrarlo. **De solo lectura**: es información para un reporte, no un
      mando.
- [ ] C10 — `npm test` (las 4 suites) pasa. `cargo check --all-targets` pasa.
- [ ] C11 — `PENDIENTE-HUMANO`: con el valor por defecto en un portátil de 4
      hilos lógicos, la UI **no** se vuelve pegajosa durante la reproducción de
      20 pistas con warp. Si lo hace, baja el valor por defecto de esa fila y
      actualiza este documento.
- [ ] C12 — En Windows, `ERROR_THREAD_ALREADY_IN_TASK` se registra como
      `already_mmcss` y no ejecuta el fallback; los fallos AVRT reales sí lo
      hacen. Test con wrapper AVRT inyectado, incluida prueba de que sabe fallar.

## Notas para el implementador

- **No implementes afinidad de CPU en este paso.** Es tentador por el asunto de
  los E-cores, pero fijar afinidad es contraproducente si el usuario tiene otra
  carga, y `thread_policy.h` ya explica por qué no detectamos tipos de núcleo.
  Si tras C11 sigue habiendo un problema de rezagados, es material para otro
  plan, con medidas propias.
- El ajuste va **junto al tamaño de buffer**, no en una pestaña nueva: son la
  misma decisión para el usuario («cuánta CPU le doy al audio»).
- Cuidado con C2: es fácil romper `Decode` al refactorizar el enum. Los
  presupuestos de móvil del plan `android-low-end` dependen de esos valores.
- El texto de ayuda tiene que ser comprensible para un músico, no para un
  ingeniero de audio. Evita «hilos de tiempo real» y «paralelismo de grafo».
