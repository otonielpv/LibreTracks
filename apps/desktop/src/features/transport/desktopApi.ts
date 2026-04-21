export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type TrackKind = "audio" | "folder";
export type JumpTriggerLabel = "immediate" | "section_end" | `after_bars:${number}`;

export type SectionSummary = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
};

export type PendingJumpSummary = {
  targetSectionId: string;
  targetSectionName: string;
  trigger: JumpTriggerLabel;
};

export type TrackSummary = {
  id: string;
  name: string;
  kind: TrackKind;
  parentTrackId?: string | null;
  depth: number;
  hasChildren: boolean;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

export type ClipSummary = {
  id: string;
  trackId: string;
  trackName: string;
  filePath: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  sourceDurationSeconds: number;
  durationSeconds: number;
  gain: number;
  waveformPeaks: number[];
  waveformMinPeaks: number[];
  waveformMaxPeaks: number[];
};

export type SongSummary = {
  id: string;
  title: string;
  artist?: string | null;
  bpm: number;
  key?: string | null;
  timeSignature: string;
  durationSeconds: number;
  sections: SectionSummary[];
  clips: ClipSummary[];
  tracks: TrackSummary[];
};

export type TransportSnapshot = {
  playbackState: PlaybackState;
  positionSeconds: number;
  song?: SongSummary | null;
  currentSection?: SectionSummary | null;
  pendingSectionJump?: PendingJumpSummary | null;
  transportClock?: {
    anchorPositionSeconds: number;
    running: boolean;
    lastSeekPositionSeconds?: number | null;
    lastStartPositionSeconds?: number | null;
    lastJumpPositionSeconds?: number | null;
  };
  songDir?: string | null;
  isNativeRuntime: boolean;
};

const tauriWindow = window as Window & {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriApp = Boolean(tauriWindow.__TAURI_INTERNALS__);

type DemoClock = {
  anchorPositionSeconds: number;
  anchorStartedAt: number | null;
  lastSeekPositionSeconds: number | null;
  lastStartPositionSeconds: number | null;
  lastJumpPositionSeconds: number | null;
};

let demoSong = buildDemoSong();
let demoPlaybackState: PlaybackState = "stopped";
let demoPendingJump: PendingJumpSummary | null = null;
let demoClock: DemoClock = {
  anchorPositionSeconds: 0,
  anchorStartedAt: null,
  lastSeekPositionSeconds: null,
  lastStartPositionSeconds: null,
  lastJumpPositionSeconds: null,
};

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowSeconds() {
  return Date.now() / 1000;
}

function currentDemoPosition() {
  if (demoPlaybackState !== "playing" || demoClock.anchorStartedAt === null) {
    return demoClock.anchorPositionSeconds;
  }

  const elapsed = nowSeconds() - demoClock.anchorStartedAt;
  return Math.min(demoSong.durationSeconds, demoClock.anchorPositionSeconds + elapsed);
}

function syncDemoPlayback() {
  const nextPosition = currentDemoPosition();
  demoClock.anchorPositionSeconds = nextPosition;

  if (demoPlaybackState === "playing") {
    demoClock.anchorStartedAt = nowSeconds();
  }

  if (nextPosition >= demoSong.durationSeconds) {
    demoPlaybackState = "stopped";
    demoClock.anchorStartedAt = null;
  }
}

function updateDemoSong(mutator: (song: SongSummary) => SongSummary) {
  syncDemoPlayback();
  demoSong = normalizeSong(mutator(cloneSnapshot(demoSong)));
  demoClock.anchorPositionSeconds = Math.min(demoClock.anchorPositionSeconds, demoSong.durationSeconds);
}

function buildDemoSnapshot(): TransportSnapshot {
  syncDemoPlayback();
  const positionSeconds = demoClock.anchorPositionSeconds;

  return {
    playbackState: demoPlaybackState,
    positionSeconds,
    song: cloneSnapshot(demoSong),
    currentSection:
      demoSong.sections.find(
        (section) => positionSeconds >= section.startSeconds && positionSeconds < section.endSeconds,
      ) ?? null,
    pendingSectionJump: demoPendingJump ? cloneSnapshot(demoPendingJump) : null,
    transportClock: {
      anchorPositionSeconds: demoClock.anchorPositionSeconds,
      running: demoPlaybackState === "playing",
      lastSeekPositionSeconds: demoClock.lastSeekPositionSeconds,
      lastStartPositionSeconds: demoClock.lastStartPositionSeconds,
      lastJumpPositionSeconds: demoClock.lastJumpPositionSeconds,
    },
    songDir: "demo://session",
    isNativeRuntime: false,
  };
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function createSong(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSong = normalizeSong({
      id: `song-demo-${Date.now()}`,
      title: "Nueva Cancion",
      artist: null,
      bpm: 120,
      key: null,
      timeSignature: "4/4",
      durationSeconds: 60,
      sections: [],
      clips: [],
      tracks: [],
    });
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock = {
      anchorPositionSeconds: 0,
      anchorStartedAt: null,
      lastSeekPositionSeconds: 0,
      lastStartPositionSeconds: null,
      lastJumpPositionSeconds: null,
    };
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_song");
}

export async function saveProject(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("save_project");
}

export async function openProject(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    demoSong = buildDemoSong();
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock.anchorPositionSeconds = 0;
    demoClock.anchorStartedAt = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("open_project_from_dialog");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("pick_and_import_song_from_dialog");
}

export async function playTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    syncDemoPlayback();
    demoPlaybackState = "playing";
    demoClock.anchorStartedAt = nowSeconds();
    demoClock.lastStartPositionSeconds = demoClock.anchorPositionSeconds;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("play_transport");
}

export async function pauseTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    syncDemoPlayback();
    demoPlaybackState = "paused";
    demoClock.anchorStartedAt = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("pause_transport");
}

export async function stopTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock.anchorPositionSeconds = 0;
    demoClock.anchorStartedAt = null;
    demoClock.lastSeekPositionSeconds = 0;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("stop_transport");
}

export async function seekTransport(positionSeconds: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoClock.anchorPositionSeconds = clamp(positionSeconds, 0, demoSong.durationSeconds);
    demoClock.anchorStartedAt = demoPlaybackState === "playing" ? nowSeconds() : null;
    demoClock.lastSeekPositionSeconds = demoClock.anchorPositionSeconds;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("seek_transport", { positionSeconds });
}

export async function scheduleSectionJump(
  targetSectionId: string,
  trigger: "immediate" | "section_end" | "after_bars",
  bars?: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const targetSection = demoSong.sections.find((section) => section.id === targetSectionId) ?? null;
    if (targetSection) {
      if (trigger === "immediate") {
        demoClock.anchorPositionSeconds = targetSection.startSeconds;
        demoClock.lastJumpPositionSeconds = targetSection.startSeconds;
        demoPendingJump = null;
      } else {
        demoPendingJump = {
          targetSectionId,
          targetSectionName: targetSection.name,
          trigger: trigger === "after_bars" ? `after_bars:${bars ?? 4}` : "section_end",
        };
      }
    }
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("schedule_section_jump", {
    targetSectionId,
    trigger,
    bars,
  });
}

export async function cancelSectionJump(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoPendingJump = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("cancel_section_jump");
}

export async function moveClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
            }
          : clip,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("move_clip", { clipId, timelineStartSeconds });
}

export async function deleteClip(clipId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.filter((clip) => clip.id !== clipId),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_clip", { clipId });
}

export async function updateClipWindow(
  clipId: string,
  timelineStartSeconds: number,
  sourceStartSeconds: number,
  durationSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
              sourceStartSeconds: Math.max(0, sourceStartSeconds),
              durationSeconds: Math.max(0.05, durationSeconds),
            }
          : clip,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_clip_window", {
    clipId,
    timelineStartSeconds,
    sourceStartSeconds,
    durationSeconds,
  });
}

export async function duplicateClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const sourceClip = song.clips.find((clip) => clip.id === clipId);
      if (!sourceClip) {
        return song;
      }

      return {
        ...song,
        clips: [
          ...song.clips,
          {
            ...sourceClip,
            id: `clip-demo-${Date.now()}`,
            timelineStartSeconds: Math.max(0, timelineStartSeconds),
          },
        ],
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("duplicate_clip", { clipId, timelineStartSeconds });
}

export async function splitClip(
  clipId: string,
  splitSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const index = song.clips.findIndex((clip) => clip.id === clipId);
      if (index === -1) {
        return song;
      }

      const sourceClip = song.clips[index];
      const clipEnd = sourceClip.timelineStartSeconds + sourceClip.durationSeconds;
      if (splitSeconds <= sourceClip.timelineStartSeconds || splitSeconds >= clipEnd) {
        return song;
      }

      const leftDuration = splitSeconds - sourceClip.timelineStartSeconds;
      const rightDuration = clipEnd - splitSeconds;
      const clips = [...song.clips];
      clips.splice(index, 1, {
        ...sourceClip,
        id: `${sourceClip.id}-a`,
        durationSeconds: leftDuration,
      }, {
        ...sourceClip,
        id: `${sourceClip.id}-b`,
        timelineStartSeconds: splitSeconds,
        sourceStartSeconds: sourceClip.sourceStartSeconds + leftDuration,
        durationSeconds: rightDuration,
      });

      return {
        ...song,
        clips,
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("split_clip", { clipId, splitSeconds });
}

export async function createSection(
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sections: [...song.sections, {
        id: `section-demo-${Date.now()}`,
        name: `Seccion ${song.sections.length + 1}`,
        startSeconds: Math.min(startSeconds, endSeconds),
        endSeconds: Math.max(startSeconds, endSeconds),
      }],
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_section", { startSeconds, endSeconds });
}

export async function updateSection(
  sectionId: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sections: song.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              name,
              startSeconds: Math.min(startSeconds, endSeconds),
              endSeconds: Math.max(startSeconds, endSeconds),
            }
          : section,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_section", {
    sectionId,
    name,
    startSeconds,
    endSeconds,
  });
}

export async function deleteSection(sectionId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sections: song.sections.filter((section) => section.id !== sectionId),
    }));
    if (demoPendingJump?.targetSectionId === sectionId) {
      demoPendingJump = null;
    }
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_section", { sectionId });
}

export async function createTrack(args: {
  name: string;
  kind: TrackKind;
  insertAfterTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const nextTrack: TrackSummary = {
        id: `track-demo-${Date.now()}`,
        name: args.name,
        kind: args.kind,
        parentTrackId: args.parentTrackId ?? null,
        depth: 0,
        hasChildren: false,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      };
      return {
        ...song,
        tracks: insertTrack(song.tracks, nextTrack, args.insertAfterTrackId ?? null, args.parentTrackId ?? null),
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_track", args);
}

export async function moveTrack(args: {
  trackId: string;
  insertAfterTrackId?: string | null;
  insertBeforeTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      tracks: moveTrackInList(
        song.tracks,
        args.trackId,
        args.insertAfterTrackId ?? null,
        args.insertBeforeTrackId ?? null,
        args.parentTrackId ?? null,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("move_track", args);
}

export async function updateTrack(args: {
  trackId: string;
  name?: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      tracks: song.tracks.map((track) =>
        track.id === args.trackId
          ? {
              ...track,
              name: args.name ?? track.name,
              volume: args.volume ?? track.volume,
              pan: args.pan ?? track.pan,
              muted: args.muted ?? track.muted,
              solo: args.solo ?? track.solo,
            }
          : track,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_track", args);
}

export async function deleteTrack(trackId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => deleteTrackFromSong(song, trackId));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_track", { trackId });
}

function deleteTrackFromSong(song: SongSummary, trackId: string): SongSummary {
  const track = song.tracks.find((entry) => entry.id === trackId);
  if (!track) {
    return song;
  }

  const nextTracks = song.tracks
    .filter((entry) => entry.id !== trackId)
    .map((entry) =>
      entry.parentTrackId === trackId ? { ...entry, parentTrackId: track.parentTrackId ?? null } : entry,
    );

  return {
    ...song,
    tracks: nextTracks,
    clips: track.kind === "audio" ? song.clips.filter((clip) => clip.trackId !== trackId) : song.clips,
  };
}

function normalizeSong(song: SongSummary): SongSummary {
  const tracks = song.tracks.map((track) => ({
    ...track,
    parentTrackId: track.parentTrackId ?? null,
  }));
  const trackIndex = new Map(tracks.map((track) => [track.id, track]));

  const normalizedTracks = tracks.map((track) => {
    let depth = 0;
    let cursor = track.parentTrackId;

    while (cursor) {
      depth += 1;
      cursor = trackIndex.get(cursor)?.parentTrackId ?? null;
    }

    return {
      ...track,
      depth,
      hasChildren: tracks.some((candidate) => candidate.parentTrackId === track.id),
    };
  });

  const normalizedClips = song.clips.map((clip) => ({
    ...clip,
    trackName: trackIndex.get(clip.trackId)?.name ?? clip.trackName,
  }));

  const durationSeconds = Math.max(
    song.durationSeconds,
    normalizedClips.reduce(
      (maxDuration, clip) => Math.max(maxDuration, clip.timelineStartSeconds + clip.durationSeconds),
      0,
    ),
  );

  return {
    ...song,
    durationSeconds,
    tracks: normalizedTracks,
    clips: normalizedClips,
    sections: [...song.sections].sort((left, right) => left.startSeconds - right.startSeconds),
  };
}

function insertTrack(
  tracks: TrackSummary[],
  track: TrackSummary,
  insertAfterTrackId: string | null,
  parentTrackId: string | null,
) {
  const nextTracks = [...tracks];
  track.parentTrackId = parentTrackId;
  const insertIndex = resolveInsertIndex(nextTracks, insertAfterTrackId, parentTrackId);
  nextTracks.splice(insertIndex, 0, track);
  return nextTracks;
}

function moveTrackInList(
  tracks: TrackSummary[],
  trackId: string,
  insertAfterTrackId: string | null,
  insertBeforeTrackId: string | null,
  parentTrackId: string | null,
) {
  const nextTracks = [...tracks];
  const start = nextTracks.findIndex((track) => track.id === trackId);
  if (start === -1) {
    return nextTracks;
  }

  const rootDepth = nextTracks[start].depth;
  let end = start + 1;
  while (end < nextTracks.length && nextTracks[end].depth > rootDepth) {
    end += 1;
  }

  const block = nextTracks.splice(start, end - start);
  block[0] = {
    ...block[0],
    parentTrackId,
  };
  const insertIndex = resolveInsertIndex(
    nextTracks,
    insertAfterTrackId,
    insertBeforeTrackId,
    parentTrackId,
  );
  nextTracks.splice(insertIndex, 0, ...block);
  return nextTracks;
}

function resolveInsertIndex(
  tracks: TrackSummary[],
  insertAfterTrackId: string | null,
  insertBeforeTrackId: string | null,
  parentTrackId: string | null,
) {
  if (insertAfterTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === insertAfterTrackId);
    if (anchorIndex === -1) {
      return tracks.length;
    }

    const anchorDepth = tracks[anchorIndex].depth;
    let end = anchorIndex + 1;
    while (end < tracks.length && tracks[end].depth > anchorDepth) {
      end += 1;
    }
    return end;
  }

  if (insertBeforeTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === insertBeforeTrackId);
    return anchorIndex === -1 ? tracks.length : anchorIndex;
  }

  if (parentTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === parentTrackId);
    if (anchorIndex === -1) {
      return tracks.length;
    }

    const anchorDepth = tracks[anchorIndex].depth;
    let end = anchorIndex + 1;
    while (end < tracks.length && tracks[end].depth > anchorDepth) {
      end += 1;
    }
    return end;
  }

  return tracks.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildDemoSong(): SongSummary {
  const rhythmWave = buildWaveform(176, "smooth");
  const bassWave = buildWaveform(176, "pulse");
  const clickWave = buildWaveform(176, "ticks");
  const vocalWave = buildWaveform(176, "phrases");

  return normalizeSong({
    id: "song-demo",
    title: "LibreTracks Session",
    artist: "Demo Ensemble",
    bpm: 120,
    key: "Am",
    timeSignature: "4/4",
    durationSeconds: 180,
    tracks: [
      {
        id: "track-folder-rhythm",
        name: "Rhythm",
        kind: "folder",
        parentTrackId: null,
        depth: 0,
        hasChildren: true,
        volume: 0.92,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-drums",
        name: "Drums",
        kind: "audio",
        parentTrackId: "track-folder-rhythm",
        depth: 1,
        hasChildren: false,
        volume: 0.88,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-bass",
        name: "Bass",
        kind: "audio",
        parentTrackId: "track-folder-rhythm",
        depth: 1,
        hasChildren: false,
        volume: 0.84,
        pan: -0.04,
        muted: false,
        solo: false,
      },
      {
        id: "track-folder-guide",
        name: "Guide",
        kind: "folder",
        parentTrackId: null,
        depth: 0,
        hasChildren: true,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-click",
        name: "Click",
        kind: "audio",
        parentTrackId: "track-folder-guide",
        depth: 1,
        hasChildren: false,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-vocal",
        name: "Guide Vox",
        kind: "audio",
        parentTrackId: "track-folder-guide",
        depth: 1,
        hasChildren: false,
        volume: 0.8,
        pan: 0.08,
        muted: false,
        solo: false,
      },
      {
        id: "track-keys",
        name: "Keys",
        kind: "audio",
        parentTrackId: null,
        depth: 0,
        hasChildren: false,
        volume: 0.78,
        pan: 0.12,
        muted: false,
        solo: false,
      },
    ],
    clips: [
      {
        id: "clip-drums",
        trackId: "track-drums",
        trackName: "Drums",
        filePath: "audio/drums.wav",
        timelineStartSeconds: 0,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 180,
        durationSeconds: 180,
        gain: 1,
        waveformPeaks: rhythmWave.max,
        waveformMinPeaks: rhythmWave.min,
        waveformMaxPeaks: rhythmWave.max,
      },
      {
        id: "clip-bass",
        trackId: "track-bass",
        trackName: "Bass",
        filePath: "audio/bass.wav",
        timelineStartSeconds: 8,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 164,
        durationSeconds: 164,
        gain: 0.94,
        waveformPeaks: bassWave.max,
        waveformMinPeaks: bassWave.min,
        waveformMaxPeaks: bassWave.max,
      },
      {
        id: "clip-click",
        trackId: "track-click",
        trackName: "Click",
        filePath: "audio/click.wav",
        timelineStartSeconds: 0,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 180,
        durationSeconds: 180,
        gain: 1,
        waveformPeaks: clickWave.max,
        waveformMinPeaks: clickWave.min,
        waveformMaxPeaks: clickWave.max,
      },
      {
        id: "clip-vocal",
        trackId: "track-vocal",
        trackName: "Guide Vox",
        filePath: "audio/guide.wav",
        timelineStartSeconds: 12,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 140,
        durationSeconds: 140,
        gain: 0.86,
        waveformPeaks: vocalWave.max,
        waveformMinPeaks: vocalWave.min,
        waveformMaxPeaks: vocalWave.max,
      },
    ],
    sections: [
      { id: "section-intro", name: "Intro", startSeconds: 0, endSeconds: 24 },
      { id: "section-verse", name: "Verse", startSeconds: 24, endSeconds: 72 },
      { id: "section-bridge", name: "Bridge", startSeconds: 72, endSeconds: 108 },
      { id: "section-outro", name: "Outro", startSeconds: 108, endSeconds: 156 },
    ],
  });
}

function buildWaveform(sampleCount: number, mode: "smooth" | "pulse" | "ticks" | "phrases") {
  const min: number[] = [];
  const max: number[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / Math.max(1, sampleCount - 1);
    let amplitude = 0.16;

    if (mode === "smooth") {
      amplitude =
        0.18 +
        Math.abs(Math.sin(progress * 15.5)) * 0.2 +
        Math.abs(Math.sin(progress * 52.0)) * 0.08 +
        Math.abs(Math.cos(progress * 7.0)) * 0.07;
    } else if (mode === "pulse") {
      amplitude =
        0.08 +
        Math.pow(Math.abs(Math.sin(progress * 24.0)), 1.5) * 0.34 +
        Math.abs(Math.cos(progress * 6.2)) * 0.06;
    } else if (mode === "ticks") {
      const subdivision = Math.floor(progress * 32);
      amplitude = subdivision % 2 === 0 ? 0.42 : 0.1;
    } else if (mode === "phrases") {
      amplitude =
        0.04 +
        Math.max(0, Math.sin(progress * 11.0)) * 0.22 +
        Math.abs(Math.sin(progress * 33.0)) * 0.09;
      if (progress > 0.18 && progress < 0.28) {
        amplitude += 0.18;
      }
      if (progress > 0.52 && progress < 0.68) {
        amplitude += 0.24;
      }
      if (progress > 0.82 && progress < 0.9) {
        amplitude += 0.28;
      }
    }

    const ceiling = clamp(amplitude, 0.04, 0.94);
    max.push(ceiling);
    min.push(-ceiling);
  }

  return { min, max };
}
