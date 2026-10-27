import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationCueSummary } from "@libretracks/shared/models";

const api = vi.hoisted(() => ({
  upsertAutomationCue: vi.fn(async () => ({ projectRevision: 2 })),
  setAutomationTrackEnabled: vi.fn(async () => ({ projectRevision: 3 })),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  ...api,
}));

import { createAutomationMenus } from "./automationMenus";
import type { TimelineMenuDeps } from "./timelineMenus";

const cue = {
  id: "c1",
  name: "Coro",
  atSeconds: 10,
  enabled: false,
  maxRuns: 2,
  actions: [{ type: "wait", durationSeconds: 1 }],
} as AutomationCueSummary;

function deps() {
  return {
    t: (key: string) => key,
    songRef: { current: { automationCues: [cue] } },
    runAction: vi.fn(async (action: () => Promise<void>) => {
      await action();
    }),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => null),
    setStatus: vi.fn(),
    setIsMixSceneModalOpen: vi.fn(),
  };
}

beforeEach(() => {
  api.upsertAutomationCue.mockClear();
  api.setAutomationTrackEnabled.mockClear();
});

describe("automation menus", () => {
  it("moving a cue re-upserts it with only its position changed, then refreshes", async () => {
    const d = deps();
    const menus = createAutomationMenus(() => d as unknown as TimelineMenuDeps);
    await menus.moveAutomationCue("c1", 14);
    expect(api.upsertAutomationCue).toHaveBeenCalledTimes(1);
    expect(api.upsertAutomationCue).toHaveBeenCalledWith({ ...cue, atSeconds: 14 });
    expect(d.applyPlaybackSnapshot).toHaveBeenCalledWith({ projectRevision: 2 });
    expect(d.refreshSongView).toHaveBeenCalledWith({ includeWaveforms: false, sync: true });
  });

  it("a move to the same place, or of an unknown cue, sends nothing", async () => {
    const d = deps();
    const menus = createAutomationMenus(() => d as unknown as TimelineMenuDeps);
    await menus.moveAutomationCue("c1", 10);
    await menus.moveAutomationCue("missing", 3);
    expect(api.upsertAutomationCue).not.toHaveBeenCalled();
  });

  it("the lane switch and the scenes manager", async () => {
    const d = deps();
    const menus = createAutomationMenus(() => d as unknown as TimelineMenuDeps);
    await menus.setAutomationTrackOn(false);
    expect(api.setAutomationTrackEnabled).toHaveBeenCalledWith(false);
    expect(d.setStatus).toHaveBeenCalledWith("transport.automation.statusTrackDisabled");
    menus.openMixScenes();
    expect(d.setIsMixSceneModalOpen).toHaveBeenCalledWith(true);
  });
});
