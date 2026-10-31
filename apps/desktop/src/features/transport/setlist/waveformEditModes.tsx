import type { SongRegionSummary, SongView, TrackSummary, WaveformSummaryDto } from "@libretracks/shared/models";

import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import type { ComponentProps } from "react";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { SetlistEditModeEntry } from "./SetlistEditDrawer";
import { SetlistLyrics } from "./SetlistLyrics";
import { requestEditMode } from "./setlistStore";
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

/** The drawer's text-only modes: the lyrics editor (behind its flag) and,
 * off the phone, the hint that the song's lanes are under the waveform. */
export function textEditModes({
  performance,
  region,
  layout,
  lanesHint,
}: {
  performance: ComponentProps<typeof SetlistLyrics>["performance"];
  region: SongRegionSummary | null;
  layout: SetlistLayoutClass;
  lanesHint: string;
}): SetlistEditModeEntry[] {
  return [
    ...(FEATURE_FLAGS.lyrics
      ? [
          {
            mode: "lyrics" as const,
            icon: "lyrics",
            labelKey: "setlistView.edit.modes.lyrics",
            content: (
              <SetlistLyrics
                performance={performance}
                region={region}
                onClose={() => void requestEditMode(null)}
                startEditing
              />
            ),
          },
        ]
      : []),
    ...(layout === "short"
      ? []
      : [
          {
            mode: "lanes" as const,
            icon: "view_timeline",
            labelKey: "setlistView.edit.modes.lanes",
            content: <p className="lt-setlist-sections-hint">{lanesHint}</p>,
          },
        ]),
  ];
}
