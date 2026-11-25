import { beforeEach, describe, expect, it } from "vitest";

import { resetThemeForTests, selectedAccentHex, setTheme } from "../../../shared/theme";
import { rhythmDisplayColor } from "./padColor";

describe("color de pads y sonidos", () => {
  beforeEach(() => {
    window.localStorage.removeItem("lt.ui.theme");
    resetThemeForTests();
  });

  it("el color por defecto de lo nuevo es el acento elegido en Temas", () => {
    expect(selectedAccentHex()).toBe("#57f1db");
    setTheme({ accent: "orange" });
    expect(selectedAccentHex()).toBe("#ffa440");
    // Aunque la base sea clara, se guarda el acento tal cual, no el oscurecido.
    setTheme({ base: "light" });
    expect(selectedAccentHex()).toBe("#ffa440");
  });

  it("el turquesa antiguo por defecto se pinta con el acento; el resto se respeta", () => {
    expect(rhythmDisplayColor("#57F1DB")).toBe("var(--lt-accent)");
    expect(rhythmDisplayColor("#ff0000")).toBe("#ff0000");
    expect(rhythmDisplayColor("")).toBeUndefined();
  });
});
