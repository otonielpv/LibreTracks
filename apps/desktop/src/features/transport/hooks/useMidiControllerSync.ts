import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

import {
  isTauriApp,
  listenToMidiMixChanged,
  syncMidiController,
  type MidiMixChangedPayload,
} from "../desktopApi";
import { setSong } from "../songStore";
import { useTransportStore } from "../store";

/**
 * Tracks a fader on a control surface can drive: audio, folder and MIDI
 * tracks. Video tracks are left out: their mute/solo pick the picture, and
 * the audio engine does not know them.
 */
export function midiControllableTracks(song: SongView | null) {
  return (song?.tracks ?? []).filter((track) => track.kind !== "video");
}

/**
 * Bridge between the MIDI controller mirror in Rust and the UI (plan
 * midi-controllers, paso 03):
 *
 * - pushes the mix (tracks, strip order, active song master) whenever the
 *   song or the active song changes, so a fader knows where its track is
 *   without the session lock;
 * - applies `midi:mix-changed` (≤30 Hz) to the optimistic mix store, so the
 *   on-screen fader follows the physical one with no `setState` in the
 *   monolith. Rust commits the model once the control is still, and the
 *   snapshot that follows retires the optimistic values.
 */
export function useMidiControllerSync({
  song,
  activeSongRegionId,
  stripOrder,
}: {
  song: SongView | null;
  activeSongRegionId: string;
  /** Visible track ids of the active mixer, in order (strips, paso 04). */
  stripOrder?: string[];
}) {
  useEffect(() => {
    if (!isTauriApp) {
      return;
    }
    const tracks = midiControllableTracks(song).map((track) => ({
      id: track.id,
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
    }));
    const region = song?.regions.find((item) => item.id === activeSongRegionId);
    void syncMidiController({
      tracks,
      stripOrder: stripOrder ?? tracks.map((track) => track.id),
      songMaster: region
        ? { regionId: region.id, gain: region.master?.gain ?? 1 }
        : null,
    }).catch(() => undefined);
  }, [song, activeSongRegionId, stripOrder]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenToMidiMixChanged(applyMidiMixChanged)
      .then((dispose) => {
        if (!active) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}

/** Exported for tests: what one `midi:mix-changed` does to the UI state. */
export function applyMidiMixChanged(payload: MidiMixChangedPayload) {
  const store = useTransportStore.getState();
  for (const [trackId, patch] of Object.entries(payload.tracks)) {
    store.setOptimisticMix(trackId, {
      ...(store.optimisticMix[trackId] ?? {}),
      ...patch,
    });
  }
  const master = payload.songMaster;
  if (master) {
    setSong((song) =>
      song
        ? {
            ...song,
            regions: song.regions.map((region) =>
              region.id === master.regionId
                ? { ...region, master: { ...region.master, gain: master.gain } }
                : region,
            ),
          }
        : song,
    );
  }
}
