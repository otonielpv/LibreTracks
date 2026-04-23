import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

async function renderApp() {
  const { App } = await import("./App");
  const view = render(<App />);
  await screen.findByText(/modo demo web activo/i);
  await screen.findByText("Rhythm");
  return view;
}

function mockRulerBounds(container: HTMLElement) {
  const rulerTrack = container.querySelector(".lt-ruler-track") as HTMLDivElement | null;
  expect(rulerTrack).toBeTruthy();

  Object.defineProperty(rulerTrack, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 1200,
      top: 0,
      bottom: 86,
      width: 1200,
      height: 86,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function mockTimelineShellMetrics(container: HTMLElement, width = 1400) {
  const shell = container.querySelector(".lt-timeline-shell") as HTMLDivElement | null;
  expect(shell).toBeTruthy();

  Object.defineProperty(shell, "clientWidth", {
    configurable: true,
    value: width,
  });

  Object.defineProperty(shell, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 0,
      bottom: 500,
      width,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(shell, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 0,
  });

  return shell as HTMLDivElement;
}

function mockLaneBounds(container: HTMLElement, width = 1140) {
  const lanes = Array.from(container.querySelectorAll(".lt-track-lane")) as HTMLDivElement[];
  expect(lanes.length).toBeGreaterThan(0);

  lanes.forEach((lane, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(lane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 260,
        right: 260 + width,
        top,
        bottom: top + 78,
        width,
        height: 78,
        x: 260,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });
}

function mockTrackListBounds(container: HTMLElement, width = 1400, height = 500) {
  const trackList = container.querySelector(".lt-track-list") as HTMLDivElement | null;
  expect(trackList).toBeTruthy();

  Object.defineProperty(trackList, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 64,
      bottom: 64 + height,
      width,
      height,
      x: 0,
      y: 64,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(trackList, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });
}

function getLibraryAssetButton(fileName: string) {
  const assetButton = document.querySelector(`.lt-library-asset[aria-label="${fileName}"]`);
  expect(assetButton).toBeTruthy();
  return assetButton as HTMLButtonElement;
}

function mockTrackRowDragGeometry(container: HTMLElement) {
  const rows = Array.from(container.querySelectorAll(".lt-track-row")) as HTMLDivElement[];
  expect(rows.length).toBeGreaterThan(0);

  rows.forEach((row, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1400,
        top,
        bottom: top + 78,
        width: 1400,
        height: 78,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });

  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((_x: number, y: number) => {
      return rows.find((_, index) => {
        const top = 120 + index * 84;
        return y >= top && y <= top + 78;
      }) ?? null;
    }),
  });
}

describe("App", () => {
  it("renders the timeline-centric DAW shell", async () => {
    const { container } = await renderApp();

    expect(screen.getByText("LIBRETRACKS")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reproducir/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pausar/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /detener/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByLabelText(/library panel/i)).toBeNull();
    expect(screen.queryByText(/submezclas/i)).toBeNull();
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

  it("toggles the library panel from the sidebar button", async () => {
    await renderApp();

    const libraryButton = screen.getByRole("button", { name: /library/i });
    expect(screen.queryByLabelText(/library panel/i)).toBeNull();

    await act(async () => {
      fireEvent.click(libraryButton);
    });

    expect(await screen.findByLabelText(/library panel/i)).toBeTruthy();
    expect(screen.getByText("drums.wav")).toBeTruthy();

    await act(async () => {
      fireEvent.click(libraryButton);
    });

    expect(screen.queryByLabelText(/library panel/i)).toBeNull();
  });

  it("supports transport shortcuts from the keyboard", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion iniciada/i)).toBeTruthy();
    expect(await screen.findByText("playing")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(/reproduccion pausada/i)).toBeTruthy();
    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("keeps folder tracks integrated in the same timeline box", async () => {
    await renderApp();

    expect(screen.getByText("Rhythm")).toBeTruthy();
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de rhythm/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /volumen de drums/i })).toBeTruthy();
  });

  it("shows library assets and exposes the drag payload for timeline drops", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    expect(screen.getByText("drums.wav")).toBeTruthy();
    expect(screen.getByText("bass.wav")).toBeTruthy();

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transferData.get(LIBRARY_ASSET_DRAG_MIME) ?? "[]")).toEqual([
      {
        file_path: "audio/drums.wav",
        durationSeconds: 180,
      },
    ]);
  });

  it("emits a multi-asset drag payload from the current library selection", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    await act(async () => {
      fireEvent.click(getLibraryAssetButton("drums.wav"));
      fireEvent.click(getLibraryAssetButton("bass.wav"), { ctrlKey: true });
    });

    expect(screen.getByText("2 selected")).toBeTruthy();

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(JSON.parse(transferData.get(LIBRARY_ASSET_DRAG_MIME) ?? "[]")).toEqual([
      {
        file_path: "audio/bass.wav",
        durationSeconds: 164,
      },
      {
        file_path: "audio/drums.wav",
        durationSeconds: 180,
      },
    ]);
  });

  it("drops a library asset onto a track lane and creates a new clip", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    const drumsRow = screen.getByText("Drums").closest(".lt-track-row");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
      fireEvent.drop(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(/clip agregado: drums\.wav/i)).toBeTruthy();
    expect(screen.getByText("5 clips")).toBeTruthy();
  });

  it("drops multiple library assets with the vertical modifier and creates stacked tracks and clips", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    const transferData = new Map<string, string>();
    transferData.set(
      LIBRARY_ASSET_DRAG_MIME,
      JSON.stringify([
        {
          file_path: "audio/drums.wav",
          durationSeconds: 180,
        },
        {
          file_path: "audio/bass.wav",
          durationSeconds: 160,
        },
      ]),
    );

    const dataTransfer = {
      dropEffect: "",
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    const drumsRow = screen.getByText("Drums").closest(".lt-track-row");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, {
        dataTransfer,
        clientX: 420,
        clientY: 160,
        ctrlKey: true,
      });
      fireEvent.drop(drumsLane as HTMLElement, {
        dataTransfer,
        clientX: 420,
        clientY: 160,
        ctrlKey: true,
      });
    });

    expect(await screen.findByText(/2 clips agregados desde la biblioteca\./i)).toBeTruthy();
    expect(await screen.findByText("8 tracks")).toBeTruthy();
    expect(await screen.findByText("6 clips")).toBeTruthy();
  });

  it("opens the global track-list context menu in an empty project and creates the first track", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    await desktopApi.createSong();

    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Narration");
    const { container } = await renderApp();

    expect(screen.getByLabelText(/empty arrangement dropzone/i)).toBeTruthy();

    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(trackList).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(trackList as HTMLElement, { clientX: 160, clientY: 240 });
    });

    expect(await screen.findByRole("button", { name: /add audio track/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add folder track/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add audio track/i }));
    });

    expect(promptSpy).toHaveBeenCalledWith("Nombre del track", "Audio track");
    expect(await screen.findByText(/track creado: narration/i)).toBeTruthy();
    expect(screen.getByText("Narration")).toBeTruthy();
  });

  it("creates a marker from the ruler right-click context menu", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(ruler, { clientX: 420, clientY: 32 });
    });

    expect(await screen.findByRole("button", { name: /create marker/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create marker/i }));
    });

    expect(await screen.findByText(/marca creada en/i)).toBeTruthy();
    expect(screen.getByText("Marker 5")).toBeTruthy();
  });

  it("opens the clip context menu and allows splitting at the cursor", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 320 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 320 });
      fireEvent.mouseUp(window, { button: 0, clientX: 320 });
    });

    const drumsRow = screen.getByText("Drums").closest(".lt-track-row");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(drumsLane as HTMLElement, { clientX: 320, clientY: 200 });
    });

    const splitAction = await screen.findByRole("button", { name: /cortar en cursor/i });
    expect(splitAction.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(splitAction);
    });

    expect(await screen.findByText(/clip cortado/i)).toBeTruthy();
    expect(screen.getByText("2 clips | pan 0.00")).toBeTruthy();
  });

  it("shows the marker context menu on right click", async () => {
    await renderApp();

    const introSection = await screen.findByRole("button", { name: "Intro" });
    await act(async () => {
      fireEvent.contextMenu(introSection, { clientX: 220, clientY: 120 });
    });

    const jumpNow = await screen.findByRole("button", { name: /jump to this marker/i });
    const context = jumpNow.closest(".lt-context-menu");
    expect(context).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /jump to this marker/i })).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /rename/i })).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("triggers marker jump with digit keys and cancels with escape", async () => {
    await renderApp();

    const modeSelect = await screen.findByRole("combobox", { name: /modo global de salto/i });
    await act(async () => {
      fireEvent.change(modeSelect, { target: { value: "next_marker" } });
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit2", key: "2" });
    });

    expect(await screen.findByText(/salto armado en la siguiente marca hacia verse/i)).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    });

    expect(await screen.findByText(/salto cancelado/i)).toBeTruthy();
  });

  it("maps numpad 0 to the first marker", async () => {
    await renderApp();

    const modeSelect = await screen.findByRole("combobox", { name: /modo global de salto/i });
    await act(async () => {
      fireEvent.change(modeSelect, { target: { value: "next_marker" } });
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Numpad0", key: "0" });
    });

    expect(await screen.findByText(/salto armado en la siguiente marca hacia intro/i)).toBeTruthy();
  });

  it("overwrites the armed marker on click and cancels when clicked again", async () => {
    await renderApp();

    const modeSelect = await screen.findByRole("combobox", { name: /modo global de salto/i });
    await act(async () => {
      fireEvent.change(modeSelect, { target: { value: "next_marker" } });
    });

    const introMarker = await screen.findByRole("button", { name: "Intro" });
    const bridgeMarker = await screen.findByRole("button", { name: "Bridge" });

    await act(async () => {
      fireEvent.click(introMarker);
    });

    expect(await screen.findByText(/armado: intro \| next_marker/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(bridgeMarker);
    });

    expect(await screen.findByText(/armado: bridge \| next_marker/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(bridgeMarker);
    });

    expect(await screen.findByText(/salto cancelado para bridge/i)).toBeTruthy();
    expect(screen.queryByText(/armado: bridge \| next_marker/i)).toBeNull();
  });

  it("warns when next marker jump is ignored because there are no markers ahead", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockRulerBounds(container);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    for (let index = 0; index < 6; index += 1) {
      await act(async () => {
        fireEvent.wheel(ruler, { deltaY: 100, clientX: 1180 });
      });
    }

    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 1180 });
      fireEvent.mouseMove(window, { button: 0, clientX: 1180 });
      fireEvent.mouseUp(window, { button: 0, clientX: 1180 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThanOrEqual(0);

    const modeSelect = await screen.findByRole("combobox", { name: /modo global de salto/i });
    await act(async () => {
      fireEvent.change(modeSelect, { target: { value: "next_marker" } });
    });

    const introMarker = await screen.findByRole("button", { name: "Intro" });
    await act(async () => {
      fireEvent.click(introMarker);
    });

    expect(await screen.findByText(/aviso: no quedan marcas por delante; salto en la siguiente marca ignorado/i)).toBeTruthy();
    expect(screen.queryByText(/armado:/i)).toBeNull();
  });

  it("pans the timeline by dragging over an empty lane", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    const firstLane = container.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(firstLane).toBeTruthy();

    Object.defineProperty(shell, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 120,
    });

    await act(async () => {
      fireEvent.mouseDown(firstLane as HTMLElement, { button: 0, clientX: 300 });
      fireEvent.mouseMove(window, { clientX: 220 });
      fireEvent.mouseUp(window, { button: 0, clientX: 220 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBe(200);
  });

  it("collapses folder children locally in the UI", async () => {
    await renderApp();

    const toggle = await screen.findByRole("button", { name: /colapsar rhythm/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.queryByText("Drums")).toBeNull();
    expect(screen.queryByText("Bass")).toBeNull();
    expect(await screen.findByRole("button", { name: /expandir rhythm/i })).toBeTruthy();
  });

  it("zooms the timeline with the wheel and exposes a native horizontal scrollbar", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockRulerBounds(container);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 900 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 900 });
      fireEvent.mouseUp(window, { button: 0, clientX: 900 });
    });

    expect(await screen.findByText(/cursor movido a 00:07.000/i)).toBeTruthy();
    expect(screen.queryByRole("slider", { name: /zoom horizontal del timeline/i })).toBeNull();
    expect(screen.getByLabelText(/desplazamiento horizontal del timeline/i)).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(ruler, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("zooms when the wheel is used over the painted timeline canvas", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const trackCanvas = container.querySelector(".lt-track-canvas") as HTMLElement | null;
    expect(trackCanvas).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(trackCanvas as HTMLElement, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("zooms when the wheel is used over the track list surface", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(trackList).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(trackList as HTMLElement, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("registers a non-passive capture wheel listener on the timeline shell", async () => {
    const addEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, "addEventListener");

    await renderApp();

    const wheelCall = addEventListenerSpy.mock.calls.find(([type, _listener, options]) => {
      return (
        type === "wheel" &&
        typeof options === "object" &&
        options !== null &&
        "capture" in options &&
        "passive" in options &&
        options.capture === true &&
        options.passive === false
      );
    });

    expect(wheelCall).toBeTruthy();
  });

  it("resizes track rows with ctrl plus wheel anywhere on the timeline shell", async () => {
    const { container } = await renderApp();
    mockTimelineShellMetrics(container, 1500);

    const firstHeader = container.querySelector(".lt-track-header") as HTMLElement | null;
    const firstLane = container.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(firstHeader).toBeTruthy();
    expect(firstLane).toBeTruthy();
    expect((firstHeader as HTMLElement).style.height).toBe("94px");
    expect((firstLane as HTMLElement).style.height).toBe("94px");

    await act(async () => {
      fireEvent.wheel(firstHeader as HTMLElement, { deltaY: -100, ctrlKey: true });
    });

    expect((firstHeader as HTMLElement).style.height).toBe("102px");
    expect((firstLane as HTMLElement).style.height).toBe("102px");
  });

  it("creates a new audio track from the track context menu", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Nueva pista");
    await renderApp();

    const keysHeader = screen.getByText("Keys").closest(".lt-track-header");
    expect(keysHeader).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(keysHeader as HTMLElement, { clientX: 180, clientY: 300 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /insertar track/i }));
    });

    expect(await screen.findByText(/track creado: nueva pista/i)).toBeTruthy();
    expect(screen.getByText("Nueva pista")).toBeTruthy();
  });

  it("reorders tracks vertically from the header drag handle", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const dragHandle = screen.getByRole("button", { name: /mover keys/i });
    expect(dragHandle).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(dragHandle, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 380 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 380 });
    });

    expect(await screen.findByText(/track reordenado encima de guide/i)).toBeTruthy();
  });

  it("allows dragging a track into a folder track", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const dragHandle = screen.getByRole("button", { name: /mover keys/i });
    expect(dragHandle).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(dragHandle, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 410 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 410 });
    });

    expect(await screen.findByText(/track movido dentro de guide/i)).toBeTruthy();
  });
});
