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

Siete piezas, cada una con sus tests y cada una verificada rompiéndola a
propósito para comprobar que sus tests saben fallar.

| Commit | Pieza | Dónde | Tests |
| --- | --- | --- | ---: |
| `5b3b838c` | Identidad de la caché | `libretracks-project/src/prepared_render.rs` | 9 |
| `69574b05` | Almacén en disco y presupuesto | `…/prepared_render_store.rs` | 8 |
| `8ba99e6e` | Renderizador offline | `native/…/render/prepared_track_renderer.cpp` | 7 |
| `8377fc12` | Entrada FFI | `lt_engine_ffi.cpp` + `lt-audio-engine-v2` | 5 |
| `e98a6d46` | Orquestación | `…/prepared_render_job.rs` | 12 |
| `93453b9c` | Cola en segundo plano y comandos | `apps/desktop/…/state/prepared_queue.rs` | 6 |
| `b0b2907e` | Ruta de reproducción | `pitch_resolution.cpp` + intercambio de sesión | 4 |

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

### La cola del escritorio

Sigue la forma de `WaveformGenerationQueue`, y por el mismo motivo que esa cola
existe: el trabajo dura segundos por pista y `engine_snapshot` toma el lock de
sesión en cada sondeo de medidores. Dos cosas cambian a propósito: **un solo
trabajador**, porque la residencia de fuentes sólo está acotada para una pista
a la vez; y **los errores no se tragan**, porque esto es una acción del usuario
y no una optimización que pueda fallar en silencio.

Sólo se preparan las pistas que de verdad pasan por el estirador. Una sin warp
ni tono ya suena directa desde su fuente, así que prepararla gastaría 11 MiB por
pista-minuto para no ahorrar nada.

`PREPARED_DSP_REVISION` es la constante que hay que **subir a mano** cuando
cambie el estirador o cómo se le alimenta. Nada más en la clave lo notaría: la
sesión sería idéntica y el audio no.

### La ruta de reproducción

Resultó mucho menos invasiva de lo esperado, y conviene explicar por qué: un
archivo preparado ya contiene warp y tono, así que reproducirlo es un clip
**directo** sobre otra fuente. No hace falta un camino nuevo en el mezclador ni
tocar el bucle de render.

1. Un campo `prepared_render` en `Track`, espejado en los **tres** sitios que
   parsean pistas. Hay un test que lo comprueba porque el fallo de las regiones
   fue exactamente ese: uno de tres sitios omitía un campo y editar durante la
   reproducción reseteaba estado del motor. Aquí el precio sería una pista
   preparada warpeada dos veces a mitad de actuación.
2. Un corte en `resolve_pitch_render_decision`: pista preparada → ruta directa,
   ratio 1,0, sin tono. No es una optimización sino la única respuesta correcta.
3. El intercambio al construir la sesión, con ganancia unitaria y sin fundidos
   porque el archivo ya los lleva.

**Es aditivo:** una sesión que nunca preparó nada se comporta exactamente igual
que antes.

## Lo que falta

### 1. Interfaz

Los comandos existen (`prepare_song_tracks`, `cancel_song_preparation`,
`song_preparation_status`) pero nada los invoca todavía. Falta el botón de
preparar/liberar por canción, la barra de progreso, el espacio ocupado y el
aviso cuando el contador de recorte se dispara.

### 2. Verificación en la aplicación real

Todo lo anterior está probado por piezas, pero **la cadena entera no se ha
ejecutado en la aplicación**: preparar una canción de verdad, cerrarla, abrirla
y comprobar que suena desde el archivo. Es lo primero que hay que hacer, y el
banco de fidelidad dice exactamente qué comprobar (desfase 0,00 ms, media
ganancia = −6,02 dB en ambas rutas).

### 3. Sin resolver

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

396 casos nativos, 150 tests del crate de proyecto, 79 del crate del motor y
259 del de escritorio, más las seis suites de `npm test`.
