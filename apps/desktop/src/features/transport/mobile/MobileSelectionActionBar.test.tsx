// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSelectionActionBar } from "./MobileSelectionActionBar";
import type { MobileSelectionMenus } from "./selectionActions";
import type { ContextMenuAction } from "../types";
import type { SongView } from "../desktopApi";
import { useTimelineUIStore } from "../uiStore";
import i18n from "../../../shared/i18n";

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  get isMobileApp() {
    return platform.mobile;
  },
}));

const song = {
  id: "s",
  title: "Sesion",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 100,
  tempoMarkers: [{ id: "tempo-1", startSeconds: 4, bpm: 90 }],
  timeSignatureMarkers: [{ id: "ts-1", startSeconds: 6, signature: "3/4" }],
  regions: [],
  sectionMarkers: [{ id: "m1", name: "Estrofa", startSeconds: 8 }],
  clips: [{ id: "c1", trackId: "t1", timelineStartSeconds: 0, durationSeconds: 4 }],
  tracks: [
    { id: "t1", name: "Voz", kind: "audio", volume: 1, pan: 0, audioTo: "master" },
    { id: "t2", name: "Bajo", kind: "audio", volume: 1, pan: 0, audioTo: "master" },
  ],
  projectRevision: 1,
} as unknown as SongView;

/** Cinco acciones: mas de las que caben en la barra. */
const markerActions: ContextMenuAction[] = [
  "Ir a la marca",
  "Renombrar",
  "Tipo de marca",
  "Color",
  "Eliminar",
].map((label) => ({ label, onSelect: vi.fn() }));

const menus: MobileSelectionMenus = {
  clipContextMenu: () => [{ label: "Eliminar", onSelect: vi.fn() }],
  sectionContextMenu: () => markerActions,
  tempoMarkerContextMenu: () => [{ label: "Cambiar BPM", onSelect: vi.fn() }],
  timeSignatureMarkerContextMenu: () => [
    { label: "Cambiar compas", onSelect: vi.fn() },
  ],
  songRegionContextMenu: () => [],
  trackContextMenu: () => [{ label: "Renombrar", onSelect: vi.fn() }],
  multiTrackContextMenu: () => [{ label: "Eliminar", onSelect: vi.fn() }],
};

const mix = {
  setVolume: vi.fn(),
  commitVolume: vi.fn(),
  setPan: vi.fn(),
  commitPan: vi.fn(),
  setAudioTo: vi.fn(),
  toggleTranspose: vi.fn(),
};

const creation = {
  onCreateSection: vi.fn(),
  onCreateCue: vi.fn(),
  onAddAudios: vi.fn(),
  onCreateTempoMarker: vi.fn(),
  onCreateTimeSignatureMarker: vi.fn(),
};

function renderBar(overrides: Partial<Parameters<typeof MobileSelectionActionBar>[0]> = {}) {
  const props = {
    song,
    selectedRegionId: null,
    menus,
    creation,
    onOpenSheet: vi.fn(),
    onClearSelection: vi.fn(),
    mix,
    audioRoutingOptions: [{ value: "master", label: "Master" }],
    ...overrides,
  };
  render(<MobileSelectionActionBar {...props} />);
  return props;
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = true;
  vi.clearAllMocks();
  window.localStorage.clear();
  useTimelineUIStore.getState().clearSelection();
  useTimelineUIStore.setState({
    selectionMixOpen: false,
    expandedTrackId: null,
    clipMultiSelect: false,
  });
});
afterEach(cleanup);

describe("la barra de la seleccion, generalizada", () => {
  it("no aparece en escritorio", () => {
    platform.mobile = false;
    renderBar();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("no llama a las factories antes de que tengan dependencias", () => {
    renderBar({ menus: null });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("sin seleccion propone crear, sin aspa que quitar", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Sección" }));
    expect(creation.onCreateSection).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Aviso" }));
    expect(creation.onCreateCue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    expect(creation.onAddAudios).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Quitar selección" })).toBeNull();
  });

  it("tempo y compas se crean desde la barra, tras los puntos", () => {
    const onOpenSheet =
      vi.fn<(title: string, actions: ContextMenuAction[]) => void>();
    renderBar({ onOpenSheet });
    // Van los ultimos porque son lo menos frecuente montando, pero se llega a
    // ellos sin clic derecho, que en tactil no existe.
    fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
    const labels = onOpenSheet.mock.calls
      .at(-1)![1]
      .map((entry) => entry.label);
    expect(labels).toContain("Tempo");
    expect(labels).toContain("Compás");
  });

  it("seleccionar una marca de tempo ensena sus acciones", () => {
    useTimelineUIStore.getState().selectTempoMarker("tempo-1");
    renderBar();
    expect(screen.getByRole("button", { name: "Cambiar BPM" })).toBeTruthy();
  });

  it("seleccionar una marca de compas ensena las suyas", () => {
    useTimelineUIStore.getState().selectTimeSignatureMarker("ts-1");
    renderBar();
    expect(screen.getByRole("button", { name: "Cambiar compas" })).toBeTruthy();
  });

  it("seleccionar una marca muestra sus acciones sin mantener pulsado", () => {
    useTimelineUIStore.getState().selectSection("m1");
    renderBar();
    expect(screen.getByRole("toolbar").textContent).toContain("Estrofa");
    fireEvent.click(screen.getByRole("button", { name: "Ir a la marca" }));
    expect(markerActions[0].onSelect).toHaveBeenCalledTimes(1);
  });

  it("lo que no cabe en la barra no se pierde: los puntos abren la lista ENTERA", () => {
    useTimelineUIStore.getState().selectSection("m1");
    const props = renderBar();

    // Cinco acciones, tres en la barra.
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
    expect(props.onOpenSheet).toHaveBeenCalledWith(
      "Estrofa",
      markerActions,
    );
  });

  it("no ofrece los puntos cuando ya se ven todas", () => {
    useTimelineUIStore.getState().selectClip("c1");
    renderBar();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Más acciones" })).toBeNull();
  });

  it("se puede recoger, y recogida deja una pestana para volver", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar acciones" }));
    expect(screen.queryByRole("toolbar")).toBeNull();

    // Esconderla del todo devolveria el problema que vino a resolver.
    fireEvent.click(screen.getByRole("button", { name: "Mostrar acciones" }));
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  it("recogida sigue recogida al reabrir la app", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar acciones" }));
    cleanup();

    renderBar();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar acciones" })).toBeTruthy();
  });

  it("de fabrica se ve: es la respuesta a no saber por donde empezar", () => {
    renderBar();
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  it("con una pista ofrece sumar mas, para borrarlas de un tiron", () => {
    useTimelineUIStore.getState().selectTrack(["t1"]);
    renderBar();
    // Con un dedo no hay Ctrl que mantener.
    useTimelineUIStore.getState().setExpandedTrackId("t1");
    fireEvent.click(
      screen.getByRole("button", { name: "Seleccionar varias pistas" }),
    );
    expect(useTimelineUIStore.getState().trackMultiSelect).toBe(true);
    // La pista sigue seleccionada; lo que se va es su panel de faders, que
    // estorba justo cuando vas a ir tocando otras cabeceras.
    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual(["t1"]);
    expect(useTimelineUIStore.getState().expandedTrackId).toBeNull();
  });

  it("con varias pistas las acciones son las del menu de varias", () => {
    useTimelineUIStore.getState().selectTrack(["t1", "t2"]);
    renderBar();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy();
    expect(screen.getByRole("toolbar").textContent).toContain("2");
  });

  it("sin pista seleccionada no ofrece sumar pistas", () => {
    renderBar();
    expect(
      screen.queryByRole("button", { name: "Seleccionar varias pistas" }),
    ).toBeNull();
  });

  it("permite soltar la seleccion sin tocar el audio", () => {
    useTimelineUIStore.getState().selectClip("c1");
    const props = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Quitar selección" }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("la mezcla de la seleccion", () => {
  // En movil la cabecera de pista se queda en el nombre y el par mute/solo, asi
  // que sin este boton no hay ninguna via para tocar volumen, paneo o salida de
  // varias pistas a la vez.
  it("abre el panel de una pista, aplicado a la seleccion entera", () => {
    useTimelineUIStore.setState({ selectedTrackIds: ["t1", "t2"] });
    renderBar();

    expect(screen.queryByLabelText("Volumen de Voz")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mezcla" }));

    expect(screen.getByText("Se aplica a las 2 pistas seleccionadas")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Volumen de Voz"), {
      target: { value: "0.4" },
    });
    // Se le habla a UNA pista: los handlers de la cabecera reparten al resto.
    expect(mix.setVolume).toHaveBeenCalled();
    expect(mix.setVolume.mock.calls[0][0]).toBe("t1");

    fireEvent.click(screen.getByRole("button", { name: "Mezcla" }));
    expect(screen.queryByLabelText("Volumen de Voz")).toBeNull();
  });

  // El panel de la barra y la fila desplegada de una cabecera son el MISMO
  // panel: con una sola pista seleccionada salian los dos, uno debajo del otro.
  it("no convive con la fila desplegada de una cabecera", () => {
    useTimelineUIStore.setState({ selectedTrackIds: ["t1"] });
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Mezcla" }));
    expect(useTimelineUIStore.getState().expandedTrackId).toBeNull();

    // Y desplegar una cabecera cierra el de la barra.
    act(() => {
      useTimelineUIStore.getState().toggleExpandedTrackId("t1");
    });
    expect(useTimelineUIStore.getState().selectionMixOpen).toBe(false);
    expect(screen.queryByLabelText("Volumen de Voz")).toBeNull();
  });

  it("no se ofrece cuando lo seleccionado no son pistas", () => {
    useTimelineUIStore.setState({ selectedClipIds: ["c1"] });
    renderBar();
    expect(screen.queryByRole("button", { name: "Mezcla" })).toBeNull();
  });
});

describe("sumar clips desde la barra", () => {
  // Con un dedo no hay Ctrl que mantener: sin el boton no hay forma de juntar
  // varios clips para moverlos o borrarlos de un tiron. El de pistas ya
  // existia; este es el mismo boton para la otra mitad.
  it("ofrece el modo de sumar cuando lo seleccionado son clips", () => {
    useTimelineUIStore.setState({ selectedClipIds: ["c1"] });
    renderBar();

    const button = screen.getByRole("button", {
      name: "Seleccionar varios clips",
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    expect(useTimelineUIStore.getState().clipMultiSelect).toBe(true);
    // Un modo sin rastro en pantalla es un modo que nadie encuentra.
    expect(screen.getByText("Toca más clips")).toBeTruthy();
  });

  it("no lo ofrece sin nada seleccionado", () => {
    renderBar();
    expect(
      screen.queryByRole("button", { name: "Seleccionar varios clips" }),
    ).toBeNull();
  });
});
