import { useEffect, useRef } from "react";

import type { AppSettings, MidiBinding, SongView, TrackEq } from "@libretracks/shared/models";

import {
  getMidiBank,
  isTauriApp,
  listenToMidiBankChanged,
  listenToMidiMixChanged,
  midiControllerScenes,
  midiControllerTransport,
  syncMidiController,
  type MidiMixChangedPayload,
} from "../desktopApi";
import {
  activeSongTrackIds,
  hasStripMappings,
  midiStripOrder,
  useMidiBankStore,
} from "../midi/midiBankStore";
import { setMidiMappingsForMappable } from "../midi/MidiMappable";
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
  midiMappings,
  appSettings,
}: {
  song: SongView | null;
  activeSongRegionId: string;
  midiMappings: Record<string, MidiBinding>;
  /** The switches whose LEDs the controller shows (paso 06). */
  appSettings: Pick<
    AppSettings,
    | "metronomeEnabled"
    | "voiceGuideEnabled"
    | "padEnabled"
    | "midiControllerOutput"
    | "midiStripsFollowSong"
  >;
}) {
  // Controller LEDs (paso 06): report the transport whenever it or a
  // lit setting changes; Rust sends only the LEDs that moved.
  const playing = useTransportStore((state) => state.playback?.playbackState === "playing");
  const paused = useTransportStore((state) => state.playback?.playbackState === "paused");
  const vampActive = useTransportStore((state) => Boolean(state.playback?.activeVamp));
  const { metronomeEnabled, voiceGuideEnabled, padEnabled, midiControllerOutput } = appSettings;
  useEffect(() => {
    if (!isTauriApp || !midiControllerOutput) {
      return;
    }
    void midiControllerTransport({ playing, paused, vampActive }).catch(() => undefined);
  }, [
    playing,
    paused,
    vampActive,
    metronomeEnabled,
    voiceGuideEnabled,
    padEnabled,
    midiControllerOutput,
    midiMappings,
  ]);

  // Scene LEDs (plan live-scenes, paso 05): the snapshot says which scenes
  // are engaged whoever engaged them (screen, MIDI, a cue, a song change).
  // Joined into strings so the effect runs on a change, not per snapshot.
  const sceneIds = useTransportStore((state) =>
    (state.playback?.mixScenes ?? []).map((scene) => scene.id).join("\n"),
  );
  const activeSceneIds = useTransportStore((state) =>
    (state.playback?.activeMixSceneIds ?? []).join("\n"),
  );
  useEffect(() => {
    if (!isTauriApp || !midiControllerOutput) {
      return;
    }
    const split = (joined: string) => (joined ? joined.split("\n") : []);
    void midiControllerScenes({
      sceneIds: split(sceneIds),
      activeSceneIds: split(activeSceneIds),
    }).catch(() => undefined);
  }, [sceneIds, activeSceneIds, midiControllerOutput, midiMappings]);

  useEffect(() => {
    setMidiMappingsForMappable(midiMappings);
  }, [midiMappings]);
  const stripsActive = hasStripMappings(midiMappings);
  const followSong = appSettings.midiStripsFollowSong;
  const lastRegionRef = useRef<string | null>(null);
  useEffect(() => {
    useMidiBankStore.getState().setActive(stripsActive);
  }, [stripsActive]);

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
      eq: track.eq ?? null,
    }));
    const region = song?.regions.find((item) => item.id === activeSongRegionId);
    // Strips follow the active song: its tracks only, back to the first
    // bank whenever the song changes.
    const songChanged = lastRegionRef.current !== activeSongRegionId;
    lastRegionRef.current = activeSongRegionId;
    void syncMidiController({
      tracks,
      stripOrder: midiStripOrder(
        song,
        followSong ? activeSongTrackIds(song, activeSongRegionId || null) : null,
      ),
      resetBank: followSong && songChanged,
      songMaster: region
        ? { regionId: region.id, gain: region.master?.gain ?? 1 }
        : null,
    }).catch(() => undefined);
  }, [song, activeSongRegionId, followSong]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }
    let active = true;
    const disposers: Array<() => void> = [];
    const keep = (dispose: () => void) => {
      if (active) {
        disposers.push(dispose);
      } else {
        dispose();
      }
    };
    const setBank = useMidiBankStore.getState().setBank;
    void listenToMidiMixChanged(applyMidiMixChanged).then(keep).catch(() => undefined);
    void listenToMidiBankChanged(setBank).then(keep).catch(() => undefined);
    void getMidiBank()
      .then((bank) => {
        if (active) setBank(bank);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}

/** Exported for tests: what one `midi:mix-changed` does to the UI state. */
export function applyMidiMixChanged(payload: MidiMixChangedPayload) {
  const store = useTransportStore.getState();
  const eqs = new Map<string, TrackEq | null>();
  for (const [trackId, { eq, ...patch }] of Object.entries(payload.tracks)) {
    // El EQ (plan track-eq-2) va a la canción: el editor y el botón lo leen
    // de ahí. El commit de Rust llega después con el mismo valor.
    if (eq !== undefined) eqs.set(trackId, eq);
    if (Object.keys(patch).length === 0) continue;
    store.setOptimisticMix(trackId, {
      ...(store.optimisticMix[trackId] ?? {}),
      ...patch,
    });
  }
  if (eqs.size > 0) {
    setSong((song) =>
      song
        ? {
            ...song,
            tracks: song.tracks.map((track) =>
              eqs.has(track.id) ? { ...track, eq: eqs.get(track.id) ?? null } : track,
            ),
          }
        : song,
    );
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
