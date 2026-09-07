import { beforeEach, describe, expect, it } from "vitest";
import {
  playheadCameraX,
  readPreparationOpen,
  writePreparationOpen,
} from "./mobileViewport";

describe("encuadre móvil de la línea de tiempo", () => {
  it("centra el cabezal en el ancho útil de lanes", () => {
    // 30 s a 20 px/s = 600 px; en un viewport de 400 px el cabezal debe quedar
    // en el centro, no pegado al borde.
    expect(playheadCameraX(30, 20, 400)).toBe(400);
  });

  it("no deja la cámara en negativo cerca del inicio", () => {
    expect(playheadCameraX(1, 20, 400)).toBe(0);
  });

  it("ignora valores no finitos en lugar de propagar NaN a la cámara", () => {
    expect(playheadCameraX(Number.NaN, 20, 400)).toBe(0);
    expect(playheadCameraX(30, Number.NaN, 400)).toBe(0);
  });
});

describe("preferencia del panel de preparación", () => {
  beforeEach(() => window.localStorage.clear());

  it("arranca cerrado para no tapar la sesión de quien sólo va a ensayar", () => {
    expect(readPreparationOpen()).toBe(false);
  });

  it("recuerda la última elección entre arranques", () => {
    writePreparationOpen(true);
    expect(readPreparationOpen()).toBe(true);
    writePreparationOpen(false);
    expect(readPreparationOpen()).toBe(false);
  });
});
