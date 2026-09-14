# Pendiente: huecos de i18n en la interfaz en inglés

Lista de cadenas que **siguen en español con la app puesta en inglés**. Ninguna
es un fallo del idioma en sí: son textos que nunca pasaron por `t()`, o claves
que faltan en `en.ts` y caen al `defaultValue` español.

Salieron todas a la vez al generar las capturas en inglés del README con
`tests/e2e/specs/readme-shots.e2e.ts` (2026-09-14): la tanda en inglés las
fotografía, así que **las imágenes publicadas del README y de la web las están
enseñando ahora mismo**. Al arreglarlas hay que volver a disparar el arnés
—receta en `docs/RELEASE_PROCESS.md`, sección *Screenshots*— porque las fotos
salen del binario compilado, no del código fuente.

## Escritorio

1. **`Compas` a pelo en la barra superior.**
   `apps/desktop/src/features/transport/timeline/TimelineTopbar.tsx:496` y
   `:736` renderizan `<span>Compas</span>` sin traducir, y el input de al lado
   lleva `aria-label="Compas de la cancion"` fijo en español. Sale en TODAS las
   capturas de escritorio, en las dos vistas y en el panel Live.

2. **Botón `NUBE` en la pantalla de inicio.**
   `apps/desktop/src/features/transport/cloud/CloudLandingButton.tsx:26` pide
   `t("transport.cloud.landingAction", { defaultValue: "Nube" })`, pero la
   clave no existe en `apps/desktop/src/shared/i18n/en.ts`, así que en inglés
   se ve el `defaultValue`. Conviene revisar de paso el resto de claves de
   `transport.cloud.*`: si falta una, faltan más.

3. **Vista compacta: `+ NUEVA CANCIÓN` e `IMPORTAR .LTPKG`.**
   Las dos tarjetas punteadas de la derecha, junto a las columnas de canción.

4. **Carril de automatización: `→ 1 acciones`.**
   La etiqueta de la marca de automatización en el timeline. Además de
   traducirla, es plural fijo: con una sola acción debería decir "1 action".

## Remote

5. **Nombres de pestaña por defecto fijos en español.**
   `apps/remote/src/remoteLayout.ts:260` y `:277` crean el layout por defecto
   con `name: "Controles"` y `name: "Herramientas"`. Como el nombre se guarda
   dentro del layout del usuario, un `t()` en el render no basta: hay que
   decidir si el nombre por defecto se resuelve al pintar (y entonces no se
   persiste literal) o si se traduce al crear el layout. Ojo con los layouts ya
   guardados en `localStorage`, que llevan el literal español dentro.

## Cómo verificarlo

El arnés de capturas es el camino más corto para ver el estado real: deja las
siete vistas en los dos idiomas de una sola pasada, y las de inglés son
exactamente donde asoman estos textos.

```bash
LT_README_SHOTS=1 LT_SHOTS_SESSION="/ruta/a/una/COPIA/song.ltsession" \
  npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/readme-shots.e2e.ts
```
