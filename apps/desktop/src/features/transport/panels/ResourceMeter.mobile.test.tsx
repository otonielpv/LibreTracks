// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemResourceSnapshot } from "@libretracks/shared/desktopApi";

/**
 * El medidor en un teléfono: una pastilla «CPU nn%» con la carga del motor de
 * audio (como SundayKeys) que abre un menú con lo que el móvil mide de verdad.
 * CPU del sistema y disco no salen: Android no deja leerlos y iOS no tiene API
 * de disco por proceso, así que pintarían un 0 engañoso.
 */

const platform = { isMobileApp: true };
let snapshot: SystemResourceSnapshot | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  get isMobileApp() {
    return platform.isMobileApp;
  },
}));

vi.mock("../hooks/useSystemResources", () => ({
  useSystemResources: () => snapshot,
}));

import { ResourceMeter } from "./ResourceMeter";

function makeSnapshot(
  overrides: Partial<SystemResourceSnapshot> = {},
): SystemResourceSnapshot {
  return {
    processCpuPercent: 7,
    processMemoryBytes: 300 * 1024 * 1024,
    systemCpuPercent: 0,
    systemMemoryUsedBytes: 3 * 1024 ** 3,
    systemMemoryTotalBytes: 6 * 1024 ** 3,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    audioLoadPercent: 42,
    audioUnderrunCount: 0,
    audioEngineActive: true,
    availableMemoryBytes: 0,
    ...overrides,
  };
}

describe("ResourceMeter en móvil", () => {
  beforeEach(() => {
    platform.isMobileApp = true;
    snapshot = makeSnapshot();
  });

  afterEach(() => {
    cleanup();
  });

  it("la pastilla enseña la carga de audio, no el CPU de la app", () => {
    const { container } = render(<ResourceMeter />);

    expect(container.querySelector(".lt-resource-chip-value")?.textContent).toBe(
      "42%",
    );
    // Sin barras de escritorio: no caben en la barra del teléfono.
    expect(container.querySelector(".lt-resource-gauge")).toBeNull();
  });

  it("un corte ya oído deja la pastilla en rojo aunque la carga sea baja", () => {
    snapshot = makeSnapshot({ audioLoadPercent: 10, audioUnderrunCount: 3 });
    const { container } = render(<ResourceMeter />);

    expect(
      container.querySelector(".lt-resource-chip")?.getAttribute("data-severity"),
    ).toBe("high");
  });

  it("el menú no enseña CPU del sistema ni disco", () => {
    render(<ResourceMeter />);
    fireEvent.click(screen.getByRole("button", { name: "resourceMeter.label" }));

    expect(screen.getByText("resourceMeter.audioLoad")).toBeTruthy();
    expect(screen.getByText("resourceMeter.processRam")).toBeTruthy();
    expect(screen.queryByText("resourceMeter.systemCpu")).toBeNull();
    expect(screen.queryByText("resourceMeter.diskRead")).toBeNull();
    expect(screen.queryByText("resourceMeter.diskWrite")).toBeNull();
  });

  it("en iOS enseña la memoria que queda antes del cierre en vez de la RAM total", () => {
    snapshot = makeSnapshot({ availableMemoryBytes: 1024 ** 3 });
    render(<ResourceMeter />);
    fireEvent.click(screen.getByRole("button", { name: "resourceMeter.label" }));

    expect(screen.getByText("resourceMeter.availableMemory")).toBeTruthy();
    expect(screen.queryByText("resourceMeter.systemRam")).toBeNull();
  });

  it("en escritorio sigue saliendo el medidor completo", () => {
    platform.isMobileApp = false;
    const { container } = render(<ResourceMeter />);

    expect(container.querySelector(".lt-resource-chip")).toBeNull();
    expect(container.querySelectorAll(".lt-resource-gauge").length).toBeGreaterThan(
      0,
    );
  });
});
