# Plan de desarrollo del motor de audio v2

## Contexto

Este documento arranca despues de cerrar `PLAN_DESARROLLO_MOTOR_AUDIO.md`.

La iteracion anterior dejo una base mucho mas estable:

- telemetria basica del runtime
- clasificacion de cambios de audio por impacto
- mezcla incremental para `MixOnly`
- cache inicial de audio preparado
- reloj de transporte desktop reforzado
- regresiones para seeks, saltos y final de cancion

Eso ya no es una base improvisada.

El siguiente reto no es solo "hacer que funcione", sino decidir con datos hasta donde puede llegar el backend actual y que mejoras deben entrar antes de pensar en una reescritura profunda.

---

## Objetivo principal

Llevar el motor desde una base estable `v1` a una base medible y escalable para proyectos mas exigentes, sin adelantar un backend nuevo antes de tener evidencia suficiente.

### Objetivo UX

Que el usuario perciba:

- respuesta consistente en proyectos mas pesados
- mezcla mas musical al hacer `solo`, mute y cambios de nivel
- timeline y audio aun mas alineados bajo sesion larga y edicion frecuente
- menos sensacion de reinicio o resync visible en cambios complejos

### Objetivo tecnico

Que el sistema pueda:

- medir carga real y regresiones en escenarios grandes
- separar mejor metadata, waveform y material de reproduccion
- introducir reglas de mezcla mas propias de un DAW
- establecer umbrales objetivos para decidir si `rodio` sigue sirviendo

---

## Criterios de exito

Este plan se considerara cumplido cuando:

- existan escenarios de stress reproducibles con metricas comparables entre iteraciones
- la cache de audio deje separadas al menos las capas de metadata, waveform y material listo para reproducir
- `solo` tenga semantica clara y cobertura automatizada en motor y desktop
- el runtime exponga datos suficientes para cuantificar el desfase transporte vs runtime sin depender solo de inspeccion visual
- exista una decision tecnica respaldada por datos sobre continuar con `rodio` o abrir la migracion a un backend por bloques

---

## Principios

### 1. Primero medir, luego sustituir

No se adelanta backend nuevo por intuicion.
La reescritura solo se activa si los datos muestran que la ruta actual ya no alcanza.

### 2. El modelo manda

Reglas como `solo`, fades persistentes y automatizacion futura deben nacer primero en el modelo o en la capa de coordinacion correcta, no como hacks visuales.

### 3. El runtime debe ser observable

No basta con saber que hubo un restart.
Necesitamos poder comparar:

- tiempo de reconstruccion
- clips reprogramados
- buffers cacheados
- posicion estimada del runtime
- desviacion respecto al transporte desktop

### 4. Cada mejora debe dejar una ruta futura limpia

Si una mejora de `v2` hace mas dificil migrar a mixer propio, no sirve.

---

## Fase 1 - Stress y benchmark reproducible

### Objetivo

Tener evidencia objetiva de como se comporta el motor en proyectos mas grandes.

### Tareas

- crear fixtures de proyecto con varias pistas largas y clips desplazados
- definir un set fijo de escenarios:
  - play inicial
  - seek repetido
  - mute rapido
  - barrido de volumen
  - varios saltos seguidos
  - cambios de timeline durante reproduccion
- registrar tiempos base para:
  - `restart`
  - `sync_song`
  - `stop`
  - numero de sinks y buffers cacheados
- documentar como repetir estas pruebas localmente

### Criterio de completado

Tenemos una bateria reproducible y una tabla base de metricas para comparar iteraciones.

---

## Fase 2 - Cache y preparacion v2

### Objetivo

Separar mejor las capas de datos del audio y reducir trabajo redundante.

### Tareas

- distinguir explicitamente:
  - metadata del archivo
  - resumen de waveform
  - bytes o buffers listos para reproducir
- definir politica de invalidacion por proyecto y por `file_path`
- medir memoria consumida por cada capa
- revisar si conviene cachear regiones de lectura o slices preparados
- evitar que la construccion de waveform y la preparacion de reproduccion compitan sin control

### Criterio de completado

La cache deja de ser "un solo saco" y pasa a tener responsabilidades y metricas diferenciadas.

---

## Fase 3 - Mezcla DAW basica: `solo` y reglas claras

### Objetivo

Dar el siguiente paso musical en la mezcla sin romper la ruta incremental ya conseguida.

### Tareas

- definir semantica exacta de `solo`:
  - solo por pista
  - interaccion con mute
  - interaccion con grupos
- resolver la ganancia efectiva en `libretracks-audio`
- propagar la semantica al runtime incremental sin reinicio global cuando sea posible
- anadir tests de motor para combinaciones:
  - solo simple
  - varios solos
  - solo con grupos
  - solo y mute en conflicto
- dejar documentada la frontera con futuras funciones como `solo safe` o `exclusive solo`

### Criterio de completado

`solo` funciona con reglas predecibles y sin introducir incoherencias en la mezcla viva.

---

## Fase 4 - Precision de transporte y desfase observable

### Objetivo

Pasar de una estimacion util a una medicion mas accionable del desfase runtime vs transporte.

### Tareas

- ampliar la telemetria del playhead del runtime
- definir una forma estable de comparar:
  - posicion del transporte desktop
  - posicion logica del engine
  - posicion estimada del runtime
- registrar muestras de desfase en eventos clave:
  - play
  - seek
  - salto
  - final de cancion
- documentar umbrales aceptables para desktop

### Criterio de completado

Podemos describir el desfase con datos y no solo con percepcion subjetiva.

---

## Fase 5 - Fades persistentes y transiciones seguras

### Objetivo

Separar claramente fades de proyecto frente a rampas de seguridad del runtime.

### Tareas

- definir fades persistentes en el modelo de clip
- mantener las rampas cortas del runtime como mecanismo anti-click
- decidir que puede aplicarse incrementalmente y que sigue requiriendo restart
- cubrir con tests:
  - fade in
  - fade out
  - fade corto cerca del borde
  - interaccion con trim y duplicado

### Criterio de completado

Los fades dejan de ser una deuda abstracta y pasan a tener modelo, semantica y limites claros.

---

## Fase 6 - Decision gate del backend

### Objetivo

Decidir si la siguiente iteracion sigue sobre `rodio` o abre migracion a mixer por bloques.

### Tareas

- consolidar metricas de Fase 1 a 4
- evaluar sintomas que justifican cambio de backend:
  - reinicios inevitables demasiado costosos
  - desfase inaceptable
  - falta de control fino para mezcla o automatizacion
  - demasiada complejidad accidental en torno a sinks por clip
- si la ruta actual sigue siendo suficiente:
  - documentar limites aceptados
  - definir una nueva lista corta de mejoras incrementales
- si no alcanza:
  - preparar RFC tecnico para backend v2 por bloques

### Criterio de completado

La decision de arquitectura queda cerrada con datos, no con intuicion.

---

## Fuera de alcance inmediato

Para no desviar el foco, esto no deberia bloquear este plan:

- MIDI y VSTs
- warping complejo
- render offline completo
- compensacion de latencia avanzada
- edicion espectral
- automatizacion de todos los parametros

---

## Orden recomendado

```txt
1. Fase 1 - Stress y benchmark reproducible
2. Fase 2 - Cache y preparacion v2
3. Fase 3 - Mezcla DAW basica: solo y reglas claras
4. Fase 4 - Precision de transporte y desfase observable
5. Fase 5 - Fades persistentes y transiciones seguras
6. Fase 6 - Decision gate del backend
```

---

## Resultado esperado

LibreTracks deberia quedar tras esta `v2` con un motor:

- mas cuantificado
- mas preparado para proyectos pesados
- con reglas de mezcla mas propias de un DAW
- con una decision de arquitectura mejor fundamentada
- listo para dar el salto a backend por bloques solo si de verdad hace falta
