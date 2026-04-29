# Manual de Usuario de LibreTracks

LibreTracks está pensado para directores musicales, playback engineers y músicos que necesitan un entorno multitrack fiable para el directo. La app mantiene la edición no destructiva y separa el motor de audio de la UI en React, para que organizar, guardar y lanzar una canción no dependa de modificar el audio original.

> ⚠️ Consejo de directo: prepara el show con antelación, guarda la sesión y ensaya los saltos con el mismo dispositivo de salida que usarás en escenario.

## 1. Introducción

LibreTracks te permite importar WAV, organizarlos en un timeline y disparar saltos musicales entre secciones durante la reproducción.

Por qué es seguro para directo:

- La edición es no destructiva. Los WAV originales no se reescriben al mover o cortar clips.
- El runtime desktop mantiene el motor de audio desacoplado de la capa de UI.
- Comportamientos como `Inmediato`, `En la siguiente marca` y `Tras X compases` se resuelven en la lógica Rust del transporte, no con temporización improvisada en la interfaz.

## 2. Configuración de Audio

### Abre `Configuracion`

1. Abre `Configuracion` desde la shell principal.
2. En el panel de audio, elige el `Dispositivo de audio` correcto.
3. Verifica la salida antes del ensayo y antes del show.

Si dejas `Dispositivo de audio` en `Predeterminado del sistema`, LibreTracks seguirá la salida por defecto del sistema operativo. En directo, normalmente es más seguro usar una interfaz dedicada.

### Usa `Modo Split Stereo (Monitor Izq. / Main Der.)`

Esta es la función clave para playback en vivo.

Cuando activas `Modo Split Stereo (Monitor Izq. / Main Der.)`:

- Todo lo que esté en el bus `Monitor` se fuerza al canal izquierdo.
- Todo lo que esté en el bus `Main` se fuerza al canal derecho.
- El paneo normal se mantiene cuando el modo está apagado.

Uso típico en escenario:

- Coloca click, count-ins, cues habladas o guías en `Monitor`.
- Coloca stems, secuencias o reproducción musical en `Main`.
- Envía el canal izquierdo al sistema de referencia del MD o del baterista y el derecho a FOH o al rack de playback.

> 🎛️ Resultado práctico: un único par estéreo se convierte en una salida split simple, con las guías a la izquierda y el material del show a la derecha.

### Usa el `Metronomo` integrado

Activa `Metronomo` desde `Configuracion` cuando necesites una claqueta fiable sin importar un archivo de audio aparte. LibreTracks envia el click al bus `Monitor` y lo mantiene bloqueado al timeline del transporte. Ajusta `Volumen del metronomo` antes del ensayo para colocarlo bien en la mezcla de cue.

### Conecta hardware MIDI

En `Configuracion`, elige un `Dispositivo de entrada MIDI`, por ejemplo una pedalera, un controlador de pads o un teclado. Usa `Refrescar dispositivos MIDI` si conectaste el controlador despues de abrir LibreTracks.

Abre `Aprendizaje MIDI` para asignar notas o mensajes CC del hardware a controles en vivo. Son mapeos utiles `Reproducir`, `Detener`, `Vamp`, modos de salto de marca, disparadores de salto de cancion, modo de transicion de cancion y controles de numero de compases.

## 3. Organización del Proyecto

### `Biblioteca`

Usa `Biblioteca` como el área de preparación de assets del show.

1. Abre `Biblioteca`.
2. Pulsa `Importar audio`.
3. Selecciona uno o varios archivos WAV.
4. Arrastra esos assets al timeline cuando quieras empezar a organizar.

`Crear carpeta virtual` te permite agrupar assets por set, escena, sección o instrumentación sin mover los archivos fuente originales. Un enfoque práctico es usar una carpeta virtual por canción o por bloque del show.

### Importar canciones y paquetes

Usa `Importar cancion` cuando quieras traer otra cancion o paquete de sesion de LibreTracks a la sesion actual. Tambien puedes arrastrar un paquete externo de LibreTracks al timeline. Es util para construir un show a partir de canciones preparadas sin rehacer pistas y marcas a mano.

### `Audio track` vs `Folder track`

- `Audio track` es la pista donde viven y suenan los clips.
- `Folder track` sirve para organizar y controlar de forma conjunta las pistas hijas.

Usa `Folder track` cuando quieras agrupar stems, por ejemplo batería, tracks de banda, coros o playback auxiliar. Usa `Audio track` cuando necesites una lane que realmente contenga clips.

## 4. Edición Básica (Timeline)

LibreTracks mantiene el timeline directo y orientado a directo.

### Añadir y mover clips

- Arrastra assets desde `Biblioteca` al timeline.
- En un arreglo vacío, soltar desde `Biblioteca` crea automáticamente la primera `Audio track`.
- Mueve un clip arrastrándolo a una nueva posición del timeline.

### Duplicar clips

- Haz clic derecho sobre el clip.
- Elige `Duplicar`.

Esto va bien para loops, repeticiones y partes de apoyo que vuelven más adelante en la canción.

### Cortar clips

1. Lleva el cursor o playhead al punto de corte.
2. Haz clic derecho sobre el clip.
3. Elige `Cortar en cursor`.

Es la forma más rápida de ajustar la estructura sin tocar el WAV original.

### Usa `Snap to Grid`

Mantén `Snap to Grid` activado cuando quieras que clips, cursor y ediciones caigan sobre divisiones musicales. Desactívalo solo cuando necesites colocar algo libremente fuera de la rejilla.

## 5. Control en Vivo: Navegación y Saltos

### `Marcas`

Crea secciones desde el ruler:

1. Haz clic derecho sobre el ruler.
2. Elige `Crear Marca`.
3. Renombra la marca si lo necesitas.

LibreTracks puede mostrar marcas con prefijo numérico, por ejemplo `1. Intro`. En la build desktop actual, los atajos `0-9` se resuelven por orden de marca en el timeline: `0` apunta a la primera marca, `1` a la segunda, y así sucesivamente. El modelo de datos ya soporta un `digit` por marca, pero la UI actual todavía no expone un control dedicado para asignarlo manualmente.

### Modos de `Salto`

Configura el comportamiento global desde `Salto`:

- `Inmediato`: salta al instante.
- `En la siguiente marca`: espera al siguiente límite de sección y salta allí.
- `Tras X compases`: cuantiza el salto para que ocurra tras el número de compases configurado.

Esto te permite reaccionar en tiempo real si la banda alarga un estribillo, se salta un puente o necesita repetir una sección.

### `Vamp`

Usa `Vamp` para mantener la reproduccion en un bucle musical cuando la banda o la accion de escenario necesita mas tiempo. `Modo Vamp` puede repetir la `Seccion` actual o un numero fijo de `Compases`. Pulsa `Vamp` de nuevo para salir del bucle.

### Saltos de cancion y transiciones

Usa los controles de `Salto de Cancion` cuando la sesion contiene varias regiones de cancion y necesitas moverte a otra zona durante la reproduccion. El disparador puede ser inmediato, tras un numero configurado de compases o al final de la cancion/region.

`Transicion de Cancion` controla como pasa la cancion actual a la siguiente:

- `Clean cut`: cambia directamente.
- `Fade out`: desvanece la reproduccion actual antes del salto.

### Atajos

- `Espacio`: alterna `Reproducir` / `Pausar`
- `Esc`: cancela un salto pendiente
- `0-9`: arma un salto hacia la marca correspondiente

Si armas la sección equivocada, pulsa `Esc` inmediatamente. Si no existe una marca para ese hueco, LibreTracks avisará de que no hay una marca disponible para ese dígito.

## 6. Control Remote Movil

LibreTracks desktop puede publicar una superficie web remota para controlar transporte y mixer.

### Conectar movil o tablet

1. Abre `Remote` desde la navegacion lateral en la app desktop.
2. En `Conectar remote movil`, escanea el codigo QR o abre una de las URLs mostradas:
	- `URL por IP`
	- `URL por hostname (.local)`
3. Verifica que desktop y movil esten en la misma red local.

![Panel de conexion remote](../screenshots/Remote.png)

### Uso remoto en ensayo/show

- Usa controles de transporte (`Reproducir`, `Pausar`, `Detener`) desde el movil.
- Arma y cancela saltos desde remote cuando necesites adaptar secciones en vivo.
- Activa `Vamp`, ajusta saltos de marca/cancion y selecciona el modo de transicion de cancion desde el remote.
- Cambia a `Mixer` para ajustar volumen, paneo, mute y solo por pista sin tocar el desktop.

![Vista de mixer remote](../screenshots/Remote_Mixer.png)

> Sugerencia de flujo en directo: deja al operador desktop centrado en timeline/arreglo y asigna a una segunda persona los ajustes de mezcla/cues desde el remote.
