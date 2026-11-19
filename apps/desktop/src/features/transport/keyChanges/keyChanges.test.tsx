import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary, SongView, TransportSnapshot } from "@libretracks/shared/models";
import type { KeyChangeInput } from "@libretracks/shared/desktopApi";
import type { ContextMenuState } from "../types";

const setSongRegionKeyChanges = vi.fn<
  (regionId: string, changes: KeyChangeInput[]) => Promise<TransportSnapshot>
>();

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  setSongRegionKeyChanges: (regionId: string, changes: KeyChangeInput[]) =>
    setSongRegionKeyChanges(regionId, changes),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { KeyChangeHotspots } from "./KeyChangeHotspots";
import {
  keyChangeAtCursorAction,
  moveKeyChange,
  openKeyChangeMenu,
  type KeyChangeMenuDeps,
} from "./keyChangeMenus";
import { KeySequenceLabel, SoundingKeyLabel } from "./SoundingKeyLabel";
import { publishSoundingKey, soundingKeyAt, useSoundingKeyStore } from "./soundingKeyStore";

function region(overrides: Partial<SongRegionSummary> = {}): SongRegionSummary {
  return {
    id: "song",
    name: "Eres Todopoderoso",
    startSeconds: 100,
    endSeconds: 400,
    transposeSemitones: 0,
    key: "D",
    keyChanges: [{ id: "up", startSeconds: 280, key: "E" }],
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    ...overrides,
  } as SongRegionSummary;
}

function song(regions: SongRegionSummary[] = [region()]): SongView {
  return {
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 400,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions,
    tracks: [],
    clips: [],
  } as unknown as SongView;
}

function menuDeps() {
  let menu: ContextMenuState = null;
  const deps: KeyChangeMenuDeps = {
    t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
    runAction: async (work) => {
      await work();
    },
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    setContextMenu: (next) => {
      menu = next;
    },
    contextMenuPositionRef: { current: { x: 10, y: 20 } },
  };
  return { deps, menu: () => menu };
}

beforeEach(() => {
  setSongRegionKeyChanges.mockReset();
  setSongRegionKeyChanges.mockResolvedValue({} as TransportSnapshot);
  useSoundingKeyStore.setState(
    { regionId: "", key: null, keyStartSeconds: null, upcoming: null },
    true,
  );
});

afterEach(cleanup);

describe("soundingKeyAt", () => {
  it("reads the key sounding under the playhead", () => {
    expect(soundingKeyAt(song(), 150)).toMatchObject({ regionId: "song", key: "D" });
    expect(soundingKeyAt(song(), 300)).toMatchObject({
      key: "E",
      keyStartSeconds: 280,
      upcoming: null,
    });
  });

  it("warns of a change only within four bars of it", () => {
    // 4 bars of 4/4 at 120 BPM = 8 s.
    expect(soundingKeyAt(song(), 271).upcoming).toBeNull();
    expect(soundingKeyAt(song(), 273).upcoming).toEqual({ startSeconds: 280, key: "E" });
  });

  it("before the first song reads that song's opening key", () => {
    expect(soundingKeyAt(song(), 50)).toMatchObject({ regionId: "song", key: "D" });
    expect(soundingKeyAt(song([]), 50)).toMatchObject({ regionId: "", key: null });
  });

  it("only touches the store when what is shown changes", () => {
    const listener = vi.fn();
    const unsubscribe = useSoundingKeyStore.subscribe(listener);
    publishSoundingKey(song(), 150);
    publishSoundingKey(song(), 151);
    publishSoundingKey(song(), 152);
    expect(listener).toHaveBeenCalledTimes(1);
    publishSoundingKey(song(), 300);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("key change menus", () => {
  it("adds a change at the cursor, keeping the ones the song had", async () => {
    const { deps, menu } = menuDeps();
    const action = keyChangeAtCursorAction(region(), 200, deps);
    expect(action.disabled).toBe(false);
    await action.onSelect();
    const picker = menu();
    expect(picker?.actions.find((entry) => entry.label === "F")).toBeDefined();
    await picker?.actions.find((entry) => entry.label === "F")?.onSelect();
    expect(setSongRegionKeyChanges).toHaveBeenCalledWith("song", [
      { id: "up", startSeconds: 280, key: "E" },
      { startSeconds: 200, key: "F" },
    ]);
  });

  it("is offered disabled when the cursor is outside the song", () => {
    const { deps } = menuDeps();
    expect(keyChangeAtCursorAction(region(), 50, deps).disabled).toBe(true);
    expect(keyChangeAtCursorAction(region(), 100, deps).disabled).toBe(true);
  });

  it("changes or removes one change from its own menu", async () => {
    const { deps, menu } = menuDeps();
    openKeyChangeMenu(region(), "up", { x: 1, y: 2 }, deps);
    const picker = menu();
    expect(picker?.actions.find((entry) => entry.label === "E")?.swatch).toBeDefined();
    await picker?.actions.find((entry) => entry.label === "F#")?.onSelect();
    expect(setSongRegionKeyChanges).toHaveBeenLastCalledWith("song", [
      { id: "up", startSeconds: 280, key: "F#" },
    ]);
    await picker?.actions[0].onSelect();
    expect(setSongRegionKeyChanges).toHaveBeenLastCalledWith("song", []);
  });
});

/** jsdom has no PointerEvent: fireEvent.pointer* would carry no clientX. */
function pointer(target: Element, type: string, clientX: number, altKey = false) {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, altKey });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

describe("moveKeyChange", () => {
  it("moves the change, or adds a copy with the same key and keeps it", async () => {
    const { deps } = menuDeps();
    await moveKeyChange(region(), "up", 300, deps);
    expect(setSongRegionKeyChanges).toHaveBeenLastCalledWith("song", [
      { id: "up", startSeconds: 300, key: "E" },
    ]);
    await moveKeyChange(region(), "up", 300, deps, true);
    expect(setSongRegionKeyChanges).toHaveBeenLastCalledWith("song", [
      { id: "up", startSeconds: 280, key: "E" },
      { startSeconds: 300, key: "E" },
    ]);
  });
});

describe("KeyChangeHotspots", () => {
  const callbacks = () => ({ openMenu: vi.fn(), move: vi.fn() });

  function renderHotspots(cb = callbacks()) {
    render(
      <KeyChangeHotspots
        song={song()}
        pixelsPerSecond={10}
        livePixelsPerSecondRef={{ current: 10 }}
        snapEnabled={false}
        callbacks={cb}
      />,
    );
    return { cb, button: screen.getByRole("button") };
  }

  it("sits on the change, in the ruler's content coordinates", () => {
    const { button } = renderHotspots();
    // 280 s × 10 px/s, minus the grab margin left of the stem.
    expect(button.style.left).toBe("2794px");
  });

  it("opens the change's menu on a tap", () => {
    const { cb, button } = renderHotspots();
    fireEvent.click(button, { clientX: 5, clientY: 6 });
    expect(cb.openMenu).toHaveBeenCalledWith(5, 6, "song", "up");
  });

  it("moves the change when dragged, and swallows the click after", () => {
    const { cb, button } = renderHotspots();
    pointer(button, "pointerdown", 100);
    pointer(button, "pointermove", 150);
    pointer(button, "pointerup", 150);
    fireEvent.click(button);
    // 50 px at 10 px/s = 5 s later.
    expect(cb.move).toHaveBeenCalledWith("song", "up", 285, false);
    expect(cb.openMenu).not.toHaveBeenCalled();
  });

  it("copies with Alt held at the drop and puts the original back", () => {
    const { cb, button } = renderHotspots();
    const leftBefore = (button as HTMLElement).style.left;
    pointer(button, "pointerdown", 100);
    pointer(button, "pointermove", 150);
    pointer(button, "pointerup", 150, true);
    expect(cb.move).toHaveBeenCalledWith("song", "up", 285, true);
    expect((button as HTMLElement).style.left).toBe(leftBefore);
  });

  it("treats a press that barely moves as a tap", () => {
    const { cb, button } = renderHotspots();
    pointer(button, "pointerdown", 100);
    pointer(button, "pointermove", 102);
    pointer(button, "pointerup", 102);
    expect(cb.move).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(cb.openMenu).toHaveBeenCalledTimes(1);
  });
});

describe("key labels", () => {
  it("shows the sounding key and the next one as it approaches", () => {
    render(<SoundingKeyLabel region={region()} />);
    expect(screen.getByText("D")).toBeTruthy();
    act(() => publishSoundingKey(song(), 275));
    expect(screen.getByText(/transport\.keyChanges\.upcoming.*"E"/)).toBeTruthy();
    act(() => publishSoundingKey(song(), 290));
    expect(screen.getByText("E")).toBeTruthy();
    expect(screen.queryByText(/transport\.keyChanges\.upcoming/)).toBeNull();
  });

  it("shows the opening key while the playhead is in another song", () => {
    render(<SoundingKeyLabel region={region({ id: "other" })} />);
    act(() => publishSoundingKey(song(), 300));
    expect(screen.getByText("D")).toBeTruthy();
  });

  it("lists every key of the song and highlights the sounding one", () => {
    const { container } = render(
      <KeySequenceLabel
        region={region({
          keyChanges: [
            { id: "up", startSeconds: 280, key: "E" },
            { id: "back", startSeconds: 350, key: "D" },
          ],
        })}
      />,
    );
    expect(container.textContent).toBe("D → E → D");
    act(() =>
      publishSoundingKey(
        song([
          region({
            keyChanges: [
              { id: "up", startSeconds: 280, key: "E" },
              { id: "back", startSeconds: 350, key: "D" },
            ],
          }),
        ]),
        360,
      ),
    );
    const current = container.querySelector(".is-current");
    // The last D, not the first: a song back in an earlier key repeats it.
    expect(current?.textContent).toBe(" → D");
  });
});
