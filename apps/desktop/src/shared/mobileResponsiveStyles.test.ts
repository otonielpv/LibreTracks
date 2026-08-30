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

  // En apaisado la barra de desplazamiento del timeline es lo ultimo antes del
  // borde inferior. En iOS ese borde es del sistema (indicador de inicio), asi
  // que sin apartarla el arrastre saca el gesto de salir de la app.
  it("aparta la barra de desplazamiento de la zona de gestos inferior", () => {
    const scrollbar = declarationsFor(".lt-mobile .lt-horizontal-scrollbar");

    expect(scrollbar).toContain("env(safe-area-inset-bottom");
    expect(scrollbar).toContain("box-sizing: border-box");
  });

  // En un teléfono apaisado el notch y las esquinas redondeadas comen por los
  // LADOS. Las hojas iban a `left: 0; right: 0`, así que el texto se metía
  // debajo del notch; y a lo ancho de un iPhone apaisado una hoja a pantalla
  // completa con tres opciones se lee mal y roza los dos bordes.
  it("aparta las hojas inferiores del notch y no las estira a pantalla completa", () => {
    const sheet = styles.match(
      /\.lt-mobile \.lt-control-popover-panel,\s*\.lt-mobile \.lt-context-menu\.is-mobile-sheet\s*\{([^}]+)\}/,
    )?.[1];

    expect(sheet, "falta la geometría compartida de las hojas").toBeTruthy();
    expect(sheet).toContain("left: env(safe-area-inset-left");
    expect(sheet).toContain("right: env(safe-area-inset-right");
    expect(sheet).toContain("max-width:");
    expect(sheet).toContain("margin-left: auto");
  });

  // La caja de la hoja YA se desplaza por `left`/`right`. Repetir el inset en el
  // relleno lo sumaría dos veces y el contenido acabaría a ~120 px del borde.
  it("no suma dos veces los insets laterales en las hojas", () => {
    const padding = declarationsFor(".lt-mobile .lt-control-popover-panel");

    expect(padding).not.toContain("safe-area-inset-left");
    expect(padding).not.toContain("safe-area-inset-right");
    // Abajo sí: la hoja se queda pegada al borde y su última línea no puede
    // quedar bajo el indicador de inicio.
    expect(padding).toContain("safe-area-inset-bottom");
  });

  it("fija el documento iOS para que WKWebView no cree scroll exterior", () => {
    expect(styles).toMatch(
      /html\.lt-ios,[^{]*html\.lt-ios body\s*\{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/s,
    );
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
