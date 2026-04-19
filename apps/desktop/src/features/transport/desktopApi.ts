export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type JumpTriggerLabel = "immediate" | "section_end" | `after_bars:${number}`;

export type GroupSummary = {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
};

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
  groupName?: string | null;
  volume: number;
  muted: boolean;
};

export type ClipSummary = {
  id: string;
  trackId: string;
  trackName: string;
  filePath: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  gain: number;
  waveformPeaks: number[];
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
  groups: GroupSummary[];
};

export type TransportSnapshot = {
  playbackState: PlaybackState;
  positionSeconds: number;
  song?: SongSummary | null;
  currentSection?: SectionSummary | null;
  pendingSectionJump?: PendingJumpSummary | null;
  songDir?: string | null;
  isNativeRuntime: boolean;
};

const tauriWindow = window as Window & {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriApp = Boolean(tauriWindow.__TAURI_INTERNALS__);

let demoSnapshot = buildDemoSnapshot();

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function createSong(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...buildDemoSnapshot(),
      song: {
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
        groups: [],
      },
      songDir: "demo://nueva-cancion",
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("create_song");
}

export async function saveProject(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("save_project");
}

export async function openProject(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    demoSnapshot = buildDemoSnapshot();
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot | null>("open_project_from_dialog");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    demoSnapshot = buildDemoSnapshot();
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot | null>("pick_and_import_song_from_dialog");
}

export async function playTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...demoSnapshot,
      playbackState: "playing",
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("play_transport");
}

export async function pauseTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...demoSnapshot,
      playbackState: "paused",
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("pause_transport");
}

export async function stopTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...demoSnapshot,
      playbackState: "stopped",
      positionSeconds: 0,
      pendingSectionJump: null,
      currentSection: null,
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("stop_transport");
}

export async function seekTransport(positionSeconds: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...demoSnapshot,
      positionSeconds,
      currentSection:
        demoSnapshot.song?.sections.find(
          (section) => positionSeconds >= section.startSeconds && positionSeconds < section.endSeconds,
        ) ?? null,
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("seek_transport", { positionSeconds });
}

export async function scheduleSectionJump(args: {
  targetSectionId: string;
  trigger: "immediate" | "section_end" | "after_bars";
  bars?: number;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const targetSection =
      demoSnapshot.song?.sections.find((section) => section.id === args.targetSectionId) ?? null;

    demoSnapshot = {
      ...demoSnapshot,
      pendingSectionJump:
        args.trigger === "immediate" || !targetSection
          ? null
          : {
              targetSectionId: targetSection.id,
              targetSectionName: targetSection.name,
              trigger: args.trigger === "after_bars" ? `after_bars:${args.bars ?? 4}` : "section_end",
            },
      currentSection: args.trigger === "immediate" && targetSection ? targetSection : demoSnapshot.currentSection,
      positionSeconds:
        args.trigger === "immediate" && targetSection
          ? targetSection.startSeconds
          : demoSnapshot.positionSeconds,
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("schedule_section_jump", {
    targetSectionId: args.targetSectionId,
    trigger: args.trigger,
    bars: args.bars,
  });
}

export async function cancelSectionJump(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoSnapshot = {
      ...demoSnapshot,
      pendingSectionJump: null,
    };
    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("cancel_section_jump");
}

export async function moveClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const clips = song.clips.map((clip) =>
      clip.id === clipId
        ? {
            ...clip,
            timelineStartSeconds: Math.max(0, timelineStartSeconds),
          }
        : clip,
    );
    const movedClip = clips.find((clip) => clip.id === clipId) ?? null;
    const durationSeconds = movedClip
      ? Math.max(song.durationSeconds, movedClip.timelineStartSeconds + movedClip.durationSeconds)
      : song.durationSeconds;

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        durationSeconds,
        clips,
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("move_clip", {
    clipId,
    timelineStartSeconds,
  });
}

export async function createSection(args: {
  startSeconds: number;
  endSeconds: number;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const startSeconds = Math.max(0, Math.min(args.startSeconds, args.endSeconds));
    const endSeconds = Math.min(song.durationSeconds, Math.max(args.startSeconds, args.endSeconds));
    const sectionIndex = song.sections.length + 1;
    const nextSection: SectionSummary = {
      id: `section-demo-${sectionIndex}`,
      name: `Seccion ${sectionIndex}`,
      startSeconds,
      endSeconds,
    };

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        sections: [...song.sections, nextSection].sort((left, right) => left.startSeconds - right.startSeconds),
      },
      currentSection:
        demoSnapshot.positionSeconds >= startSeconds && demoSnapshot.positionSeconds < endSeconds
          ? nextSection
          : demoSnapshot.currentSection,
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("create_section", args);
}

function buildDemoSnapshot(): TransportSnapshot {
  return {
    playbackState: "stopped",
    positionSeconds: 0,
    isNativeRuntime: false,
    song: {
      id: "demo-song",
      title: "Demo Song",
      artist: "LibreTracks",
      bpm: 72,
      key: "D",
      timeSignature: "4/4",
      durationSeconds: 240,
      sections: [],
      clips: [
        {
          id: "clip-click",
          trackId: "track-click",
          trackName: "Click",
          filePath: "audio/click.wav",
          timelineStartSeconds: 0,
          durationSeconds: 240,
          gain: 1,
          waveformPeaks: buildDemoWaveform(96, 0.25, 0.85),
        },
        {
          id: "clip-guide",
          trackId: "track-guide",
          trackName: "Guide",
          filePath: "audio/guide.wav",
          timelineStartSeconds: 0,
          durationSeconds: 240,
          gain: 1,
          waveformPeaks: buildDemoWaveform(96, 0.2, 0.72),
        },
        {
          id: "clip-drums",
          trackId: "track-drums",
          trackName: "Drums",
          filePath: "audio/drums.wav",
          timelineStartSeconds: 16,
          durationSeconds: 176,
          gain: 1,
          waveformPeaks: buildDemoWaveform(96, 0.35, 1),
        },
        {
          id: "clip-bass",
          trackId: "track-bass",
          trackName: "Bass",
          filePath: "audio/bass.wav",
          timelineStartSeconds: 32,
          durationSeconds: 160,
          gain: 1,
          waveformPeaks: buildDemoWaveform(96, 0.28, 0.8),
        },
        {
          id: "clip-keys",
          trackId: "track-keys",
          trackName: "Keys",
          filePath: "audio/keys.wav",
          timelineStartSeconds: 48,
          durationSeconds: 128,
          gain: 1,
          waveformPeaks: buildDemoWaveform(96, 0.18, 0.62),
        },
      ],
      groups: [
        { id: "group-monitor", name: "Click + Guide", volume: 1, muted: false },
        { id: "group-rhythm", name: "Drums + Bass", volume: 0.92, muted: false },
        { id: "group-keys", name: "Keys + Pads", volume: 0.78, muted: true },
      ],
      tracks: [
        { id: "track-click", name: "Click", groupName: "Click + Guide", volume: 1, muted: false },
        { id: "track-guide", name: "Guide", groupName: "Click + Guide", volume: 0.86, muted: false },
        { id: "track-drums", name: "Drums", groupName: "Drums + Bass", volume: 0.94, muted: false },
        { id: "track-bass", name: "Bass", groupName: "Drums + Bass", volume: 0.88, muted: false },
        { id: "track-keys", name: "Keys", groupName: "Keys + Pads", volume: 0.72, muted: true },
      ],
    },
    currentSection: null,
    pendingSectionJump: null,
    songDir: null,
  };
}

function cloneSnapshot(snapshot: TransportSnapshot) {
  return JSON.parse(JSON.stringify(snapshot)) as TransportSnapshot;
}

function buildDemoWaveform(bucketCount: number, floor: number, ceiling: number) {
  return Array.from({ length: bucketCount }, (_, index) => {
    const waveA = Math.sin(index * 0.33) * 0.5 + 0.5;
    const waveB = Math.cos(index * 0.12) * 0.5 + 0.5;
    const blend = (waveA * 0.7 + waveB * 0.3) * (ceiling - floor);
    return Number((floor + blend).toFixed(3));
  });
}
