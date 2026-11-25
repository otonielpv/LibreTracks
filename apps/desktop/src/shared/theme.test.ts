import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  THEME_ACCENTS,
  accentHex,
  accentRgba,
  buildThemePalette,
  flushThemeForTests,
  getTheme,
  remapThemeRgb,
  resetThemeForTests,
  setTheme,
  themedRgba,
} from "./theme";
import { THEMED_CSS_COLORS } from "./themeColors.generated";

const luma = ([r, g, b]: readonly number[]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.removeItem("lt.ui.theme");
    document.documentElement.removeAttribute("style");
    resetThemeForTests();
  });

  it("el tema por defecto deja todos los colores como estaban", () => {
    expect(getTheme()).toEqual(DEFAULT_THEME);
    expect(accentHex()).toBe("#57f1db");
    expect(accentRgba(0.5)).toBe("rgba(87, 241, 219, 0.5)");
    for (const hex of THEMED_CSS_COLORS) {
      const rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      expect(remapThemeRgb(rgb as [number, number, number], DEFAULT_THEME)).toEqual(rgb);
    }
  });

  it("el tema claro invierte fondos y texto", () => {
    const light = { ...DEFAULT_THEME, base: "light" as const };
    const background = remapThemeRgb([14, 14, 14], light);
    const text = remapThemeRgb([229, 226, 225], light);
    expect(luma(background)).toBeGreaterThan(0.85);
    expect(luma(text)).toBeLessThan(0.3);
  });

  it("en tema claro un pastel pensado para fondo negro pasa a oscuro", () => {
    const light = { ...DEFAULT_THEME, base: "light" as const };
    expect(luma(remapThemeRgb([255, 226, 171], light))).toBeLessThan(0.45);
    // En oscuro los colores no se tocan.
    expect(remapThemeRgb([255, 226, 171], { ...DEFAULT_THEME, base: "midDark" })).toEqual([
      255, 226, 171,
    ]);
  });

  it("en tema claro el acento se oscurece para leerse sobre blanco", () => {
    const palette = buildThemePalette({ ...DEFAULT_THEME, base: "light" });
    expect(palette.light).toBe(true);
    expect(luma(palette.accent)).toBeLessThanOrEqual(0.49);
    // Y no se apaga a marrón: el naranja sigue siendo un naranja saturado.
    const orange = buildThemePalette({ ...DEFAULT_THEME, base: "light", accent: "orange" }).accent;
    expect(orange[0] - orange[2]).toBeGreaterThan(150);
  });

  it("las variantes del turquesa del diseño siguen al acento elegido", () => {
    const hue = (rgb: readonly number[]) => {
      const [r, g, b] = rgb.map((v) => v / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    // #7fe0d8: el turquesa claro de los chips de BPM y nota en Live.
    const variant = [127, 224, 216] as const;
    expect(remapThemeRgb(variant, DEFAULT_THEME)).toEqual(variant);
    for (const base of ["dark", "light"] as const) {
      const orange = remapThemeRgb(variant, { ...DEFAULT_THEME, base, accent: "orange" });
      expect(hue(orange)).toBeGreaterThan(15);
      expect(hue(orange)).toBeLessThan(45);
    }
  });

  it("las bases claras conservan la separación entre pistas, paneles y regla", () => {
    for (const base of ["light", "midLight"] as const) {
      const theme = { ...DEFAULT_THEME, base };
      const lanes = remapThemeRgb([14, 14, 14], theme)[0];
      const panel = remapThemeRgb([32, 31, 31], theme)[0];
      const ruler = remapThemeRgb([42, 42, 42], theme)[0];
      expect(lanes - panel).toBeGreaterThanOrEqual(12);
      expect(panel - ruler).toBeGreaterThanOrEqual(8);
    }
  });

  it("un velo de color translúcido no se invierte en claro", () => {
    setTheme({ base: "light" });
    expect(themedRgba(255, 226, 171, 0.2)).toBe("rgba(255, 226, 171, 0.2)");
    expect(themedRgba(255, 226, 171, 0.9)).not.toBe("rgba(255, 226, 171, 0.9)");
  });

  it("cambiar de tema reescribe las variables de la CSS y los colores del canvas", () => {
    setTheme({ base: "light", accent: "orange" });
    flushThemeForTests();
    const style = document.documentElement.style;
    const remapped = remapThemeRgb([14, 14, 14], getTheme()).join(" ");
    expect(style.getPropertyValue("--lt-c-0e0e0e")).toBe(remapped);
    expect(style.colorScheme).toBe("light");
    expect(themedRgba(14, 14, 14)).toBe(`rgba(${remapped.split(" ").join(", ")}, 1)`);
    const orange = THEME_ACCENTS.find((accent) => accent.id === "orange")!;
    expect(accentRgba(1)).not.toBe(`rgba(${orange.accent.join(", ")}, 1)`);
    expect(JSON.parse(window.localStorage.getItem("lt.ui.theme")!)).toMatchObject({
      base: "light",
      accent: "orange",
    });

    // Volver al de por defecto quita las variables: manda el valor de reserva.
    setTheme(DEFAULT_THEME);
    flushThemeForTests();
    expect(style.getPropertyValue("--lt-c-0e0e0e")).toBe("");
  });

  it("lee el formato antiguo (solo el acento) y valores desconocidos", () => {
    window.localStorage.setItem("lt.ui.theme", "blue");
    resetThemeForTests();
    expect(getTheme()).toMatchObject({ base: "dark", accent: "blue" });
    window.localStorage.setItem("lt.ui.theme", '{"base":"nope","brightness":9}');
    resetThemeForTests();
    expect(getTheme()).toMatchObject({ base: "dark", brightness: 1.2 });
  });

  it("la CSS no lleva colores escritos a mano fuera de las variables", () => {
    // Un color escrito a mano no cambia con el tema: sale como un parche oscuro
    // en el tema claro. Escríbelo como rgb(var(--lt-c-<hex>, r g b)) y añade el
    // hex a themeColors.generated.ts. El negro puro (sombras) se queda.
    const known = new Set(THEMED_CSS_COLORS);
    for (const file of cssFiles(resolve(__dirname, ".."))) {
      const css = readFileSync(file, "utf8").replace(/:root\s*\{[\s\S]*?\n\}/, "");
      const stripped = css.replace(/var\(--lt-c-[0-9a-f]{6}, \d+ \d+ \d+\)/g, "");
      for (const match of stripped.matchAll(/#([0-9a-f]{6})\b/gi)) {
        const hex = match[1].toLowerCase();
        expect(hex === "000000" ? null : `${file}: #${hex}`).toBeNull();
      }
      expect(stripped).not.toMatch(/#57f1db|87,\s*241,\s*219|87 241 219/i);
      for (const match of css.matchAll(/--lt-c-([0-9a-f]{6})/g)) {
        expect(known.has(match[1])).toBe(true);
      }
    }
  });
});
