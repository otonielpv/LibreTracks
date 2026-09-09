# El audio preparado como función: lo construido y lo que falta

Etapa iniciada el 2026-09-09, tras nueve etapas de banco. **Esto ya no es
instrumentación: es código de producción.**

## Por qué ahora

El plan tenía una regla —no ajustar hilos, precarga ni caché desde este i7—
que es correcta y sigue en pie. Se estaba aplicando de más: el audio preparado
no es una política sino una **función**, y una función se diseña, no se
calibra. Nueve etapas y un solo commit que cambiara lo que oye un usuario era
señal de que la regla se había convertido en excusa.

El presupuesto de disco, que era lo único que podía matar la estrategia, lo
aceptó el mantenedor: 0,51 GiB por canción es asumible con almacenamiento
moderno.

## Lo construido

Cinco piezas, cada una con sus tests y cada una verificada rompiéndola a
propósito para comprobar que sus tests saben fallar.

| Commit | Pieza | Dónde | Tests |
| --- | --- | --- | ---: |
| `5b3b838c` | Identidad de la caché | `libretracks-project/src/prepared_render.rs` | 9 |
| `69574b05` | Almacén en disco y presupuesto | `…/prepared_render_store.rs` | 8 |
| `8ba99e6e` | Renderizador offline | `native/…/render/prepared_track_renderer.cpp` | 7 |
| `8377fc12` | Entrada FFI | `lt_engine_ffi.cpp` + `lt-audio-engine-v2` | 5 |
| `e98a6d46` | Orquestación | `…/prepared_render_job.rs` | 11 |

### Las decisiones que no eran obvias

**La clave cubre lo que el renderer hornea y nada de lo que aplica el
mezclador.** El prototipo del banco se dejaba fuera todo lo del clip, y como
`TrackRenderer` multiplica `ganancia de pista × ganancia de clip`, editar la
ganancia de un clip habría dejado sonando el audio viejo. Hay un test por cada
mitad: trece ediciones que deben invalidar y siete controles en vivo que no.

**El archivo cubre el tramo de clips de la pista, no la canción.** Un clip de
diez segundos en una canción de cinco minutos habría pagado cinco minutos de
silencio, y una sesión dispersa es el caso normal.

**Las fuentes se hacen residentes antes de renderizar.** La ruta estirada no
puede repetir un paso que se quedó corto —el estirador ya consumió su entrada—
así que esperar y reintentar no está disponible. Una pista cada vez lo acota:
el pico medido es 112 MiB.

**El renderizador comparte el `SourceManager` del motor.** Uno privado
decodificaría cada fuente por segunda vez y luego desalojaría la caché viva
para guardar la copia: pagar el doble para empeorar la reproducción.

**La clave se comprueba dos veces.** Un render tarda segundos y el usuario
puede seguir editando. Se calcula antes para decidir qué hacer y otra vez
contra el modelo actual antes de publicar; si se movió, el archivo se descarta.
Publicar primero y validar después pondría audio obsoleto delante de quien
escucha, que es el único desenlace que esta función no puede producir nunca.

**La publicación es atómica y el manifiesto va el último.** Audio sin
manifiesto es invisible y se barre; un manifiesto sin audio anunciaría un
archivo que no está.

## Lo que falta, y cómo debería hacerse

### 1. Cableado del escritorio (siguiente paso)

Se escribió un módulo síncrono para esto y **se retiró antes de commitear**,
porque el patrón correcto ya existe en el repositorio y es otro:
`WaveformGenerationQueue` (`apps/desktop/src-tauri/src/state/mod.rs`), con su
`WaveformTask::Prime { app, song_dir, song }`. Esa cola ya resuelve el problema
que aquí importa —trabajo pesado fuera del lock de sesión— y hacerlo síncrono
desde un comando lo reintroduciría.

Lo que hay que construir, entonces:

- Una tarea de preparación en esa cola (o una hermana), que reciba `song_dir` y
  el `Song` clonado, construya los specs con `PreparedRenderSpec::from_song` y
  llame a `prepare_tracks`.
- Un `TrackRenderSink` sobre `Engine::prepared_track_renderer()`. El manejador
  es `Send` y detached justo para esto: se obtiene bajo un lock brevísimo, se
  suelta el lock, y se renderiza.
- Cancelación por `AtomicBool` compartido, visible desde el hilo del botón.
- Progreso emitido como evento, siguiendo el mismo camino que el progreso de
  importación.
- La identidad del DSP (`dsp_identity`) tiene que salir de una constante que se
  suba a mano cuando cambie el estirador o cómo se le alimenta. Nada más en el
  spec lo detectaría.

### 2. La ruta de reproducción

Nada de lo anterior se oye todavía. Falta que el motor lea el archivo preparado
en vez de ejecutar Bungee para esa pista, con el interruptor por canción, y que
respete `timeline_start_frames` del manifiesto.

Es la pieza más invasiva —toca el camino caliente— y la que más se beneficia de
que la fidelidad ya esté medida: las etapas 07 y 09 dicen exactamente qué tiene
que seguir cumpliéndose (desfase 0,00 ms, ganancia a la mitad = −6,02 dB en
ambas rutas).

### 3. Interfaz

Preparar/liberar por canción, progreso, espacio ocupado y el aviso cuando el
contador de recorte se dispara.

### 4. Sin resolver

- **Política de margen para el techo de PCM16.** El warp añade 3,3 dB de pico;
  un stem por encima de unos −3,3 dBFS recortaría. El preparador ya cuenta las
  muestras recortadas y la orquestación las propaga hasta el informe, pero
  nadie decide qué hacer con ese número.
- **Publicación atómica frente a cambios en caliente de warp/tono.** La caché se
  invalida correctamente, pero no está probado que un cambio de parámetros
  durante la reproducción no llegue a sonar desde caché obsoleta.
- **Ninguna medida en PC modesto ni Android real.** Los MiB por pista-minuto se
  trasladan; los segundos no.

## Cómo verificar lo construido

```powershell
cargo test -p libretracks-project
cargo test -p lt-audio-engine-v2 --features no-link
cmake --build native/audio-engine-v2/build-tests --config Release --target lt_engine_tests -j 4
native\audio-engine-v2\build-tests\tests\Release\lt_engine_tests.exe
```

149 tests del crate de proyecto, 79 del crate del motor y 392 casos nativos.
