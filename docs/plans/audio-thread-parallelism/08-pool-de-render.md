# 08 — Pool de trabajadores de tiempo real

**Depende de:** 03, 04, 05 y 07. **Todos aprobados.** No empieces sin eso.
**Toca:** un módulo nuevo en `native/audio-engine-v2/src/render/`,
`src/render/mixer.cpp`, `src/devices/audio_device_manager.cpp` (extraer la
promoción de prioridad).
**Riesgo: alto.** Es el paso que puede introducir fallos que sólo aparecen en la
máquina de un usuario.

## Por qué los prerrequisitos son duros

- **Sin 03**, N trabajadores asignan memoria: la contención del lock global del
  allocator se multiplica por N en vez de dividirse.
- **Sin 05**, N trabajadores toman un spinlock **global del proceso** una vez
  por clip: serializa exactamente la sección que se quiere paralelizar.
- **Sin 07**, todos escriben en el mismo bus: es una carrera de datos, no un
  problema de rendimiento.
- **Sin 04**, cada trabajador repite búsquedas lineales por cadena; no es
  incorrecto, pero desperdicia el paralelismo que se acaba de ganar.

## Cambio pedido

### 1. `RenderThreadPool`

Un módulo nuevo, sin dependencias del `Mixer` más allá de una función de trabajo.

```cpp
// Reparte las pistas de un bloque entre el hilo del callback ("director") y
// N-1 trabajadores en prioridad de tiempo real. El director también trabaja.
class RenderThreadPool {
public:
    // Ambas SOLO desde la hebra de control, nunca durante un bloque.
    void start(int thread_count) noexcept;
    void stop() noexcept;

    // Llamada desde el hilo de audio. Ejecuta job(i) para i en [0, count) y
    // no vuelve hasta que todos han terminado.
    void run_block(int count, const std::function<void(int)>& job) noexcept;

    int thread_count() const noexcept;
};
```

`std::function` en la firma es ilustrativo. **No la uses tal cual en el camino
caliente**: asigna. Usa un puntero a función más un `void*`, una plantilla, o un
`function_ref` no propietario.

### 2. Reglas de tiempo real del pool

- **Espera activa sólo en la junta del director.** El callback gira mientras
  queda trabajo real del bloque, porque no puede devolver audio incompleto. Los
  trabajadores hacen un giro corto y luego duermen con `atomic::wait`;
  `atomic::notify_all` los despierta sin tomar un mutex desde el callback.
  Mantenerlos girando durante los 2,7-10,7 ms entre buffers provocó una
  regresión medida de 20-25 % de CPU del proceso.
- **Bypass de bloques baratos.** Una sola tarea, las rutas Direct y las sesiones
  con menos de ocho pistas DSP caras se renderizan en serie. Despertar el pool
  cuesta más que ese trabajo y no aporta margen audible.
- **El director trabaja.** Toma tareas de la misma cola. Con `thread_count == 1`
  no hay barrera ni atómicos: el camino es literalmente el bucle de hoy.
- **Prioridad de tiempo real en todos los trabajadores.** Extrae
  `promote_audio_thread_to_pro_audio()` de `audio_device_manager.cpp:48` a un
  cabecero compartido (hoy es Windows-only y vive dentro del `.cpp`) y añade las
  implementaciones que falten: macOS/iOS `thread_policy_set` con
  `THREAD_TIME_CONSTRAINT_POLICY`, Linux/Android el mejor esfuerzo disponible.
  **Un trabajador a prioridad normal es peor que no tener pool**: el planificador
  lo desaloja y se convierte en el rezagado que revienta el bloque.

  **Pero no promociones a ciegas a `AVRT_PRIORITY_CRITICAL`.** El hecho 1.1 del
  diagnóstico lo midió en el log del usuario afectado: en WASAPI, JUCE ya mete
  su hilo de callback en la tarea «Pro Audio» con `AVRT_PRIORITY_NORMAL`
  (`juce_WASAPI_windows.cpp:1492-1505`), nuestra promoción posterior falla con
  1552 y el director se queda en `NORMAL`. Si los trabajadores entran en
  `CRITICAL`, quedan **por encima del director**, que es el único hilo con una
  fecha límite dura: una inversión de prioridad fabricada por nosotros.

  La regla es **igualar, no superar**: los trabajadores deben acabar en la misma
  clase MMCSS que el director. Como no podemos leer la prioridad efectiva del
  hilo de JUCE, lo honesto es promocionar los trabajadores a «Pro Audio» con
  `AVRT_PRIORITY_NORMAL` y dejar `CRITICAL` sólo para el caso en que el director
  sí lo haya conseguido (promoción propia, sin JUCE de por medio). Registra en un
  contador de diagnóstico qué clase acabó teniendo cada uno; si no lo mides, no
  lo sabes.
- **Nada de asignaciones, locks ni excepciones** dentro de `run_block`. El
  detector del paso 02 lo verifica.

### 3. Cablearlo en el mixer

Sólo la **fase A** del paso 07 se reparte. La fase B (reducción, ganancia, pan,
routing, medidores de carpeta, acumulación en la salida) se queda en el
director, en orden ascendente de ranura. El metrónomo, la voz guía y los pads
se quedan en el director, después.

Ciclo de vida: `start()` al abrir el dispositivo, `stop()` al cerrarlo. Nunca
durante un bloque.

### 4. Diagnóstico

Contadores nuevos en el snapshot del motor, para el banco y para depurar en
casa del usuario:

- `render_threads_active`
- `pool_conductor_wait_us` (cuánto esperó el director a los rezagados)
- `pool_blocks_run` y `pool_blocks_serial` (cuántos cayeron al camino de 1 hilo)

**Estos contadores son para el banco y la telemetría, no para tests.** Ningún
criterio de aceptación puede afirmar sobre un tiempo.

## Criterios de aceptación

- [ ] C1 — **Bit-exactitud serie vs paralelo.** Sesión fija de ≥ 24 pistas con
      carpetas, routing mixto, warp y pitch: 500 bloques renderizados con
      `threads = 1, 2, 3, 4, 8`, comparados muestra a muestra contra la salida
      de `threads = 1`. **Cero diferencia en todas.** El paso 07 lo hace posible;
      si no sale exacto, algo de la fase B se ha colado en la A.
- [ ] C2 — Prueba de que sabe fallar: mueve a propósito la acumulación en la
      salida a la fase A y comprueba que C1 se pone rojo con 2+ hilos. Pega
      ambas salidas y deja el código como estaba.
- [ ] C3 — `LIBRETRACKS_RENDER_THREADS=1` da el camino serie **sin atómicos ni
      barrera**: verificable con un contador que cuente entradas a la barrera,
      que debe valer 0 tras 200 bloques.
- [ ] C4 — Cero asignaciones: el test del paso 02 pasa con 4 hilos, y **también
      en los trabajadores** — el detector es por hilo, así que hay que
      instrumentarlos a ellos también. Amplía el test.
- [ ] C5 — Sin carreras de datos: el conjunto de tests del engine pasa bajo
      **ThreadSanitizer** (o, si TSan no está disponible en el toolchain de
      Windows, bajo el Application Verifier o en un build de Linux/macOS con
      TSan en CI). Si no puedes ejecutar ningún detector de carreras, márcalo
      `PENDIENTE-HUMANO` y **dilo**; no lo des por bueno.
- [ ] C6 — Arranque y parada limpios: `start()`/`stop()` repetidos 100 veces no
      filtran hilos ni cuelgan. Test.
- [ ] C7 — Los trabajadores duermen entre callbacks y con el transporte parado:
      `pool_waiting_threads` refleja la espera atómica, y el uso de CPU se mide
      con `bench_render_callback --paced` tanto en reposo como reproduciendo.
- [ ] C8 — Cambiar el número de hilos en caliente (a través de `start`/`stop`
      desde la hebra de control, entre bloques) no produce ni un bloque de
      silencio. Test.
- [ ] C9 — Robustez: si `start()` no consigue crear los hilos (simúlalo), el
      motor cae al camino serie y **sigue sonando**. Test.
- [ ] C10 — `bench_render_callback --tracks 24 --warp 1 --threads N` para
      N ∈ {1,2,4,8}: pega la tabla. Se espera ≥ 3x con 4 hilos en la máquina de
      referencia. **Si no llega, no falsees el criterio**: anota lo medido, di
      qué crees que lo limita, y déjalo para que lo decida la persona.
- [ ] C11 — `npm run test:native` pasa. `cargo check --all-targets` pasa.
- [ ] C12 — `PENDIENTE-HUMANO`: reproducción real de ≥ 20 pistas con warp
      durante 5 minutos sin crujidos, con la UI abierta y moviendo faders. Lo
      verifica la persona.

## Notas para el implementador

- **El rezagado manda.** El bloque no acaba hasta que acaba la última pista. Un
  trabajador desalojado por el planificador durante 5 ms revienta el buffer
  aunque el trabajo total sobre de sobra. Por eso C5 y la prioridad importan
  más que el reparto perfecto.
- **E-cores.** En híbridos Intel (12ª gen+), un trabajador en un E-core es 2-3x
  más lento. El diagnóstico avisa de que las columnas de 6 y 8 hilos del banco
  probablemente ya lo sufren. **No** metas afinidad en este paso: es del paso
  09. Aquí sólo hay que ser consciente al leer C10.
- **El director no debe poder colgarse.** Gira esperando a `done == count`. Si
  un trabajador muere, se cuelga el audio. Los trabajadores sólo salen por el
  flag de parada; no metas nada que pueda lanzar o retornar antes.
- **Reparto**: empieza por el más simple que funcione — un índice atómico
  compartido con `fetch_add` (robo de trabajo), que es lo que mide el banco de
  referencia. No hace falta un planificador de grafo: nuestras pistas no tienen
  dependencias entre sí.
- El pool **no** cambia nada del transporte, del reloj ni del scheduler de
  saltos. Si te encuentras tocando `TransportClock`, has salido del alcance.
- Móviles: este paso deja el pool disponible pero **el valor por defecto lo fija
  el paso 09**. Mientras tanto, por defecto 1 hilo (comportamiento de hoy).
