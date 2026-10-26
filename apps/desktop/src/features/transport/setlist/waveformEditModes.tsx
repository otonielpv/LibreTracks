import type { SongRegionSummary, SongView, TrackSummary, WaveformSummaryDto } from "@libretracks/shared/models";

import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import type { SetlistEditModeEntry } from "./SetlistEditDrawer";
import { SetlistAutomationPanel } from "./SetlistAutomationPanel";
import { SetlistMidiPanel } from "./SetlistMidiPanel";
import { SetlistVideoPanel } from "./SetlistVideoPanel";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type WaveformEditModesInput = {
  song: SongView;
  region: SongRegionSummary | null;
  tracks: TrackSummary[];
  layout: SetlistLayoutClass;
  menus: TimelineMenus;
  positionSecondsRef: { readonly current: number };
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
  video?: VideoLaneBindings;
};

/**
 * The Edit modes that work on the song's waveform (SongScrubView): automation,
 * MIDI and video. Each places its things where they land in the song and
 * brings the DAW's actions; together they are what a phone has instead of
 * lanes.
 */
export function waveformEditModes(input: WaveformEditModesInput): SetlistEditModeEntry[] {
  const { song, region, tracks, layout, menus, positionSecondsRef, waveformSummaries, onSeek, runShortcutAction } = input;
  const scrub = { song, layout, menus, positionSecondsRef, waveformSummaries, onSeek, runShortcutAction };
  return [
    {
      mode: "automation",
      icon: "bolt",
      labelKey: "setlistView.edit.modes.automation",
      content: region ? <SetlistAutomationPanel {...scrub} region={region} /> : null,
    },
    {
      mode: "midi",
      icon: "piano",
      labelKey: "setlistView.edit.modes.midi",
      content: region ? <SetlistMidiPanel {...scrub} region={region} tracks={tracks} /> : null,
    },
    {
      mode: "video",
      icon: "movie",
      labelKey: "setlistView.edit.modes.video",
      content: region ? <SetlistVideoPanel {...scrub} region={region} tracks={tracks} video={input.video} /> : null,
    },
  ];
}
