# Plan de desarrollo DAW

## Contexto

Este documento no sustituye a `PLAN_DESARROLLO.md`.

El plan anterior nos ha servido para levantar la base tecnica:

- app desktop Tauri + React funcionando
- motor de audio y transporte minimos
- importacion WAV
- persistencia de `song.json`
- timeline basico con waveform
- secciones basicas
- grupos basicos
- saltos logicos de seccion

El nuevo objetivo ya no es solo "que funcione".

El nuevo objetivo es:

> convertir LibreTracks en una experiencia tipo DAW, donde el timeline sea la pantalla principal y casi toda la edicion ocurra directamente sobre el timeline.

Esto implica un cambio de enfoque importante:

- menos paneles separados
- menos formularios auxiliares
- mas interaccion directa sobre clips, secciones, pistas y cursores
- una jerarquia visual mucho mas profesional
- un flujo mas parecido a un DAW real que a una app de formularios

---

## Estado de partida

Estado a 19/04/2026:

- ya existe proyecto desktop funcional
- ya se pueden crear, abrir y guardar proyectos
- ya se pueden importar uno o varios WAVs
- ya se puede reproducir audio real
- ya existe timeline con regla temporal, cursor y clips
- ya se pueden mover clips de forma basica
- ya se pueden crear secciones desde el timeline
- ya se pueden programar saltos de seccion
- ya existen grupos con volumen y mute

Limitaciones actuales que este nuevo plan quiere resolver:

- el timeline aun no es la pantalla dominante del producto
- mucha edicion sigue viviendo en paneles auxiliares
- mover clips no es todavia una interaccion directa tipo DAW
- la mezcla aun no esta integrada visualmente en el area principal
- la jerarquia visual no transmite aun una aplicacion de produccion musical
- el flujo de secciones y saltos aun no esta suficientemente anclado al timeline

---

## Objetivo principal

### Objetivo UX

Que al abrir la app se sienta como una estacion de trabajo musical:

- timeline como foco principal
- tracks visibles y estables
- clips editables directamente
- secciones visibles como regiones musicales
- cursor, seleccion, zoom y navegacion rapidos
- mezcla y estados relevantes accesibles sin romper el foco del timeline

### Objetivo tecnico

Reorganizar frontend y flujos de edicion para que el timeline sea la superficie principal, manteniendo compatibilidad con el motor actual y permitiendo crecer despues hacia:

- recorte de clips
- snap musical
- fades
- duplicacion
- automatizacion
- setlists
- modo directo

---

## Principios del nuevo plan

### 1. Timeline primero

Toda accion central debe poder empezar desde el timeline:

- mover clip
- seleccionar clip
- crear seccion
- ajustar rango
- mover cursor
- programar salto

### 2. Menos menus, mas manipulacion directa

Si una accion puede resolverse arrastrando, seleccionando o haciendo click sobre la superficie principal, esa opcion debe tener prioridad frente a paneles externos.

### 3. Inspector secundario

Seguira pudiendo existir inspector, pero como apoyo:

- detalles finos
- valores numericos
- opciones avanzadas

No debe ser la via principal de edicion.

### 4. DAW claro, no imitacion literal

No hace falta copiar Ableton Live pixel a pixel.

Si hace falta copiar el tipo de interaccion:

- timeline dominante
- pistas compactas
- clips editables
- contexto musical visible
- acciones rapidas

### 5. No romper el audio

Ninguna mejora visual debe degradar:

- reproduccion
- persistencia
- saltos
- estabilidad del transporte

---

## Vision de producto despues de este plan

Pantalla principal deseada:

```txt
┌──────────────────────────────────────────────────────────────────────┐
│ Barra superior: proyecto | transporte | tempo | compas | zoom      │
├───────────────┬──────────────────────────────────────────────────────┤
│ Cabeceras     │ Regla temporal / secciones / saltos                 │
│ de pista      ├──────────────────────────────────────────────────────┤
│               │ Track 1 | [clip waveform................................] │
│ nombre        │ Track 2 | [clip waveform........] [clip....]        │
│ grupo         │ Track 3 | [clip....................................] │
│ mute          │ Track 4 | [clip....]                                │
│ solo          │                                                      │
│ volumen       │ Cursor | seleccion | arrastre | snap | regiones     │
├───────────────┴──────────────────────────────────────────────────────┤
│ Barra inferior contextual: clip | seccion | salto | edicion fina    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Fase A - Replanteamiento visual del shell

### Objetivo

Cambiar la estructura del frontend para que el timeline pase a ser la pantalla principal real.

### Resultado esperado

- layout mas ancho y mas parecido a un editor
- timeline ocupando la mayor parte del viewport
- controles secundarios reubicados
- jerarquia visual de DAW clara desde el primer vistazo

### Tareas

- redisenar `TransportPanel` como shell principal de edicion
- mover transporte global a una barra superior mas compacta
- reducir protagonismo de cajas informativas grandes
- integrar lista de pistas dentro del layout del timeline
- llevar grupos y mezcla a una columna o cabecera de pista mas natural
- mejorar tipografia, densidad y espaciado para trabajo continuado

### Criterio de completado

Al abrir la app, la primera impresion visual debe ser "editor musical" y no "panel con widgets".

---

## Fase B - Interaccion directa de clips

### Objetivo

Hacer que editar clips sea una accion directa en el timeline.

### Resultado esperado

- arrastrar clips horizontalmente para mover su posicion
- seleccion visual mas clara
- feedback inmediato al arrastrar
- persistencia del nuevo estado al soltar

### Tareas

- implementar drag horizontal directo de clips
- mostrar ghost / preview de posicion durante arrastre
- persistir `timelineStartSeconds` al finalizar
- evitar clicks accidentales en modo arrastre
- mantener el cursor y la seleccion coherentes mientras se edita
- anadir tests frontend del flujo de arrastre

### Criterio de completado

Mover un clip debe hacerse arrastrandolo desde el timeline, no desde un panel externo.

---

## Fase C - Secciones como regiones del timeline

### Objetivo

Convertir las secciones en entidades visibles y editables directamente sobre la regla temporal.

### Resultado esperado

- regiones de seccion dibujadas sobre el timeline
- seleccion por arrastre natural
- posibilidad de renombrar y ajustar rango
- seleccion de destino de salto directamente desde la region

### Tareas

- consolidar el modelo visual de regiones
- permitir seleccionar una region existente
- permitir arrastrar bordes de inicio y fin
- permitir renombrar una seccion desde contexto ligero
- permitir borrar seccion
- resaltar seccion actual durante reproduccion
- vincular region seleccionada con programacion de salto

### Criterio de completado

Las secciones deben sentirse como regiones musicales del timeline, no como datos anexos.

---

## Fase D - Saltos musicales dentro del timeline

### Objetivo

Llevar el flujo de saltos a una experiencia musical y visual.

### Resultado esperado

- ver destino del salto directamente en el timeline
- ver punto esperado de ejecucion
- programar salto desde una seccion seleccionada
- cancelar salto sin salir del area principal

### Tareas

- mostrar estado de salto pendiente en la regla o cabecera
- marcar visualmente seccion destino
- marcar visualmente punto de ejecucion estimado
- exponer triggers:
  - inmediato
  - fin de seccion
  - despues de N compases
- anadir cancelacion rapida
- anadir tests del flujo UI + backend

### Criterio de completado

El usuario debe entender visualmente que salto esta armado, hacia donde va y cuando ocurrira.

---

## Fase E - Mezcla integrada en cabeceras de pista

### Objetivo

Mover mezcla y organizacion de grupos a una forma mas propia de un DAW.

### Resultado esperado

- volumen y mute de pista en cabeceras
- grupo visible por pista
- volumen y mute de grupo visibles sin romper el foco
- creacion y asignacion de grupo mejor integradas

### Tareas

- redisenar cabeceras de pista con mas densidad
- llevar controles de pista a la cabecera
- incorporar selector de grupo en contexto natural
- hacer visible el estado de grupo sobre cada pista
- crear una zona compacta de grupos o submezclas
- verificar persistencia completa en `song.json`

### Criterio de completado

El usuario debe poder entender y manipular mezcla basica sin bajar a paneles separados grandes.

---

## Fase F - Edicion musical v1

### Objetivo

Empezar la edicion real de material en timeline.

### Resultado esperado

- recorte de inicio
- recorte de final
- duplicar clip
- borrar clip
- primer snap basico

### Tareas

- handles laterales de clip
- actualizar `sourceStartSeconds` y `durationSeconds`
- limitar rangos invalidos
- duplicar clip con offset razonable
- borrar clip seleccionado
- snap opcional a grid temporal simple
- tests de persistencia y UI

### Criterio de completado

El timeline ya no solo organiza audio: empieza a editarlo de forma no destructiva.

---

## Fase G - Navegacion y precision

### Objetivo

Mejorar sensacion de control y trabajo fino.

### Resultado esperado

- scroll horizontal y vertical fluidos
- zoom centrado en contexto
- autoscroll durante arrastres
- mejor lectura temporal

### Tareas

- zoom alrededor del cursor o seleccion
- autoscroll en borde durante drag
- refinamiento de regla temporal
- hotkeys basicas:
  - espacio play/stop
  - suprimir borrar clip
  - escape cancelar seleccion
- seleccionar clip y seccion con mejor feedback visual

### Criterio de completado

El usuario debe poder trabajar varios minutos en el timeline sin sentir friccion fuerte.

---

## Fase H - Cierre funcional del nuevo shell

### Objetivo

Dar por terminada la primera gran etapa DAW del frontend.

### Resultado esperado

- timeline principal estable
- flujo de clips, secciones, saltos y mezcla coherente
- UI con identidad clara de editor musical
- base preparada para refactor visual mas fino o para siguientes funciones

### Tareas

- limpieza de componentes
- separar shell, ruler, lanes, clip items, regions y mixer headers
- consolidar estilos y tokens visuales
- revisar accesibilidad basica
- revisar rendimiento basico en canciones con varias pistas
- actualizar documentacion y plan

---

## Orden recomendado de implementacion

```txt
1. Fase A - Replanteamiento visual del shell
2. Fase B - Interaccion directa de clips
3. Fase C - Secciones como regiones del timeline
4. Fase D - Saltos musicales dentro del timeline
5. Fase E - Mezcla integrada en cabeceras de pista
6. Fase F - Edicion musical v1
7. Fase G - Navegacion y precision
8. Fase H - Cierre funcional del nuevo shell
```

---

## Fuera de alcance inmediato

Para no mezclar objetivos, estas cosas no deberian bloquear este nuevo plan:

- control remoto web avanzado
- setlists
- cambio de tempo y tono
- formatos extra mas alla de WAV
- automatizacion compleja
- buses de salida avanzados
- modo directo final

No estan descartadas.
Solo no deben frenar la conversion del timeline en superficie principal.

---

## Definicion de exito

Consideraremos cumplido este nuevo objetivo cuando:

- el timeline sea claramente la pantalla principal
- mover y editar clips ocurra sobre el timeline
- secciones se creen y ajusten sobre el timeline
- saltos se programen y entiendan visualmente desde el timeline
- mezcla basica viva en cabeceras o zonas integradas
- el inspector quede como apoyo, no como centro del flujo

---

## Primera lista de tareas concretas

### Milestone DAW 1 - Shell principal

```txt
[ ] Rehacer layout principal para priorizar timeline
[ ] Compactar barra superior de transporte
[ ] Integrar cabeceras de pista con timeline
[ ] Reducir cajas informativas actuales
```

### Milestone DAW 2 - Clips directos

```txt
[ ] Arrastrar clips horizontalmente
[ ] Mostrar preview de movimiento
[ ] Persistir posicion al soltar
[ ] Evitar conflicto entre click y drag
```

### Milestone DAW 3 - Regiones de seccion

```txt
[ ] Seleccionar seccion desde timeline
[ ] Ajustar inicio/fin de seccion
[ ] Renombrar seccion
[ ] Borrar seccion
```

### Milestone DAW 4 - Saltos visuales

```txt
[ ] Mostrar destino del salto en timeline
[ ] Mostrar punto de ejecucion
[ ] Programar salto desde region seleccionada
[ ] Cancelar salto desde timeline
```

### Milestone DAW 5 - Mezcla integrada

```txt
[ ] Llevar volumen de pista a cabecera de pista
[ ] Llevar mute de pista a cabecera de pista
[ ] Mostrar grupo en cabecera
[ ] Crear/asignar grupos desde flujo mas integrado
```

### Milestone DAW 6 - Edicion v1

```txt
[ ] Recortar inicio de clip
[ ] Recortar final de clip
[ ] Duplicar clip
[ ] Borrar clip
[ ] Snap temporal basico
```

---

## Decision de producto para la siguiente etapa

La siguiente etapa recomendada es:

> rehacer el frontal empezando por el timeline como pantalla principal y mover la manipulacion de clips al propio timeline.

Ese deberia ser el siguiente trabajo grande antes de seguir anadiendo funciones nuevas.
