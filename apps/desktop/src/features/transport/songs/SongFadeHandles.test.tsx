import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";

import i18n from "../../../shared/i18n";
import { SongFadeHandles, fadesAfterDrag } from "./SongFadeHandles";

const updateSongRegionFades = vi.fn();
vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    updateSongRegionFades: (...args: unknown[]) => updateSongRegionFades(...args),
  };
});

describe("fadesAfterDrag", () => {
  it("drags the fade in right and the fade out left", () => {
    expect(fadesAfterDrag({ fadeIn: 0, fadeOut: 0 }, "in", 3, 100)).toEqual({ fadeIn: 3, fadeOut: 0 });
    expect(fadesAfterDrag({ fadeIn: 0, fadeOut: 0 }, "out", -4, 100)).toEqual({ fadeIn: 0, fadeOut: 4 });
  });

  it("never goes below zero, past the song or across the other fade", () => {
    expect(fadesAfterDrag({ fadeIn: 2, fadeOut: 0 }, "in", -10, 100).fadeIn).toBe(0);
    expect(fadesAfterDrag({ fadeIn: 0, fadeOut: 30 }, "in", 200, 100).fadeIn).toBe(70);
    expect(fadesAfterDrag({ fadeIn: 60, fadeOut: 0 }, "out", -200, 100).fadeOut).toBe(40);
  });
});

const region = {
  id: "r1",
  name: "Oceans",
  startSeconds: 0,
  endSeconds: 100,
  master: { gain: 1, fadeInSeconds: 0, fadeOutSeconds: 0 },
} as unknown as SongRegionSummary;

describe("SongFadeHandles", () => {
  beforeEach(async () => {
    updateSongRegionFades.mockReset().mockResolvedValue({});
    await i18n.changeLanguage("en");
  });

  // jsdom has no PointerEvent: MouseEvent with the pointer event names carries
  // clientX, which is all the drag reads. The band has no layout in jsdom, so
  // the screen scale falls back to 1.
  it("saves the fade in dragged from the top-left corner", () => {
    const { container } = render(
      <div className="lt-region-hotspot">
        <SongFadeHandles region={region} pixelsPerSecond={10} />
      </div>,
    );
    const handle = container.querySelector<HTMLElement>(".lt-song-fade-handle.is-in")!;
    handle.setPointerCapture = () => {};

    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    });
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50 }));
    });
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 50 }));
    });

    // 50 px at 10 px/s = 5 s.
    expect(updateSongRegionFades).toHaveBeenCalledWith("r1", 5, 0);
  });

  it("draws nothing over the band when the song has no fades", () => {
    const { container } = render(<SongFadeHandles region={region} pixelsPerSecond={10} />);
    expect(container.querySelector(".lt-song-fade-ramps")).toBeNull();
  });
});
