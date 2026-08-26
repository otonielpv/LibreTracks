import { afterEach, describe, expect, it, vi } from "vitest";

import { act, en, fireEvent, render, screen, waitFor } from "../../test/testUtils";
import { useSongStore } from "../transport/songStore";
import { TourLauncherButton } from "./TourLauncherButton";
import { TourOverlay } from "./TourOverlay";
import { subscribeWorkspaceContinuation, useTourStore } from "./tourStore";
import { TOUR_TARGETS } from "./tourTargets";

const landing = en.tutorial.landing.steps;
const workspace = en.tutorial.workspace.steps;

/** Un elemento con anclaje, para los pasos que iluminan un control. */
const mountedAnchors: HTMLElement[] = [];

function mountAnchor(target: string): HTMLElement {
  const element = document.createElement("button");
  element.setAttribute("data-lt-tour", target);
  document.body.appendChild(element);
  mountedAnchors.push(element);
  return element;
}

/**
 * `testUtils` deja los recorridos marcados como vistos para que ninguno
 * arranque solo en los tests de la app; aquí lo limpiamos para que "queda
 * marcado como terminado" signifique algo.
 */
function clearProgress(): void {
  act(() => {
    useTourStore.setState({ progress: {} });
  });
}

function startTour(tourId: "landing" | "workspace"): void {
  clearProgress();
  act(() => {
    useTourStore.getState().startTour(tourId, "desktop");
  });
}

/** Salta al paso que interesa sin pulsar "Siguiente" media docena de veces. */
function goToStep(stepId: string): void {
  const index = useTourStore
    .getState()
    .steps.findIndex((step) => step.id === stepId);
  expect(index, `no existe el paso "${stepId}"`).toBeGreaterThanOrEqual(0);
  act(() => {
    useTourStore.setState({ stepIndex: index });
  });
}

afterEach(() => {
  // Sólo los que montamos a mano: `TourLauncherButton` también lleva anclaje y
  // arrancárselo del DOM rompe la limpieza de Testing Library.
  while (mountedAnchors.length > 0) {
    mountedAnchors.pop()?.remove();
  }
});

describe("TourOverlay", () => {
  it("no pinta nada mientras no hay recorrido activo", () => {
    render(<TourOverlay />);

    expect(document.querySelector(".lt-tour-root")).toBeNull();
  });

  it("abre por el primer paso y nombra el recorrido en el progreso", () => {
    render(<TourOverlay />);
    startTour("landing");

    const total = useTourStore.getState().steps.length;
    expect(screen.getByText(landing.welcome.title)).toBeTruthy();
    expect(
      screen.getByText(`${en.tutorial.landing.name} · step 1 of ${total}`),
    ).toBeTruthy();
  });

  it("publica en el DOM qué recorrido y qué paso está mostrando", () => {
    // Es el asidero de los E2E, que corren con la app en español: sin esto
    // tendrían que afirmar sobre texto traducido.
    render(<TourOverlay />);
    startTour("landing");

    const root = document.querySelector(".lt-tour-root");
    expect(root?.getAttribute("data-tour-id")).toBe("landing");
    expect(root?.getAttribute("data-tour-step")).toBe("welcome");

    fireEvent.click(screen.getByText(en.tutorial.next));
    expect(
      document.querySelector(".lt-tour-root")?.getAttribute("data-tour-step"),
    ).toBe("create");
  });

  it("avanza y retrocede con los botones", () => {
    render(<TourOverlay />);
    startTour("landing");

    fireEvent.click(screen.getByText(en.tutorial.next));
    expect(screen.getByText(landing.create.title)).toBeTruthy();

    fireEvent.click(screen.getByText(en.tutorial.back));
    expect(screen.getByText(landing.welcome.title)).toBeTruthy();
  });

  it("ilumina el control cuando su anclaje está en pantalla", () => {
    mountAnchor(TOUR_TARGETS.landingCreate);
    render(<TourOverlay />);
    startTour("landing");
    fireEvent.click(screen.getByText(en.tutorial.next));

    expect(document.querySelector(".lt-tour-spotlight")).not.toBeNull();
    expect(document.querySelector(".lt-tour-dim")).toBeNull();
  });

  it("cae a tarjeta centrada cuando el anclaje no existe", () => {
    // Pasa de verdad: el botón Remote no existe en móvil, y el lienzo del
    // timeline no existe fuera de la vista DAW. El paso se explica igual, sin
    // foco, en vez de romperse.
    render(<TourOverlay />);
    startTour("landing");
    fireEvent.click(screen.getByText(en.tutorial.next));

    expect(document.querySelector(".lt-tour-spotlight")).toBeNull();
    expect(document.querySelector(".lt-tour-dim")).not.toBeNull();
  });

  it("el foco no se anima al aparecer, sólo al moverse", async () => {
    // Sin esto el foco entra volando desde la esquina (0,0) hasta su sitio,
    // porque la transición CSS también corre en el primer pintado. Lo destapó
    // el E2E de geometría, que medía a mitad de vuelo.
    mountAnchor(TOUR_TARGETS.landingCreate);
    render(<TourOverlay />);
    startTour("landing");
    fireEvent.click(screen.getByText(en.tutorial.next));

    expect(
      document.querySelector(".lt-tour-spotlight")?.className,
    ).not.toContain("is-settled");

    // Un frame después la animación queda habilitada para los saltos entre
    // controles, que sí deben deslizarse.
    await waitFor(() => {
      expect(
        document.querySelector(".lt-tour-spotlight")?.className,
      ).toContain("is-settled");
    });
  });

  it("el último paso cierra el recorrido y lo marca como terminado", () => {
    render(<TourOverlay />);
    startTour("landing");

    // Por posición y no por texto: en los pasos interactivos el botón pasa a
    // ser "Saltar este paso", porque el camino esperado es que el usuario haga
    // la acción de verdad.
    const advance = () => {
      const buttons = document.querySelectorAll(
        ".lt-tour-actions-main button",
      );
      fireEvent.click(buttons[buttons.length - 1]);
    };

    const total = useTourStore.getState().steps.length;
    for (let index = 0; index < total; index += 1) {
      advance();
    }

    expect(document.querySelector(".lt-tour-root")).toBeNull();
    expect(useTourStore.getState().progress.landing).toBe("completed");
  });

  it("Escape sale de la guía y cuenta como descartada", () => {
    render(<TourOverlay />);
    startTour("landing");

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(document.querySelector(".lt-tour-root")).toBeNull();
    expect(useTourStore.getState().progress.landing).toBe("dismissed");
  });

  it("las flechas avanzan la guía y no llegan al timeline", () => {
    // Las flechas son `edit.nudgeLeft/Right`: sin cortar la propagación,
    // pasar de paso movería los clips del usuario. El listener del timeline
    // está en `window` en fase de burbuja, así que despachamos desde un
    // elemento —como haría el navegador— y no directamente sobre `window`.
    const timelineListener = vi.fn();
    window.addEventListener("keydown", timelineListener);
    render(<TourOverlay />);
    startTour("landing");

    fireEvent.keyDown(document.body, { key: "ArrowRight" });

    expect(useTourStore.getState().stepIndex).toBe(1);
    expect(timelineListener).not.toHaveBeenCalled();

    window.removeEventListener("keydown", timelineListener);
  });
});

describe("pasos interactivos", () => {
  it("espera al usuario y deja un hueco en el escudo para que pueda pulsar", () => {
    mountAnchor(TOUR_TARGETS.sideNavSettings);
    render(<TourOverlay />);
    startTour("landing");
    goToStep("openSettings");

    const root = document.querySelector(".lt-tour-root");
    expect(root?.getAttribute("data-tour-awaiting")).toBe("true");
    expect(screen.getByText(en.tutorial.waiting)).toBeTruthy();

    // Cuatro bandas alrededor del control en vez de un escudo entero: sin el
    // hueco, el clic que la guía pide no llegaría nunca al botón.
    const shields = document.querySelectorAll(".lt-tour-shield");
    expect(shields.length).toBe(4);
    expect(document.querySelector(".lt-tour-shield.is-full")).toBeNull();
  });

  it("avanza solo cuando el usuario abre lo que se le pide", async () => {
    mountAnchor(TOUR_TARGETS.sideNavSettings);
    render(<TourOverlay />);
    startTour("landing");
    goToStep("openSettings");

    // Abrir los ajustes monta el modal, que es justo lo que la guía observa.
    act(() => {
      mountAnchor(TOUR_TARGETS.settingsModal);
    });

    await waitFor(() => {
      expect(
        document.querySelector(".lt-tour-root")?.getAttribute("data-tour-step"),
      ).toBe("settingsTour");
    });
  });

  it("el paso de cerrar espera a que el panel desaparezca", async () => {
    const modal = mountAnchor(TOUR_TARGETS.settingsModal);
    mountAnchor(TOUR_TARGETS.settingsClose);
    render(<TourOverlay />);
    startTour("landing");
    goToStep("closeSettings");

    expect(
      document.querySelector(".lt-tour-root")?.getAttribute("data-tour-awaiting"),
    ).toBe("true");

    act(() => {
      modal.remove();
    });

    await waitFor(() => {
      expect(
        document.querySelector(".lt-tour-root")?.getAttribute("data-tour-step"),
      ).toBe("next");
    });
  });

  it("no rebota hacia delante si la condición ya se cumplía al entrar", () => {
    // Si auto-avanzáramos con la condición ya satisfecha, volver atrás desde el
    // paso siguiente sería imposible: rebotaría al instante.
    mountAnchor(TOUR_TARGETS.sideNavSettings);
    mountAnchor(TOUR_TARGETS.settingsModal);
    render(<TourOverlay />);
    startTour("landing");
    goToStep("openSettings");

    const root = document.querySelector(".lt-tour-root");
    expect(root?.getAttribute("data-tour-step")).toBe("openSettings");
    expect(root?.getAttribute("data-tour-awaiting")).toBe("false");
    // Y con la condición cumplida el escudo vuelve a ser uno solo.
    expect(document.querySelector(".lt-tour-shield.is-full")).not.toBeNull();
  });
});

describe("el botón GUÍA elige el recorrido según la pantalla", () => {
  it("sin sesión abierta lanza el de la pantalla de inicio", () => {
    render(
      <>
        <TourLauncherButton />
        <TourOverlay />
      </>,
    );
    clearProgress();

    fireEvent.click(screen.getByText(en.tutorial.launch));

    expect(screen.getByText(landing.welcome.title)).toBeTruthy();
  });

  it("con sesión abierta lanza el del área de trabajo", () => {
    // Este es el reparto que justifica los dos recorridos: hasta que no hay
    // proyecto cargado no existen ni la línea de tiempo ni las vistas.
    render(
      <>
        <TourLauncherButton />
        <TourOverlay />
      </>,
    );
    clearProgress();
    act(() => {
      useSongStore.setState({ song: { id: "s1" } as never });
    });

    fireEvent.click(screen.getByText(en.tutorial.launch));

    expect(screen.getByText(workspace.overview.title)).toBeTruthy();
  });
});

describe("continuación al abrir una sesión", () => {
  it("sigue sola con el área de trabajo sin volver a pulsar GUÍA", () => {
    // El cableado real: la suscripción escucha al store de canciones. Se prueba
    // con `isTestRun: false` porque en un test todos los arranques automáticos
    // están desactivados a propósito.
    act(() => {
      useTourStore.setState({ progress: { landing: "completed" } });
      useSongStore.setState({ song: null });
    });
    const unsubscribe = subscribeWorkspaceContinuation({
      isWebDriver: false,
      isTestRun: false,
    });

    render(<TourOverlay />);
    act(() => {
      useSongStore.setState({ song: { id: "s1" } as never });
    });

    expect(screen.getByText(workspace.overview.title)).toBeTruthy();
    unsubscribe();
  });

  it("no sigue sola si el usuario había saltado la guía de inicio", () => {
    act(() => {
      useTourStore.setState({ progress: { landing: "dismissed" } });
      useSongStore.setState({ song: null });
    });
    const unsubscribe = subscribeWorkspaceContinuation({
      isWebDriver: false,
      isTestRun: false,
    });

    render(<TourOverlay />);
    act(() => {
      useSongStore.setState({ song: { id: "s1" } as never });
    });

    expect(document.querySelector(".lt-tour-root")).toBeNull();
    unsubscribe();
  });
});
