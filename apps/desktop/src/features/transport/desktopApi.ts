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

export type AudioCommandTrace = {
  kind: string;
  reason?: string | null;
};

export type AudioOperationSummary = {
  reason?: string | null;
  elapsedMs: number;
  scheduledClips: number;
  activeSinks: number;
  openedFiles: number;
};

export type AudioStopSummary = {
  elapsedMs: number;
  stoppedSinks: number;
};

export type AudioRuntimeStateSummary = {
  activeSinks: number;
  filesOpenedLastRestart: number;
  lastScheduledClips: number;
  cachedAudioBuffers: number;
};

export type AudioDebugSnapshot = {
  enabled: boolean;
  logCommands: boolean;
  commandCount: number;
  lastCommand?: AudioCommandTrace | null;
  lastRestart?: AudioOperationSummary | null;
  lastSync?: AudioOperationSummary | null;
  lastStop?: AudioStopSummary | null;
  runtimeState: AudioRuntimeStateSummary;
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

export async function getAudioDebugSnapshot(): Promise<AudioDebugSnapshot> {
  if (!isTauriApp) {
    return {
      enabled: false,
      logCommands: false,
      commandCount: 0,
      lastCommand: null,
      lastRestart: null,
      lastSync: null,
      lastStop: null,
      runtimeState: {
        activeSinks: 0,
        filesOpenedLastRestart: 0,
        lastScheduledClips: 0,
        cachedAudioBuffers: 0,
      },
    };
  }

  return invokeCommand<AudioDebugSnapshot>("get_audio_debug_snapshot");
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

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        durationSeconds: computeSongDuration(song.sections, clips),
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

export async function deleteClip(clipId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const clips = song.clips.filter((clip) => clip.id !== clipId);
    if (clips.length === song.clips.length) {
      throw new Error(`No existe el clip ${clipId}.`);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        durationSeconds: computeSongDuration(song.sections, clips),
        clips,
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("delete_clip", { clipId });
}

export async function updateClipWindow(args: {
  clipId: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    let updated = false;
    const clips = song.clips.map((clip) => {
      if (clip.id !== args.clipId) {
        return clip;
      }

      if (
        args.timelineStartSeconds < 0 ||
        args.sourceStartSeconds < 0 ||
        args.durationSeconds < 0.05
      ) {
        throw new Error("El rango del clip no es valido.");
      }

      updated = true;
      return {
        ...clip,
        timelineStartSeconds: args.timelineStartSeconds,
        sourceStartSeconds: args.sourceStartSeconds,
        durationSeconds: args.durationSeconds,
      };
    });

    if (!updated) {
      throw new Error(`No existe el clip ${args.clipId}.`);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        clips,
        durationSeconds: computeSongDuration(song.sections, clips),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("update_clip_window", args);
}

export async function duplicateClip(args: {
  clipId: string;
  timelineStartSeconds: number;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const sourceClip = song.clips.find((clip) => clip.id === args.clipId);
    if (!sourceClip) {
      throw new Error(`No existe el clip ${args.clipId}.`);
    }

    const duplicatedClip: ClipSummary = {
      ...sourceClip,
      id: `clip-demo-${Date.now()}`,
      timelineStartSeconds: Math.max(0, args.timelineStartSeconds),
    };
    const clips = [...song.clips, duplicatedClip];

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        clips,
        durationSeconds: computeSongDuration(song.sections, clips),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("duplicate_clip", args);
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
        durationSeconds: computeSongDuration(
          [...song.sections, nextSection],
          song.clips,
        ),
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

export async function updateSection(args: {
  sectionId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const trimmedName = args.name.trim();
    if (!trimmedName) {
      throw new Error("El nombre de la seccion no puede estar vacio.");
    }

    const startSeconds = Math.max(0, Math.min(args.startSeconds, args.endSeconds));
    const endSeconds = Math.min(song.durationSeconds, Math.max(args.startSeconds, args.endSeconds));
    if (endSeconds - startSeconds < 0.05) {
      throw new Error("El rango de la seccion no es valido.");
    }

    let updatedSection: SectionSummary | null = null;
    const sections = sortSections(
      song.sections.map((section) => {
        if (section.id !== args.sectionId) {
          return section;
        }

        updatedSection = {
          ...section,
          name: trimmedName,
          startSeconds,
          endSeconds,
        };

        return updatedSection;
      }),
    );

    if (!updatedSection) {
      throw new Error(`No existe la seccion ${args.sectionId}.`);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        sections,
        durationSeconds: computeSongDuration(sections, song.clips),
      },
      currentSection: resolveDemoCurrentSection(sections, demoSnapshot.positionSeconds),
      pendingSectionJump:
        demoSnapshot.pendingSectionJump?.targetSectionId === args.sectionId
          ? {
              ...demoSnapshot.pendingSectionJump,
              targetSectionName: trimmedName,
            }
          : demoSnapshot.pendingSectionJump,
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("update_section", args);
}

export async function deleteSection(sectionId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const sections = song.sections.filter((section) => section.id !== sectionId);
    if (sections.length === song.sections.length) {
      throw new Error(`No existe la seccion ${sectionId}.`);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        sections,
        durationSeconds: computeSongDuration(sections, song.clips),
      },
      currentSection: resolveDemoCurrentSection(sections, demoSnapshot.positionSeconds),
      pendingSectionJump:
        demoSnapshot.pendingSectionJump?.targetSectionId === sectionId
          ? null
          : demoSnapshot.pendingSectionJump,
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("delete_section", { sectionId });
}

export async function createGroup(name: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      return cloneSnapshot(demoSnapshot);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        groups: [
          ...song.groups,
          {
            id: `group-demo-${song.groups.length + 1}`,
            name: trimmedName,
            volume: 1,
            muted: false,
          },
        ],
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("create_group", { name });
}

export async function assignTrackToGroup(
  trackId: string,
  groupId: string | null,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    const targetGroupName = song.groups.find((group) => group.id === groupId)?.name ?? null;
    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        tracks: song.tracks.map((track) =>
          track.id === trackId
            ? {
                ...track,
                groupName: targetGroupName,
              }
            : track,
        ),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("assign_track_to_group", {
    trackId,
    groupId,
  });
}

export async function setTrackVolume(
  trackId: string,
  volume: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        tracks: song.tracks.map((track) =>
          track.id === trackId
            ? {
                ...track,
                volume: clamp01(volume),
              }
            : track,
        ),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("set_track_volume", {
    trackId,
    volume,
  });
}

export async function toggleTrackMute(trackId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        tracks: song.tracks.map((track) =>
          track.id === trackId
            ? {
                ...track,
                muted: !track.muted,
              }
            : track,
        ),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("toggle_track_mute", { trackId });
}

export async function setGroupVolume(
  groupId: string,
  volume: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        groups: song.groups.map((group) =>
          group.id === groupId
            ? {
                ...group,
                volume: clamp01(volume),
              }
            : group,
        ),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("set_group_volume", {
    groupId,
    volume,
  });
}

export async function toggleGroupMute(groupId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const song = demoSnapshot.song;
    if (!song) {
      return cloneSnapshot(demoSnapshot);
    }

    demoSnapshot = {
      ...demoSnapshot,
      song: {
        ...song,
        groups: song.groups.map((group) =>
          group.id === groupId
            ? {
                ...group,
                muted: !group.muted,
              }
            : group,
        ),
      },
    };

    return cloneSnapshot(demoSnapshot);
  }

  return invokeCommand<TransportSnapshot>("toggle_group_mute", { groupId });
}

function buildDemoSnapshot(): TransportSnapshot {
  const clickWaveform = buildDemoWaveform(2048, 0.25, 0.85);
  const guideWaveform = buildDemoWaveform(2048, 0.2, 0.72);
  const drumsWaveform = buildDemoWaveform(2048, 0.35, 1);
  const bassWaveform = buildDemoWaveform(2048, 0.28, 0.8);
  const keysWaveform = buildDemoWaveform(2048, 0.18, 0.62);

  const sections: SectionSummary[] = [
    { id: "section-intro", name: "Intro", startSeconds: 0, endSeconds: 32 },
    { id: "section-verse", name: "Verse", startSeconds: 32, endSeconds: 96 },
    { id: "section-chorus", name: "Chorus", startSeconds: 96, endSeconds: 160 },
    { id: "section-outro", name: "Outro", startSeconds: 160, endSeconds: 240 },
  ];

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
      sections,
      clips: [
        {
          id: "clip-click",
          trackId: "track-click",
          trackName: "Click",
          filePath: "audio/click.wav",
          timelineStartSeconds: 0,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 240,
          durationSeconds: 240,
          gain: 1,
          waveformPeaks: clickWaveform.peaks,
          waveformMinPeaks: clickWaveform.minPeaks,
          waveformMaxPeaks: clickWaveform.maxPeaks,
        },
        {
          id: "clip-guide",
          trackId: "track-guide",
          trackName: "Guide",
          filePath: "audio/guide.wav",
          timelineStartSeconds: 0,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 240,
          durationSeconds: 240,
          gain: 1,
          waveformPeaks: guideWaveform.peaks,
          waveformMinPeaks: guideWaveform.minPeaks,
          waveformMaxPeaks: guideWaveform.maxPeaks,
        },
        {
          id: "clip-drums",
          trackId: "track-drums",
          trackName: "Drums",
          filePath: "audio/drums.wav",
          timelineStartSeconds: 16,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 176,
          durationSeconds: 176,
          gain: 1,
          waveformPeaks: drumsWaveform.peaks,
          waveformMinPeaks: drumsWaveform.minPeaks,
          waveformMaxPeaks: drumsWaveform.maxPeaks,
        },
        {
          id: "clip-bass",
          trackId: "track-bass",
          trackName: "Bass",
          filePath: "audio/bass.wav",
          timelineStartSeconds: 32,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 160,
          durationSeconds: 160,
          gain: 1,
          waveformPeaks: bassWaveform.peaks,
          waveformMinPeaks: bassWaveform.minPeaks,
          waveformMaxPeaks: bassWaveform.maxPeaks,
        },
        {
          id: "clip-keys",
          trackId: "track-keys",
          trackName: "Keys",
          filePath: "audio/keys.wav",
          timelineStartSeconds: 48,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 128,
          durationSeconds: 128,
          gain: 1,
          waveformPeaks: keysWaveform.peaks,
          waveformMinPeaks: keysWaveform.minPeaks,
          waveformMaxPeaks: keysWaveform.maxPeaks,
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
    currentSection: resolveDemoCurrentSection(sections, 0),
    pendingSectionJump: null,
    songDir: null,
  };
}

function cloneSnapshot(snapshot: TransportSnapshot) {
  return JSON.parse(JSON.stringify(snapshot)) as TransportSnapshot;
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function sortSections(sections: SectionSummary[]) {
  return [...sections].sort((left, right) => left.startSeconds - right.startSeconds);
}

function resolveDemoCurrentSection(sections: SectionSummary[], positionSeconds: number) {
  return (
    sections.find(
      (section) => positionSeconds >= section.startSeconds && positionSeconds < section.endSeconds,
    ) ?? null
  );
}

function computeSongDuration(sections: SectionSummary[], clips: ClipSummary[]) {
  const maxSectionEnd = sections.reduce((maxValue, section) => Math.max(maxValue, section.endSeconds), 0);
  const maxClipEnd = clips.reduce(
    (maxValue, clip) => Math.max(maxValue, clip.timelineStartSeconds + clip.durationSeconds),
    0,
  );
  return Math.max(maxSectionEnd, maxClipEnd, 1);
}

function buildDemoWaveform(bucketCount: number, floor: number, ceiling: number) {
  const peaks = Array.from({ length: bucketCount }, (_, index) => {
    const waveA = Math.sin(index * 0.33) * 0.5 + 0.5;
    const waveB = Math.cos(index * 0.12) * 0.5 + 0.5;
    const blend = (waveA * 0.7 + waveB * 0.3) * (ceiling - floor);
    return Number((floor + blend).toFixed(3));
  });

  return {
    peaks,
    minPeaks: peaks.map((peak) => Number((-peak).toFixed(3))),
    maxPeaks: peaks,
  };
}
