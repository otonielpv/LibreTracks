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

Estado a 20/04/2026:

- ya existe proyecto desktop funcional
- ya se pueden crear, abrir y guardar proyectos
- ya se pueden importar uno o varios WAVs
- ya se puede reproducir audio real
- ya existe timeline con regla temporal, cursor y clips
- ya se pueden mover clips de forma basica
- ya existe shell visual DAW con timeline dominante
- ya hay cabeceras de pista integradas con controles de mezcla basica
- ya existe barra contextual inferior para clip, seccion y salto
- ya se pueden crear secciones desde el timeline
- ya se pueden renombrar, borrar y ajustar rangos de seccion desde la barra contextual
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

### Estado

- Completada en primera iteracion

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

### Estado

- Completada en primera iteracion funcional
- Ya existe preview de posicion y persistencia directa al arrastrar clips
- Ya hay cobertura frontend del drag principal de movimiento sobre el timeline

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

### Estado

- Completada en primera iteracion funcional
- Ya se dibujan regiones en la regla y se pueden seleccionar como destino de salto
- Ya se pueden renombrar, borrar y ajustar rango desde contexto ligero
- Ya se pueden arrastrar bordes directamente sobre la region del ruler

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

### Estado

- Completada en primera iteracion funcional
- Ya se muestran destino del salto y punto estimado de ejecucion en el timeline
- Ya se puede programar y cancelar salto desde la barra contextual
- Ya hay tests UI + backend para salto inmediato, en compases y cancelacion

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

### Estado

- Completada en primera iteracion del shell DAW
- Pendiente robustecer comportamiento nativo en reproduccion para cambios de volumen y mute

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

### Estado

- Completada en primera iteracion funcional
- Ya se puede borrar el clip seleccionado desde la barra contextual
- Ya se puede recortar inicio y final del clip desde el contexto ligero
- Ya se pueden recortar clips directamente desde sus handles laterales
- Ya se puede duplicar el clip seleccionado desde el timeline
- Ya existe snap temporal basico opcional a beat

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

### Estado

- Completada en primera iteracion funcional
- Ya existe `Space` para play/pause desde el shell principal
- Ya existe `Escape` para limpiar seleccion y borradores del timeline
- Ya existe zoom horizontal con `Ctrl + rueda` manteniendo el contexto visual
- Ya existe autoscroll basico en borde durante arrastres del timeline
- Ya existe `Backspace` ademas de `Suprimir` para borrar el clip seleccionado
- Ya existe `Ctrl/Cmd + D` para duplicar el clip seleccionado
- Ya existen nudges con flechas para mover clips seleccionados

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

### Estado

- Completada como cierre funcional del frontend v1
- El shell principal ya integra clips, secciones, saltos, mezcla y atajos basicos en una sola superficie de trabajo
- El plan queda actualizado junto con tests frontend y backend de los flujos criticos del shell
- La siguiente etapa prioritaria pasa a ser la estabilidad y fluidez del motor de audio nativo

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

## Estabilizacion urgente 20/04/2026

Antes de seguir cerrando fases visuales habia un bloqueo critico en el runtime nativo que ya no podiamos posponer.

```txt
[x] Corregir reproduccion nativa para programar clips futuros y no solo los activos al pulsar Play
[x] Evitar reinicio global del audio al cambiar volumen o mute de pista/grupo
[x] Mantener cambios de mezcla sobre el conjunto sin parar toda la reproduccion
[x] Mostrar feedback visual de trabajo durante importacion multiple de WAVs
```

Esto no cierra fases nuevas del plan por si solo, pero si protege el principio de "no romper el audio" para poder seguir con C, F y G.

---

## Primera lista de tareas concretas

### Milestone DAW 1 - Shell principal

```txt
[x] Rehacer layout principal para priorizar timeline
[x] Compactar barra superior de transporte
[x] Integrar cabeceras de pista con timeline
[x] Reducir cajas informativas actuales
```

### Milestone DAW 2 - Clips directos

```txt
[x] Arrastrar clips horizontalmente
[x] Mostrar preview de movimiento
[x] Persistir posicion al soltar
[x] Evitar conflicto entre click y drag
```

### Milestone DAW 3 - Regiones de seccion

```txt
[x] Seleccionar seccion desde timeline
[x] Ajustar inicio/fin de seccion
[x] Renombrar seccion
[x] Borrar seccion
```

### Milestone DAW 4 - Saltos visuales

```txt
[x] Mostrar destino del salto en timeline
[x] Mostrar punto de ejecucion
[x] Programar salto desde region seleccionada
[x] Cancelar salto desde timeline
```

### Milestone DAW 5 - Mezcla integrada

```txt
[x] Llevar volumen de pista a cabecera de pista
[x] Llevar mute de pista a cabecera de pista
[x] Mostrar grupo en cabecera
[x] Crear/asignar grupos desde flujo mas integrado
```

### Milestone DAW 6 - Edicion v1

```txt
[x] Recortar inicio de clip
[x] Recortar final de clip
[x] Duplicar clip
[x] Borrar clip
[x] Snap temporal basico
```

### Milestone DAW 7 - Navegacion y precision

```txt
[x] Espacio para play/pause
[x] Suprimir para borrar clip
[x] Escape para cancelar seleccion
[x] Ctrl + rueda para zoom horizontal del timeline
[x] Autoscroll en borde durante drag
```

---

## Decision de producto para la siguiente etapa

La siguiente etapa recomendada es:

> rehacer el frontal empezando por el timeline como pantalla principal y mover la manipulacion de clips al propio timeline.

Ese trabajo ya esta en marcha y tiene una primera iteracion funcional cerrada.

La siguiente prioridad inmediata pasa a ser:

> estabilizar el runtime nativo durante importacion y mezcla para que volumen, mute e importacion multiple sean fiables mientras seguimos avanzando las fases C, F y G.
