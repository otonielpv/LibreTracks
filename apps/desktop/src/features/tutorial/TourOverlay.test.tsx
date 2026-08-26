import { afterEach, describe, expect, it, vi } from "vitest";

import { act, en, fireEvent, render, screen } from "../../test/testUtils";
import { useSongStore } from "../transport/songStore";
import { TourLauncherButton } from "./TourLauncherButton";
import { TourOverlay } from "./TourOverlay";
import { useTourStore } from "./tourStore";
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
 * marcado como visto" signifique algo.
 */
function clearSeen(): void {
  act(() => {
    useTourStore.setState({ seenTours: [] });
  });
}

function startTour(tourId: "landing" | "workspace"): void {
  clearSeen();
  act(() => {
    useTourStore.getState().startTour(tourId, "desktop");
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

  it("el último paso cierra el recorrido y lo marca como visto", () => {
    render(<TourOverlay />);
    startTour("landing");

    const total = useTourStore.getState().steps.length;
    for (let index = 0; index < total - 1; index += 1) {
      fireEvent.click(screen.getByText(en.tutorial.next));
    }
    fireEvent.click(screen.getByText(en.tutorial.finish));

    expect(document.querySelector(".lt-tour-root")).toBeNull();
    expect(useTourStore.getState().seenTours).toContain("landing");
  });

  it("Escape sale de la guía", () => {
    render(<TourOverlay />);
    startTour("landing");

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(document.querySelector(".lt-tour-root")).toBeNull();
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

describe("el botón GUÍA elige el recorrido según la pantalla", () => {
  it("sin sesión abierta lanza el de la pantalla de inicio", () => {
    render(
      <>
        <TourLauncherButton />
        <TourOverlay />
      </>,
    );
    clearSeen();

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
    clearSeen();
    act(() => {
      useSongStore.setState({ song: { id: "s1" } as never });
    });

    fireEvent.click(screen.getByText(en.tutorial.launch));

    expect(screen.getByText(workspace.overview.title)).toBeTruthy();
  });
});
