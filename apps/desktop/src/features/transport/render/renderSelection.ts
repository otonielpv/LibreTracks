import type { SongView, TrackSummary } from "@libretracks/shared/models";
import type { RenderSampleFormat } from "@libretracks/shared/desktopApi";

/**
 * Pure helpers behind the "Render audio" modal: which tracks a song can
 * render, what the file is called, and which options the user chose last time.
 */

export type RenderableTrack = {
  id: string;
  name: string;
  color: string | null;
  /** Folder nesting, for indentation. */
  depth: number;
  /** Folders under which this track sits, outermost first. */
  folderNames: string[];
};

/**
 * Audio tracks with at least one clip sounding inside the song, in session
 * order. Folders are not listed (they render through their tracks), nor are
 * MIDI tracks, which make no sound of their own.
 */
export function renderableTracks(song: SongView | null, regionId: string): RenderableTrack[] {
  const region = song?.regions.find((candidate) => candidate.id === regionId);
  if (!song || !region) {
    return [];
  }
  const withClips = new Set(
    song.clips
      .filter(
        (clip) =>
          clip.timelineStartSeconds < region.endSeconds &&
          clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds,
      )
      .map((clip) => clip.trackId),
  );
  const byId = new Map(song.tracks.map((track) => [track.id, track]));
  const folderNames = (track: TrackSummary) => {
    const names: string[] = [];
    let parentId = track.parentTrackId ?? null;
    // Bounded like the engine's folder walk, so a malformed cycle cannot hang.
    for (let depth = 0; parentId && depth < 8; depth += 1) {
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentTrackId ?? null;
    }
    return names;
  };
  return song.tracks
    .filter((track) => track.kind === "audio" && withClips.has(track.id))
    .map((track) => ({
      id: track.id,
      name: track.name,
      color: track.color ?? null,
      depth: track.depth,
      folderNames: folderNames(track),
    }));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Default file name, without extension. Says what is IN the file, because
 * the point of the feature is sending each musician a different mix:
 * "Song (sin Batería)" tells the drummer at a glance it is theirs.
 */
export function defaultRenderFileName(
  t: Translate,
  songName: string,
  tracks: RenderableTrack[],
  selectedIds: ReadonlySet<string>,
  mode: "mix" | "stems",
): string {
  const name = songName.trim() || t("transport.renderModal.untitled");
  if (mode === "stems") {
    return t("transport.renderModal.stemsFileName", { name });
  }
  const excluded = tracks.filter((track) => !selectedIds.has(track.id));
  if (excluded.length === 0) {
    return name;
  }
  const included = tracks.length - excluded.length;
  if (included === 1) {
    const only = tracks.find((track) => selectedIds.has(track.id));
    return t("transport.renderModal.onlyFileName", { name, track: only?.name ?? "" });
  }
  if (excluded.length <= 2) {
    return t("transport.renderModal.withoutFileName", {
      name,
      tracks: excluded.map((track) => track.name).join(t("transport.renderModal.andSeparator")),
    });
  }
  return t("transport.renderModal.customMixFileName", { name });
}

export type RenderPreferences = {
  mode: "mix" | "stems";
  format: RenderSampleFormat;
  sampleRate: number | null;
  channels: 1 | 2;
  normalize: boolean;
  applyMixer: boolean;
  includeMetronome: boolean;
  includeVoiceGuide: boolean;
};

export const DEFAULT_RENDER_PREFERENCES: RenderPreferences = {
  mode: "mix",
  // 24-bit: the common ground every DAW opens, with headroom to spare.
  format: "pcm24",
  sampleRate: null,
  channels: 2,
  normalize: false,
  applyMixer: true,
  includeMetronome: false,
  includeVoiceGuide: false,
};

export const RENDER_SAMPLE_RATES = [44100, 48000, 88200, 96000] as const;

const PREFERENCES_KEY = "lt.render.preferences";

/**
 * Last-used options. Per device and best effort: storage can be missing or
 * throw (private mode, blocked site data), and then the defaults apply.
 */
export function loadRenderPreferences(): RenderPreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return DEFAULT_RENDER_PREFERENCES;
    }
    const parsed = JSON.parse(raw) as Partial<RenderPreferences>;
    const merged = { ...DEFAULT_RENDER_PREFERENCES, ...parsed };
    return {
      mode: merged.mode === "stems" ? "stems" : "mix",
      format: (["pcm16", "pcm24", "float32"] as const).includes(merged.format)
        ? merged.format
        : DEFAULT_RENDER_PREFERENCES.format,
      sampleRate:
        typeof merged.sampleRate === "number" &&
        (RENDER_SAMPLE_RATES as readonly number[]).includes(merged.sampleRate)
          ? merged.sampleRate
          : null,
      channels: merged.channels === 1 ? 1 : 2,
      normalize: Boolean(merged.normalize),
      applyMixer: merged.applyMixer !== false,
      includeMetronome: Boolean(merged.includeMetronome),
      includeVoiceGuide: Boolean(merged.includeVoiceGuide),
    };
  } catch {
    return DEFAULT_RENDER_PREFERENCES;
  }
}

export function saveRenderPreferences(preferences: RenderPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Not remembering is fine.
  }
}
