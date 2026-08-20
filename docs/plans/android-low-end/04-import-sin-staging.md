# 04 — Eliminar la copia de staging del `.ltset` en Android

**Depende de:** nada (independiente de 01-03; puede ir en paralelo).
**Toca:** `apps/desktop/src-tauri/src/platform/mobile_files.rs`,
`apps/desktop/src-tauri/src/commands/project.rs`,
`crates/libretracks-project/src/session_package.rs`.
**Riesgo:** medio. Cambia el camino de datos del import.
**Impacto: el más alto de todo el plan.** Ahorra 2 GB de escritura de los ~4 GB.

## Problema

En Android, `start_import_session_package_from_dialog` hace:

1. `stage_picked_file_to_temp` → **copia el `.ltset` entero** del `content://`
   a `app_cache_dir()/saf-staging/` con `std::io::copy`. Para el paquete del
   usuario: **2,02 GiB escritos en disco**.
2. `extract_session_package_off_lock` → descomprime, **otros 2,02 GiB escritos**.
3. Borra el staging.

El paso 1 existe por una razón mecánica, no de diseño: `extract_session_package`
acepta un `&Path` y abre el fichero con `std::fs::File`, y un `content://` no es
una ruta. La copia es un adaptador de tipos, no una necesidad.

Coste: la mitad de la I/O total del import, en un eMMC de gama baja, más un
`ParcelFileDescriptor` vivo durante minutos — exactamente el fd cuyo finalizer
expiró en el crash.

## Cambio pedido

### 1. Generalizar `extract_session_package` sobre `Read + Seek`

La firma actual:

```rust
pub fn extract_session_package(
    dest_dir: &Path,
    package_path: &Path,
    on_progress: impl FnMut(u32, u32),
) -> Result<ExtractedSessionPackage, ...>
```

pasa a tener una variante:

```rust
pub fn extract_session_package_from_reader<R: Read + Seek>(
    dest_dir: &Path,
    reader: R,
    on_progress: impl FnMut(u32, u32),
) -> Result<ExtractedSessionPackage, ...>
```

y la función original queda como un envoltorio fino que abre el `File` y delega.
`zip::ZipArchive` ya es genérico sobre `Read + Seek`, así que el cambio es
mecánico.

### 2. Un `Read + Seek` sobre el fd del SAF

El fichero SAF se abre con `app.fs().open(picked, options)`. Hay que comprobar
si ese handle implementa `Seek`. **Si lo implementa**, se pasa directo,
envuelto en un `BufReader` de 64 KB.

**Si no lo implementa** (posible con algunos providers), hay dos salidas, en
este orden de preferencia:

- Obtener el `ParcelFileDescriptor` y construir un `std::fs::File` desde el fd
  crudo (`FromRawFd`). Un fd de fichero regular **sí** es seekable, aunque el
  wrapper de Tauri no exponga `Seek`. Ésta es la vía buena.
- Sólo si lo anterior falla: mantener el staging **pero solo para providers no
  seekables**, detectado en tiempo de ejecución, no siempre.

### 3. Cerrar el fd de forma determinista

Sea cual sea la vía, el handle SAF debe cerrarse **explícitamente** (`drop`) en
cuanto termina la extracción, no dejarlo al finalizer de la JVM. Esto ataca
directamente el `TimeoutException` del crash.

### 4. Progreso real durante la extracción

El bucle de extracción ya recibe `on_progress(current, total)`. Comprobar que en
la ruta Android ese progreso llega al frontend: en el incidente el usuario vio
la app «pensando» varios minutos sin feedback.

## Criterios de aceptación

- [ ] `extract_session_package_from_reader` existe y **todos los tests actuales
      de `session_package.rs` siguen pasando sin cambios** (la función vieja es
      un envoltorio).
- [ ] Hay un test nuevo que extrae desde un `Cursor<Vec<u8>>` (no un fichero) y
      obtiene el mismo resultado que desde disco.
- [ ] En Android, `stage_picked_file_to_temp` **ya no se llama** en el camino
      feliz del import de `.ltset`. Verificable por inspección y por ausencia de
      ficheros en `saf-staging/` durante el import.
- [ ] **Medición obligatoria en el dispositivo real:** importar el mismo
      `WhatAGod-Reckless.ltset` y registrar bytes escritos y tiempo total
      antes/después. El resultado debe mostrar **≈2 GB menos de escritura**.
      Anota las cifras en el PR. Sin esta medición el paso no está terminado.
- [ ] El handle SAF se cierra antes de que empiece la preparación de audio
      (comprobable porque ya no aparece el `ParcelFileDescriptor.finalize()`
      timeout bajo carga).
- [ ] La barra de progreso avanza durante la extracción en el dispositivo.
- [ ] El import sigue funcionando en escritorio (Windows) sin cambios de
      comportamiento. `npm run test:native` y los tests de `libretracks-project`
      pasan.

## Notas para el implementador

- Si descubres que el handle de `tauri-plugin-fs` **sí** implementa `Seek`, el
  paso se vuelve trivial: dilo en el PR y pasa a los criterios de medición.
- No borres `stage_picked_file_to_temp`: otros flujos (import de `.ltpkg`,
  añadir audio) probablemente la usan. Revisa antes de tocarla.
- Ojo con la memoria del proyecto sobre paquetes: las entradas del zip deben
  seguir validándose (`is_safe_relative_entry`) — no relajes eso al refactorizar.
