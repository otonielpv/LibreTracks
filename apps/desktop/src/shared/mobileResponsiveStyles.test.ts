import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sharedDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(sharedDir, "styles.css"), "utf8");
const main = readFileSync(resolve(sharedDir, "../main.tsx"), "utf8");
const viteConfig = readFileSync(resolve(sharedDir, "../../vite.config.ts"), "utf8");
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

  it("reconoce iOS por el target nativo y mantiene fallbacks de navegador", () => {
    expect(viteConfig).toContain("TAURI_ENV_PLATFORM");
    expect(viteConfig).toContain("__LIBRETRACKS_TAURI_PLATFORM__");
    expect(desktopApi).toContain("tauriBuildPlatform");
    expect(desktopApi).toContain("navigator.platform");
    expect(desktopApi).toContain("isIPadDesktopUserAgent");
    expect(desktopApi).toContain("navigator.maxTouchPoints > 1");
  });

  it("mantiene el shell a pantalla completa y protege controles, no el lienzo", () => {
    const shell = declarationsFor(".lt-mobile .lt-app-shell");
    const topbar = declarationsFor(".lt-mobile .lt-topbar");
    const sideNav = declarationsFor(".lt-mobile .lt-side-nav");

    expect(shell).not.toContain("padding:");
    expect(topbar).toContain("env(safe-area-inset-top");
    expect(topbar).toContain("env(safe-area-inset-right");
    expect(topbar).toContain("env(safe-area-inset-left");
    expect(sideNav).toContain("env(safe-area-inset-left");
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
      /\.lt-mobile \.lt-library-panel\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*z-index:\s*50/s,
    );
  });

  it("reparte el DAW vertical entre pistas y timeline sin un ancho fijo de dispositivo", () => {
    expect(styles).toMatch(
      /\.lt-mobile \.lt-timeline-main-grid,[^{]*\.lt-mobile \.lt-timeline-bottom-grid\s*\{[^}]*grid-template-columns:\s*clamp\(12rem,\s*34vw,\s*16\.25rem\)\s+minmax\(0,\s*1fr\)/s,
    );
  });

  it("incluye padding y bordes dentro del ancho de navegacion y modales", () => {
    expect(styles).toMatch(
      /\.lt-side-nav\s*\{\s*box-sizing:\s*border-box/,
    );
    expect(styles).toMatch(
      /\.lt-settings-modal\s*\{\s*box-sizing:\s*border-box/,
    );
  });

  it("adapta el tutorial a teléfonos, apaisado y tablets", () => {
    const mobileCard = declarationsFor(".lt-mobile .lt-tour-card");
    expect(mobileCard).toContain("clamp(18rem, 37.5vw, 18.75rem)");
    expect(mobileCard).toContain("env(safe-area-inset-left");
    expect(mobileCard).toContain("env(safe-area-inset-right");
    expect(mobileCard).toContain("58dvh");
    expect(styles).toContain("--lt-safe-area-top");
    expect(styles).toContain("--lt-safe-area-right");
    expect(styles).toContain("--lt-safe-area-bottom");
    expect(styles).toContain("--lt-safe-area-left");
    expect(styles).toMatch(
      /\.lt-mobile \.lt-tour-menu\s*\{[^}]*position|\.lt-tour-menu\s*\{[^}]*position:\s*fixed/s,
    );
    const mobileMenu = declarationsFor(".lt-mobile .lt-tour-menu");
    expect(mobileMenu).toContain("env(safe-area-inset-left");
    expect(mobileMenu).toContain("env(safe-area-inset-right");
    expect(mobileMenu).toContain("100dvh");
  });

  it("no vuelve a introducir ajustes ligados a modelos concretos", () => {
    expect(styles).not.toMatch(/iPhone\s*13/i);
    expect(styles).not.toContain("@media (max-width: 850px)");
  });
});
