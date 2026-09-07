// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { MobilePreparation } from "./MobilePreparation";
import { useSongStore } from "../songStore";
import { useTimelineUIStore } from "../uiStore";
import { createSectionMarker, createAudioTracksWithClips, type SongView, type TransportSnapshot } from "../desktopApi";
import { BASE_PIXELS_PER_SECOND } from "../timeline/timelineMath";
import type { MobilePreparationProps } from "./types";

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("../desktopApi", async (original) => ({ ...(await original<object>()), get isMobileApp() { return platform.mobile; },
  createSectionMarker: vi.fn(async () => ({})), createAudioTracksWithClips: vi.fn(async () => ({})),
}));
const song: SongView = { id: "project", title: "Test", bpm: 120, timeSignature: "4/4", durationSeconds: 60, tempoMarkers: [], timeSignatureMarkers: [], regions: [], sectionMarkers: [], clips: [], tracks: [], projectRevision: 0 };
let props: MobilePreparationProps;
beforeEach(async () => {
  await i18n.changeLanguage("es"); platform.mobile = true; vi.clearAllMocks(); window.localStorage.clear();
  useSongStore.getState().setSong(song); useTimelineUIStore.setState({ viewMode: "daw", mobileTimelineTool: "navigate", zoomLevel: 7, cameraX: 0 });
  props = { positionRef: { current: 12.345 }, assets: [{ fileName: "Drums.wav", filePath: "/Drums.wav", durationSeconds: 60, isMissing: false }], importing: false,
    routes: [], fitZoomLevel: 0.4, laneViewportWidth: 400, onImport: vi.fn(), onLibrary: vi.fn(), onSettings: vi.fn(), onSave: vi.fn(), onSnapshot: vi.fn(), refreshSong: vi.fn(async () => {}), onCreateCue: vi.fn(), onEditCue: vi.fn(), normalizeSeconds: (seconds) => seconds };
});
afterEach(cleanup);

/** Arranca cerrado a propósito; las tareas de montaje se prueban tras abrirlo. */
function renderOpen() {
  const result = render(<MobilePreparation {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Preparar" }));
  return result;
}

describe("native mobile preparation", () => {
  it("does not render in desktop, regardless of window width", () => {
    platform.mobile = false; render(<MobilePreparation {...props} />);
    expect(screen.queryByRole("button", { name: "Preparar" })).toBeNull();
  });
  it("starts closed so opening the app for a rehearsal keeps the usual view", () => {
    render(<MobilePreparation {...props} />);
    expect(screen.queryByRole("button", { name: "Marcas" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preparar" }).getAttribute("aria-pressed")).toBe("false");
  });
  it("reopens where the user left it on the next launch", () => {
    const first = render(<MobilePreparation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Preparar" }));
    first.unmount();
    render(<MobilePreparation {...props} />);
    expect(screen.getByRole("button", { name: "Marcas" })).toBeTruthy();
  });
  it("captures a marker time before playback advances and preserves it when naming", async () => {
    renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Marcas" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Marca en el cabezal" }));
    props.positionRef.current = 40;
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Intro" } });
    fireEvent.submit(screen.getByLabelText("Nombre").closest("form")!);
    await waitFor(() => expect(createSectionMarker).toHaveBeenCalledWith(12.345, { kind: "custom", variant: null, name: "Intro" }));
    expect(props.onSnapshot).toHaveBeenCalled();
  });
  it("imports into the library without an implicit timeline placement", () => {
    renderOpen(); fireEvent.click(screen.getByRole("button", { name: "Importar audios" }));
    expect(props.onImport).toHaveBeenCalledWith({ placeAfterImport: false });
  });
  it("adds aligned stems at the displayed destination, not a later playhead", async () => {
    renderOpen();
    fireEvent.click(screen.getByLabelText(/Drums.wav/)); props.positionRef.current = 50;
    fireEvent.click(screen.getByRole("button", { name: /Añadir ·/ }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir" }));
    await waitFor(() => expect(createAudioTracksWithClips).toHaveBeenCalledWith([{ filePath: "/Drums.wav", trackName: "Drums", timelineStartSeconds: 12.345 }]));
  });
  it("keeps marker input after a backend error and permits retry", async () => {
    vi.mocked(createSectionMarker).mockRejectedValueOnce(new Error("disk full"));
    renderOpen(); fireEvent.click(screen.getByRole("button", { name: "Marcas" })); fireEvent.click(screen.getByRole("button", { name: "+ Marca en el cabezal" }));
    fireEvent.submit(screen.getByLabelText("Nombre").closest("form")!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
    expect((screen.getByLabelText("Posición en la sesión (segundos)") as HTMLInputElement).value).toBe("12.345");
    vi.mocked(createSectionMarker).mockResolvedValueOnce({} as TransportSnapshot);
  });
  it("leaves all three performance/editing views reachable", () => {
    render(<MobilePreparation {...props} />);
    for (const [label, view] of [["DAW", "daw"], ["Compacta", "compact"], ["Live", "live"]]) {
      fireEvent.click(screen.getByRole("button", { name: label })); expect(useTimelineUIStore.getState().viewMode).toBe(view);
    }
  });
  it("frames the whole session with the measured lane width, not the header column", () => {
    render(<MobilePreparation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver toda la sesión" }));
    expect(useTimelineUIStore.getState().zoomLevel).toBe(0.4);
    expect(useTimelineUIStore.getState().cameraX).toBe(0);
  });
  it("centres the playhead instead of pinning it to the left edge", () => {
    render(<MobilePreparation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Volver al cabezal" }));
    const { zoomLevel, cameraX } = useTimelineUIStore.getState();
    expect(cameraX).toBeCloseTo(12.345 * zoomLevel * BASE_PIXELS_PER_SECOND - 200, 5);
  });
});
