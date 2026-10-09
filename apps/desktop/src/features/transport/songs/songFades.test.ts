import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { formatFadeSeconds, parseFadeSeconds, songFadeMenuActions } from "./songFades";

const updateSongRegionFades = vi.fn();
const promptDialog = vi.fn();

vi.mock("../desktopApi", () => ({
  updateSongRegionFades: (...args: unknown[]) => updateSongRegionFades(...args),
}));
vi.mock("../../../shared/dialog/dialogService", () => ({
  promptDialog: (...args: unknown[]) => promptDialog(...args),
}));

const region = {
  id: "r1",
  name: "Oceans",
  startSeconds: 0,
  endSeconds: 200,
  master: { gain: 1, fadeInSeconds: 2, fadeOutSeconds: 6 },
} as unknown as SongRegionSummary;

function deps() {
  return {
    t: (key: string) => key,
    runAction: async (action: () => Promise<void>) => action(),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe("parseFadeSeconds", () => {
  it("reads decimals with comma or dot", () => {
    expect(parseFadeSeconds("2,5")).toBe(2.5);
    expect(parseFadeSeconds(" 4.25 ")).toBe(4.25);
  });

  it("treats an empty field as no fade", () => {
    expect(parseFadeSeconds("")).toBe(0);
  });

  it("rejects negatives and non-numbers", () => {
    expect(parseFadeSeconds("-1")).toBeNull();
    expect(parseFadeSeconds("abc")).toBeNull();
  });
});

describe("formatFadeSeconds", () => {
  it("shows whole and fractional seconds without noise", () => {
    expect(formatFadeSeconds(3)).toBe("3");
    expect(formatFadeSeconds(2.5)).toBe("2.5");
    expect(formatFadeSeconds(undefined)).toBe("0");
  });
});

describe("songFadeMenuActions", () => {
  beforeEach(() => {
    updateSongRegionFades.mockReset().mockResolvedValue({ projectRevision: 2 });
    promptDialog.mockReset();
  });

  // Editing one fade must send the other one unchanged, or setting the fade
  // out would silently wipe the fade in.
  it("editing the fade out keeps the fade in", async () => {
    promptDialog.mockResolvedValue("8");
    const [, fadeOut] = songFadeMenuActions(region, deps());
    await fadeOut.onSelect();
    expect(updateSongRegionFades).toHaveBeenCalledWith("r1", 2, 8);
  });

  it("editing the fade in keeps the fade out", async () => {
    promptDialog.mockResolvedValue("0");
    const [fadeIn] = songFadeMenuActions(region, deps());
    await fadeIn.onSelect();
    expect(updateSongRegionFades).toHaveBeenCalledWith("r1", 0, 6);
  });

  it("does nothing when the prompt is cancelled or invalid", async () => {
    const [fadeIn] = songFadeMenuActions(region, deps());
    promptDialog.mockResolvedValue(null);
    await fadeIn.onSelect();
    promptDialog.mockResolvedValue("-3");
    await fadeIn.onSelect();
    expect(updateSongRegionFades).not.toHaveBeenCalled();
  });
});
