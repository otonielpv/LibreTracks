# Plan de desarrollo del motor de audio

## Contexto

Este documento no sustituye a `PLAN_DESARROLLO.md` ni a `PLAN_DESARROLLO_DAW.md`.

El shell DAW del frontend ya tiene una primera iteracion funcional:

- timeline principal consolidado
- edicion directa de clips y secciones
- mezcla basica integrada
- atajos de navegacion y edicion
- saltos musicales visibles y programables

El siguiente cuello de botella ya no es la interfaz.

El siguiente cuello de botella es el motor de audio nativo y su integracion con el transporte desktop.

Hoy el sistema funciona, pero todavia arrastra varios limites estructurales:

- parte del audio se reinicia completo ante cambios que deberian ser incrementales
- el runtime reabre y redecodifica clips al reconstruir reproduccion
- los cambios de mute y volumen no estan pensados todavia como operaciones de baja latencia
- el reloj de transporte y el audio real no comparten aun una base de tiempo suficientemente robusta
- no existen metricas ni observabilidad para saber donde se pierde fluidez

El objetivo de este nuevo plan es convertir el motor actual en una base mas estable, mas reactiva y preparada para crecer.

---

## Estado de partida

Estado a 20/04/2026:

- existe separacion basica entre `libretracks-audio` y el runtime desktop Tauri
- `AudioEngine` resuelve transporte logico, secciones, saltos y ganancias efectivas
- `audio_runtime.rs` reproduce clips con `rodio`
- el controlador de audio corre en un hilo dedicado con comandos via canal
- al reproducir se construyen sinks por clip activo o futuro
- al cambiar mezcla se llama a `sync_song`
- al cambiar timeline o ejecutar ciertos saltos se reinicia la reproduccion completa
- el runtime abre WAVs desde disco y crea decoders durante cada reinicio
- no hay cache de decodificacion ni preparacion progresiva del material
- no hay telemetria interna de latencia, tiempo de reinicio, numero de sinks ni coste de cambios

Problemas ya observados en uso real:

- al mutear o tocar volumen pueden percibirse pausas y reanudaciones poco naturales
- cambios por pista pueden sentirse globales porque el runtime no esta suficientemente desacoplado
- el motor no transmite todavia la sensacion de fluidez de un DAW
- la estabilidad bajo proyectos con multiples WAVs necesita mejorar antes de seguir creciendo

---

## Avance actual

Actualizado a 20/04/2026 tras los primeros hitos implementados:

- se anadio instrumentacion basica al runtime de audio para medir `restart`, `stop`, `sync_song`, numero de clips programados, numero de sinks activos y archivos abiertos
- el hilo de audio ya registra razones explicitas de restart:
  - `initial_play`
  - `resume_play`
  - `seek`
  - `immediate_jump`
  - `timeline_window`
  - `structure_rebuild`
  - `transport_resync`
- existe un snapshot de depuracion accesible desde Tauri mediante `get_audio_debug_snapshot`
- existen logs opt-in mediante:
  - `LIBRETRACKS_AUDIO_DEBUG`
  - `LIBRETRACKS_AUDIO_LOG_COMMANDS`
- `persist_song_update` ya no trata todos los cambios por igual y clasifica el impacto del cambio como:
  - `MixOnly`
  - `TransportOnly`
  - `TimelineWindow`
  - `StructureRebuild`
- cambios de mezcla ya no disparan restart global del runtime
- el runtime mantiene estado estable por clip activo y aplica mezcla incremental sobre sinks ya vivos
- cambios de volumen y mute usan rampas cortas para reducir clicks y transiciones bruscas
- la cola del runtime ahora coalesce cambios consecutivos de mezcla para evitar trabajo redundante
- existe una cache simple de audio preparado por proyecto para reducir reaperturas de WAV en reinicios cercanos
- hay documentacion operativa inicial en `docs/audio-runtime-debug.md`

Commits que respaldan este avance:

- `08e796e` `Instrumenta el runtime de audio`
- `f66cbc8` `Suaviza la mezcla incremental en vivo`
- `6fa9dd9` `Cachea audio preparado para reinicios cercanos`

---

## Objetivo principal

### Objetivo UX

Que el usuario perciba un motor:

- fluido al reproducir
- estable al cambiar mute, volumen o saltos
- predecible en play, pause, stop y seek
- sin cortes notorios al editar mientras la sesion esta viva

### Objetivo tecnico

Rehacer progresivamente la capa de audio desktop para que:

- los cambios de mezcla sean incrementales y de baja friccion
- los cambios de timeline tengan una ruta clara y segura
- el runtime reduzca reaperturas y redecodificaciones innecesarias
- el reloj de transporte quede mejor alineado con la reproduccion real
- exista base de observabilidad, test y benchmark para medir mejoras

---

## Criterios de exito

El plan se considerara cumplido cuando:

- cambiar volumen o mute de pista o grupo no provoque reinicios perceptibles del audio
- play, pause, stop y seek sean consistentes y no dejen el runtime en estados ambiguos
- los saltos musicales funcionen sin desalineacion evidente entre cursor, transporte y audio
- el coste de reinicio total de reproduccion quede acotado y medido
- exista cobertura de tests de motor para rutas criticas y regresiones ya conocidas
- exista una base de metricas para evaluar proyectos con varias pistas y clips largos

---

## Principios del plan

### 1. Cambios incrementales primero

No todo cambio en `song` debe reiniciar el audio completo.

Debemos distinguir claramente:

- cambios de mezcla
- cambios de transporte
- cambios de timeline
- cambios estructurales que si obligan a reconstruir el grafo

### 2. El reloj manda

El transporte no puede depender solo de tiempos aproximados de UI o de polling oportunista.

El audio y el transporte deben compartir una referencia temporal mas fiable.

### 3. Sin magia opaca

Cada mejora de rendimiento debe dejar rastros medibles:

- tiempo de reinicio
- numero de clips preparados
- numero de sinks activos
- tiempo de respuesta a comandos

### 4. Primero robustez, luego sofisticacion

Antes de hablar de fades avanzados, warping o automatizacion compleja, el motor debe resistir:

- varios WAVs importados
- cambios repetidos de mute y volumen
- seeks y saltos consecutivos
- reproduccion prolongada

### 5. Evolucion por capas

No hace falta saltar en un solo paso a un motor completamente nuevo.

Podemos avanzar por etapas:

- observabilidad
- control incremental
- cache y preparacion
- refactor del backend si sigue siendo necesario

---

## Arquitectura actual a corregir

### 1. Reinicios completos demasiado frecuentes

Hoy el runtime puede reconstruir toda la reproduccion para cambios de timeline y para ciertos saltos.

Eso implica:

- parar sinks
- abrir archivos otra vez
- crear decoders otra vez
- volver a programar delays

### 2. Mezcla viva limitada

`sync_song` solo ajusta volumen efectivo sobre sinks ya creados.

Eso no cubre bien:

- transiciones suaves
- cambios rapidos y repetidos
- casos donde el estado de runtime y el estado de `song` divergen

### 3. Reloj de transporte demasiado indirecto

La posicion actual se apoya en `Instant` mas el estado del engine.

Eso es suficiente para una base minima, pero no para un comportamiento fino bajo:

- saltos
- seeks
- reanudaciones
- reinicios del runtime

### 4. Coste de IO y decodificacion

Cada reinicio vuelve a abrir WAVs y construir `Decoder`s.

Eso penaliza especialmente:

- proyectos con muchas pistas
- clips largos
- cambios frecuentes mientras reproduce

### 5. Falta de observabilidad

Ahora mismo no tenemos una superficie clara para responder:

- cuanto tarda un restart
- cuantos clips se reprograman
- cuanto tarda un cambio de mezcla
- si hay rutas que bloquean demasiado el hilo de audio

---

## Fase 0 - Diagnostico y observabilidad

### Objetivo

Poder medir antes de reescribir.

### Tareas

- instrumentar `audio_runtime.rs` con tiempos basicos de:
  - restart
  - stop
  - sync de mezcla
  - numero de clips programados
- registrar causas de reinicio:
  - play inicial
  - seek
  - salto musical
  - cambio estructural de timeline
- anadir logs opt-in para comandos del `AudioController`
- preparar un modo debug con resumen de:
  - tiempo de arranque de reproduccion
  - numero de sinks activos
  - numero de archivos abiertos
- definir sesiones de prueba manual reproducibles

### Criterio de completado

Podemos describir con datos donde se va el tiempo y que operaciones disparan cortes.

### Estado

- Completada

### Entregado en esta fase

- instrumentacion basica del runtime desktop
- razones de restart visibles y medibles
- snapshot de debug accesible desde Tauri
- logs opt-in para comandos del hilo de audio
- guia inicial de pruebas manuales reproducibles en `docs/audio-runtime-debug.md`

---

## Fase A - Clasificacion formal de cambios de audio

### Objetivo

Evitar reinicios globales cuando no hacen falta.

### Tareas

- formalizar una tipologia de cambios:
  - `MixOnly`
  - `TransportOnly`
  - `TimelineWindow`
  - `StructureRebuild`
- revisar `persist_song_update` para que no trate igual todos los cambios
- documentar que operaciones del editor caen en cada clase
- asegurar que cambios de mezcla no reinicien reproduccion
- asegurar que cambios de timeline pequenos usen rutas mas finas cuando sea posible

### Criterio de completado

Cada comando desktop tiene una politica explicita de impacto sobre el runtime.

### Estado

- Completada

### Entregado en esta fase

- clasificacion formal de impacto de cambios en `state.rs`
- `persist_song_update` ya decide entre mezcla incremental, cambio de transporte, ventana de timeline o rebuild estructural
- operaciones del editor ya no comparten una politica unica de restart
- cambios de mezcla no reinician reproduccion
- cambios de secciones ya pueden seguir una ruta de `TransportOnly` cuando no requieren reconstruccion

---

## Fase B - Runtime incremental v1

### Objetivo

Que mute, volumen y otras operaciones basicas sean seguras y fluidas durante reproduccion.

### Tareas

- desacoplar estado de mezcla del acto de recrear sinks
- introducir estado runtime por pista y por clip con identificadores estables
- aplicar cambios de volumen y mute sin reconstruir el conjunto completo
- anadir rampas cortas de volumen para evitar clicks al mutear o variar nivel
- garantizar que cambios simultaneos de varias pistas no provoquen inconsistencias globales
- reforzar la cola de comandos del runtime para cambios rapidos consecutivos

### Criterio de completado

La mezcla basica en vivo se siente directa y no interrumpe el flujo de reproduccion.

### Estado

- Completada en v1

### Entregado en esta fase

- estado runtime estable por clip activo
- mezcla desacoplada del recreado completo de sinks
- rampas cortas de volumen para mute y cambios de nivel
- coalescencia de `sync_song` consecutivos en la cola del runtime
- cobertura de tests para mezcla incremental y coalescencia

### Nota

Esta fase queda cerrada como `v1`.
Todavia no introduce un mixer propio ni fades avanzados por bloque, pero ya elimina varios reinicios evitables y corrige la base de mezcla viva.

---

## Fase C - Cache y preparacion de audio

### Objetivo

Reducir IO y decodificacion repetitiva.

### Tareas

- definir una cache de metadatos y material preparado por `file_path`
- separar claramente:
  - lectura de metadata
  - construccion de waveform
  - preparacion para reproduccion
- evitar reapertura innecesaria de WAVs en reinicios cercanos
- evaluar cache de readers, buffers o regiones ya conocidas
- establecer politicas simples de invalidacion al cambiar proyecto
- medir memoria frente a ganancia real de latencia

### Criterio de completado

Los reinicios inevitables son mas rapidos y su coste queda acotado.

### Estado

- Parcial en v1

### Entregado en esta fase

- cache simple de buffers de audio por proyecto y `file_path`
- invalidacion al cambiar de proyecto
- metricas de buffers cacheados expuestas en el snapshot de debug
- reduccion de reaperturas de WAVs en reinicios cercanos

### Pendiente dentro de esta fase

- separar mas claramente metadata, waveform y preparacion de reproduccion
- medir memoria frente a latencia con escenarios mas grandes
- evaluar si conviene cache de regiones o readers mas finos

---

## Fase D - Transporte y reloj robustos

### Objetivo

Mejorar la coherencia entre tiempo logico y audio real.

### Tareas

- revisar el modelo actual basado en `Instant` y `advance_transport`
- definir una fuente de verdad clara para:
  - posicion actual
  - ultimo seek
  - momento real de arranque
  - saltos ejecutados
- reducir el desfase entre snapshot UI y runtime real
- endurecer play, pause, stop y seek bajo secuencias rapidas
- asegurar que el fin de cancion y los saltos limpien bien el estado

### Criterio de completado

El cursor, el estado del transporte y el audio dejan de divergir en situaciones normales de trabajo.

### Estado

- Pendiente

---

## Fase E - Saltos y cambios de timeline sin artefactos

### Objetivo

Hacer fiables los cambios musicales mientras el motor esta vivo.

### Tareas

- revisar que parte del salto requiere reconstruccion y que parte puede reprogramarse
- minimizar el coste audible de saltos inmediatos y a final de seccion
- validar seeks consecutivos mientras reproduce
- validar cambios de clip que afecten a material activo o inminente
- definir un comportamiento seguro para cambios imposibles de aplicar en caliente
- anadir tests de regresion con:
  - salto inmediato
  - salto al final
  - salto en compases
  - seek repetido

### Criterio de completado

Los cambios musicales en tiempo real tienen comportamiento definido, estable y medido.

### Estado

- Pendiente

---

## Fase F - Backend de reproduccion v2 si el runtime actual no alcanza

### Objetivo

Reservar una fase explicita para una mejora de backend mas profunda si `rodio` mas parches no da la talla.

### Tareas

- decidir con datos si el runtime actual puede escalar lo suficiente
- evaluar migracion progresiva a un backend con mezcla propia por bloques si hiciera falta
- valorar una capa de reproduccion con:
  - scheduler mas fino
  - mixer propio
  - control de ganancia por pista y clip en tiempo real
  - clock mas cercano al callback de audio
- aislar esta decision tras Fase 0 a E para no sobrerreaccionar antes de medir

### Criterio de completado

Existe una decision tecnica clara: continuar sobre el backend actual o sustituirlo por uno mas apropiado.

### Estado

- Pendiente

---

## Fase G - Stress, benchmarks y regresion

### Objetivo

Convertir la mejora del motor en algo verificable y sostenible.

### Tareas

- crear una bateria de escenarios de prueba:
  - proyecto con varias pistas largas
  - cambios rapidos de mute
  - barridos de volumen
  - seeks consecutivos
  - varios saltos seguidos
- anadir benchmarks o pruebas temporales para operaciones clave
- documentar metricas base y metricas objetivo
- definir criterios de no regresion antes de tocar backend profundo

### Criterio de completado

Las mejoras del motor se pueden medir y comparar entre iteraciones.

### Estado

- Pendiente

---

## Fase H - Integracion producto y cierre

### Objetivo

Conectar la mejora tecnica con una experiencia visible y mantenible.

### Tareas

- actualizar documentacion tecnica del runtime desktop
- anadir notas de arquitectura sobre responsabilidades de:
  - `libretracks-audio`
  - `audio_runtime.rs`
  - `state.rs`
- dejar claras las rutas de cambio para futuras funciones:
  - solo
  - fades
  - automatizacion
  - precarga
- preparar lista de deudas tecnicas resultantes

### Criterio de completado

El motor queda listo para seguir creciendo sin volver a la improvisacion inicial.

### Estado

- Pendiente

---

## Orden recomendado de implementacion

```txt
0. Fase 0 - Diagnostico y observabilidad
1. Fase A - Clasificacion formal de cambios de audio
2. Fase B - Runtime incremental v1
3. Fase C - Cache y preparacion de audio
4. Fase D - Transporte y reloj robustos
5. Fase E - Saltos y cambios de timeline sin artefactos
6. Fase G - Stress, benchmarks y regresion
7. Fase F - Backend de reproduccion v2 si el runtime actual no alcanza
8. Fase H - Integracion producto y cierre
```

---

## Primeros hitos recomendados

Estos primeros hitos ya fueron realizados:

1. Se instrumento y midio el runtime actual.
2. Se separaron claramente cambios de mezcla frente a cambios que exigen restart.
3. Se hizo que mute y volumen fueran mas robustos durante reproduccion.
4. Se introdujo una cache inicial para reducir reaperturas en reinicios cercanos.

## Siguiente bloque recomendado

Para mantener el foco, el siguiente bloque deberia concentrarse en:

1. Endurecer reloj y transporte bajo secuencias rapidas de `play`, `pause`, `stop` y `seek`.
2. Validar seeks consecutivos y saltos musicales con tests de regresion especificos.
3. Medir el desfase real entre snapshot UI, `AudioEngine` y runtime desktop.
4. Decidir con datos si el backend actual alcanza o si la Fase F debe adelantarse.

---

## Fuera de alcance inmediato

Para no mezclar objetivos, estas cosas no deberian bloquear este plan:

- warping o time-stretching
- soporte de formatos extra mas alla de WAV
- automatizacion avanzada
- compensacion de latencia compleja
- render offline o bounce
- MIDI y instrumentos virtuales

---

## Resultado esperado al cerrar este plan

LibreTracks deberia quedar con un motor de audio:

- mas estable
- mas medible
- mas predecible
- menos propenso a reinicios globales
- preparado para seguir creciendo hacia funciones de DAW reales sin arrastrar una base fragil
