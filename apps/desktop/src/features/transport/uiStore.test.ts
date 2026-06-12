import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIEW_MODE,
  TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
  TIMELINE_DEFAULT_SNAP_ENABLED,
  TIMELINE_DEFAULT_TRACK_HEIGHT,
  TIMELINE_DEFAULT_ZOOM_LEVEL,
  useTimelineUIStore,
} from "./uiStore";

const initial = useTimelineUIStore.getState();

function reset() {
  useTimelineUIStore.setState({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight: TIMELINE_DEFAULT_TRACK_HEIGHT,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedSectionId: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    followPlayheadEnabled: TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
    midiLearnMode: null,
    viewMode: DEFAULT_VIEW_MODE,
  });
}

const get = useTimelineUIStore.getState;

describe("useTimelineUIStore", () => {
  beforeEach(reset);

  it("starts from the documented defaults", () => {
    expect(initial.zoomLevel).toBe(TIMELINE_DEFAULT_ZOOM_LEVEL);
    expect(initial.trackHeight).toBe(TIMELINE_DEFAULT_TRACK_HEIGHT);
    expect(initial.snapEnabled).toBe(TIMELINE_DEFAULT_SNAP_ENABLED);
    expect(initial.followPlayheadEnabled).toBe(
      TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
    );
    expect(initial.viewMode).toBe(DEFAULT_VIEW_MODE);
  });

  describe("view mode", () => {
    it("sets and toggles between daw and compact", () => {
      get().setViewMode("compact");
      expect(get().viewMode).toBe("compact");
      get().toggleViewMode();
      expect(get().viewMode).toBe("daw");
      get().toggleViewMode();
      expect(get().viewMode).toBe("compact");
    });
  });

  describe("cameraX", () => {
    it("clamps to non-negative values", () => {
      get().setCameraX(120);
      expect(get().cameraX).toBe(120);
      get().setCameraX(-50);
      expect(get().cameraX).toBe(0);
    });

    it("falls back to 0 for non-finite input", () => {
      get().setCameraX(Number.NaN);
      expect(get().cameraX).toBe(0);
      get().setCameraX(Number.POSITIVE_INFINITY);
      expect(get().cameraX).toBe(0);
    });
  });

  describe("zoom and track height accept values or updaters", () => {
    it("sets a literal zoom level", () => {
      get().setZoomLevel(3);
      expect(get().zoomLevel).toBe(3);
    });

    it("applies an updater function for zoom", () => {
      get().setZoomLevel(5);
      get().setZoomLevel((z) => z + 2);
      expect(get().zoomLevel).toBe(7);
    });

    it("sets and updates track height", () => {
      get().setTrackHeight(100);
      expect(get().trackHeight).toBe(100);
      get().setTrackHeight((h) => h - 30);
      expect(get().trackHeight).toBe(70);
    });
  });

  describe("selection is mutually exclusive across tracks/clips/sections", () => {
    it("selecting tracks clears clip and section selection", () => {
      get().selectClip("clip-1");
      get().selectSection("sec-1");
      get().setSelectedTrackIds(["t1", "t2"]);
      expect(get().selectedTrackIds).toEqual(["t1", "t2"]);
      expect(get().selectedClipId).toBeNull();
      expect(get().selectedClipIds).toEqual([]);
    });

    it("selectTrack clears every other selection", () => {
      get().selectClip("clip-1");
      get().selectSection("sec-1");
      get().selectTrack(["t1"]);
      expect(get().selectedTrackIds).toEqual(["t1"]);
      expect(get().selectedClipId).toBeNull();
      expect(get().selectedSectionId).toBeNull();
    });

    it("setSelectedClipId mirrors into selectedClipIds", () => {
      get().setSelectedClipId("clip-9");
      expect(get().selectedClipId).toBe("clip-9");
      expect(get().selectedClipIds).toEqual(["clip-9"]);
      get().setSelectedClipId(null);
      expect(get().selectedClipId).toBeNull();
      expect(get().selectedClipIds).toEqual([]);
    });

    it("setSelectedClipIds uses the last id as the primary clip", () => {
      get().setSelectedClipIds(["a", "b", "c"]);
      expect(get().selectedClipId).toBe("c");
      expect(get().selectedClipIds).toEqual(["a", "b", "c"]);
      expect(get().selectedTrackIds).toEqual([]);
      expect(get().selectedSectionId).toBeNull();
    });

    it("selectClip clears tracks and sections", () => {
      get().setSelectedTrackIds(["t1"]);
      get().selectSection("sec-1");
      get().selectClip("clip-2");
      expect(get().selectedClipId).toBe("clip-2");
      expect(get().selectedTrackIds).toEqual([]);
      expect(get().selectedSectionId).toBeNull();
    });

    it("selectSection clears tracks and clips", () => {
      get().setSelectedClipIds(["a", "b"]);
      get().selectSection("sec-7");
      expect(get().selectedSectionId).toBe("sec-7");
      expect(get().selectedTrackIds).toEqual([]);
      expect(get().selectedClipId).toBeNull();
      expect(get().selectedClipIds).toEqual([]);
    });
  });

  describe("toggleClipSelection", () => {
    it("adds a clip when absent and removes it when present", () => {
      get().toggleClipSelection("a");
      expect(get().selectedClipIds).toEqual(["a"]);
      get().toggleClipSelection("b");
      expect(get().selectedClipIds).toEqual(["a", "b"]);
      expect(get().selectedClipId).toBe("b");
      get().toggleClipSelection("a");
      expect(get().selectedClipIds).toEqual(["b"]);
      expect(get().selectedClipId).toBe("b");
    });

    it("clears the primary clip when the last one is toggled off", () => {
      get().toggleClipSelection("only");
      get().toggleClipSelection("only");
      expect(get().selectedClipIds).toEqual([]);
      expect(get().selectedClipId).toBeNull();
    });
  });

  describe("clearSelection", () => {
    it("wipes all selection state", () => {
      get().setSelectedTrackIds(["t1"]);
      get().setSelectedClipIds(["c1"]);
      get().selectSection("s1");
      get().clearSelection();
      expect(get().selectedTrackIds).toEqual([]);
      expect(get().selectedClipId).toBeNull();
      expect(get().selectedClipIds).toEqual([]);
      expect(get().selectedSectionId).toBeNull();
    });
  });

  describe("snap and midi learn", () => {
    it("sets snap with a literal or updater and toggles it", () => {
      get().setSnapEnabled(false);
      expect(get().snapEnabled).toBe(false);
      get().setSnapEnabled((s) => !s);
      expect(get().snapEnabled).toBe(true);
      get().toggleSnapEnabled();
      expect(get().snapEnabled).toBe(false);
    });

    it("sets playhead follow with a literal or updater and toggles it", () => {
      get().setFollowPlayheadEnabled(true);
      expect(get().followPlayheadEnabled).toBe(true);
      get().setFollowPlayheadEnabled((enabled) => !enabled);
      expect(get().followPlayheadEnabled).toBe(false);
      get().toggleFollowPlayheadEnabled();
      expect(get().followPlayheadEnabled).toBe(true);
    });

    it("stores and clears the midi learn target", () => {
      get().setMidiLearnMode("play");
      expect(get().midiLearnMode).toBe("play");
      get().setMidiLearnMode(null);
      expect(get().midiLearnMode).toBeNull();
    });
  });
});
