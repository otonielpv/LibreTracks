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

  it("reemplaza la barra horizontal por navegacion tactil en ambos ejes", () => {
    const shell = declarationsFor(".lt-mobile .lt-timeline-shell");
    const scrollbarRow = declarationsFor(".lt-mobile .lt-timeline-bottom-grid");
    const navigation = declarationsFor(".lt-mobile-navigation-surface");

    expect(shell).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(scrollbarRow).toContain("display: none");
    expect(navigation).toContain("touch-action: none");
    expect(navigation).toContain("overscroll-behavior: contain");
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

  // El grupo de transporte reservaba 19rem de base y 17rem de suelo: en cuanto
  // se le sumaron deshacer/rehacer, el reloj BAR/TIMECODE dejo de caber en la
  // fila y se bajo a una segunda... mientras el grupo se estiraba para ocupar el
  // hueco que acababa de dejar. La base solo decide el salto de linea; el ancho
  // real lo pone `flex-grow`, asi que pedir menos no encoge nada cuando hay
  // sitio.
  it("el transporte no reserva el ancho que necesita el reloj", () => {
    const buttons = declarationsFor(".lt-mobile .lt-transport-buttons");
    const history = declarationsFor(".lt-mobile .lt-topbar-history");
    const basis = Number(/flex:\s*1\s+1\s+([\d.]+)rem/.exec(buttons)?.[1]);

    expect(basis).toBeLessThanOrEqual(14);
    expect(buttons).toContain("min-width: 0");
    expect(history).toContain("margin-right: 0");
    // Pedir menos ancho no puede acabar aplastando los botones: si el grupo se
    // queda corto, se desplaza. Antes los botones lisos se encogian hasta ~20 px
    // y el fondo tenido de un toggle tocaba la flecha del grupo anterior.
    expect(buttons).toContain("overflow-x: auto");
    expect(buttons).toContain("max-width: max-content");
    const items = declarationsFor(
      ".lt-mobile .lt-transport-buttons .lt-topbar-split > button",
    );
    expect(items).toContain("flex: 0 0 auto");
  });

  // El fader es de 6 px de alto y su pulgar de 9: con el dedo no se coge. Y sin
  // `touch-action: none` el navegador se queda con la parte vertical del
  // arrastre, cancela el puntero y mueve la app entera en vez del fader.
  it("los faders del panel de pista son agarrables con el dedo", () => {
    const faders = declarationsFor(
      '.lt-mobile .lt-mobile-track-row-panel .lt-track-pan input[type="range"]',
    );

    expect(faders).toContain("touch-action: none");
    expect(faders).toContain("padding-block:");
    // El relleno agranda la zona de agarre, no el riel...
    expect(faders).toContain("background-clip: content-box");
    // ...y el margen negativo devuelve el alto que anadia, para que la fila del
    // panel no engorde. Sin el, el fader se ve el doble de grande.
    expect(faders).toMatch(/margin-block:\s*-/);
  });

  // `input, textarea { user-select: text }` se lo daba tambien a los faders, y
  // en iOS dejar el dedo quieto sobre uno sacaba la lupa y el menu de seleccion
  // justo mientras se ajustaba.
  it("un fader no es texto seleccionable", () => {
    // El salto de linea ancla la regla suelta, no las de dentro del panel.
    const range = declarationsFor('\ninput[type="range"]');

    expect(range).toContain("user-select: none");
    expect(range).toContain("-webkit-user-select: none");
    expect(range).toContain("-webkit-touch-callout: none");
  });

  // El valor mide por contenido y la etiqueta se lleva lo que ocupe, asi que al
  // pasar de "0.0 dB" a "-12.5 dB" el riel de al lado se encogia a media pasada
  // y el pulgar temblaba bajo el dedo.
  it("el numero del fader no cambia de ancho al arrastrarlo", () => {
    // El salto de linea ancla la regla BASE, no la que recorta el ancho del
    // paneo (`.lt-track-pan .lt-track-mix-value`).
    const value = declarationsFor("\n.lt-track-mix-value");

    expect(value).toContain("min-width:");
    expect(value).toContain("text-align: right");
    expect(value).toContain("font-variant-numeric: tabular-nums");
  });

  it("elige las columnas de la landing desde el espacio disponible", () => {
    const columns = declarationsFor(".lt-mobile .lt-empty-state-columns");
    const card = declarationsFor(".lt-mobile .lt-empty-state-card");

    expect(columns).toContain("repeat(auto-fit");
    expect(columns).toContain("minmax(");
    expect(card).toContain("max-height: 100%");
    expect(card).toContain("overflow-y: auto");
  });

  // Con una sesión abierta, "Sesiones…" mete la tarjeta de la landing en un
  // modal. La tarjeta trae el scroller de la landing a pantalla completa
  // (`overflow-y: auto` + `overscroll-behavior: contain`), pero ahí dentro su
  // `max-height: 100%` no resuelve: nunca desborda, y `contain` impide que el
  // gesto suba al marco, que es quien sí tiene el desbordamiento. El dedo
  // empuja una caja que no se mueve y sólo funciona la barra.
  it("deja un único scroller en el modal de sesiones", () => {
    const modal = declarationsFor(".lt-mobile .lt-sessions-modal");
    const body = declarationsFor(
      ".lt-mobile .lt-sessions-modal .lt-settings-modal-body",
    );
    const card = declarationsFor(
      ".lt-mobile .lt-sessions-modal .lt-empty-state-card",
    );
    const lists = declarationsFor(".lt-mobile .lt-empty-state-template-list");

    expect(modal).toContain("overflow: hidden");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("touch-action: pan-y");
    expect(body).toContain("overscroll-behavior: contain");
    // Nada dentro del cuerpo puede ser otro scrollport.
    expect(card).toContain("overflow: visible");
    expect(card).toContain("overscroll-behavior: auto");
    expect(lists).toContain("max-height: none");
    expect(lists).toContain("overflow: visible");
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

  it("compacta la configuracion en iOS y Android sin afectar los otros modales", () => {
    const modal = declarationsFor(".lt-mobile .lt-settings-modal--fixed");
    const title = declarationsFor(
      ".lt-mobile .lt-settings-modal--fixed .lt-settings-modal-header h2",
    );
    const field = declarationsFor(
      ".lt-mobile .lt-settings-modal--fixed .lt-settings-field",
    );
    const select = declarationsFor(
      ".lt-mobile .lt-settings-modal--fixed .lt-settings-field select",
    );
    const description = declarationsFor(
      ".lt-mobile .lt-settings-modal--fixed .lt-settings-toggle-copy small",
    );

    expect(modal).toContain("100dvh");
    expect(modal).toContain("padding: 0.7rem");
    expect(title).toContain("font-size: 1.1rem");
    expect(field).toContain("padding: 0.58rem");
    expect(select).toContain("font-size: 0.74rem");
    expect(description).toContain("font-size: 0.58rem");
    expect(styles).not.toContain(".lt-mobile .lt-settings-modal {");
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
