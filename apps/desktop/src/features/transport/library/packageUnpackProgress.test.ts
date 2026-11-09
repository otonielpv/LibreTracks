import { describe, expect, it } from "vitest";

import { nextPackageUnpackState, PACKAGE_UNPACK_IDLE } from "./packageUnpackProgress";

const active = { active: true, percent: 0 };

describe("nextPackageUnpackState", () => {
  it("shows the phase the backend is in, not always «Descomprimiendo»", () => {
    const unpacking = nextPackageUnpackState(active, { percent: 20, message: "Descomprimiendo paquete..." });
    const merging = nextPackageUnpackState(unpacking, { percent: 47, message: "Aplicando cambios al proyecto..." });
    expect(merging).toEqual({ active: true, percent: 47, message: "Aplicando cambios al proyecto..." });
  });

  it("ignores the audio preparation of a previous import", () => {
    const state = { active: true, percent: 20, message: "Descomprimiendo paquete..." };
    expect(nextPackageUnpackState(state, { percent: 64, message: "Preparando audio... 3/58 fuentes" })).toBe(state);
  });

  it("never moves back", () => {
    const state = { active: true, percent: 42, message: "Copiando audio del paquete..." };
    expect(nextPackageUnpackState(state, { percent: 30, message: "Preparando audio... 1/4 fuentes" })).toBe(state);
  });

  it("does nothing while no import is running", () => {
    expect(nextPackageUnpackState(PACKAGE_UNPACK_IDLE, { percent: 20, message: "x" })).toBe(PACKAGE_UNPACK_IDLE);
  });

  it("keeps the last message when an event carries none", () => {
    const state = { active: true, percent: 10, message: "Descomprimiendo paquete..." };
    expect(nextPackageUnpackState(state, { percent: 12, message: " " })).toEqual({
      active: true,
      percent: 12,
      message: "Descomprimiendo paquete...",
    });
  });
});
