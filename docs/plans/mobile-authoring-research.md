# Preparar multitracks desde móvil y tablet

Fecha: 2026-09-07. Código revisado: `fb085d78`.

Estado: primera implementación entregada (ver «Estado de implementación»); pendiente de validación en dispositivos reales y con usuarios. No es un diagnóstico de rendimiento en release ni una reproducción del fallo de marcas: la causa raíz del síntoma de las marcas sigue sin reproducirse, sólo se ha eliminado una de las hipótesis por construcción.

## Decisión de producto propuesta

Dar a una persona que solo tiene móvil un recorrido completo: crear canción, importar stems, organizarlos, marcar secciones, ajustar mezcla y salidas, configurar automatizaciones, guardar y ensayar en Compacta/Live. Preparar en PC y transferir debe seguir siendo una opción cómoda, pero la autonomía móvil requiere este recorrido propio.

La DAW sigue siendo necesaria para montaje libre y edición precisa. Sin embargo, preparar una canción de stems alineados no debería exigir dominar una sesión de muchas pistas y regiones. Propongo una entrada «Preparar canción» sobre el proyecto existente, con herramientas por tarea y acceso a la DAW. No implica crear otro formato, otro motor ni una copia de la canción.

## Qué se ha observado

Las rutas de código siguientes son relativas a `apps/desktop/src/features/transport/`, salvo indicación contraria. Los comentarios históricos explican decisiones, pero no demuestran que un fallo siga ocurriendo.

| Área | Evidencia actual | Implicación |
|---|---|---|
| Navegación | `Renderer/InputManager.ts`: vertical con un dedo fuera del gesto propio; desplazamiento horizontal/zoom con dos; decisión tras 14 px, reanclaje y bloqueo del modo hasta terminar | Navegar exige cambiar de gesto según el eje. El recorrido inicial no mueve la cámara. Es una posible explicación de la sensación de falta de respuesta, no una medición de latencia |
| Entrada del segundo dedo | `handleTouchStart` rechaza eventos no cancelables y cambia `touchAction` al comenzar el gesto | Si el navegador ya tomó el scroll, se requiere levantar y volver a apoyar. Un cambio tardío de CSS no garantiza recuperar el gesto |
| Marcas | `timeline/useTouchContextMenu.ts`: espera 550 ms, tolera 16 px y conserva las coordenadas iniciales de pantalla | Ya existe protección frente a la deriva del dedo. La posición musical no se captura aquí |
| Posición de marca | `TransportPanelContent.tsx`, `snappedRulerSeconds` y callback `onRulerContextMenu`: convierten usando cámara/escala actuales y normalizan con snap cuando se abre el menú | Hay que comprobar cambios de cámara durante la espera, zoom recién terminado y ajuste a rejilla; no atribuir todo a la pulsación larga |
| Acción del menú | `menus/timelineMenus.ts`, `rulerContextMenu`: con selección de rango activa ofrece crear canción; sin ella ofrece crear marca y después elegir tipo | El mismo lugar puede producir otra acción según una selección anterior. Descubribilidad y estado visible importan |
| Importación | `library/LibrarySidebarPanel.tsx` y `library/libraryPlacement.ts`: selección móvil + «Añadir al timeline»; crea una pista por audio en el cabezal | El móvil ya tiene alternativa al arrastre. El destino depende de un cabezal que puede estar oculto por la biblioteca |
| Carpetas | `addFolderToTimeline`: crea canción con distribución vertical, al siguiente tiempo fuerte tras la última región; sin regiones ancla en cero | Hay una base para «Crear canción desde stems». El caso de clips existentes sin regiones necesita evaluación específica |
| Añadir a canción | `addAssetsToSong`: coloca en el inicio de la región | Conviven tres reglas de destino. Conviene explicitar cuál se está usando |
| Reordenar pistas | `tracks/trackHeaderHandlers.ts` bloquea drag táctil salvo `trackReorderMode`; existe `MobileTrackReorderToggle` | Ya se separa scroll de reordenación. Mejorar acceso, indicación y alternativas a arrastrar a través de una lista larga |
| Mezcla/routing | `TrackHeaderItem.tsx`, `AudioRouteCombobox.tsx`, `compact/CompactMixer.tsx` | Hay controles reutilizables. Falta validar comodidad, precisión y consulta de muchas salidas en pantalla pequeña |
| Automatizaciones | `panels/AutomationCueModal.tsx`: acciones de salto, mute, solo, mezcla, escena, pad y espera; límite de ejecuciones | No reducir el análisis a curvas de volumen: el flujo existente incluye programación de acciones de directo |
| Espacio horizontal | `src/shared/styles.css`, regla portrait: cabeceras con `clamp(12rem, 34vw, 16.25rem)` | Con raíz de 16 px y viewport de 360 px, la columna mínima ocupa 192 px y deja como máximo 168 px antes de otros elementos. Es un cálculo de CSS, pendiente de medir con el zoom real |

## Investigar el fallo de marcas sin adivinar la causa

La cadena actual es: toque → espera → evento contextmenu en coordenada inicial → conversión a segundos con viewport actual → snap → menú que captura esos segundos → selección de tipo → creación. El menú ya recibe un valor temporal; la sospecha principal a comprobar está antes de abrirlo, no en que la marca persiga al dedo mientras se elige el tipo.

Registrar, solo en una herramienta de diagnóstico: instante y objetivo del pointerdown, coordenadas de pantalla, rectángulo y escala del ruler, cámara, píxeles/segundo, tiempo sin snap, tiempo con snap, instante del menú y posición final guardada. Incluir cancelaciones y apertura del menú nativo/sintético para detectar duplicados.

Reproducir sobre regla vacía, cabezal y marcas existentes; con reproducción detenida y activa; snap activado/desactivado; antes y después de pinza; con zoom de interfaz distinto de 100%; desplazamiento vertical previo; deriva pequeña; segundo dedo; rotación. Comprobar también que no queda una selección de rango que cambie el menú.

Hipótesis separadas:

- **Viewport cambiante:** una coordenada de pantalla inicial puede representar otro tiempo 550 ms después. Capturar el tiempo de intención al tocar, o cancelar explícitamente si cambia la cámara, son opciones a comparar.
- **Snap poco visible:** la marca puede caer correctamente en la rejilla pero contradecir lo que esperaba el usuario. Mostrar antes de confirmar la posición y el ajuste aplicados.
- **Transformaciones desincronizadas:** comprobar que canvas, overlay y conversión usan la misma geometría durante y justo después de un zoom.
- **Gestos competidores:** determinar quién conserva el control al entrar otro dedo y si todos los temporizadores y previews se cancelan.

Para reducir la dependencia de ese gesto, ofrecer además «Añadir marca en el cabezal» con posición visible. Durante reproducción, capturar el tiempo al pulsar; introducir el nombre después no debe cambiarlo. Afinar mediante compás/tiempo o segundos, avance/retroceso según rejilla y escucha del entorno.

## Referencias contrastadas

Las referencias muestran patrones disponibles; no constituyen pruebas comparativas de fluidez ni justifican copiar todas sus decisiones.

- **Cubasis:** documenta navegación por arrastre, pinza y zoom vertical en la columna de pistas. Es una referencia para dar funciones reconocibles a superficies concretas. [Tracks, Cubasis 3.8](https://www.steinberg.help/r/cubasis/3.8/en/cubasis/topics/tracks_r.html).
- **GarageBand en iPhone:** ofrece un editor de automatización donde las pistas se expanden y la edición tiene controles explícitos. Referencia para dedicar espacio a una tarea de precisión. [Automatización de volumen](https://support.apple.com/en-ie/guide/garageband-iphone/chsf716994ec/ios).
- **GarageBand en iPhone:** selecciona regiones antes de operar y permite ampliar al mantener un borde durante el recorte. Referencia para precisión sin mostrar permanentemente todos los controles. [Edición de regiones](https://support.apple.com/en-mide/guide/garageband-iphone/chsec12c15d/ios).
- **Playback:** documenta edición del arreglo mediante secciones y botones para añadir/eliminar. Es una referencia de organización musical; no prueba que su importación satisfaga el uso local y autónomo que buscamos. [Arreglos personalizados](https://helpcenter.multitracks.com/en/articles/6437439-how-to-create-custom-arrangements-in-playback).
- **W3C:** una vez asumido el gesto, cambiar `touch-action` no altera la decisión del navegador durante esa acción. Hay que fijar responsabilidades de superficies/modos antes del contacto y validar la convivencia con Touch Events. [Pointer Events](https://www.w3.org/TR/pointerevents/#the-touch-action-css-property).
- **Android:** recomienda objetivos táctiles de al menos 48 × 48 dp, pudiendo ampliar el área interactiva de un icono pequeño. No equiparar sin medir dp, píxeles CSS y zoom de la WebView. [Accesibilidad](https://developer.android.com/guide/topics/ui/accessibility/views/apps-views?hl=en).

## Recorrido propuesto

### 1. Crear canción desde archivos

«Nueva canción» → seleccionar varios audios → ver nombres, duración y destino → «Crear canción». Por defecto, una pista por stem y el mismo inicio, conservando offsets si se importan de un formato que los aporta. No inferir alineación eliminando silencios ni por duración: dos stems de distinta longitud pueden estar correctamente sincronizados.

Mostrar claramente «Nueva canción al final del set» o «Añadir a [canción] desde su inicio». En edición avanzada también «Pista existente / posición elegida». Mantener el destino visible al cerrar la biblioteca.

Reutilizar el pipeline de importación y sus límites de memoria/progreso. Añadir controles de UX no implica decodificar todos los stems a la vez. Medir cancelación, espacio insuficiente y reanudación tras interrupciones en el flujo real de archivos, incluyendo proveedores que primero descargan el audio.

### 2. Organizar pistas

Lista enfocada a la canción, con nombre, color, grupo y salida resumida. Selección múltiple visible sin teclas modificadoras. «Reordenar» activa asas; ofrecer «Mover antes/después de…» y «Mover a carpeta…» para 30–60 pistas. Cambiar orden nunca debe cambiar el inicio temporal de clips.

Buscar pistas y plegar grupos reduce desplazamientos. Auditar la semántica actual de pistas compartidas por varias canciones: una lista filtrada por canción no debe presentar un cambio global de nombre, routing u orden como si fuera local. Etiquetar su alcance y, si hace falta, proponer una operación específica de canción.

### 3. Marcar secciones escuchando

Pantalla con forma de onda de referencia, transporte y lista de marcas. «+ Marca» accesible durante escucha; nombres rápidos Intro, Verso, Estribillo y nombre libre; tiempo editable y snap explícito. Mantener la distinción existente entre sección, cue y otros tipos.

Permitir afinar una marca sin agarrar su bandera. Conservar su tiempo absoluto y mostrar también el relativo a la canción cuando corresponda. Los cambios de tempo/métrica deben usar el mapa temporal existente.

Mover una marca no equivale a reordenar el audio. Una futura operación «Repetir estribillo» debe declarar qué ocurre con todos los stems, marcas, cues y cambios de tempo; requiere diseño propio y no debe entrar como un simple cambio visual de lista.

### 4. Mezcla y salidas

Desde la pista seleccionada, abrir controles amplios de volumen, paneo, mute/solo y salida. Ofrecer valor numérico y ajuste fino táctil, además del fader. Aprovechar CompactMixer para balance general; evitar repetir todos los controles en cada cabecera estrecha.

Pantalla «Salidas» con resumen pista/grupo → destino, selección múltiple y plantillas reutilizables. Las etiquetas Música, Click y Guía pueden ayudar a organizar la intención, pero una capa nueva de buses lógicos requiere comprobar su encaje con el routing actual.

Mostrar canales realmente disponibles y rutas guardadas que no existen en el dispositivo conectado; no sustituir silenciosamente una salida de guía por el master. Validar con altavoz, auriculares y una interfaz real. La selección de dispositivo/ruta y el routing de pistas son tareas distintas; revisar además `docs/IOS_PORT.md` para el comportamiento particular de ese backend.

### 5. Automatizaciones y clips

Para cues existentes: lista temporal legible, «Añadir acción», destino, valor, momento y resultado resumidos; por ejemplo «En 17.1, silenciar Guía». Permitir crear en el cabezal o elegir una marca como referencia de posición. Si se ofrece vínculo persistente a una marca, definirlo explícitamente: elegir su tiempo una vez y seguir futuros movimientos no son la misma operación.

Si se requieren curvas continuas, tratarlas como capacidad a auditar/diseñar aparte de los cues ya revisados. Un editor ampliado del parámetro elegido puede evitar puntos diminutos en muchas pistas simultáneas.

Para clips: seleccionar → barra con Mover, Cortar en cabezal, Duplicar, Borrar y Propiedades. Mover ofrece pista destino y posición exacta, además de drag con preview. Permitir seleccionar varios stems y conservar sus diferencias temporales. Aclarar si «reordenar clips» significa cambiar su posición libremente o concatenarlos; solo el segundo implica cerrar huecos automáticamente.

### 6. Guardar y ensayar

Guardar/reabrir y pasar a Compacta/Live conservando canción y posición. Deshacer/rehacer accesible en todas las tareas de preparación; validar operaciones compuestas como una acción comprensible. Probar exportación/importación PC↔móvil y Android↔iOS, resolución de audios y salidas no disponibles.

## Navegación a prototipar

Comparar el comportamiento actual con una variante donde un dedo navega en ambos ejes y un toque selecciona; arrastrar contenido requiere activar Mover o usar un asa. Pinza para zoom temporal, regla para cabezal, y botones «Ver canción», «Ver selección», «Volver al cabezal».

Es una hipótesis, no una decisión cerrada: añade un paso al movimiento de clips a cambio de hacer segura la navegación. Medir ambas tareas. No cambiar dinámicamente `touch-action` a mitad de contacto para habilitar las asas; deben estar listas antes del siguiente pointerdown. Evaluar inercia y frenado por separado; trasladar el pan a JS puede perder ventajas del scroll nativo.

En teléfono, inspector inferior y controles por tarea. En tablet, inspector lateral y más pistas simultáneas. Decidir por espacio disponible, incluyendo pantalla dividida y teclado; una tablet no es siempre una ventana grande. Mantener posición al abrir/cerrar paneles y considerar ratón o lápiz sin imponerles necesariamente los gestos del dedo.

## Plan y criterios de salida

| Orden | Entrega | Evidencia necesaria |
|---|---|---|
| P0 | Reproducción e instrumentación de marcas y gestos actuales | Secuencia reproducible, coordenadas/tiempos y trazas en release por plataforma |
| P1 | Posición de marca explícita, creación en cabezal, accesos de encuadre | Marca guardada en el tiempo mostrado; cancelar o entrar con segundo dedo no crea ni mueve contenido |
| P1 | Destino explícito al añadir stems y acceso a crear canción | Usuario completa primera canción sin arrastrar de biblioteca a DAW |
| P2 | Prototipo de navegación y edición táctil | Comparación con comportamiento actual antes de sustituirlo |
| P2 | Lista de pistas, mezcla/routing y editor de cues adaptados | Operaciones completas con muchas pistas y teclado abierto |
| P3 | Montaje avanzado y posible arreglo por secciones | Semántica definida para clips, cues, tempo y deshacer |

Prueba de usuario propuesta: 5–8 músicos en primera ronda formativa, incluyendo usuarios sin DAW de escritorio. No es una muestra para conclusiones estadísticas. Repetir con participantes nuevos tras corregir problemas para reducir el efecto de aprendizaje.

Tareas: importar 16 stems; preparar una canción; crear 8 marcas; corregir una; llevar pista 16 antes de la 2; añadir clip a pista y compás concretos; mover varios stems juntos; ajustar un fader a un valor solicitado; separar música/click; añadir un cue de mezcla; deshacer; guardar/reabrir; ensayar en Live.

Medir éxito sin ayuda, tiempo por tarea, intentos fallidos, ediciones accidentales, error de posición y confianza declarada. Propuesta de umbral: al menos 80% completa el recorrido básico sin ayuda, cero pérdidas de trabajo y cero modificaciones de audio al navegar en la batería de aceptación. Son objetivos, no resultados obtenidos.

Matriz técnica: Android modesto comparable al Oppo del diagnóstico, Android reciente, iPhone pequeño y tablet; vertical/horizontal; 8/24/60 pistas, distintos zooms, reproducción activa/inactiva y audio real. Empezar con volumen de datos representativo y elevarlo conforme al plan Android de memoria, sin convertir la prueba de gestos en una importación extrema.

Separar tiempo desde contacto hasta reconocimiento, reconocimiento hasta primer frame y cadencia durante el gesto. Comparar p50/p95, bloqueos y renderCounts; medir siempre en release antes de concluir que falta rendimiento. Los tests sintéticos no ejercitan arbitraje nativo del navegador, ergonomía ni latencia física.

## Estado de implementación

Fecha de esta tanda: 2026-09-07. Todo lo de esta sección está tras `isMobileApp`
(identidad nativa de plataforma, **no** ancho de ventana): redimensionar la
ventana de escritorio nunca activa nada de esto, y el escritorio no cambia.

### Entregado

| Entrega | Dónde | Qué hace |
|---|---|---|
| Recorrido «Preparar canción» | `mobile/MobilePreparation.tsx` + paneles | Pantalla completa con pestañas Audios / Pistas / Marcas / Clips / Automatizaciones, selector de canción, transporte, deshacer/rehacer y guardar |
| Importar sin colocación implícita | `mobile/MobileAudioPanel.tsx`, `library/libraryDragDrop.ts` | `handleImportLibraryFromDialog({ placeAfterImport: false })` importa a biblioteca sin preguntar por el timeline; la colocación es un paso aparte con destino visible |
| Destino explícito de stems | `mobile/MobileAudioPanel.tsx` | Elegir «inicio de la canción» o una posición numérica, y pista existente o una pista por stem |
| Marca en el cabezal | `mobile/MobileMarkersPanel.tsx` | La posición se captura al pulsar y no la mueve la reproducción posterior; editable en segundos, con snap explícito |
| Tiempo de intención en la pulsación larga | `timeline/touchContextPosition.ts`, `timeline/useTouchContextMenu.ts` | El tiempo musical se captura en el `pointerdown` y viaja con el evento; si la cámara se mueve durante los 550 ms de espera, la marca ya no nace en otro sitio |
| Herramienta Navegar / Editar | `mobile/MobileTimelineNavigation.ts`, `uiStore.mobileTimelineTool` | Por defecto **Navegar**: un dedo recorre ambos ejes, dos dedos hacen zoom, y no se edita nada por accidente. Editar devuelve los handlers de siempre |
| Encuadre y vuelta al cabezal | `mobile/mobileViewport.ts` | «Ver toda la sesión» usa el zoom de encuadre ya calculado por el panel de transporte; «Volver al cabezal» lo centra en el ancho útil de lanes |
| Organizar pistas sin arrastrar | `mobile/MobileTracksPanel.tsx` | Búsqueda, «Mover antes de…», «Mover a carpeta…», renombrar, mute/solo, volumen en dB, panorama y salida |
| Clips por selección | `mobile/MobileClipsPanel.tsx` | Selección múltiple con casillas, mover conservando las distancias entre clips, duplicar, cortar en el cabezal, recortar y borrar |
| Automatizaciones legibles | `mobile/MobileAutomationPanel.tsx` | Lista ordenada por tiempo con las acciones de cada cue; crear en el cabezal y editar en el modal existente |

Decisiones que conviene no revertir sin pensarlo:

- **El panel arranca cerrado y recuerda la última elección**
  (`mobileViewport.readPreparationOpen`). Quien abre la app para ensayar una
  sesión ya montada debe caer en la vista de siempre; «Preparar» está a un
  toque en una barra siempre visible.
- **El ancho de lanes y el zoom de encuadre llegan como props desde
  `TransportPanelContent`**, que ya los mide bien. Medirlos desde el DOM en el
  módulo móvil da el valor equivocado: `.lt-track-list` incluye la columna de
  cabeceras y el contenido del ruler se auto-dimensiona a `laneViewportWidth`.
- **La herramienta por defecto es Navegar.** Es la mitad del arreglo de
  «los gestos no reaccionan»: sin ella, cualquier arrastre sobre una lane es
  una edición potencial.

### Verificación ejecutada

`npm --prefix apps/desktop run lint` y `npm --prefix apps/desktop run test`:
122 ficheros, 1069 pruebas en verde antes de esta tanda y sin regresiones
después. Las pruebas nuevas de encuadre, preferencia de arranque y captura de
tiempo se comprobaron **mutando el código para verificar que saben fallar**
(11 fallos provocados, código restaurado).

Esto no certifica comodidad. Sigue pendiente todo lo de «Plan y criterios de
salida»: build release en Android/iOS, medición de latencia de gesto en
dispositivo, y la sesión con músicos.

### Pendiente

- **P0 sin cerrar:** reproducir el síntoma de las marcas en release. La captura
  del tiempo de intención elimina la hipótesis del viewport cambiante *por
  construcción*, pero nadie ha observado todavía el fallo original ni ha
  descartado el snap poco visible ni las transformaciones desincronizadas.
- **P2:** pantalla «Salidas» con resumen pista/grupo → destino y selección
  múltiple; reordenar pistas arrastrando dentro de la lista; plegar grupos.
- **P3:** arreglo por secciones (repetir estribillo) con semántica declarada
  para stems, marcas, cues y tempo.
- Manual en español con instrucciones móviles, hoy escrito para ratón.

## Restricciones de implementación

Usar factories/hooks/módulos con fronteras reales y reutilizar operaciones del proyecto. No añadir lógica o estado de la feature al monolito. Mantener previews y playhead fuera de renders React por frame según `docs/REDESIGN_transport_refs_to_stores.md`. Añadir pruebas de invariantes: navegación no edita; cancelación no confirma; tiempo mostrado coincide con persistido; movimiento múltiple conserva offsets. No reescribir todo el sistema de cámara como requisito previo a mejorar el flujo.

## Límites de esta investigación

Verificación ejecutada: `npm --prefix apps/desktop run test -- src/features/transport/Renderer/InputManager.touch.test.ts src/features/transport/timeline/useTouchContextMenu.test.tsx`. Pasaron 23 pruebas en 2 ficheros. Confirman los comportamientos unitarios cubiertos, incluidos algunos gestos deliberadamente limitados por el diseño actual; no certifican que el flujo resulte cómodo.

No había dispositivos Android conectados al consultar `adb devices -l`; no se ejecutó una build móvil release ni se observó interacción física en iOS. Se revisaron código, pruebas existentes y fuentes primarias. Siguen pendientes la reproducción de los síntomas, auditoría visual de tamaños reales y sesiones de usuario. El manual español actual describe mayormente operaciones de ratón; deberá acompañarse de instrucciones móviles basadas en el flujo finalmente validado.
