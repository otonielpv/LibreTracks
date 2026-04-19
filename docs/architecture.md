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
- Los saltos programados deben poder cancelarse antes de ejecutarse.
- La futura barra de seguimiento y el timeline estilo DAW tendran que mostrar tanto la posicion actual como el salto pendiente cuando exista.
