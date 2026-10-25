import { describe, expect, it, vi } from "vitest";

import { createMidiMenus } from "./midiMenus";
import type { TimelineMenuDeps } from "./timelineMenus";

function deps() {
  return {
    t: (key: string) => key,
    moveMidiClip: vi.fn(),
    openMidiRouteEditor: vi.fn(),
    toggleMidiTrackEnabled: vi.fn(),
    openSettingsTab: vi.fn(),
    setMidiClipDraft: vi.fn(),
  };
}

describe("MIDI menus used by the Setlist lanes", () => {
  it("move passes the target track through to the DAW's handler", () => {
    const d = deps();
    const menus = createMidiMenus(() => d as unknown as TimelineMenuDeps, vi.fn());
    menus.moveMidiClip("c", 12, "other");
    expect(d.moveMidiClip).toHaveBeenCalledWith("c", 12, "other");
    menus.moveMidiClip("c", 14);
    expect(d.moveMidiClip).toHaveBeenLastCalledWith("c", 14, null);
  });

  it("routing, on/off and «MIDI settings…» go to the DAW's commands", () => {
    const d = deps();
    const menus = createMidiMenus(() => d as unknown as TimelineMenuDeps, vi.fn());
    menus.openMidiRouteEditor("t");
    menus.toggleMidiTrackEnabled("t");
    menus.openMidiSettings();
    expect(d.openMidiRouteEditor).toHaveBeenCalledWith("t");
    expect(d.toggleMidiTrackEnabled).toHaveBeenCalledWith("t");
    expect(d.openSettingsTab).toHaveBeenCalledWith("midi");
  });

  it("creating opens the DAW's clip modal draft at that time on that track", () => {
    const d = deps();
    const menus = createMidiMenus(() => d as unknown as TimelineMenuDeps, vi.fn());
    menus.createMidiClipAt("lights", 40);
    expect(d.setMidiClipDraft).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: null, trackId: "lights", timelineStartSeconds: 40 }),
    );
  });
});
