import { beforeEach, describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { getSong, setSong } from "../songStore";
import { useTransportStore } from "../store";
import { applyMidiMixChanged, midiControllableTracks } from "./useMidiControllerSync";

const track = (id: string, kind: "audio" | "video" | "folder" = "audio") => ({
  id,
  name: id,
  kind,
  depth: 0,
  hasChildren: false,
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  audioTo: "master",
  transposeEnabled: true,
});

describe("useMidiControllerSync", () => {
  beforeEach(() => {
    useTransportStore.setState({ optimisticMix: {} });
    setSong(null);
  });

  it("merges MIDI mix changes into the optimistic mix", () => {
    useTransportStore.getState().setOptimisticMix("t1", { pan: -0.5 });
    applyMidiMixChanged({ tracks: { t1: { volume: 0.4 }, t2: { muted: true } } });
    const mix = useTransportStore.getState().optimisticMix;
    expect(mix.t1).toEqual({ pan: -0.5, volume: 0.4 });
    expect(mix.t2).toEqual({ muted: true });
  });

  it("moves the song master of the right region", () => {
    setSong({
      regions: [
        { id: "r1", master: { gain: 1 } },
        { id: "r2", master: { gain: 1 } },
      ],
      tracks: [],
    } as unknown as SongView);
    applyMidiMixChanged({ tracks: {}, songMaster: { regionId: "r2", gain: 0.5 } });
    const regions = getSong()?.regions ?? [];
    expect(regions.map((region) => region.master.gain)).toEqual([1, 0.5]);
  });

  it("leaves video tracks out of the controller", () => {
    const song = {
      tracks: [track("a"), track("v", "video"), track("f", "folder")],
    } as unknown as SongView;
    expect(midiControllableTracks(song).map((item) => item.id)).toEqual(["a", "f"]);
  });
});
