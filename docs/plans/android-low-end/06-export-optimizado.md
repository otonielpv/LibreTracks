# 06 — Modo de exportación «Optimizado»: audio ya preparado

**Depende de:** 04, 05 (comparte el camino de paquete). Conceptualmente
independiente de 01-03.
**Toca:** `crates/libretracks-project/src/session_package.rs`,
`crates/libretracks-project/src/song_store.rs` (para `.ltpkg`),
`apps/desktop/src-tauri/src/commands/project.rs`, UI de export,
`native/audio-engine-v2/src/sources/source_manager.cpp` (exponer rutas de caché).
**Riesgo:** medio. Formato de paquete nuevo → compatibilidad hacia atrás.

## Idea

Hoy hay dos modos de export:

- **Ligero**: solo la sesión + sidecars; el audio se referencia por ruta.
- **Completo**: empaqueta el audio **original** tal cual (MP3 sigue MP3, FLAC
  sigue FLAC, WAV sigue WAV).

Con Completo, el dispositivo de destino tiene que **decodificar y remuestrear
todo** al abrir. En el Oppo eso es la fase «Preparando audio» que precedió al
apagado: 36 fuentes decodificándose y escribiéndose como PCM.

**Optimizado** empaqueta en su lugar el **PCM ya preparado** — el mismo
contenido que el motor escribiría en su caché — con los nombres de fichero
correspondientes. El destino abre y reproduce: sin decodificar, sin remuestrear,
sin escribir caché.

Es el modelo que ya usa el propio motor internamente (decodificar una vez,
cachear como PCM, estilo Ableton); esto lo extiende a la frontera del paquete.

## Decisiones de diseño (ya tomadas — no re-litigar)

### El formato es WAV PCM 16-bit

La caché del motor ya lo es (`cache_sample_format()` →
`SF_FORMAT_PCM_16`, con el comentario que explica el porqué: la mitad de tamaño
y de I/O que float32, y int16 sobra para reproducción). El paquete usa lo mismo.

Consecuencia de tamaño, con el set del usuario como referencia:

| Modo | Contenido | Tamaño aprox. |
| --- | --- | --- |
| Completo | 24 WAV originales + 12 MP3 | **2,0 GB** |
| Optimizado | 36 fuentes en PCM 16-bit @44,1k | **~2,7 GB** |

**Optimizado es más grande, no más pequeño.** Cambia I/O y CPU en el destino por
tamaño de transferencia. Eso hay que decírselo al usuario en la UI (ver abajo) y
es la razón de que Optimizado **no** sea el modo por defecto.

### La frecuencia de muestreo va sellada en el manifiesto

El PCM está horneado a una SR concreta. Si el destino abre a otra, todo el
ahorro se pierde (y peor: se convierte igualmente). El manifiesto del paquete
debe declarar `"prepared_sample_rate": 44100` y `"prepared_format": "pcm_s16"`.

Al abrir un paquete Optimizado, la app **se alinea a esa SR** antes de registrar
fuentes, reutilizando `align_engine_sample_rate_to_session()`
(`state/audio_prep.rs`), que ya existe justo para esto. Si el dispositivo no
admite esa SR, se avisa y se degrada al camino normal.

### Se exporta desde los ficheros de caché, no re-decodificando

Si el motor ya tiene la fuente cacheada, el export **copia** ese fichero. Si no
la tiene (fuente nunca reproducida), la prepara primero. El export debe
disparar la preparación de las fuentes que falten y esperar, con progreso.

### Nombres

Los ficheros del paquete llevan el nombre lógico de la fuente
(`audio/Keys 3.wav`), no el hash interno de la caché. El mapeo clip→fichero
sigue las mismas reglas que Completo (`allocate_audio_relative_path`,
`plan_audio_sources`) — incluido el trato de basenames repetidos, que ya tiene
tests (`full_export_separates_distinct_sources_that_share_a_basename`).

## Cambio pedido

### 1. Modelo

Sustituir el booleano `include_audio` por un enum de tres estados:

```rust
pub enum SessionPackageAudio {
    Referenced,  // Ligero
    Original,    // Completo
    Prepared { sample_rate: u32 }, // Optimizado
}
```

Mantener la API vieja como envoltorio deprecado si hay llamantes fuera.

### 2. Manifiesto y compatibilidad

Un paquete Optimizado abierto por una versión **antigua** de LibreTracks debe
funcionar igual que un Completo (son WAV normales en `audio/`). Los campos
nuevos del manifiesto son aditivos y opcionales. **Ningún paquete existente
puede dejar de abrirse.**

### 3. UI de exportación

Tercera opción, con el compromiso explícito:

> **Optimizado** — Audio ya preparado. Se abre al instante en móviles y equipos
> lentos, sin esperar a «Preparando audio». El archivo ocupa más
> (aprox. 2,7 GB frente a 2,0 GB).

Localizado es/en.

### 4. Aplicar también a `.ltpkg`

El mismo modo para el export de una canción suelta (`song_store.rs`), que es el
caso más frecuente de compartir.

## Criterios de aceptación

- [ ] `SessionPackageAudio` existe; Ligero y Completo se comportan
      **exactamente como hoy** (todos los tests actuales pasan sin tocarlos).
- [ ] Round trip: exportar Optimizado → importar → cada clip resuelve a un
      fichero PCM presente en el paquete, y el audio es equivalente al original
      (test que compara muestras con tolerancia de cuantización a 16-bit).
- [ ] El manifiesto declara `prepared_sample_rate` y `prepared_format`; un test
      lo verifica.
- [ ] Al abrir un paquete Optimizado, el motor se alinea a `prepared_sample_rate`
      **antes** de registrar fuentes, y el snapshot muestra
      **cero bytes escritos en la caché de disco** (`disk_bytes_used` no crece).
      Éste es el criterio que demuestra que el modo cumple su promesa.
- [ ] Si el dispositivo no admite esa SR, se avisa al usuario y la importación
      **termina correctamente** por el camino normal (degradación, no fallo).
- [ ] Compatibilidad hacia atrás: un `.ltset` Completo y uno Ligero exportados
      con la versión anterior siguen importándose. Test con fixtures fijos.
- [ ] Un paquete Optimizado importado por código que ignore los campos nuevos
      sigue siendo válido (los WAV están en `audio/`).
- [ ] Fuentes no cacheadas al exportar: se preparan, con progreso visible, y el
      paquete sale completo. Test.
- [ ] El caso de nombres duplicados se comporta como en Completo (reutilizar el
      test existente adaptado).
- [ ] **Medición en el Oppo:** importar el mismo set exportado como Optimizado y
      registrar el tiempo desde «abrir» hasta «listo para reproducir», frente al
      Completo. Anotar ambas cifras en el PR.
- [ ] Documentado en `docs/USER_MANUAL.es.md` y `docs/USER_MANUAL.md`.

## Notas para el implementador

- **Lee la memoria del proyecto sobre paquetes antes de empezar.** Hay al menos
  tres bugs ya pagados en esta zona: assets de biblioteca sin clip que no se
  empaquetaban, el fix de clip→track por id (no por nombre), y los zips con `\`
  que rompían macOS (los nombres de entrada van planos y con `/`).
- El formato RF64 existe para fuentes de más de ~3,9 GB. Un paquete Optimizado
  puede toparse con eso; asegúrate de que `cache_container_format` se respeta.
- Ojo con las fuentes que el motor cachea con transposición o warp aplicados:
  el paquete debe llevar el PCM **sin** procesar (el original preparado), no una
  variante con pitch. Verifica cuál es cuál antes de copiar ficheros.
