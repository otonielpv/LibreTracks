import { beforeEach, describe, expect, it } from "vitest";

import {
  GRID_INTENSITY_DEFAULT,
  getGridIntensity,
  resetGridIntensityForTests,
  setGridIntensity,
} from "./gridIntensity";

describe("gridIntensity", () => {
  beforeEach(() => {
    window.localStorage.removeItem("lt.ui.gridIntensity");
    resetGridIntensityForTests();
  });

  it("vale 100 % por defecto", () => {
    expect(getGridIntensity()).toBe(GRID_INTENSITY_DEFAULT);
  });

  it("guarda, redondea al paso y limita al rango", () => {
    setGridIntensity(0.42);
    expect(getGridIntensity()).toBeCloseTo(0.4);
    expect(window.localStorage.getItem("lt.ui.gridIntensity")).toBe(String(getGridIntensity()));
    setGridIntensity(5);
    expect(getGridIntensity()).toBe(2);
    setGridIntensity(-1);
    expect(getGridIntensity()).toBe(0);
  });

  it("lee el valor guardado al arrancar", () => {
    window.localStorage.setItem("lt.ui.gridIntensity", "0.6");
    resetGridIntensityForTests();
    expect(getGridIntensity()).toBe(0.6);
  });
});
