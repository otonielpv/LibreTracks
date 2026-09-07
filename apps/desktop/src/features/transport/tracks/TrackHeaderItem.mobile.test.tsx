// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackHeaderItem } from "./TrackHeaderItem";
import { useTimelineUIStore } from "../uiStore";
import { HEADER_WIDTH, MOBILE_HEADER_WIDTH } from "../constants";
import i18n from "../../../shared/i18n";

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  get isMobileApp() {
    return platform.mobile;
  },
}));

type Overrides = Partial<Parameters<typeof TrackHeaderItem>[0]>;

function renderHeader(overrides: Overrides = {}) {
  const props = {
    trackId: "t1",
    trackName: "Voz",
    trackKind: "audio" as const,
    hasParent: false,
    trackDepth: 0,
    childCount: 0,
    trackHeight: 40,
    panValue: 0,
    trackMuted: false,
    trackSolo: false,
    trackTransposeEnabled: false,
    volumeValue: 1,
    audioTo: "master",
    audioRoutingOptions: [{ value: "master", label: "Master" }],
    isCollapsed: false,
    isSelected: false,
    isDropTarget: false,
    dropMode: null,
    isDragging: false,
    densityClass: "",
    onSelectTrack: vi.fn(),
    onOpenContextMenu: vi.fn(),
    onStartTrackDrag: vi.fn(),
    onToggleFolder: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleSolo: vi.fn(),
    onToggleTranspose: vi.fn(),
    onVolumeChange: vi.fn(),
    onCommitVolume: vi.fn(),
    onPanChange: vi.fn(),
    onCommitPan: vi.fn(),
    onAudioToChange: vi.fn(),
    ...overrides,
  };
  render(<TrackHeaderItem {...props} />);
  return props;
}

const mute = () => screen.queryByRole("button", { name: "Silenciar" });
const solo = () => screen.queryByRole("button", { name: "Solo" });
/** El panel desplegado: es lo unico que trae el fader de volumen. */
const panel = () => screen.queryByLabelText("Volumen de Voz");
const tapHeader = () => fireEvent.click(screen.getByText("Voz"));

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = true;
  useTimelineUIStore.setState({ expandedTrackId: null, trackReorderMode: false });
});
afterEach(cleanup);

describe("cabeceras finas y expansion en fila", () => {
  it("el audio gana el ancho que hoy ocupa la columna", () => {
    // La regla de portrait nunca se aplica -Android fija sensorLandscape-, asi
    // que 260 px se llevaban el ancho antes del primer pixel de audio.
    expect(MOBILE_HEADER_WIDTH).toBeLessThan(HEADER_WIDTH);
  });

  it("en movil la cabecera lleva nombre y estado, y nada mas", () => {
    renderHeader();
    expect(screen.getByText("Voz")).toBeTruthy();
    // Mute y solo son el ESTADO: se pulsan mientras suena y comparando entre
    // pistas, asi que no pueden costar un despliegue cada uno.
    expect(mute()).toBeTruthy();
    expect(solo()).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("en escritorio la cabecera no cambia", () => {
    platform.mobile = false;
    renderHeader();
    expect(mute()).toBeTruthy();
    expect(panel()).toBeTruthy();
  });

  it("un toque despliega la fila con sus controles; otro la cierra", () => {
    renderHeader();
    tapHeader();
    expect(useTimelineUIStore.getState().expandedTrackId).toBe("t1");
    expect(panel()).toBeTruthy();

    tapHeader();
    expect(useTimelineUIStore.getState().expandedTrackId).toBeNull();
    expect(panel()).toBeNull();
  });

  it("reordenando, el dedo es para mover pistas: no despliega nada", () => {
    useTimelineUIStore.setState({ trackReorderMode: true });
    renderHeader();
    tapHeader();
    expect(useTimelineUIStore.getState().expandedTrackId).toBeNull();
    expect(panel()).toBeNull();
  });

  it("desplegar no impide seleccionar: el toque hace las dos cosas", () => {
    const props = renderHeader();
    tapHeader();
    expect(props.onSelectTrack).toHaveBeenCalledTimes(1);
  });

  it("mute y solo van a UN toque, sin desplegar", () => {
    const props = renderHeader();
    fireEvent.click(mute()!);
    expect(props.onToggleMute).toHaveBeenCalledWith("t1");
    expect(useTimelineUIStore.getState().expandedTrackId).toBeNull();
  });

  it("el resto sigue alcanzable en dos toques", () => {
    const props = renderHeader();
    tapHeader(); // 1: despliega
    fireEvent.change(panel()!, { target: { value: "0.5" } }); // 2: actua
    expect(props.onVolumeChange).toHaveBeenCalled();
  });

  it("con la fila al minimo se salva el nombre, no los botones", () => {
    // Los botones eran mas altos que una fila de 18 px: estiraban la cabecera,
    // que recorta lo que sobresale, y se llevaban por delante TAMBIEN el
    // nombre. Saber de que pista es la fila importa mas que el mute.
    renderHeader({ trackHeight: 18 });
    expect(screen.getByText("Voz")).toBeTruthy();
    expect(mute()).toBeNull();
  });

  it("en cuanto la fila da de si, el estado vuelve", () => {
    renderHeader({ trackHeight: 30 });
    expect(screen.getByText("Voz")).toBeTruthy();
    expect(mute()).toBeTruthy();
  });

  it("solo hay una fila desplegada a la vez", () => {
    useTimelineUIStore.getState().toggleExpandedTrackId("otra");
    renderHeader();
    tapHeader();
    expect(useTimelineUIStore.getState().expandedTrackId).toBe("t1");
  });

  it("el panel sale FUERA de la cabecera, que recorta lo que sobresale", () => {
    renderHeader();
    tapHeader();
    const panel = document.querySelector(".lt-mobile-track-row-panel");
    expect(panel).not.toBeNull();
    // `.lt-track-header` tiene overflow: hidden; dentro, el panel se cortaria.
    expect(panel!.closest(".lt-track-header")).toBeNull();
  });
});
