import { describe, expect, it, vi } from "vitest";
import type { TrackSummary } from "@libretracks/shared/models";

import type { ContextMenuAction } from "../types";
import { multiTrackMixActions } from "./multiTrackMixMenu";

function track(id: string): TrackSummary {
  return { id, name: id } as TrackSummary;
}

/** Labels come back interpolated so the assertions read like the menu does. */
const t = (key: string, options?: Record<string, unknown>) => {
  const suffix = options
    ? Object.entries(options)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")
    : "";
  return suffix ? `${key}[${suffix}]` : key;
};

function build(tracks = [track("a"), track("b"), track("c")]) {
  const mix = {
    nudgeVolumeDb: vi.fn(),
    setVolume: vi.fn(),
    nudgePan: vi.fn(),
    setPan: vi.fn(),
    setAudioTo: vi.fn(),
  };
  const opened: Array<{ title: string; actions: ContextMenuAction[] }> = [];
  const actions = multiTrackMixActions({
    tracks,
    t,
    routingOptions: [
      { value: "master", label: "Master" },
      { value: "out-3-4", label: "3/4" },
    ],
    mix,
    openSubMenu: (title, subActions) => opened.push({ title, actions: subActions }),
  });
  return { actions, mix, opened };
}

/** Open entry `index` of the top menu and return the submenu it pushed. */
function openSub(index: number) {
  const built = build();
  built.actions[index].onSelect();
  expect(built.opened).toHaveLength(1);
  return { ...built, sub: built.opened[0].actions };
}

function select(actions: ContextMenuAction[], labelPart: string) {
  const action = actions.find((entry) => entry.label.includes(labelPart));
  if (!action) {
    throw new Error(
      `no action matching "${labelPart}" in: ${actions.map((a) => a.label).join(" | ")}`,
    );
  }
  action.onSelect();
}

describe("multiTrackMixActions", () => {
  it("offers volume, pan and routing for the selection", () => {
    const { actions } = build();
    expect(actions.map((action) => action.label)).toEqual([
      "transport.menu.volumeOfTracks[count=3]",
      "transport.menu.panOfTracks[count=3]",
      "transport.menu.routingOfTracks[count=3]",
    ]);
  });

  // The whole point: a step has to reach EVERY selected track. Sending it to
  // the first one only would silently edit one track out of three.
  it("sends a volume step to every selected track", () => {
    const { sub, mix } = openSub(0);
    select(sub, "db=3");
    expect(mix.nudgeVolumeDb).toHaveBeenCalledWith(["a", "b", "c"], 3);
  });

  it("keeps the sign of a cut", () => {
    const { sub, mix } = openSub(0);
    select(sub, "db=6");
    // Two entries carry db=6; `select` takes the first, which is the boost.
    expect(mix.nudgeVolumeDb).toHaveBeenCalledWith(["a", "b", "c"], 6);

    const cut = openSub(0);
    cut.sub[cut.sub.length - 2].onSelect();
    expect(cut.mix.nudgeVolumeDb).toHaveBeenCalledWith(["a", "b", "c"], -6);
  });

  // Relative for the steps, absolute for the resets: the steps preserve the
  // balance between tracks, the resets deliberately flatten it.
  it("resets volume and pan absolutely", () => {
    const volume = openSub(0);
    select(volume.sub, "volumeReset");
    expect(volume.mix.setVolume).toHaveBeenCalledWith(["a", "b", "c"], 1);

    const pan = openSub(1);
    select(pan.sub, "panCenter");
    expect(pan.mix.setPan).toHaveBeenCalledWith(["a", "b", "c"], 0);
    select(pan.sub, "panHardLeft");
    expect(pan.mix.setPan).toHaveBeenCalledWith(["a", "b", "c"], -1);
    select(pan.sub, "panHardRight");
    expect(pan.mix.setPan).toHaveBeenCalledWith(["a", "b", "c"], 1);
  });

  it("routes the whole selection to one output", () => {
    const { sub, mix } = openSub(2);
    expect(sub.map((action) => action.label)).toEqual(["Master", "3/4"]);
    select(sub, "3/4");
    expect(mix.setAudioTo).toHaveBeenCalledWith(["a", "b", "c"], "out-3-4");
  });

  it("disables routing when there is no output to pick", () => {
    const actions = multiTrackMixActions({
      tracks: [track("a")],
      t,
      routingOptions: [],
      mix: {
        nudgeVolumeDb: vi.fn(),
        setVolume: vi.fn(),
        nudgePan: vi.fn(),
        setPan: vi.fn(),
        setAudioTo: vi.fn(),
      },
      openSubMenu: () => {},
    });
    expect(actions[2].disabled).toBe(true);
  });
});
