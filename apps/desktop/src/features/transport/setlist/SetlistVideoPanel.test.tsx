import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackSummary, VideoClipSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import { SetlistVideoPanel, songVideoClips } from "./SetlistVideoPanel";
import { testRegion } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

const mobile = vi.hoisted(() => ({ value: false }));
const picked = vi.hoisted(() => ({ paths: ["C:/v/intro.mp4", "C:/a/drums.wav"] }));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  get isMobileApp() {
    return mobile.value;
  },
  pickLibraryFiles: vi.fn(async () => picked.paths),
}));

const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 60 });
const clip = (id: string, at: number, trackId = "v1"): VideoClipSummary =>
  ({ id, trackId, filePath: `C:/v/${id}.mp4`, isMissing: false, timelineStartSeconds: at, durationSeconds: 10, sourceStartSeconds: 0, sourceDurationSeconds: 10 }) as VideoClipSummary;
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  clips: [],
  sectionMarkers: [{ id: "c", name: "Coro", kind: "chorus", startSeconds: 20 }],
  videoClips: [clip("late", 30), clip("first", 4), clip("other-song", 90)],
} as unknown as SongView;
const videoTrack = { id: "v1", name: "Fondos", kind: "video" } as TrackSummary;

function video(): VideoLaneBindings {
  return {
    readOnly: false,
    onContextMenu: vi.fn(),
    handlers: {
      addVideosFromDevice: vi.fn(),
      importVideoPaths: vi.fn(),
      addVideoTrack: vi.fn(),
    } as unknown as VideoLaneBindings["handlers"],
  };
}

function panel(bindings: VideoLaneBindings | undefined, menus = { openMenu: vi.fn(), trackContextMenu: vi.fn(() => [{ label: "common.rename" }]) }) {
  render(
    <SetlistVideoPanel
      song={song}
      region={region}
      tracks={[videoTrack]}
      layout="short"
      menus={menus as unknown as TimelineMenus}
      positionSecondsRef={{ current: 12 }}
      waveformSummaries={{}}
      onSeek={vi.fn()}
      runShortcutAction={vi.fn()}
      video={bindings}
    />,
  );
  return menus;
}

beforeEach(() => {
  mobile.value = false;
  resetFrameGateForTests();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

// The phone report: there was no way to add video from the phone.
describe("Edit → Video", () => {
  it("the song's clips in order, on the waveform and in the list; tapping one opens its menu", () => {
    expect(songVideoClips(song, region).map((entry) => entry.id)).toEqual(["first", "late"]);
    const bindings = video();
    panel(bindings);
    const bars = Array.from(document.querySelectorAll<HTMLElement>(".lt-setlist-scrub-video"));
    expect(bars.map((bar) => bar.textContent)).toEqual(["moviefirst.mp4", "movielate.mp4"]);
    fireEvent.click(bars[1]);
    expect(bindings.onContextMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "late" }));
  });

  it("phone: «Video here» offers gallery or files and adds at the line on the song's video track", () => {
    mobile.value = true;
    const bindings = video();
    const menus = panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.video.addHere" }));
    const [, , actions] = menus.openMenu.mock.calls[0] as unknown as [unknown, string, Array<{ label: string; onSelect: () => void }>];
    expect(actions.map((action) => action.label)).toEqual(["transport.video.addFromGallery", "transport.video.addFromFiles"]);
    actions[1].onSelect();
    expect(bindings.handlers.addVideosFromDevice).toHaveBeenCalledWith({ seconds: 12, trackId: "v1" }, "files");
  });

  it("desktop: the file picker, videos only, at the line", async () => {
    const bindings = video();
    panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.video.addHere" }));
    await vi.waitFor(() =>
      expect(bindings.handlers.importVideoPaths).toHaveBeenCalledWith(["C:/v/intro.mp4"], { seconds: 12, trackId: "v1" }),
    );
  });

  it("the track row: its DAW menu and «add video track»", () => {
    const bindings = video();
    const menus = panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.menu:Fondos" }));
    expect(menus.openMenu).toHaveBeenCalledWith(expect.anything(), "Fondos", [{ label: "common.rename" }]);
    fireEvent.click(screen.getByRole("button", { name: "transport.video.addTrack" }));
    expect(bindings.handlers.addVideoTrack).toHaveBeenCalledWith("v1");
  });

  it("without the video feature: no add buttons, a note", () => {
    panel(undefined);
    expect(screen.queryByRole("button", { name: "setlistView.video.addHere" })).toBeNull();
    expect(screen.getByText("setlistView.video.unavailable")).toBeTruthy();
  });
});
