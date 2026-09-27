import { beforeEach, describe, expect, it, vi } from "vitest";

import { MIDI_LEARN_COMMANDS } from "../constants";
import { SHORTCUT_ACTIONS, SHORTCUT_GROUP_ORDER } from "../keyboard/actions";
import { applyVideoLiveState, VIDEO_SHORTCUT_HANDLERS } from "./videoLive";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

const api = vi.hoisted(() => ({
  videoLiveAction: vi.fn(async () => ({ forcedBlack: true, forcedIdle: false, outputEnabled: true })),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function keyEvent(repeat = false) {
  return { preventDefault: vi.fn(), repeat } as unknown as KeyboardEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
});

describe("video live control", () => {
  it("the four actions are rebindable shortcuts in their own group, black on B", () => {
    const video = SHORTCUT_ACTIONS.filter((action) => action.group === "video");
    expect(video.map((action) => action.id)).toEqual([
      "video.black",
      "video.fadeBlack",
      "video.idle",
      "video.toggleOutput",
    ]);
    expect(video.every((action) => action.editable !== false)).toBe(true);
    expect(video[0].defaultBinding).toBe("B");
    expect(SHORTCUT_GROUP_ORDER).toContain("video");
    // B was free: nothing else ships on it.
    expect(SHORTCUT_ACTIONS.filter((action) => action.defaultBinding === "B")).toHaveLength(1);
    // Every video shortcut has a dispatcher handler.
    for (const action of video) {
      expect(VIDEO_SHORTCUT_HANDLERS).toHaveProperty(action.id);
    }
  });

  it("pressing the shortcut runs the action and the badge follows the answer", async () => {
    VIDEO_SHORTCUT_HANDLERS["video.black"](keyEvent());
    await flush();
    expect(api.videoLiveAction).toHaveBeenCalledWith("black");
    expect(useVideoStore.getState().forcedBlack).toBe(true);

    // Auto-repeat of a held key does not toggle it back and forth.
    VIDEO_SHORTCUT_HANDLERS["video.fadeBlack"](keyEvent(true));
    await flush();
    expect(api.videoLiveAction).toHaveBeenCalledTimes(1);
  });

  it("MIDI learn offers the same actions with the keys the backend dispatches", () => {
    const keys = MIDI_LEARN_COMMANDS.map((command) => command.key);
    // Must match VideoLiveAction::from_midi_key in video/live.rs.
    expect(keys).toEqual(
      expect.arrayContaining([
        "action:video_black",
        "action:video_fade_black",
        "action:video_idle",
        "action:video_output",
      ]),
    );
  });

  it("a press from MIDI or the remote reaches the store through the event", () => {
    applyVideoLiveState({ forcedBlack: true, forcedIdle: true, outputEnabled: true });
    expect(useVideoStore.getState().forcedBlack).toBe(true);
    expect(useVideoStore.getState().forcedIdle).toBe(true);
    applyVideoLiveState({ forcedBlack: false, forcedIdle: false, outputEnabled: true });
    expect(useVideoStore.getState().forcedBlack).toBe(false);
  });
});
