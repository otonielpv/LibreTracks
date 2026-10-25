import { vi } from "vitest";

import {
  act,
  disablePointerEventSupport,
  emitNativeDropEvent,
  en,
  fireEvent,
  getLibraryAssetButton,
  renderApp,
  screen,
  textMatcher,
  waitFor,
  within,
} from "../test/testUtils";

async function openSetlist() {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const view = await renderApp();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: textMatcher(en.liveView.openSetlist) }),
    );
  });
  return view;
}

describe("App / Setlist view", () => {
  it("shows one card per song of the session", async () => {
    const { container } = await openSetlist();
    expect(screen.getByRole("main", { name: textMatcher(en.setlistView.title) })).toBeTruthy();
    const cards = container.querySelectorAll(".lt-setlist-song-tile");
    expect(cards.length).toBeGreaterThan(0);
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeNull();
  });

  it("a card's menu is the DAW song menu", async () => {
    const { container } = await openSetlist();
    const card = container.querySelector<HTMLElement>(".lt-setlist-song-tile")!;
    await act(async () => {
      fireEvent.contextMenu(card);
    });
    const rename = await screen.findByRole("button", {
      name: textMatcher(en.transport.menu.renameSong),
    });
    const menu = rename.closest(".lt-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(
      within(menu).getByRole("button", { name: textMatcher(en.transport.menu.deleteSong) }),
    ).toBeTruthy();
  });

  it("audio files dropped from the OS on the song's waveform go into that song", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const importMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    const createMock = vi.mocked(desktopApi.createClipsWithAutoTracks);
    const { container } = await openSetlist();
    const band = container.querySelector<HTMLElement>("[data-setlist-zone='overview']")!;
    const regionId = band.getAttribute("data-region-id");
    expect(regionId).toBeTruthy();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => band) });

    await act(async () => {
      await emitNativeDropEvent({
        payload: { type: "over", paths: ["C:/mock/imports/bajo.wav"], position: { x: 400, y: 300 } },
      });
      await emitNativeDropEvent({
        payload: { type: "drop", paths: ["C:/mock/imports/bajo.wav"], position: { x: 400, y: 300 } },
      });
    });

    await waitFor(() => {
      expect(importMock).toHaveBeenCalledWith([
        expect.objectContaining({ sourcePath: "C:/mock/imports/bajo.wav" }),
      ]);
      expect(createMock).toHaveBeenCalled();
    });
  });

  it("a library audio dragged onto the mixer goes into the shown song", async () => {
    disablePointerEventSupport();
    const desktopApi = await import("../features/transport/desktopApi");
    const createMock = vi.mocked(desktopApi.createClipsWithAutoTracks);
    const { container } = await openSetlist();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });
    await screen.findByText("drums.wav");
    const mixer = container.querySelector<HTMLElement>("[data-setlist-zone='mixer']")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => mixer) });
    createMock.mockClear();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), { button: 0, clientX: 90, clientY: 210 });
      fireEvent.mouseMove(window, { clientX: 400, clientY: 600 });
      fireEvent.mouseUp(window, { clientX: 400, clientY: 600 });
    });

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith([
        expect.objectContaining({ filePath: "audio/drums.wav" }),
      ]);
    });
  });
});
