import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSongStore } from "../transport/songStore";
import {
  isWaitSatisfied,
  shouldOfferToursOnSessionOpen,
  shouldAutoStartLandingTour,
  tourIdForContext,
} from "./tourModel";
import { tourForCurrentContext, useTourStore } from "./tourStore";
import { TOURS } from "./tours";
import { TOUR_TARGETS } from "./tourTargets";

const STORAGE_KEY = "lt.tutorial.v2";
const LEGACY_STORAGE_KEY = "lt.tutorial.v1";

function stepIds(): string[] {
  return useTourStore.getState().steps.map((step) => step.id);
}

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  useSongStore.setState({ song: null });
  useTourStore.setState({
    activeTourId: null,
    stepIndex: 0,
    steps: [],
    progress: {},
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

    expect(landingTargets).not.toContain(TOUR_TARGETS.timelineCanvas);
    expect(landingTargets).not.toContain(TOUR_TARGETS.topbarTransport);
    expect(landingTargets).not.toContain(TOUR_TARGETS.viewModeSwitcher);
  });

  it("el área de trabajo recorre las tres vistas, no las resume", () => {
    // Contarlas en un párrafo desde la DAW no enseña nada: cada vista tiene su
    // paso y la guía cambia a ella de verdad.
    const visited = new Set(
      TOURS.workspace.steps
        .map((step) => step.viewMode)
        .filter((mode): mode is NonNullable<typeof mode> => Boolean(mode)),
    );

    expect(visited).toEqual(new Set(["daw", "compact", "live"]));
  });

  it("el recorrido DAW cubre todo lo que hay que montar", () => {
    // Lista explícita porque es fácil borrar un paso al reorganizar y no
    // enterarse: la guía seguiría "funcionando", sólo que sin explicar el
    // tempo, o las pistas, o los clips.
    const targets = new Set(TOURS.daw.steps.map((step) => step.target));

    for (const target of [
      TOUR_TARGETS.timelineRuler,
      TOUR_TARGETS.topbarTempo,
      TOUR_TARGETS.topbarTimeSignature,
      TOUR_TARGETS.toolbarSnap,
      TOUR_TARGETS.trackHeaders,
      TOUR_TARGETS.timelineCanvas,
      TOUR_TARGETS.mobileTouchControls,
    ]) {
      expect(targets, `falta ${target} en el recorrido DAW`).toContain(target);
    }

    // Crear canción, redimensionar, mover, marcas, tipos y arrastre: todos
    // pasan en la regla, así que se comprueban por id de paso.
    const ids = TOURS.daw.steps.map((step) => step.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "createSong",
        "resizeSong",
        "moveSong",
        "createMarker",
        "markerKinds",
        "dragMarkers",
        "folders",
        "clips",
      ]),
    );
  });

  it("el recorrido de directo cubre saltos, vamp, master, tono y warp", () => {
    const targets = new Set(TOURS.live.steps.map((step) => step.target));

    for (const target of [
      TOUR_TARGETS.toolbarMarkerJump,
      TOUR_TARGETS.toolbarSongJump,
      TOUR_TARGETS.toolbarVamp,
      TOUR_TARGETS.toolbarMaster,
      TOUR_TARGETS.toolbarTranspose,
      TOUR_TARGETS.toolbarWarp,
    ]) {
      expect(targets, `falta ${target} en el recorrido de directo`).toContain(
        target,
      );
    }
  });

  it("los controles táctiles sólo se explican en móvil", () => {
    // En escritorio no existen: la altura se cambia con Alt+scroll y no hay
    // palmas que muevan el cabezal.
    const touchStep = TOURS.daw.steps.find(
      (step) => step.target === TOUR_TARGETS.mobileTouchControls,
    );

    expect(touchStep?.platforms).toEqual(["mobile"]);
  });

  it("los recorridos del área de trabajo fuerzan una vista donde existan sus controles", () => {
    // La barra de herramientas no se dibuja en la vista Live, así que un paso
    // de directo sin `viewMode` apuntaría a un control que no está en pantalla.
    for (const step of TOURS.live.steps) {
      expect(step.viewMode, `${step.id} sin vista forzada`).toBe("daw");
    }
  });

  it("la biblioteca explica sus dos botones", () => {
    const targets = TOURS.workspace.steps.map((step) => step.target);

    expect(targets).toContain(TOUR_TARGETS.libraryImport);
    expect(targets).toContain(TOUR_TARGETS.libraryNewFolder);
  });

  it("el recorrido de inicio ilumina crear, abrir e importar", () => {
    const landingTargets = TOURS.landing.steps.map((step) => step.target);

    expect(landingTargets).toContain(TOUR_TARGETS.landingCreate);
    expect(landingTargets).toContain(TOUR_TARGETS.landingOpen);
    expect(landingTargets).toContain(TOUR_TARGETS.landingImport);
  });
});

describe("pasos interactivos", () => {
  it("la condición se cumple cuando el anclaje aparece", () => {
    expect(
      isWaitSatisfied({ target: TOUR_TARGETS.libraryPanel }, () => true),
    ).toBe(true);
    expect(
      isWaitSatisfied({ target: TOUR_TARGETS.libraryPanel }, () => false),
    ).toBe(false);
  });

  it("con `present: false` la condición se cumple al desaparecer", () => {
    // Es como se pide cerrar el modal de ajustes, que si no tapa el rail al
    // que apuntan los pasos siguientes.
    const closing = { target: TOUR_TARGETS.settingsModal, present: false };

    expect(isWaitSatisfied(closing, () => false)).toBe(true);
    expect(isWaitSatisfied(closing, () => true)).toBe(false);
  });

  it("los dos recorridos hacen abrir algo de verdad", () => {
    for (const tour of [TOURS.landing, TOURS.workspace]) {
      const interactive = tour.steps.filter((step) => step.waitFor);
      expect(
        interactive.length,
        `${tour.id} no tiene ningún paso interactivo`,
      ).toBeGreaterThan(0);
    }
  });

  it("todo lo que se abre se vuelve a cerrar", () => {
    // Un modal abierto y nunca cerrado taparía los pasos siguientes. El panel
    // de biblioteca es una barra lateral y no cuenta: deja ver el timeline.
    for (const tour of [TOURS.landing, TOURS.workspace]) {
      const opensSettings = tour.steps.some(
        (step) =>
          step.waitFor?.target === TOUR_TARGETS.settingsModal &&
          step.waitFor.present !== false,
      );
      const closesSettings = tour.steps.some(
        (step) =>
          step.waitFor?.target === TOUR_TARGETS.settingsModal &&
          step.waitFor.present === false,
      );
      expect(
        closesSettings,
        `${tour.id} abre los ajustes y no pide cerrarlos`,
      ).toBe(opensSettings);
    }
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

  it("llegar al final cuenta como terminado", () => {
    const total = useTourStore.getState().steps.length;
    for (let index = 0; index < total; index += 1) {
      useTourStore.getState().nextStep();
    }

    expect(useTourStore.getState().activeTourId).toBeNull();
    expect(useTourStore.getState().progress.landing).toBe("completed");
  });

  it("salir a medias cuenta como descartado, no como terminado", () => {
    // La diferencia decide si la guía continúa sola al abrir la sesión: quien
    // la salta ya ha dicho que no quiere que le expliquen la app.
    useTourStore.getState().nextStep();
    useTourStore.getState().endTour();

    expect(useTourStore.getState().progress.landing).toBe("dismissed");
  });
});

describe("persistencia", () => {
  it("guarda cómo terminó cada recorrido, no el paso en curso", () => {
    useTourStore.getState().startTour("landing", "desktop");
    useTourStore.getState().nextStep();
    useTourStore.getState().endTour("completed");

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
      { landing: "completed" },
    );
  });

  it("los recorridos se marcan por separado", () => {
    useTourStore.getState().startTour("landing", "desktop");
    useTourStore.getState().endTour("completed");

    expect(useTourStore.getState().progress.workspace).toBeUndefined();
  });

  it("migra el formato v1 tratándolo como descartado", async () => {
    // v1 era un array de ids vistos y no distinguía cómo acabaron. Darlos por
    // descartados es lo conservador: como mucho no ofrecemos la continuación,
    // nunca insistimos de más a quien ya la había saltado.
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify(["landing"]),
    );
    vi.resetModules();
    const fresh = await import("./tourStore");

    expect(fresh.useTourStore.getState().progress).toEqual({
      landing: "dismissed",
    });
  });
});

describe("arranque automático", () => {
  it("arranca la guía de inicio la primera vez", () => {
    expect(
      shouldAutoStartLandingTour({
        progress: {},
        isWebDriver: false,
        isTestRun: false,
      }),
    ).toBe(true);
  });

  it("no arranca si ya se vio, se terminara o no", () => {
    for (const outcome of ["completed", "dismissed"] as const) {
      expect(
        shouldAutoStartLandingTour({
          progress: { landing: outcome },
          isWebDriver: false,
          isTestRun: false,
        }),
      ).toBe(false);
    }
  });

  it("no arranca bajo WebDriver", () => {
    // Los E2E abren la app recién construida: sin esto, el overlay taparía la
    // pantalla de inicio y se llevaría por delante todos los flujos.
    expect(
      shouldAutoStartLandingTour({
        progress: {},
        isWebDriver: true,
        isTestRun: false,
      }),
    ).toBe(false);
  });

  it("no arranca en los tests", () => {
    expect(
      shouldAutoStartLandingTour({
        progress: {},
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

describe("oferta de recorridos al abrir una sesión", () => {
  const base = {
    isTourActive: false,
    alreadyOffered: false,
    isWebDriver: false,
    isTestRun: false,
  };

  it("se ofrece si el recorrido de inicio se terminó o no llegó a verse", () => {
    // Terminar el de inicio invita a continuar; no haberlo visto tampoco
    // equivale a rechazar el tutorial.
    for (const progress of [{ landing: "completed" } as const, {} as const]) {
      expect(
        shouldOfferToursOnSessionOpen({ ...base, progress }),
        `no se ofreció con progress=${JSON.stringify(progress)}`,
      ).toBe(true);
    }
  });

  it("un recorrido saltado rechaza la oferta de todos los demás", () => {
    // "Saltar tutorial" es un no explícito, también cuando se pulsa en la
    // pantalla de inicio y los tres recorridos de la sesión siguen sin ver.
    for (const progress of [
      { landing: "dismissed" } as const,
      { workspace: "dismissed" } as const,
      { daw: "dismissed" } as const,
      { live: "dismissed" } as const,
    ]) {
      expect(
        shouldOfferToursOnSessionOpen({ ...base, progress }),
        `se ofreció con progress=${JSON.stringify(progress)}`,
      ).toBe(false);
    }
  });

  it("basta con que quede uno sin ver, no tiene que ser el del área de trabajo", () => {
    // Quien ya hizo el general pero no ha tocado montaje ni directo sigue
    // teniendo algo que descubrir, y ése es el momento de contárselo.
    expect(
      shouldOfferToursOnSessionOpen({
        ...base,
        progress: { workspace: "completed" },
      }),
    ).toBe(true);
  });

  it("calla cuando ya se han visto los tres", () => {
    expect(
      shouldOfferToursOnSessionOpen({
        ...base,
        progress: {
          workspace: "completed",
          daw: "completed",
          live: "completed",
        },
      }),
    ).toBe(false);
  });

  it("sólo una vez por arranque de la app", () => {
    // Abrir tres sesiones seguidas no debe sacar el menú tres veces.
    expect(
      shouldOfferToursOnSessionOpen({
        ...base,
        alreadyOffered: true,
        progress: {},
      }),
    ).toBe(false);
  });

  it("no interrumpe un recorrido en marcha", () => {
    expect(
      shouldOfferToursOnSessionOpen({
        ...base,
        isTourActive: true,
        progress: {},
      }),
    ).toBe(false);
  });

  it("no dispara bajo WebDriver ni en tests", () => {
    expect(
      shouldOfferToursOnSessionOpen({ ...base, isWebDriver: true, progress: {} }),
    ).toBe(false);
    expect(
      shouldOfferToursOnSessionOpen({ ...base, isTestRun: true, progress: {} }),
    ).toBe(false);
  });
});
