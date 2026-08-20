# 05 — Extracción amable con el sistema de ficheros

**Depende de:** 04 (comparten el bucle de extracción).
**Toca:** `crates/libretracks-project/src/session_package.rs`.
**Riesgo:** bajo.

## Problema

El bucle de extracción hace `io::copy(&mut zip_file, &mut writer)` por entrada,
tan rápido como el disco acepte. Con 71 entradas y 2 GB en un eMMC de gama baja,
eso satura la cola de I/O del dispositivo durante minutos. El síntoma en los
logs es inequívoco: `SlowSQLite: /execute COMMIT;/ cost= 44043` — un COMMIT del
*sistema operativo* tardando 44 segundos porque nosotros teníamos el disco
ocupado.

Existe ya en el engine un `io_throttle.cpp` con esta misma idea aplicada al
streaming de audio (ver el comentario de `source_manager.cpp:1103`, sobre ceder
para no ahogar a otras pistas). La extracción no lo tiene.

## Cambio pedido

### 1. Comprobación de espacio ANTES de empezar

Antes de la primera entrada, sumar los tamaños descomprimidos del directorio
central del zip (`ZipArchive` los expone sin descomprimir nada) y compararlos
con el espacio libre del volumen de destino.

Si `necesario > libre - margen` (margen = 1 GB en móvil, 2 GB en escritorio),
fallar **inmediatamente** con un error accionable y localizado:

> «Esta sesión necesita 2,1 GB y solo quedan 0,8 GB libres. Libera espacio o
> importa la sesión en formato Ligero.»

Hoy la extracción se lanza a ciegas y muere a medias, dejando un directorio
corrupto.

### 2. Ceder I/O periódicamente en móvil

Copiar por bloques (64-256 KB) en lugar de un `io::copy` de un tirón, y cada N
MB escritos hacer un `std::thread::yield_now()` + un `sleep` corto (~1-2 ms).
Solo en `Handheld`/`Constrained` (paso 01); en escritorio, `io::copy` directo.

Sí, alarga la extracción. A cambio el sistema sigue respondiendo, que es la
diferencia entre «tarda 4 minutos» y «se reinicia el teléfono».

### 3. Limpieza en caso de fallo

Si la extracción falla a medias, borrar el directorio de destino parcial. Hoy
queda un proyecto medio extraído que el usuario puede intentar abrir.

Cuidado: solo si el directorio lo creamos nosotros en esta operación. Nunca
borrar un directorio preexistente del usuario.

### 4. Progreso por bytes, no por entradas

`on_progress(current, total)` cuenta entradas. Con 24 WAV de 76 MB y 30 sidecars
de 1,4 MB, el porcentaje da saltos absurdos. Cambiar a bytes descomprimidos
acumulados.

## Criterios de aceptación

- [ ] Con espacio insuficiente, la extracción falla **antes de escribir el
      primer byte** y el mensaje nombra el tamaño requerido y el disponible.
      Test con un destino simulado.
- [ ] El mensaje de error está localizado (es/en) siguiendo el patrón del commit
      `26283606` («localize actionable user errors»).
- [ ] Un fallo a mitad de extracción deja el destino limpio; un test lo verifica
      inyectando un error en la entrada N.
- [ ] Un directorio de destino **preexistente y no vacío** nunca se borra: test.
- [ ] El progreso se reporta por bytes: test que comprueba monotonía y que llega
      a 100 %.
- [ ] En escritorio la extracción **no** hace `sleep` (misma velocidad que hoy):
      test que mide que un zip pequeño se extrae sin retardo añadido, o
      verificación por inspección del `cfg`.
- [ ] En el Oppo, durante la extracción, el sistema sigue usable: se puede
      cambiar de app y volver sin que se cierre LibreTracks. Verificación manual.
- [ ] Tests de `libretracks-project` pasan.

## Notas para el implementador

- Los tests existentes de `session_package.rs` incluyen uno delicado
  (`extraction_does_not_block_a_concurrent_lock_holder`) y hay memoria del
  proyecto sobre dos intentos previos de test de contención que fueron *flaky* y
  tumbaron una release. **No añadas tests que midan tiempos de hilos.** Si
  necesitas verificar el throttle, hazlo contando llamadas a un hook inyectado,
  no cronometrando.
