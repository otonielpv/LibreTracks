// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [],
  sectionMarkers: [{ id: "m1", name: "Estrofa", startSeconds: 8 }],
  clips: [{ id: "c1", trackId: "t1", timelineStartSeconds: 0, durationSeconds: 4 }],
  tracks: [{ id: "t1", name: "Voz", kind: "audio" }],
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
  tempoMarkerContextMenu: () => [],
  timeSignatureMarkerContextMenu: () => [],
  songRegionContextMenu: () => [],
  trackContextMenu: () => [],
};

const creation = {
  onCreateSection: vi.fn(),
  onCreateCue: vi.fn(),
  onAddAudios: vi.fn(),
};

function renderBar(overrides: Partial<Parameters<typeof MobileSelectionActionBar>[0]> = {}) {
  const props = {
    song,
    selectedRegionId: null,
    menus,
    creation,
    onOpenSheet: vi.fn(),
    onClearSelection: vi.fn(),
    ...overrides,
  };
  render(<MobileSelectionActionBar {...props} />);
  return props;
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = true;
  vi.clearAllMocks();
  useTimelineUIStore.getState().clearSelection();
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

  it("permite soltar la seleccion sin tocar el audio", () => {
    useTimelineUIStore.getState().selectClip("c1");
    const props = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Quitar selección" }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });
});
