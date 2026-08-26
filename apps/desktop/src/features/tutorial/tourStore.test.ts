import { beforeEach, describe, expect, it } from "vitest";

import { useSongStore } from "../transport/songStore";
import { shouldAutoStartLandingTour, tourIdForContext } from "./tourModel";
import { tourForCurrentContext, useTourStore } from "./tourStore";
import { TOURS } from "./tours";

const STORAGE_KEY = "lt.tutorial.v1";

function stepIds(): string[] {
  return useTourStore.getState().steps.map((step) => step.id);
}

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  useSongStore.setState({ song: null });
  useTourStore.setState({
    activeTourId: null,
    stepIndex: 0,
    steps: [],
    seenTours: [],
  });
});

describe("qué recorrido toca", () => {
  it("sin sesión abierta, el de la pantalla de inicio", () => {
    expect(tourIdForContext(false)).toBe("landing");
    expect(tourForCurrentContext()).toBe("landing");
  });

  it("con sesión abierta, el del área de trabajo", () => {
    // `song !== null` es el mismo criterio que usa el panel para decidir si
    // pinta la pantalla vacía o el área de trabajo.
    useSongStore.setState({ song: { id: "s1" } as never });

    expect(tourIdForContext(true)).toBe("workspace");
    expect(tourForCurrentContext()).toBe("workspace");
  });

  it("el recorrido de inicio no habla de nada que necesite sesión", () => {
    // La razón de que haya dos recorridos: la línea de tiempo, el transporte y
    // el selector de vistas no existen en la pantalla de inicio, así que un
    // paso que los ilumine describiría algo que el usuario no tiene delante.
    const landingTargets = TOURS.landing.steps.map((step) => step.target);

    expect(landingTargets).not.toContain("timeline-canvas");
    expect(landingTargets).not.toContain("topbar-transport");
    expect(landingTargets).not.toContain("view-mode-switcher");
  });

  it("el recorrido de inicio ilumina crear, abrir e importar", () => {
    const landingTargets = TOURS.landing.steps.map((step) => step.target);

    expect(landingTargets).toContain("landing-create");
    expect(landingTargets).toContain("landing-open");
    expect(landingTargets).toContain("landing-import");
  });
});

describe("recorrido por plataforma", () => {
  it("en escritorio el área de trabajo incluye el menú ARCHIVO y Remote", () => {
    useTourStore.getState().startTour("workspace", "desktop");

    expect(stepIds()).toContain("fileMenu");
    expect(stepIds()).toContain("remote");
    expect(stepIds()).not.toContain("fileActionsMobile");
  });

  it("en móvil cambia el paso de archivo y se salta Remote", () => {
    // El rail del móvil no tiene botón Remote (no existe la feature allí) y el
    // menú ARCHIVO no se dibuja: sus entradas viven en el propio rail.
    useTourStore.getState().startTour("workspace", "mobile");

    expect(stepIds()).toContain("fileActionsMobile");
    expect(stepIds()).not.toContain("fileMenu");
    expect(stepIds()).not.toContain("remote");
  });

  it("el recorrido de inicio sólo se salta en móvil lo que allí no existe", () => {
    // Crear, abrir e importar están en las dos pantallas de inicio y sólo
    // cambian de texto (`bodyMobile`). Lo único que se cae es traer un montaje
    // de Reaper/Ableton, que `MobileLanding` no ofrece.
    useTourStore.getState().startTour("landing", "desktop");
    const desktop = stepIds();
    useTourStore.getState().endTour();
    useTourStore.getState().startTour("landing", "mobile");

    expect(stepIds()).toEqual(desktop.filter((id) => id !== "importExternal"));
    expect(stepIds()).toEqual(
      expect.arrayContaining(["create", "open", "import"]),
    );
  });
});

describe("navegación", () => {
  beforeEach(() => {
    useTourStore.getState().startTour("landing", "desktop");
  });

  it("avanza y retrocede entre pasos", () => {
    useTourStore.getState().nextStep();
    expect(useTourStore.getState().stepIndex).toBe(1);

    useTourStore.getState().previousStep();
    expect(useTourStore.getState().stepIndex).toBe(0);
  });

  it("no retrocede por debajo del primer paso", () => {
    useTourStore.getState().previousStep();
    expect(useTourStore.getState().stepIndex).toBe(0);
  });

  it("avanzar en el último paso termina el recorrido", () => {
    const total = useTourStore.getState().steps.length;
    for (let index = 0; index < total; index += 1) {
      useTourStore.getState().nextStep();
    }

    expect(useTourStore.getState().activeTourId).toBeNull();
    expect(useTourStore.getState().seenTours).toContain("landing");
  });

  it("salir a medias también cuenta como visto", () => {
    // Si no, la guía volvería a saltar en el siguiente arranque justo a quien
    // ya ha dicho que no la quiere.
    useTourStore.getState().nextStep();
    useTourStore.getState().endTour();

    expect(useTourStore.getState().seenTours).toContain("landing");
  });
});

describe("persistencia", () => {
  it("guarda los recorridos vistos, no el paso en curso", () => {
    useTourStore.getState().startTour("landing", "desktop");
    useTourStore.getState().nextStep();
    useTourStore.getState().endTour();

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual(
      ["landing"],
    );
  });

  it("los recorridos se marcan por separado", () => {
    // Haber visto la pantalla de inicio no cuenta como haber visto el área de
    // trabajo, que es lo que hace que el segundo recorrido siga teniendo
    // sentido más adelante.
    useTourStore.getState().startTour("landing", "desktop");
    useTourStore.getState().endTour();

    expect(useTourStore.getState().seenTours).toEqual(["landing"]);
  });

  it("no repite un recorrido ya marcado como visto", () => {
    useTourStore.setState({ seenTours: ["landing"] });
    useTourStore.getState().startTour("landing", "desktop");
    useTourStore.getState().endTour();

    expect(useTourStore.getState().seenTours).toEqual(["landing"]);
  });
});

describe("arranque automático", () => {
  it("arranca la guía de inicio la primera vez", () => {
    expect(
      shouldAutoStartLandingTour({
        seenTours: [],
        isWebDriver: false,
        isTestRun: false,
      }),
    ).toBe(true);
  });

  it("no arranca si ya se vio", () => {
    expect(
      shouldAutoStartLandingTour({
        seenTours: ["landing"],
        isWebDriver: false,
        isTestRun: false,
      }),
    ).toBe(false);
  });

  it("haber visto el área de trabajo no cuenta como haber visto la de inicio", () => {
    expect(
      shouldAutoStartLandingTour({
        seenTours: ["workspace"],
        isWebDriver: false,
        isTestRun: false,
      }),
    ).toBe(true);
  });

  it("no arranca bajo WebDriver", () => {
    // Los E2E abren la app recién construida: sin esto, el overlay taparía la
    // pantalla de inicio y se llevaría por delante todos los flujos.
    expect(
      shouldAutoStartLandingTour({
        seenTours: [],
        isWebDriver: true,
        isTestRun: false,
      }),
    ).toBe(false);
  });

  it("no arranca en los tests", () => {
    expect(
      shouldAutoStartLandingTour({
        seenTours: [],
        isWebDriver: false,
        isTestRun: true,
      }),
    ).toBe(false);
  });

  it("el entorno de test se reconoce por import.meta.env.MODE", () => {
    // El overlay pasa este valor como `isTestRun`. Si Vitest dejara de
    // ponerlo a "test", la guardia de arriba sería letra muerta y el fallo
    // aparecería como un overlay misterioso en tests ajenos.
    expect(import.meta.env.MODE).toBe("test");
  });
});
