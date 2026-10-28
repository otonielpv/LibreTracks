import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "../desktopApi";
import type { TimelineMenuDeps } from "./timelineMenus";

/**
 * Two section markers cannot share a spot. Creating or retyping one where a
 * section already sits asks whether to put it in the cue lane instead; "yes"
 * does it, "no" leaves things as they were.
 */
const confirmDialog = vi.fn<(message: string) => Promise<boolean>>();
const createSectionMarker = vi.fn(async () => ({ projectRevision: 2 }));
const setSectionMarkerKind = vi.fn(async () => ({ projectRevision: 3 }));
const updateSectionMarker = vi.fn(async () => ({ projectRevision: 4 }));

vi.mock("../../../shared/dialog/dialogService", () => ({
  confirmDialog: (message: string) => confirmDialog(message),
}));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  createSectionMarker: (...args: unknown[]) => createSectionMarker(...(args as [])),
  setSectionMarkerKind: (...args: unknown[]) => setSectionMarkerKind(...(args as [])),
  updateSectionMarker: (...args: unknown[]) => updateSectionMarker(...(args as [])),
}));

const { createMarkerKindMenus } = await import("./markerKindMenus");

const marker = (id: string, startSeconds: number, kind: string, categoryOverride?: string) =>
  ({ id, name: id, startSeconds, kind, variant: null, categoryOverride: categoryOverride ?? null }) as never;

const song = {
  sectionMarkers: [marker("verse", 10, "verse"), marker("drums", 20, "drums_in")],
} as unknown as SongView;

function menus() {
  const deps = {
    t: ((key: string) => key) as never,
    songRef: { current: song },
    runAction: vi.fn(async (work: () => Promise<void>) => work()),
    applyPlaybackSnapshot: vi.fn(),
    clearSelection: vi.fn(),
    setSelectedRegionId: vi.fn(),
    setSelectedTimelineRange: vi.fn(),
    setStatus: vi.fn(),
    setContextMenu: vi.fn(),
    appSettings: { voiceGuideLanguage: "es" },
  } as unknown as TimelineMenuDeps;
  return { deps, ...createMarkerKindMenus(() => deps, () => ({ x: 0, y: 0 })) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => vi.clearAllMocks());

describe("cue menus", () => {
  it("offers count first when creating or changing a cue", () => {
    const { deps, openCreateCueKindMenu, openCreateMarkerKindMenu, openMarkerKindMenu } = menus();
    const actions: { label: string; onSelect: () => void }[] = [];
    (deps.setContextMenu as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (menu: { actions: typeof actions }) => actions.splice(0, actions.length, ...menu.actions),
    );
    openCreateCueKindMenu(10);
    expect(actions[0].label).toBe("transport.markerKind.count ▸");
    openCreateMarkerKindMenu(10);
    actions[1].onSelect();
    expect(actions[0].label).toBe("transport.markerKind.count ▸");
    openMarkerKindMenu(song.sectionMarkers[1]);
    actions[1].onSelect();
    expect(actions[0].label).toBe("transport.markerKind.count ▸");
  });
});

describe("two sections on one spot", () => {
  it("asks, and on yes creates the section in the cue lane", async () => {
    confirmDialog.mockResolvedValue(true);
    menus().createTypedMarker(10, "acapella", null);
    await settle();
    expect(confirmDialog).toHaveBeenCalledWith("transport.markerCollision.askCue");
    expect(createSectionMarker).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ kind: "acapella", categoryOverride: "cue" }),
    );
  });

  it("on no creates nothing", async () => {
    confirmDialog.mockResolvedValue(false);
    menus().createTypedMarker(10, "chorus", null);
    await settle();
    expect(createSectionMarker).not.toHaveBeenCalled();
  });

  it("does not ask for a cue, nor for a section on a free spot", async () => {
    const { createTypedMarker } = menus();
    createTypedMarker(10, "drums_in", null);
    createTypedMarker(30, "chorus", null);
    // A cue marker on the spot is no section.
    createTypedMarker(20, "bridge", null);
    await settle();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(createSectionMarker).toHaveBeenCalledTimes(3);
    for (const call of createSectionMarker.mock.calls as unknown as [number, { categoryOverride: unknown }][]) {
      expect(call[1].categoryOverride).toBeNull();
    }
  });

  it("retyping a cue into a section next to a section asks and keeps it a cue", async () => {
    confirmDialog.mockResolvedValue(true);
    const crowded = {
      sectionMarkers: [marker("verse", 10, "verse"), marker("extra", 10, "drums_in")],
    } as unknown as SongView;
    const { deps, openMarkerKindMenu } = menus();
    deps.songRef.current = crowded;
    void openMarkerKindMenu;
    // Retype through the same path the "Type" submenu uses.
    const actions: { label: string; onSelect: () => void }[] = [];
    (deps.setContextMenu as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (menu: { actions: typeof actions }) => actions.splice(0, actions.length, ...menu.actions),
    );
    openMarkerKindMenu(crowded.sectionMarkers[1]);
    const sectionsEntry = actions.find((action) => /section/i.test(action.label));
    sectionsEntry?.onSelect();
    const acapella = actions.find((action) => action.label.includes("A Capella") || action.label.includes("acapella"));
    acapella?.onSelect();
    await settle();
    expect(confirmDialog).toHaveBeenCalledWith("transport.markerCollision.askCue");
    expect(setSectionMarkerKind).toHaveBeenCalled();
    expect(updateSectionMarker).toHaveBeenCalledWith("extra", "extra", 10, "cue");
  });
});
