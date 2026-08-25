import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sharedDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(sharedDir, "styles.css"), "utf8");
const main = readFileSync(resolve(sharedDir, "../main.tsx"), "utf8");
const desktopApi = readFileSync(
  resolve(sharedDir, "../../../../packages/shared/src/desktopApi.ts"),
  "utf8",
);

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(
    styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g")),
  );
  expect(matches.length, `No se encontró la regla responsive ${selector}`).toBeGreaterThan(0);
  return matches.at(-1)?.[1] ?? "";
}

describe("contrato responsive móvil", () => {
  it("usa un hook móvil común para iOS y Android", () => {
    expect(main).toContain('classList.add("lt-mobile")');
    expect(styles).toContain(".lt-mobile .lt-app-shell");
  });

  it("reconoce iPadOS aunque publique un user-agent de escritorio", () => {
    expect(desktopApi).toContain("isIPadDesktopUserAgent");
    expect(desktopApi).toContain("navigator.maxTouchPoints > 1");
  });

  it("obtiene los cuatro márgenes seguros del dispositivo", () => {
    const shell = declarationsFor(".lt-mobile .lt-app-shell");

    expect(shell).toContain("env(safe-area-inset-top");
    expect(shell).toContain("env(safe-area-inset-right");
    expect(shell).toContain("env(safe-area-inset-bottom");
    expect(shell).toContain("env(safe-area-inset-left");
  });

  it("reorganiza grupos completos del transporte sin recortar horizontalmente", () => {
    const transport = declarationsFor(".lt-mobile .lt-transport");

    expect(transport).toContain("flex-wrap: wrap");
    expect(transport).toContain("overflow: visible");
    expect(transport).toContain("clamp(");
  });

  it("elige las columnas de la landing desde el espacio disponible", () => {
    const columns = declarationsFor(".lt-mobile .lt-empty-state-columns");
    const card = declarationsFor(".lt-mobile .lt-empty-state-card");

    expect(columns).toContain("repeat(auto-fit");
    expect(columns).toContain("minmax(");
    expect(card).toContain("max-height: 100%");
    expect(card).toContain("overflow-y: auto");
  });

  it("convierte la navegación lateral en barra inferior en vertical", () => {
    expect(styles).toMatch(/@media\s*\(orientation:\s*portrait\)/);
    expect(styles).toMatch(
      /\.lt-mobile \.lt-side-nav\s*\{[^}]*order:\s*2[^}]*flex-direction:\s*row/s,
    );
    expect(styles).toMatch(
      /\.lt-mobile \.lt-library-panel\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/s,
    );
  });

  it("no vuelve a introducir ajustes ligados a modelos concretos", () => {
    expect(styles).not.toMatch(/iPhone\s*13/i);
    expect(styles).not.toContain("@media (max-width: 850px)");
  });
});
