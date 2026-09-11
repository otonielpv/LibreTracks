import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "CanvasTimeline.tsx"), "utf8");
const panel = readFileSync(
  resolve(here, "../TransportPanelContent.tsx"),
  "utf8",
);

/**
 * Props que el panel de transporte pasa como flechas escritas en el JSX, o que
 * cuelgan de su render: cada repintado suyo las cambia de identidad.
 */
const UNSTABLE_CALLBACKS = [
  "onNativeCameraXPreview",
  "onNativeCameraXCommit",
  "onNativeZoomPreview",
  "onNativeZoomCommit",
  "onNativeTrackHeightChange",
  "onNativeTrackRowHeightStep",
];

describe("el gesto sobrevive a un repintado", () => {
  // La razon de ser de la regla: si el efecto que crea el InputManager depende
  // de estas props, cualquier repintado del panel —una onda que termina de
  // cargarse, un medidor— lo destruye y lo vuelve a crear. Si eso pasa con el
  // dedo en la pantalla, el gesto deja de existir y el desplazamiento se para
  // en seco hasta levantarlo: el "se para a mitad".
  it("las props de camara y zoom llegan al panel como funciones nuevas en cada render", () => {
    expect(panel).toMatch(/onNativeCameraXPreview=\{\(/);
    expect(panel).toMatch(/onNativeZoomPreview=\{\(/);
  });

  it("ningun InputManager depende de ellas", () => {
    const managers = source.split("new InputManager({").slice(1);
    expect(managers).toHaveLength(2);

    for (const block of managers) {
      const deps = /\}, \[([\s\S]*?)\]\);/.exec(block)?.[1];
      expect(deps, "no se encontro el array de dependencias").toBeTruthy();
      for (const callback of UNSTABLE_CALLBACKS) {
        expect(deps).not.toContain(callback);
      }
    }
  });

  it("el gesto las lee por ref, asi que sigue llamando a la ultima version", () => {
    for (const callback of UNSTABLE_CALLBACKS) {
      expect(source).toContain(`gestureRef.current.${callback}`);
    }
  });
});
