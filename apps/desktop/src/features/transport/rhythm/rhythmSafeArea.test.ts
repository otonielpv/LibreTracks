import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "rhythm.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "gm"))];
  return blocks.map((m) => m[1]).join("\n");
}

// iPhone apaisado: el inset del notch se sumaba dos veces y el panel Ritmo y
// la hoja del pad quedaban estrechos y desplazados.
describe("insets del notch en el panel Ritmo", () => {
  it("el panel acoplado no se aparta del notch: lo hace la vista que lo contiene", () => {
    const docked = rule(".lt-rhythm-panel--docked.lt-rhythm-panel--short");
    expect(docked).toBeTruthy();
    expect(docked).not.toContain("--lt-safe-area-left");
    expect(docked).not.toContain("--lt-safe-area-right");
  });

  it("el editor de patrones en el teléfono llega al borde derecho", () => {
    const backdrop = rule(".lt-rhythm-backdrop--short");
    expect(backdrop).toContain("--lt-safe-area-left");
    expect(backdrop).not.toContain("--lt-safe-area-right");
  });

  it("el editor de patrones en el teléfono llega abajo: el inset lo absorbe la rejilla", () => {
    expect(rule(".lt-rhythm-backdrop--short")).not.toContain("--lt-safe-area-bottom");
    expect(rule(".lt-loop-editor--short .lt-loop-editor__grid")).toContain("--lt-safe-area-bottom");
  });

  it("la rejilla se desplaza en un solo eje por scroll (sin diagonal)", () => {
    const outer = rule(".lt-loop-editor__grid");
    const inner = rule(".lt-loop-editor__canvas");
    expect(outer).toContain("overflow-x: hidden");
    expect(outer).toContain("overflow-y: auto");
    expect(inner).toContain("overflow-x: auto");
    expect(inner).toContain("overflow-y: hidden");
    // Fuera de las celdas se desplaza; en las celdas se pinta arrastrando.
    expect(rule(".lt-step-grid")).toContain("touch-action: pan-x pan-y");
    expect(rule(".lt-loop-editor .lt-step-grid .lt-step-cell")).toContain("touch-action: none");
  });

  it("el panel acoplado mide lo mismo en las cuatro vistas del teléfono", () => {
    // Antes el Setlist lo estiraba (flex 1) y el DAW le daba 62vh.
    expect(rule(".lt-rhythm-panel--docked.lt-rhythm-panel--short")).toContain("flex: 0 0 auto");
    expect(rule(".lt-setlist-view.is-short.has-rhythm + .lt-rhythm-panel--docked")).not.toContain("height: auto");
    expect(rule(".lt-setlist-view.is-short.has-rhythm + .lt-rhythm-panel--docked")).not.toContain("flex: 1");
  });

  it("los pads del teléfono no se montan: sin mínimo propio y 6×2 en el acoplado", () => {
    expect(rule(".lt-rhythm-panel--short .lt-rhythm-pad")).toContain("min-height: 0");
    const docked = rule(".lt-rhythm-panel--docked.lt-rhythm-panel--short:not(.is-expanded) .lt-rhythm-shots__grid");
    expect(docked).toContain("repeat(6");
    expect(docked).toContain("repeat(2");
  });

  it("a pantalla completa cubre la ventana y aparta el contenido del notch", () => {
    const expanded = rule(".lt-rhythm-panel.is-expanded,\n.lt-rhythm-panel--docked.lt-rhythm-panel--short.is-expanded");
    expect(expanded).toContain("position: fixed");
    expect(expanded).toContain("inset: 0");
    expect(expanded).toContain("--lt-safe-area-left");
  });

  it("el kit no se oculta en el teléfono", () => {
    expect(rule(".lt-loop-editor--short .lt-loop-editor__identity .lt-loop-editor__kit")).not.toContain("display: none");
  });

  it("la hoja del pad no se aparta del notch con la caja Y con el relleno", () => {
    const sheet = rule(".lt-pad-editor.is-sheet");
    const box = sheet.match(/(?:^|[\s;])(?:left|right):[^;]+;/g)?.join(" ") ?? "";
    const padding = sheet.match(/padding:[^;]+;/)?.[0] ?? "";
    expect(padding).toContain("--lt-safe-area-left");
    expect(box).not.toContain("--lt-safe-area");
  });
});
