# Plan A — Hacer táctil la vista DAW

**Estado: implementado** (rama `mobile-daw-plan-a`, commits `e887a161`…`fd2e9750`,
uno por paso). Falta el criterio de salida, que sólo se puede cerrar en un
dispositivo real — ver el final de este documento.

Mantiene los carriles y el modelo mental de la DAW, y ataca lo que la hace
impracticable en un móvil: que la pantalla no propone ningún primer paso y que
las acciones están escondidas tras el clic derecho.

## Principio rector

**Una tarea de precisión gana sitio DENTRO de la vista; nunca la sustituye.**

Es la regla que sí sigue GarageBand (su editor de automatización expande la
fila de la pista; su lista de pistas *es* la columna de cabeceras) y la que
incumplió el panel «Preparar canción» que se revirtió: se abría a pantalla
completa y ocultaba el timeline, de modo que «añadir marca en el cabezal»
tapaba justo el cabezal.

Corolario práctico: **nada obligatorio detrás de mantener pulsado.** El pulsado
largo se queda para quien lo conozca, pero deja de ser la única puerta.

## Lo que ve hoy alguien nuevo (verificado en emulador, 2026-09-07)

Abriendo una sesión vacía en la vista DAW:

- Cerca del 70% de la pantalla es un área negra sin ninguna indicación.
- La columna de pistas dice `TRACKS`, está vacía y tiene cuatro iconos sin
  etiqueta.
- Ocupando el ancho superior: `VAMP MODE`, `VAMP`, `MARKER JUMP`,
  `SONG TRANSITION`, `MASTER`. Son ajustes de **directo**, inútiles antes de
  tener una pista y desconcertantes para un novato.
- **No hay nada en pantalla que sugiera «añade audio»**. La única entrada es un
  icono de la barra lateral.

Y la aritmética que lo condiciona todo: descontando cabeceras y barras, al área
de carriles le quedan unos 650 px de alto. Con 16 stems son ~40 px por pista en
píxeles de pantalla. Es estrecho, pero suficiente para leer estructura si las
cabeceras dejan de comerse el ancho — que es lo que ataca el paso 5.

## Pasos

Cada paso es entregable por sí solo y deja la app en un estado mejor que el
anterior. El orden es el del usuario del primer día.

---

### Paso 1 — El vacío se convierte en el primer paso

**Qué:** el área de carriles vacía deja de ser un muro negro y muestra el paso
siguiente: «Aún no hay audio en esta sesión» y un botón **Añadir audios** que
abre el flujo de importación existente.

**Por qué primero:** es el único bloqueo absoluto. Sin esto, un usuario nuevo no
tiene forma de empezar salvo adivinar un icono de la barra lateral.

**Dónde:** `timeline/TimelineCanvasPane.tsx` (zona `lt-track-list-dropzone`, que
ya existe y hoy es invisible). Reutilizar `handleImportLibraryFromDialog`.

**Criterios de aceptación:**
- Con cero pistas, el área de carriles muestra el mensaje y el botón.
- El botón abre el mismo diálogo que la biblioteca; no duplica pipeline.
- Con al menos una pista, no aparece nada (no roba sitio).
- Sólo en móvil; el escritorio no cambia.

**No hace:** no cambia dónde se colocan los audios ni el pipeline de import.

---

### Paso 2 — La barra de la selección, generalizada

**Qué:** `MobileClipActionBar` (ya existe, sólo entiende de clips) pasa a
mostrar las acciones de **lo que esté seleccionado**: marca, clip, región o
pista. Sin selección, muestra las acciones de creación (`+ Sección`,
`+ Aviso`, `+ Audio`).

**Cómo, sin duplicar lógica:** las acciones salen de las factories que ya
existen en `menus/timelineMenus.ts` (`sectionContextMenu`,
`tempoMarkerContextMenu`, `timeSignatureMarkerContextMenu`, `clipContextMenu`,
`trackContextMenu`, `songRegionContextMenu`…), que devuelven
`ContextMenuAction[]`. La barra las **renderiza**, no las reimplementa, igual
que hoy dispara acciones por id del registro de atajos.

**Criterios de aceptación:**
- Seleccionar una marca muestra sus acciones sin mantener pulsado.
- Las acciones son las mismas que ofrece el menú contextual del escritorio
  (test que compare ambas listas para el mismo objeto).
- La barra flota sobre el timeline; el cabezal y la regla siguen visibles.
- Si hay más acciones de las que caben, se accede al resto sin perder ninguna.

**No hace:** no añade acciones nuevas al modelo; sólo las saca a la superficie.

---

### Paso 3 — Las marcas, de primera clase

**Qué:** crear una marca **con su tipo** desde la barra, y editar tipo, nombre y
posición desde la selección. Hoy el botón crea una marca genérica, lo que es un
recorte respecto al escritorio, que ofrece 22 tipos de sección
(`MARKER_KINDS`), 13 de aviso (`CUE_KINDS`) y variantes numeradas.

**Por qué importa:** la vista DAW se nutre de las marcas. Es el gesto que más se
repite montando, así que es el que más barato tiene que salir.

**Decisión pendiente (ver «Preguntas abiertas»):** si `+ Sección` pide el tipo
al crear o crea genérica y se tipifica después.

**Criterios de aceptación:**
- Se puede crear una sección tipificada y un aviso tipificado sin pulsado largo.
- Se puede cambiar el tipo de una marca existente desde su selección.
- La posición se muestra y se puede corregir numéricamente (compás/tiempo y
  segundos), no sólo arrastrando la bandera.
- La marca se crea en el tiempo mostrado, y la reproducción posterior no lo
  cambia.

---

### Paso 4 — Los ajustes de directo, agrupados pero accesibles

**Qué:** `VAMP MODE`, `VAMP`, `MARKER JUMP`, `SONG TRANSITION` y `MASTER` se
recogen bajo un grupo **Directo**, cerrado por defecto en móvil.

**Restricción explícita del usuario:** *tienen que seguir siendo accesibles.*
Hay quien usa la vista DAW para tocar en directo. Por tanto:
- El grupo se abre con un toque y **recuerda su estado**, de modo que quien toca
  en directo lo deja abierto y no vuelve a pelearse con él.
- Abierto, ofrece exactamente los mismos controles que hoy. No se recorta nada.
- En escritorio no cambia nada.

**Criterios de aceptación:**
- Sesión nueva en móvil: el grupo aparece cerrado y la barra deja sitio.
- Abrirlo da acceso a todos los controles actuales.
- Su estado sobrevive a cerrar y reabrir la app.

**No hace:** no elimina ni simplifica ningún ajuste de directo.

---

### Paso 5 — Cabeceras finas y expansión en fila

**Qué:** la cabecera de pista en móvil se reduce a nombre y estado. Tocarla
**expande esa fila** con sus controles —volumen, mute/solo, salida, color— sin
salir del timeline, como hace GarageBand con la automatización.

**Por qué:** `HEADER_WIDTH` es 260 px y en móvil la regla de portrait
(`clamp(12rem, 34vw, 16.25rem)`) **nunca se aplica**, porque Android fija
`sensorLandscape`. Es decir: la columna se lleva 260 px fijos de ancho antes de
que veas un solo píxel de audio.

**Criterios de aceptación:**
- El audio gana el ancho que hoy ocupa la columna.
- Los controles de una pista siguen alcanzables en dos toques como mucho.
- Expandir una fila no cambia el zoom ni la posición de la cámara.

---

### Paso 6 — Tempo y compás como acciones visibles

**Qué:** crear y editar marcas de tempo y de compás desde la barra de la
selección, no sólo desde sus menús contextuales.

**Va el último** porque es el menos frecuente montando: la mayoría de sesiones
tienen un tempo y un compás constantes.

---

## Riesgos

- **Presupuesto de tamaño.** `fileSizeBudget.test.ts` vigila
  `TransportPanelContent.tsx` (8500), `TimelineCanvasPane.tsx` y otros. La regla
  del proyecto es **extraer, no subir el límite**. Todo lo nuevo va en
  `features/transport/mobile/` con el patrón de factory con getters. Se cumplió:
  el presupuesto saltó tres veces y las tres se extrajo un bloque; dos límites
  acabaron más bajos que al empezar.
- **Estabilidad referencial.** De la navegación táctil cuelga el gesto. Nada que
  se recree por render puede entrar en ese camino; ver
  `docs/REDESIGN_transport_refs_to_stores.md`.
- **Regresión en escritorio.** Todo va tras `isMobileApp` —identidad nativa de
  plataforma, **no** ancho de ventana—. Redimensionar la ventana de escritorio
  nunca debe activar nada de esto.

## Preguntas abiertas (resueltas al implementar)

1. **`+ Sección`: pide el tipo al crear.** La marca nace tipificada y nombrada.
   Cuesta un toque más en el gesto más repetido, y a cambio no deja trabajo
   pendiente ni sesiones llenas de marcas sin tipo. `+ Sección` y `+ Aviso` van
   separados y cada uno entra directo en su lista, así que el toque extra no es
   elegir el grupo, sólo el tipo.
2. **Tablet: misma densidad que el móvil.** `TRACK_HEADER_WIDTH` cuelga de
   `isMobileApp` y nada más. Un umbral por ancho metía un segundo camino que se
   activaría al girar el dispositivo, y la expansión en fila ya da los controles
   completos en dos toques con o sin ancho de sobra.

## Lo que se decidió sobre la marcha

- **La lista de la barra es la del escritorio, no una copia.** Cada rama de
  `mobile/selectionActions.ts` devuelve lo que devuelve la factory del menú
  contextual, y `selectionActions.test.ts` compara ambas listas objeto a objeto.
  Por eso «Posición…» se añadió a la factory compartida y el escritorio la ganó
  también: cualquier otra cosa habría roto esa invariante.
- **Compás → segundos es la inversa de segundos → compás**, por búsqueda
  binaria sobre la conversión que ya existe, no un mapa de tempos rehecho
  (`mobile/musicalPosition.ts`). Vale porque el mapa es monótono, y así no puede
  desincronizarse al tocar marcas de tempo o cambios de compás.
- **La fila expandida se superpone, no empuja.** El alto de fila lo comparten la
  columna de cabeceras y el área de carriles; crecer en un lado desincroniza los
  dos. Al no haber reflujo, «expandir no cambia el zoom ni la cámara» sale
  gratis en vez de haber que defenderlo.
- **Presupuesto de tamaño: se extrajo tres veces, nunca se subió un límite.**
  `timeline/describeAutomationCue.ts` (paso 1), `mobile/useMobileSelectionBar.ts`
  (paso 2) y `menus/markerKindMenus.ts` (paso 3). Dos límites bajaron con los
  ficheros: `TimelineCanvasPane` 1700→1650 y `timelineMenus` 1650→1450.

## Criterio de salida — PENDIENTE

Los seis pasos están implementados y con tests, pero **el plan no está cerrado**.
No se declara resuelto hasta que **alguien que no conoce la aplicación monte una
canción de cero en un teléfono**, sin ayuda: importar stems, crear secciones,
corregir una, ajustar una salida y ensayar. Medido en dispositivo, no en
emulador.

Y sigue en pie lo que dice el README: **la fluidez real de los gestos no se ha
medido**. Nada de lo hecho aquí toca el camino del gesto (la barra y el panel de
fila son superposiciones sin reflujo), pero eso es un argumento, no una medida.
Ver la batería de pruebas en `../mobile-authoring-research.md`.
