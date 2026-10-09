import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissBootSplash } from "./bootSplash";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, "../../index.html"), "utf8");
const tauriConf = JSON.parse(
  readFileSync(resolve(here, "../../src-tauri/tauri.conf.json"), "utf8"),
) as { app: { windows: Array<{ backgroundColor?: string }> } };

describe("pantalla de carga", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // Sin esto la ventana de escritorio se veía en negro hasta que React montaba.
  it("index.html pinta el splash antes de cargar el bundle", () => {
    const splashAt = indexHtml.indexOf('id="lt-boot-splash"');
    const bundleAt = indexHtml.indexOf('src="/src/main.tsx"');
    expect(splashAt).toBeGreaterThan(-1);
    expect(splashAt).toBeLessThan(bundleAt);
  });

  it("la ventana, el splash y la app comparten color de fondo", () => {
    expect(tauriConf.app.windows[0].backgroundColor).toBe("#131313");
    expect(indexHtml).toContain('<body style="margin: 0; background: #131313">');
  });

  it("se desvanece y sale del DOM", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="lt-boot-splash"></div>';
    dismissBootSplash();
    expect(document.getElementById("lt-boot-splash")?.classList.contains("is-leaving")).toBe(true);
    vi.runAllTimers();
    expect(document.getElementById("lt-boot-splash")).toBeNull();
  });

  it("no falla si no hay splash", () => {
    expect(() => dismissBootSplash()).not.toThrow();
  });
});
