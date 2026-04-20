# Arquitectura inicial

## Principios

- Audio primero: el motor debe poder probarse sin UI.
- Edicion no destructiva: el audio original nunca se modifica.
- Proyecto portable: cada cancion debe viajar como carpeta.
- Remoto desacoplado: controla estado, no reproduce audio.

## Capas

### `crates/libretracks-core`

Contiene el modelo de dominio puro y sus validaciones.

### `crates/libretracks-project`

Gestiona lectura/escritura de proyecto y `song.json`.

### `crates/libretracks-audio`

Implementa transporte, mezcla basica y carga de audio.

### `crates/libretracks-remote`

Publica estado y recibe comandos remotos.

### `apps/desktop`

Interfaz de escritorio en React + Tauri. Debe consumir servicios del core sin meter reglas de negocio en componentes.

### `apps/remote`

Cliente web reducido para control desde movil/tablet.

## Decisiones ya tomadas

- Monorepo con workspaces separados para JS y Rust.
- `Song` es la unidad minima de trabajo del prototipo.
- Los buses iniciales son `main` y `monitor`.
- El proyecto usara primero WAV antes de ampliar formatos.

## Transporte musical

- El transporte no debe modelarse solo como una posicion lineal en segundos.
- Necesitamos separar la posicion real de reproduccion del comportamiento musical esperado por el usuario.
- Las canciones podran programar saltos entre secciones de tres tipos iniciales: inmediato, al terminar la seccion actual y tras cierto numero de compases.
- La cuantizacion por compases debe comportarse como Ableton Live: el salto se ejecuta en el siguiente limite global de la rejilla musical configurada, no X compases despues del clic.
- Los saltos programados deben poder cancelarse antes de ejecutarse.
- La futura barra de seguimiento y el timeline estilo DAW tendran que mostrar tanto la posicion actual como el salto pendiente cuando exista.

## Runtime desktop de audio

### Responsabilidades actuales

#### `crates/libretracks-audio`

- Mantiene el modelo logico del transporte.
- Resuelve seccion actual, saltos pendientes y su ejecucion musical.
- Calcula clips activos y ganancias efectivas por pista y grupo.
- Debe seguir siendo testeable sin UI ni runtime de escritorio.

#### `apps/desktop/src-tauri/src/audio_runtime.rs`

- Traduce un `Song` ya resuelto a reproduccion real con `rodio`.
- Mantiene el hilo dedicado de audio y su cola de comandos.
- Aplica mezcla incremental sobre sinks vivos cuando el cambio es `MixOnly`.
- Expone telemetria de runtime y una estimacion del playhead para depuracion.

#### `apps/desktop/src-tauri/src/state.rs`

- Orquesta frontend desktop, `AudioEngine` y `AudioController`.
- Clasifica el impacto de cada cambio (`MixOnly`, `TransportOnly`, `TimelineWindow`, `StructureRebuild`).
- Mantiene el `transport_clock` que alimenta snapshots y resincroniza el motor cuando hace falta.
- Decide cuando un cambio debe reiniciar el runtime y con que razon de arranque.

### Regla de frontera

- Las reglas musicales viven en `libretracks-audio`.
- Las decisiones de runtime real y telemetria viven en `audio_runtime.rs`.
- La coordinacion de estado desktop y persistencia del proyecto vive en `state.rs`.
- Si una futura funcionalidad no cabe con claridad en una sola capa, hay que tratarla como deuda de arquitectura y no resolverla con atajos en React.

## Rutas de evolucion

### `solo`

- Debe modelarse primero como regla de mezcla efectiva en `libretracks-audio`.
- `audio_runtime.rs` solo deberia recibir la nueva ganancia resuelta y aplicarla incrementalmente.

### `fades`

- Los fades de clip permanentes deben vivir en el modelo de proyecto.
- Los fades de reproduccion o rampas de seguridad deben seguir en el runtime desktop.

### `automatizacion`

- La automatizacion futura no deberia entrar primero por componentes React.
- Requerira una capa temporal clara entre transporte logico y runtime para poder muestrearse por bloques o ventanas.

### `precarga`

- La precarga debe crecer desde la cache actual por `file_path`.
- Antes de introducir readers o regiones persistentes hay que medir memoria y coste de invalidacion por proyecto.

## Deuda tecnica activa

- El runtime sigue apoyandose en `rodio` y sinks por clip, sin mixer propio por bloques.
- La estimacion de playhead del runtime sirve para medir desfase, pero no es sample-accurate.
- La cache actual reduce reaperturas, pero todavia no separa del todo metadata, waveform y material listo para reproducir.
- Las pruebas de regresion cubren flujos criticos, pero aun no existe un harness de rendimiento dedicado con proyectos grandes versionados.
