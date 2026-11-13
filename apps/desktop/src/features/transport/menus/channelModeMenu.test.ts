import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelModeMenu } from "./channelModeMenu";
import type { TimelineMenuDeps } from "./timelineMenus";
import type { ContextMenuAction } from "../types";
import type { TrackSummary } from "../desktopApi";
import { splitTrackChannels, updateTrackChannelMode } from "../desktopApi";

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  updateTrackChannelMode: vi.fn(async () => ({ projectRevision: 1 })),
  splitTrackChannels: vi.fn(async () => ({ projectRevision: 2 })),
}));

function track(
  channelMode?: TrackSummary["channelMode"],
  hasStereoAudio = true,
): TrackSummary {
  return {
    id: "t1",
    name: "Pista",
    kind: "audio",
    channelMode,
    hasStereoAudio,
  } as unknown as TrackSummary;
}

function setup() {
  const deps = {
    t: ((key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key) as never,
    runAction: vi.fn(async (work: () => Promise<void>) => work()),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => undefined),
  } as unknown as TimelineMenuDeps;
  let opened: { title: string; actions: ContextMenuAction[] } | null = null;
  const menu = createChannelModeMenu(
    () => deps,
    (title, actions) => {
      opened = { title, actions };
    },
  );
  return { deps, menu, opened: () => opened };
}

describe("submenú Canales", () => {
  beforeEach(() => {
    vi.mocked(updateTrackChannelMode).mockClear();
    vi.mocked(splitTrackChannels).mockClear();
  });

  it("marca el modo actual y ofrece los cuatro", () => {
    const { menu, opened } = setup();
    menu.channelModeEntry(track("left")).onSelect();
    const labels = opened()!.actions.map((action) => action.label);
    expect(labels).toEqual([
      "Estéreo",
      "Mono (suma)",
      "✓ Solo izquierdo",
      "Solo derecho",
      "Separar canales L/R",
    ]);
  });

  it("sin modo guardado marca estéreo", () => {
    const { menu } = setup();
    expect(menu.modeActions(track())[0].label).toBe("✓ Estéreo");
  });

  it("elegir otro modo llama al comando con ese valor", async () => {
    const { menu, deps } = setup();
    await menu.modeActions(track("stereo"))[3].onSelect();
    expect(updateTrackChannelMode).toHaveBeenCalledWith({ trackId: "t1", channelMode: "right" });
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalled();
  });

  it("elegir el modo actual no hace nada", async () => {
    const { menu } = setup();
    await menu.modeActions(track("mono"))[1].onSelect();
    expect(updateTrackChannelMode).not.toHaveBeenCalled();
  });

  it("añade debajo las acciones extra", () => {
    const { menu, opened } = setup();
    const extra = { label: "Separar", onSelect: () => undefined };
    menu.channelModeEntry(track(), [extra]).onSelect();
    expect(opened()!.actions.at(-1)).toBe(extra);
  });

  it("separar canales llama a la acción con los nombres L y R", async () => {
    const { menu } = setup();
    await menu.splitChannelsAction(track("stereo")).onSelect();
    expect(splitTrackChannels).toHaveBeenCalledWith({
      trackId: "t1",
      leftName: "Pista L",
      rightName: "Pista R",
    });
  });

  it("separar canales está deshabilitada en una pista sin audio estéreo", async () => {
    const { menu } = setup();
    const action = menu.splitChannelsAction(track("stereo", false));
    expect(action.disabled).toBe(true);
    await action.onSelect();
    expect(splitTrackChannels).not.toHaveBeenCalled();
  });
});
