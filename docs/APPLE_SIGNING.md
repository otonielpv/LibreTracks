# Firma de las builds de Apple

Dos caminos que se confunden fácil y **no comparten certificado**:

| | macOS (DMG) | iOS (App Store) |
| --- | --- | --- |
| Dónde vive | fuera de la tienda, descarga directa | App Store / TestFlight |
| Certificado | *Developer ID Application* | *Apple Distribution* |
| Además | notarización + staple | perfil de aprovisionamiento + revisión |
| Workflow | [release.yml](../.github/workflows/release.yml) | [ios-release.yml](../.github/workflows/ios-release.yml) |

La primera mitad de este documento cubre el DMG; la sección
[App Store (iOS)](#app-store-ios) cubre la tienda. La **clave de API de App
Store Connect es la única credencial compartida** por los dos: notariza el DMG
y sube el IPA.

macOS no entra en la Mac App Store: el escritorio enlaza JUCE bajo AGPLv3, que
choca con los términos de la tienda. En iOS no hay tal problema porque JUCE no
se compila (ver [IOS_PORT.md](./IOS_PORT.md)).

## DMG: de "está dañado" a doble clic

Cómo pasar de "LibreTracks está dañado y no se puede abrir" a un DMG que
cualquiera instala con doble clic.

## Por qué hace falta

Desde macOS Catalina, una app descargada de internet que no esté **firmada con
un certificado Developer ID y notarizada por Apple** se bloquea. El mensaje no
invita a continuar: en Sequoia y posteriores ni siquiera hay un "Abrir de todos
modos" en el diálogo, hay que ir a Ajustes del Sistema. Mucha gente lo lee como
"la descarga está rota" y se va.

Firmar y notarizar son dos cosas distintas y hacen falta **las dos**:

- **Firmar** demuestra quién construyó el binario y que nadie lo ha tocado
  desde entonces.
- **Notarizar** es enviar el resultado a Apple, que lo analiza y devuelve un
  "ticket". El *staple* pega ese ticket dentro del DMG para que el Mac del
  usuario no necesite conexión a internet para comprobarlo.

Una build firmada pero sin notarizar sigue bloqueada. Por eso la CI falla
duro si están unos secretos y faltan otros (ver más abajo).

## Lo que hay que conseguir una vez

### 1. Cuenta

Apple Developer Program, 99 USD/año. La modalidad **individual** basta para
firmar y notarizar; publica tu nombre legal como desarrollador. La de
organización exige un número D-U-N-S y solo compensa si quieres que aparezca un
nombre de empresa.

### 2. Certificado *Developer ID Application*

Desde un Mac:

1. **Acceso a Llaveros** → menú *Acceso a Llaveros* → *Asistente de
   certificados* → *Solicitar un certificado a una autoridad de certificación*.
   Guarda la petición (`.certSigningRequest`) en disco.
2. [developer.apple.com/account](https://developer.apple.com/account) →
   *Certificates, IDs & Profiles* → *Certificates* → **+** → tipo
   **Developer ID Application** → sube el `.certSigningRequest` → descarga el
   `.cer` y ábrelo con doble clic para instalarlo en el llavero.
3. Exporta el par certificado + clave privada: **Acceso a Llaveros** → *Mis
   certificados* → clic derecho sobre `Developer ID Application: …` →
   *Exportar* → formato `.p12` con una contraseña fuerte.

   Tiene que salir de *Mis certificados*: es la vista que incluye la clave
   privada. Un `.p12` exportado desde *Certificados* no sirve para firmar.

Apunta el nombre EXACTO de la identidad, que es lo que va en el secreto:

```bash
security find-identity -v -p codesigning
# 1) A1B2C3… "Developer ID Application: Tu Nombre (TEAMID1234)"
```

Guarda el `.p12` y su contraseña en tu gestor de contraseñas. Perderlos
significa emitir otro certificado (hay un límite por cuenta) y, aunque las
sesiones guardadas sobreviven, cambiar de identidad rompe la continuidad de los
*security-scoped bookmarks* de [entitlements.plist](../apps/desktop/src-tauri/entitlements.plist).

#### Sin un Mac a mano (Windows o Linux)

Todo lo anterior se puede hacer con OpenSSL; el Mac solo aporta la comodidad de
Acceso a Llaveros. Vale igual para el *Apple Distribution* de iOS: es el mismo
procedimiento cambiando el tipo de certificado en el portal.

```bash
# 1. Clave privada y petición de firma (una por certificado)
openssl genrsa -out developer-id.key 2048
openssl req -new -key developer-id.key -out developer-id.certSigningRequest \
  -subj "//emailAddress=tucorreo@ejemplo.com/CN=Tu Nombre/C=ES"

# 2. Sube el .certSigningRequest en developer.apple.com y descarga el .cer

# 3. Del .cer de Apple + tu clave, sale el .p12 que quiere la CI
openssl x509 -in developer-id.cer -inform DER -out developer-id.pem -outform PEM
openssl pkcs12 -export -inkey developer-id.key -in developer-id.pem \
  -out developer-id.p12 -name "Developer ID Application"

# 4. El valor del secreto
base64 -w0 developer-id.p12 > developer-id.p12.base64
```

En Git Bash la **doble barra** de `-subj` no es una errata: sin ella, MSYS
convierte el argumento en una ruta de Windows y el `subj` sale mal.

Y el nombre exacto de `APPLE_SIGNING_IDENTITY`, que en un Mac daría
`security find-identity`, está dentro del propio `.cer`:

```bash
openssl x509 -in developer-id.cer -inform DER -noout -subject
# subject=CN = Developer ID Application: Tu Nombre (TEAMID1234), C = ES
```

El `CN` completo es el valor del secreto, tal cual, sin el `CN = ` de delante.

**Guarda la clave privada** (`.key`) junto al `.p12`: sin ella, el `.cer` que
descargas del portal no sirve para firmar nada.

### 3. Clave de API de App Store Connect (para notarizar)

Más robusta que el par Apple ID + contraseña específica: no caduca sola ni se
rompe al cambiar la contraseña de la cuenta.

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → *Usuarios y
   acceso* → *Integraciones* → *Claves de API* → genera una clave. Para
   notarizar basta el rol *Developer*, pero **genérala como *App Manager***: la
   misma clave sube los builds de iOS a TestFlight, y el rol no se puede
   cambiar después. Una clave por función también vale; entonces son dos juegos
   de secretos.
2. Descarga el `AuthKey_XXXXXXXXXX.p8`. **Solo se puede descargar una vez.**
3. Apunta el **Key ID** (el `XXXXXXXXXX` del nombre) y el **Issuer ID** (el
   UUID que aparece encima de la tabla).

## Secretos del repositorio

En *Settings → Secrets and variables → Actions*:

| Secreto | Valor |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | La contraseña del `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Tu Nombre (TEAMID1234)` |
| `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY` | El Key ID (`XXXXXXXXXX`) |
| `APPLE_API_ISSUER` | El Issuer ID (UUID) |

Mientras no exista `APPLE_CERTIFICATE`, la release sigue saliendo **sin firmar**
con un aviso en el log: los forks y este repositorio siguen compilando igual. En
cuanto `APPLE_CERTIFICATE` está puesto, los otros cinco son obligatorios y el
job falla si falta alguno — un DMG firmado a medias no lo puede abrir nadie, así
que es preferible parar la release.

## Qué hace la CI

En [.github/workflows/release.yml](../.github/workflows/release.yml), job
`build-release-assets`:

1. **Prepare macOS signing identity** — crea un llavero temporal, importa el
   certificado, comprueba que `APPLE_SIGNING_IDENTITY` coincide de verdad con lo
   importado (el fallo más habitual es un nombre mal copiado) y materializa el
   `.p8` en disco, que es la única forma en que `notarytool` lo lee.
2. **Build Tauri bundles (signed + notarized macOS)** — el bundler firma la app
   con *hardened runtime* y notariza el `.app`.
3. **Notarize and staple macOS DMG** — el DMG se ensambla después de todo eso y
   el bundler no lo *staplea*; se hace aquí, tras el guardarraíl de dylibs, para
   no gastar un envío a Apple en un bundle que ya sabemos roto.
4. **Verify macOS signature and notarization** — `codesign --verify --deep`,
   comprobación del hardened runtime, veredicto real de Gatekeeper
   (`spctl` debe decir `source=Notarized Developer ID`) y `stapler validate`.
5. **Remove temporary signing keychain** — corre siempre, también si algo falló.

## Probarlo en local antes de gastar una release

Desde un Mac con el certificado ya en el llavero:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Tu Nombre (TEAMID1234)"
export APPLE_API_ISSUER="<issuer-uuid>"
export APPLE_API_KEY="XXXXXXXXXX"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_XXXXXXXXXX.p8"

npm --prefix apps/desktop run tauri build -- --target universal-apple-darwin
```

Y las mismas comprobaciones que hace la CI, sobre el `.app` resultante:

```bash
APP=target-desktop-native/universal-apple-darwin/release/bundle/macos/LibreTracks.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=2 "$APP" | grep flags     # debe incluir runtime
spctl --assess --type exec --verbose=4 "$APP"          # Notarized Developer ID
xcrun stapler validate "$APP"
```

## Si la notarización falla

`notarytool` devuelve un identificador de envío; el detalle está en el log:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
```

Lo que se puede esperar en este proyecto concreto:

- **Un binario anidado sin firmar.** El `.app` lleva el motor, `bungee.framework`
  y cuatro dylibs de FFmpeg (`bundle.macOS.frameworks` en
  [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json)). `bungee.framework`
  tiene estructura `Versions/` con enlaces simbólicos y hay que firmarlo de
  dentro afuera; el log de notarización nombra el fichero exacto.
- **Rutas absolutas de la máquina de build en una dylib.** Eso ya lo caza antes
  el paso *Validate macOS .app bundle dylib wiring*; se arregla en
  [scripts/macos-bundle-ffmpeg.sh](../scripts/macos-bundle-ffmpeg.sh).
- **La app arranca en CI pero muere en un Mac ajeno por *library validation*.**
  Todas las dylibs se firman con la misma identidad, así que no debería pasar.
  Si pasara, la salida correcta es firmar lo que falte, y solo como último
  recurso añadir `com.apple.security.cs.disable-library-validation` a
  [entitlements.plist](../apps/desktop/src-tauri/entitlements.plist).
- **Permisos que hoy no se piden.** LibreTracks solo abre salidas de audio. El
  día que se abra una entrada harán falta `NSMicrophoneUsageDescription` y
  `com.apple.security.device.audio-input`, o macOS mata la captura sin avisar.

## Mantenimiento

- El certificado *Developer ID Application* caduca a los **5 años**. Renuévalo
  antes: las builds ya notarizadas siguen funcionando (el ticket es lo que
  vale), pero sin certificado válido no se firman nuevas.
- La clave de API no caduca; revócala y genera otra si se filtra.
- Cuando la firma esté activa, borra la nota de Gatekeeper de la página de
  descargas: está marcada como temporal en
  [GithubReleases.astro](../apps/website/src/components/GithubReleases.astro)
  (`gatekeeperTitle`) y su estilo `.platform-note` en
  [global.css](../apps/website/src/styles/global.css).

---

# App Store (iOS)

El bloqueante de licencia que tuvo parado este camino **ya no existe**: JUCE se
compila fuera del binario de iOS desde el 1 de septiembre de 2026 y el permiso
de tienda está escrito en [LICENSE-EXCEPTIONS.md](../LICENSE-EXCEPTIONS.md)
como permiso adicional del artículo 7 de la AGPL. Lo que queda es mecánico.

## Lo que hay que conseguir una vez

### 1. El App ID

[developer.apple.com/account](https://developer.apple.com/account) →
*Identifiers* → **+** → *App IDs* → *App* → Bundle ID **explícito**
`com.libretracks.ios`.

Tiene que ser **exactamente** el `identifier` de
[tauri.ios.conf.json](../apps/desktop/src-tauri/tauri.ios.conf.json), y no se
puede cambiar después de publicar. No hace falta marcar ninguna capability:
*Background Modes* (el audio en segundo plano que declara
[Info.ios.plist](../apps/desktop/src-tauri/Info.ios.plist)) no lleva
entitlement, va solo en el `Info.plist`.

### 2. Certificado *Apple Distribution*

El mismo procedimiento que el *Developer ID Application* de arriba, pero
eligiendo el tipo **Apple Distribution**. Exportar a `.p12` desde *Mis
certificados*, igual que allí — o con OpenSSL desde Windows, siguiendo
[Sin un Mac a mano](#sin-un-mac-a-mano-windows-o-linux).

No sirve el de escritorio: el de la tienda lo emite Apple con otra cadena de
confianza, y firmar el IPA con un *Developer ID* produce un rechazo en el
momento de subir.

### 3. Perfil de aprovisionamiento *App Store*

*Profiles* → **+** → *App Store Connect* → elige el App ID del paso 1 y el
certificado del paso 2 → descarga el `.mobileprovision`.

Caduca **al año** y hay que renovarlo a mano: el `verify-ios-ipa.sh` imprime la
fecha de caducidad del perfil en cada build precisamente para que no pille por
sorpresa.

### 4. La app en App Store Connect

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → *Apps* → **+**
→ plataforma iOS, el Bundle ID del paso 1, un SKU cualquiera y el idioma
principal. Sin esto, la subida se rechaza con "no app with bundle id".

## Secretos del repositorio

Los tres `APPLE_API_*` son los mismos que notarizan el DMG; los cuatro
primeros son exclusivos de iOS:

| Secreto | Valor |
| --- | --- |
| `IOS_CERTIFICATE` | `base64 -i AppleDistribution.p12 \| pbcopy` |
| `IOS_CERTIFICATE_PASSWORD` | La contraseña del `.p12` |
| `IOS_MOBILE_PROVISION` | `base64 -i LibreTracks_AppStore.mobileprovision \| pbcopy` |
| `APPLE_DEVELOPMENT_TEAM` | El Team ID (`TEAMID1234`, el mismo del paréntesis de la identidad) |
| `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY` | El Key ID (`XXXXXXXXXX`) |
| `APPLE_API_ISSUER` | El Issuer ID (UUID) |

Los nombres de los tres primeros no son arbitrarios: son los que **Tauri**
lee para firmar (importa el certificado en un llavero temporal e instala el
perfil él mismo).

Sin `IOS_CERTIFICATE` el workflow se salta con un aviso cuando lo dispara una
etiqueta —un fork no tiene por qué ver rojo— pero **falla** si lo lanzas a
mano: se lo has pedido explícitamente. Con el certificado puesto, los otros
seis son obligatorios.

## Sacar un build

*Actions* → **iOS Release (signed App Store build)** → *Run workflow*:

- **upload** marcado sube a TestFlight; desmarcado deja el IPA como artefacto
  ya validado por Apple, que es lo que quieres la primera vez.
- **build_number** vacío usa el número de ejecución. Es el `CFBundleVersion`:
  tiene que ser único y creciente dentro de una misma versión de marketing, y
  **como mucho tres números separados por puntos** (por eso el workflow lo pone
  entero en `bundle.iOS.bundleVersion` en vez de usar `--build-number`, que lo
  pegaría detrás de `1.11.1` y produciría un cuarto componente que Apple
  rechaza).

También se dispara en cada etiqueta `v*`, pero **solo construye**: para que una
etiqueta suba a TestFlight hay que poner la variable de repositorio
`IOS_UPLOAD_ON_TAG` a `true` (*Settings → Secrets and variables → Actions →
Variables*).

Antes de subir nada, el workflow pasa el IPA por
[scripts/verify-ios-ipa.sh](../scripts/verify-ios-ipa.sh) —el mismo que usa la
build sin firmar— y luego por `altool --validate-app`, que es la validación de
Apple. Un rechazo cuesta segundos en vez de un ciclo de ingesta.

## Qué se comprueba en cada IPA

`verify-ios-ipa.sh` existe para que la build que se prueba y la que se publica
sean la misma cosa. En ambos modos:

- bundle id, mínimo iOS 15, arquitectura `arm64`;
- que el motor nativo está enlazado de verdad (`coreaudio-ios` presente, el
  stub mudo `no-link` ausente, sin JUCE);
- que el banco de voz guía viaja dentro;
- que `PrivacyInfo.xcprivacy` está en la **raíz** del bundle (si no, el rechazo
  es ITMS-91053);
- que el icono compilado no es el de la plantilla de cargo-mobile2.

Y solo en `--signed`:

- que la identidad es *Apple Distribution* y la firma verifica;
- que lleva `embedded.mobileprovision`, con su equipo y caducidad;
- que **no** lleva `get-task-allow` (un perfil de desarrollo colado en un
  envío es ITMS-90046);
- que el `CFBundleVersion` tiene un formato que Apple acepta.

## Antes de mandarlo a revisión

Nada de esto lo puede hacer la CI:

1. **TestFlight primero.** Instálalo en un iPhone real desde TestFlight, no
   desde AltStore: es la única forma de ver el build firmado tal y como lo verá
   el revisor.
2. **La ficha**: capturas por tamaño de pantalla, descripción, categoría,
   clasificación por edades, URL de soporte y la de privacidad
   (`libretracks.com/privacy`, que ya existe).
3. **Decidir el iPad.** El IPA que genera Tauri declara hoy **iPhone + iPad**
   (lo imprime `verify-ios-ipa.sh` en cada build, en *Device family*). Eso
   significa que un revisor de Apple la abrirá en iPad y que las capturas de
   iPad pasan a ser obligatorias. Si no quieres mantener iPad de momento, hay
   que forzar `TARGETED_DEVICE_FAMILY = 1` en el proyecto generado, igual que
   se hace con el manifiesto de privacidad; si sí lo quieres, hay que probar
   ahí antes de enviarlo.
4. **Cuidado con lo que promete el texto.** MIDI no existe en móvil; no debe
   aparecer en la ficha ni en las capturas.
5. **Cumplimiento de exportación**: ya está resuelto en el `Info.plist`
   (`ITSAppUsesNonExemptEncryption = false`), así que App Store Connect no
   volverá a preguntarlo en cada envío.

## Si Apple rechaza la subida

El correo nombra un código `ITMS-9xxxx`. Los que más probablemente salgan aquí:

- **ITMS-91053** (API sin declarar): el correo dice la categoría exacta. Se
  añade otro bloque a `NSPrivacyAccessedAPITypes` en
  [PrivacyInfo.xcprivacy](../apps/desktop/src-tauri/PrivacyInfo.xcprivacy) con
  su motivo; hay una tabla de lo ya declarado en [IOS_PORT.md](./IOS_PORT.md).
- **ITMS-90046 / 90034** (firma o perfil equivocados): los caza
  `verify-ios-ipa.sh` antes de subir, así que si llegan es que el secreto que
  se cambió fue el del certificado o el del perfil.
- **Build number repetido**: relanza el workflow; el número de ejecución ya es
  otro.

## Mantenimiento

El *Apple Distribution* caduca a los **3 años** y el perfil de aprovisionamiento
**al año** — antes que nada de lo del DMG, y el perfil es el que más
desprevenido pilla. Cuando toque, se renueva en el portal y se actualiza el
secreto `IOS_MOBILE_PROVISION`; los builds ya publicados no se ven afectados.
