# Handoff: crash en macOS (FFmpeg de Homebrew) + vuelta a Catalina

> Documento de traspaso para continuar el trabajo **en el Mac**. Resume el
> diagnóstico real, qué se ha cambiado, qué falta, y los comandos exactos a
> ejecutar. Branch: `fixes-mac-catalina`.

## 1. El problema real (NO era CSS ni versión mínima)

Un usuario reportó que LibreTracks **no abre** en macOS. Dos pantallazos previos
hacían pensar en CSS roto (Safari viejo), pero el crash log de Big Sur reveló la
causa verdadera:

```
Termination Reason: DYLD, [0x1] Library missing
Library not loaded: /usr/local/opt/ffmpeg/lib/libavformat.62.dylib
  Referenced from: /Applications/LibreTracks.app/Contents/Frameworks/liblt_audio_engine_v2.dylib
  Reason: image not found
```

**El `.dylib` del engine enlaza FFmpeg por la ruta absoluta de Homebrew del Mac
donde se compiló.** Ese path solo existe en esa máquina. En cualquier otro Mac
(Catalina, Big Sur, etc.) dyld no lo encuentra y aborta al arrancar. Por eso
"falla igual en Catalina y en Big Sur": es el mismo bug de empaquetado, no la
versión de macOS.

Confirmado: el `.app` que instaló el usuario **se compiló localmente** en el Mac
del dev (con `LT_ENGINE_USE_FFMPEG=ON` y FFmpeg de Homebrew). El CI de release
compilaba macOS con `FFMPEG=OFF`, así que el binario del CI no tenía esta
dependencia — pero tampoco soportaba M4A/AAC.

## 2. Decisiones tomadas

1. **FFmpeg ON en las 3 plataformas** (Windows, Linux, macOS) para soportar
   todos los formatos de audio en todas partes.
2. En macOS, **empaquetar los dylibs de FFmpeg dentro del `.app`** y reescribir
   sus `install_name` a `@rpath`, en vez de depender de Homebrew. Origen de los
   dylibs: la instalación de Homebrew del Mac (vía `dylibbundler`/`install_name_tool`).
3. **Volver a Catalina como mínimo** (`minimumSystemVersion` 10.15), una vez
   resuelto el FFmpeg. El único límite real para Catalina entonces es el CSS, que
   ya está cubierto (ver §4).

## 3. Por qué el CSS ya está resuelto (contexto)

El WebView de Tauri usa el Safari del sistema. Catalina trae Safari 13.1, que
rechaza CSS moderno. Solución aplicada (ya en el código):

- `apps/desktop/vite.config.ts`: **Lightning CSS** como minificador con target
  `safari >= 13`. Down-levela `rgb(r g b / a)` → `rgba()`, flex `gap`,
  `aspect-ratio`, prefijos `-webkit-`. PostCSS/Tailwind corre primero.
- `apps/desktop/package.json`: `"browserslist": ["safari >= 13"]`.
- `styles.css`: `color-mix()` y `:has()` NO son down-levelables con `var()`
  runtime, así que se resolvieron a mano:
  - `color-mix()` → **overlay `::after` de color sólido + `opacity`** (tinte
    por-pista). Ver `.lt-track-header[style*=--lt-track-color]::after` y
    `.lt-compact-clip-entry.is-coloured::after`.
  - `:has()` → clase explícita `.lt-import-header--simple` en
    `ImportAudioModal.tsx`; `:has()` queda como progressive enhancement.

Verificación: `npx vite build` y comprobar que `dist/assets/index-*.css` tiene
**0** de `color-mix(`, `rgb(R G B`, `:has(`.

## 4. Estado actual del código (cambios sin commitear / WIP)

- ✅ `scripts/macos-bundle-ffmpeg.sh` — **NUEVO**. Script que, dado
  `vendor/bin/native/`, lee las deps FFmpeg del engine (`otool -L`), copia los
  `libav*.dylib` (y sus inter-dependencias) al mismo dir, y reescribe todos los
  `install_name` a `@rpath`. Verifica al final que no quedan rutas absolutas.
- ✅ `scripts/desktop-native.mjs` — invoca el script anterior en darwin cuando
  FFmpeg=ON; deployment target por defecto bajado a `10.15`.
- ✅ `.github/workflows/release.yml` — FFmpeg `ON` en las 3 plataformas;
  deployment target macOS `10.15`; llamada a `macos-bundle-ffmpeg.sh` tras copiar
  los dylibs.
- ✅ `apps/desktop/vite.config.ts` — Lightning CSS restaurado (target safari 13).
- ✅ `apps/desktop/package.json` — browserslist `safari >= 13`.
- ✅ `apps/desktop/src-tauri/tauri.conf.json` — `minimumSystemVersion` `10.15`.

## 4-bis. Hecho en el Mac (sesión 2026-06-11)

- ✅ **Bug crítico del script**: usaba `declare -A` (arrays asociativos, bash 4+),
  pero macOS y los runners de GitHub traen bash 3.2 → fallaba con
  `declare: -A: invalid option`. Reescrito a tracking por string ` token `
  compatible con 3.2. (Habría fallado igual en CI.)
- ✅ **Cierre transitivo completo, no solo `libav*`**: el FFmpeg "full" de
  Homebrew arrastra códecs de terceros (x264, x265, libvpx, svt-av1, lame, opus,
  dav1d, openssl). dyld los carga al cargar libavcodec, así que dejar SUS rutas
  absolutas de Homebrew seguía rompiendo el arranque. El script ahora reubica
  toda dependencia no-sistema (lo que NO está en `/usr/lib` ni `/System`), estilo
  `dylibbundler`. Resultado: 13 dylibs vendored + engine, todos `@rpath`, sin
  ninguna ruta absoluta restante (verificado).
- ✅ §5.1 resuelto: `bundle.macOS.frameworks` en `tauri.conf.json` lista los 15
  artefactos (engine + bungee.framework + 13 dylibs). El script imprime al final
  la lista lista-para-pegar, para reconciliar drift cuando brew suba versiones.
- ✅ §5.4 (CI): el paso "Validate macOS .app bundle dylib wiring" de `release.yml`
  ahora además (a) falla si cualquier dylib bundled conserva una ruta absoluta
  no-sistema, (b) exige que cada dep `@rpath/libav*` del engine esté en
  Frameworks/, y (c) **exige que todo dylib bundled sea universal** (atrapa el
  problema de §5.2 en CI en vez de en un crash de usuario).
- ✅ §5.4 (docs): `system-requirements.md` (EN+ES) actualizado a mínimo macOS
  10.15 Catalina + sección de formatos soportados en los 3 SO.

### ⚠️ DECISIÓN ABIERTA — §5.2 (build universal). El bug es de arquitectura, no de runtime:
el CI compila el engine universal (`x86_64;arm64`) y bundlea
`--target universal-apple-darwin`, pero el FFmpeg de Homebrew es **single-arch**
(la arch del runner). En un runner arm64 (macos-latest) el slice x86_64 del
engine **ni siquiera enlaza** contra un FFmpeg arm64 → el build de release
**falla**. Hay que elegir estrategia (ver opciones abajo) antes de poder cortar
release universal. El check de arch añadido en CI lo hará explícito.

## 5. LO QUE FALTA (hacer en el Mac)

### 5.1. ✅ RESUELTO — Nombres exactos de los dylibs de FFmpeg → añadidos al bundle

Tauri solo copia a `Contents/Frameworks/` lo que esté en
`bundle.macOS.frameworks`. Los `libav*.dylib` hay que listarlos ahí (el glob de
`resources` no sirve: van a Resources/, no a Frameworks/, y el `@rpath` apunta a
Frameworks/).

**Correr en el Mac** (tras un build local de Mac que deje el engine en
`vendor/bin/native/`):

```bash
otool -L vendor/bin/native/liblt_audio_engine_v2.dylib | grep -iE 'libav|libsw|libpostproc'
```

Con esa lista, añadir cada dylib a `bundle.macOS.frameworks` en
`apps/desktop/src-tauri/tauri.conf.json`, p. ej.:

```json
"frameworks": [
  "../../../vendor/bin/native/liblt_audio_engine_v2.dylib",
  "../../../vendor/bin/native/bungee.framework",
  "../../../vendor/bin/native/libavformat.62.dylib",
  "../../../vendor/bin/native/libavcodec.62.dylib",
  "../../../vendor/bin/native/libavutil.60.dylib",
  "../../../vendor/bin/native/libswresample.6.dylib"
]
```

(ajustar nombres/versiones a lo que devuelva `otool`).

### 5.2. ✅ DECIDIDO — FFmpeg universal vía `lipo` (un solo DMG universal)

Decisión: mantener un único `.app` universal y hacer FFmpeg universal en CI con
`lipo`, en vez de releases por-arch. El problema no era solo de runtime: como el
engine se compila universal, el slice de la "otra" arch **ni siquiera enlaza**
contra un FFmpeg single-arch, así que el build de release fallaba.

Implementado en `release.yml` (sin probar en CI todavía — esta máquina es Intel y
no puede generar el slice arm64; la primera corrida de release es la prueba real):

- **`scripts/macos-universal-ffmpeg.sh`** (NUEVO): dados dos prefijos de Homebrew
  (nativo + el de la otra arch), recorre el cierre de FFmpeg desde los `libav*`
  y hace `lipo -create` in-place de cada dylib con su counterpart, dejando el
  prefijo nativo universal. Idempotente (salta los que ya son fat).
- **Paso "Prepare universal FFmpeg (macOS arm64 runner)"** (solo `macos-latest`):
  instala Rosetta + un Homebrew x86_64 en `/usr/local`, `brew install ffmpeg` en
  ambos prefijos (misma versión → sonames alineados) y corre el merge.
- **Arch por runner**: `macos-latest` (arm64) compila/bundlea universal;
  `macos-13` (Intel, validación) compila/bundlea **x86_64** (un host Intel no
  puede producir el slice arm64). Engine `CMAKE_OSX_ARCHITECTURES` y el
  `--target` de tauri se eligen según `matrix.os`.
- **Guard de arch** en la validación: cada dylib bundled debe cubrir TODAS las
  arches del engine (no se asume universal; se compara contra el propio engine).

Verificar arch de un dylib: `lipo -info vendor/bin/native/libavformat.*.dylib`.

⚠️ Riesgos a vigilar en la primera corrida de CI: que ambos `brew install ffmpeg`
resuelvan a la **misma versión** (si no, los sonames difieren y el merge aborta
limpio con "no counterpart"); y el tiempo del install x86_64 bajo Rosetta.

### 5.3. FFmpeg en Linux (bundling .so)

`desktop-native.mjs` línea ~65 pone FFmpeg=0 en Linux para el build local. El CI
ya lo pondrá en ON. Falta: copiar los `.so` de FFmpeg junto al engine y que el
rpath `$ORIGIN` los resuelva (el engine ya tiene `INSTALL_RPATH $ORIGIN`). Ver
`native/audio-engine-v2/CMakeLists.txt` líneas 43-44 y `cmake/dependencies.cmake`
líneas 145-168.

### 5.4. Validación en CI + docs

- Añadir al paso "Validate macOS .app bundle dylib wiring" de `release.yml` un
  check de que `otool -L` del engine **dentro del .app** no tiene rutas
  absolutas de FFmpeg, y que los `libav*.dylib` están en `Contents/Frameworks/`.
- Actualizar `apps/website/src/content/docs/.../system-requirements.md` (EN+ES):
  mínimo macOS 10.15 Catalina, formatos soportados en los 3 SO.

## 6. Cómo probar el fix en el Mac (flujo recomendado)

```bash
# 1. Build local del engine + app (FFmpeg ON por defecto en Mac)
npm run desktop:native:build      # o el script equivalente; ver package.json raíz

# 2. Confirmar que el engine vendored ya NO apunta a Homebrew:
otool -L vendor/bin/native/liblt_audio_engine_v2.dylib | grep -iE 'ffmpeg|libav'
#    -> deben verse @rpath/libav*.dylib, NO /usr/local/opt/ffmpeg/...

# 3. Tras el bundle, inspeccionar el .app:
APP=$(find target-desktop-native -name 'LibreTracks.app' -path '*bundle*' | head -1)
otool -L "$APP/Contents/Frameworks/liblt_audio_engine_v2.dylib" | grep -iE 'libav'
ls "$APP/Contents/Frameworks/" | grep -iE 'libav'   # deben estar copiados

# 4. Probar arranque en un Mac SIN ffmpeg de Homebrew (o renombrando brew):
open "$APP"
```

El éxito = la app abre y no aparece el diálogo "no puede abrirse / reporte a
Apple". Pega aquí la salida de los `otool -L` para verificar juntos.

## 7. Notas / gotchas

- El shim de High Sierra (`NSHTTPCookieSameSite*`) fue **eliminado** en un commit
  anterior; no hace falta para 10.15 (esos símbolos existen desde Catalina). No
  reintroducir salvo que se baje el mínimo a 10.13.
- `bungee.framework` ya se bundlea bien (no tiene este problema; usa
  `@loader_path`/`@rpath`).
- Memoria relacionada del proyecto: ver `project-catalina-css-compat`,
  `project-fonts-self-hosted`, `project-flac-decoding`,
  `project-audio-loading-roadmap`.
