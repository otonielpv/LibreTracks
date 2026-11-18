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
