import { beforeEach, describe, expect, it } from "vitest";

import type { TransportSnapshot } from "./desktopApi";
import type { PendingAudioImport } from "./library/pendingAudioImports";
import {
  meterDictionaryFromLevels,
  regionMeterDictionaryFromLevels,
  useTransportStore,
} from "./store";

function reset() {
  useTransportStore.setState({
    meters: {},
    regionMeters: {},
    playback: null,
    optimisticMix: {},
    optimisticRegionMaster: {},
    pendingAudioImports: [],
  });
}

const get = useTransportStore.getState;

function makeSnapshot(
  overrides: Partial<TransportSnapshot> = {},
): TransportSnapshot {
  return {
    playbackState: "stopped",
    positionSeconds: 0,
    projectRevision: 1,
    isNativeRuntime: false,
    ...overrides,
  };
}

function makePending(
  id: string,
  overrides: Partial<PendingAudioImport> = {},
): PendingAudioImport {
  return {
    id,
    fileName: `${id}.wav`,
    temporaryAssetId: `asset-${id}`,
    temporaryTrackId: `track-${id}`,
    temporaryClipId: `clip-${id}`,
    dropSeconds: 0,
    status: "queued",
    showInTimeline: true,
    ...overrides,
  };
}

describe("meterDictionaryFromLevels", () => {
  it("maps level arrays into a keyed dictionary", () => {
    expect(
      meterDictionaryFromLevels([
        { trackId: "a", leftPeak: 0.1, rightPeak: 0.2 },
        { trackId: "b", leftPeak: 0.3, rightPeak: 0.4 },
      ]),
    ).toEqual({
      a: { leftPeak: 0.1, rightPeak: 0.2 },
      b: { leftPeak: 0.3, rightPeak: 0.4 },
    });
  });

  it("returns an empty object for no levels", () => {
    expect(meterDictionaryFromLevels([])).toEqual({});
  });
});

describe("regionMeterDictionaryFromLevels", () => {
  it("maps region peaks into a keyed dictionary", () => {
    expect(
      regionMeterDictionaryFromLevels([
        { regionId: "r1", peak: 0.5 },
        { regionId: "r2", peak: 0.9 },
      ]),
    ).toEqual({ r1: 0.5, r2: 0.9 });
  });
});

describe("useTransportStore", () => {
  beforeEach(reset);

  describe("meters", () => {
    it("replaces the meter and region-meter dictionaries", () => {
      get().setMeters({ a: { leftPeak: 0.1, rightPeak: 0.2 } });
      expect(get().meters).toEqual({ a: { leftPeak: 0.1, rightPeak: 0.2 } });
      get().setRegionMeters({ r1: 0.7 });
      expect(get().regionMeters).toEqual({ r1: 0.7 });
    });
  });

  describe("setPlaybackState publish gating", () => {
    it("publishes the first snapshot from null", () => {
      const snap = makeSnapshot();
      get().setPlaybackState(snap);
      expect(get().playback).toBe(snap);
    });

    it("ignores a position-only change with the same signature", () => {
      const first = makeSnapshot({ positionSeconds: 0 });
      get().setPlaybackState(first);
      const sameSignature = makeSnapshot({ positionSeconds: 12.5 });
      get().setPlaybackState(sameSignature);
      // Position alone is not part of the publish signature, so the store
      // keeps the previous reference to avoid needless re-renders.
      expect(get().playback).toBe(first);
    });

    it("publishes when playbackState changes", () => {
      get().setPlaybackState(makeSnapshot({ playbackState: "stopped" }));
      const playing = makeSnapshot({ playbackState: "playing" });
      get().setPlaybackState(playing);
      expect(get().playback).toBe(playing);
    });

    it("publishes when the project revision changes", () => {
      get().setPlaybackState(makeSnapshot({ projectRevision: 1 }));
      const next = makeSnapshot({ projectRevision: 2 });
      get().setPlaybackState(next);
      expect(get().playback).toBe(next);
    });

    it("publishes when a pending marker jump appears", () => {
      get().setPlaybackState(makeSnapshot());
      const withJump = makeSnapshot({
        pendingMarkerJump: {
          targetMarkerId: "m1",
          targetMarkerName: "Verse",
          trigger: "immediate",
          executeAtSeconds: 4,
          transition: "instant",
        },
      });
      get().setPlaybackState(withJump);
      expect(get().playback).toBe(withJump);
    });

    it("publishes when the transport clock running flag flips", () => {
      get().setPlaybackState(
        makeSnapshot({ transportClock: { anchorPositionSeconds: 0, running: false } }),
      );
      const running = makeSnapshot({
        transportClock: { anchorPositionSeconds: 0, running: true },
      });
      get().setPlaybackState(running);
      expect(get().playback).toBe(running);
    });

    it("can publish a transition back to null", () => {
      get().setPlaybackState(makeSnapshot());
      get().setPlaybackState(null);
      expect(get().playback).toBeNull();
    });
  });

  describe("optimisticMix", () => {
    it("stores a mix override and removes it on null", () => {
      get().setOptimisticMix("t1", { muted: true });
      expect(get().optimisticMix.t1).toEqual({ muted: true });
      get().setOptimisticMix("t1", null);
      expect(get().optimisticMix).toEqual({});
    });

    it("removes an override when given an empty object", () => {
      get().setOptimisticMix("t1", { solo: true });
      get().setOptimisticMix("t1", {});
      expect(get().optimisticMix).toEqual({});
    });

    it("keeps state identity when clearing an absent track", () => {
      const before = get().optimisticMix;
      get().setOptimisticMix("ghost", null);
      expect(get().optimisticMix).toBe(before);
    });
  });

  describe("optimisticRegionMaster", () => {
    it("stores a gain and removes it on null", () => {
      get().setOptimisticRegionMaster("r1", 0.5);
      expect(get().optimisticRegionMaster.r1).toBe(0.5);
      get().setOptimisticRegionMaster("r1", null);
      expect(get().optimisticRegionMaster).toEqual({});
    });

    it("keeps state identity when clearing an absent region", () => {
      const before = get().optimisticRegionMaster;
      get().setOptimisticRegionMaster("ghost", null);
      expect(get().optimisticRegionMaster).toBe(before);
    });
  });

  describe("pending audio imports", () => {
    it("appends imports and ignores empty additions", () => {
      get().addPendingAudioImports([makePending("a"), makePending("b")]);
      expect(get().pendingAudioImports.map((i) => i.id)).toEqual(["a", "b"]);
      const before = get().pendingAudioImports;
      get().addPendingAudioImports([]);
      expect(get().pendingAudioImports).toBe(before);
    });

    it("updates status for the targeted ids only", () => {
      get().addPendingAudioImports([makePending("a"), makePending("b")]);
      get().updatePendingAudioImportStatus(["a"], "analyzing");
      const byId = Object.fromEntries(
        get().pendingAudioImports.map((i) => [i.id, i.status]),
      );
      expect(byId).toEqual({ a: "analyzing", b: "queued" });
    });

    it("marks imports failed with an error message", () => {
      get().addPendingAudioImports([makePending("a")]);
      get().markPendingAudioImportsFailed(["a"], "boom");
      const item = get().pendingAudioImports[0];
      expect(item.status).toBe("failed");
      expect(item.error).toBe("boom");
    });

    it("removes imports by id", () => {
      get().addPendingAudioImports([
        makePending("a"),
        makePending("b"),
        makePending("c"),
      ]);
      get().removePendingAudioImports(["a", "c"]);
      expect(get().pendingAudioImports.map((i) => i.id)).toEqual(["b"]);
    });

    it("ignores empty id lists across all mutators", () => {
      get().addPendingAudioImports([makePending("a")]);
      const before = get().pendingAudioImports;
      get().updatePendingAudioImportStatus([], "ready");
      get().removePendingAudioImports([]);
      get().markPendingAudioImportsFailed([], "x");
      expect(get().pendingAudioImports).toBe(before);
    });
  });
});
