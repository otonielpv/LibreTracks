import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { MidiClipSummary, SongRegionSummary, SongView, TrackSummary, WaveformSummaryDto } from "@libretracks/shared/models";

import { formatMusicalPosition } from "../helpers";
import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import { midiClipSummary } from "./lanes/MidiLane";
import { sectionAt } from "./lanes/automationLaneModel";
import { SongScrubView } from "./SongScrubView";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistMidiPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  tracks: TrackSummary[];
  layout: SetlistLayoutClass;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
  menus: Pick<
    TimelineMenus,
    "openMenu" | "createMidiClipAt" | "editMidiClip" | "openMidiClipMenu" | "globalTrackListContextMenu"
  >;
};

/** The song's MIDI clips in time order. */
export function songMidiClips(song: SongView, region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">) {
  return (song.midiClips ?? [])
    .filter((clip) => clip.timelineStartSeconds >= region.startSeconds && clip.timelineStartSeconds < region.endSeconds)
    .sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
}

/**
 * Edit → MIDI: the song's waveform (SongScrubView: swipe, zoom, play from
 * the line) with each MIDI clip where it fires, so you see which part of
 * the song it lands on, and the list below. Every action is the DAW's:
 * «+ MIDI here» creates on a MIDI track at the line's bar (MidiClipModal),
 * tapping a clip edits it, holding it (or «…») opens its menu.
 */
function SetlistMidiPanelComponent({
  song,
  region,
  tracks,
  layout,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  runShortcutAction,
  menus,
}: SetlistMidiPanelProps) {
  const { t } = useTranslation();
  const midiTracks = tracks.filter((track) => track.kind === "midi");
  const clips = songMidiClips(song, region);
  const trackName = (id: string) => tracks.find((track) => track.id === id)?.name ?? "MIDI";
  // Each MIDI track its own row on the waveform, so clips of two tracks at
  // the same moment do not cover each other.
  const rowOf = (id: string) => Math.max(0, midiTracks.findIndex((track) => track.id === id));

  const addAt = (event: ReactMouseEvent<HTMLElement>, seconds: number) => {
    if (midiTracks.length === 1) {
      menus.createMidiClipAt(midiTracks[0].id, seconds);
      return;
    }
    menus.openMenu(
      event,
      t("setlistView.midi.add"),
      midiTracks.map((track) => ({ label: track.name, onSelect: () => menus.createMidiClipAt(track.id, seconds) })),
    );
  };
  const addMidiTrack = menus
    .globalTrackListContextMenu()
    .find((action) => action.label === t("transport.midi.addTrack"));

  const chip = (clip: MidiClipSummary, x: number) => (
    <button
      key={clip.id}
      type="button"
      className="lt-setlist-scrub-midi"
      style={{ left: `${x}px`, "--lt-midi-row": rowOf(clip.trackId) } as CSSProperties}
      title={`${trackName(clip.trackId)}: ${clip.name || "MIDI"}\n${midiClipSummary(clip)}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => menus.editMidiClip(clip)}
      onContextMenu={(event) => {
        event.preventDefault();
        menus.openMidiClipMenu(event, clip);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">piano</span>
      {clip.name || midiClipSummary(clip)}
    </button>
  );

  return (
    <div className={`lt-setlist-automation lt-setlist-midi is-${layout}`}>
      {midiTracks.length === 0 ? (
        <div className="lt-setlist-sections-bar">
          <p className="lt-setlist-sections-hint">{t("setlistView.midi.noTracks")}</p>
          {addMidiTrack ? (
            <button type="button" className="lt-setlist-settings-button is-primary" onClick={() => void addMidiTrack.onSelect?.()}>
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {addMidiTrack.label}
            </button>
          ) : null}
        </div>
      ) : (
        <SongScrubView
          song={song}
          region={region}
          waveformSummaries={waveformSummaries}
          positionSecondsRef={positionSecondsRef}
          onSeek={onSeek}
          runShortcutAction={runShortcutAction}
          overlay={({ xOf }) => clips.map((clip) => chip(clip, xOf(clip.timelineStartSeconds)))}
          actions={({ cursorSeconds }) => (
            <button
              type="button"
              className="lt-setlist-settings-button is-primary"
              aria-haspopup={midiTracks.length > 1 ? "menu" : undefined}
              onClick={(event) => addAt(event, cursorSeconds())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {t("setlistView.midi.addHere")}
            </button>
          )}
        />
      )}
      {midiTracks.length > 0 && clips.length === 0 ? (
        <p className="lt-setlist-sections-hint">{t("setlistView.midi.empty")}</p>
      ) : null}
      <ul className="lt-setlist-automation-list" aria-label={t("setlistView.midi.list")}>
        {clips.map((clip) => {
          const section = sectionAt(song, region, clip.timelineStartSeconds);
          return (
            <li key={clip.id} className="lt-setlist-automation-item">
              <span className="material-symbols-outlined lt-setlist-midi-icon" aria-hidden="true">piano</span>
              <button type="button" className="lt-setlist-automation-main" onClick={() => menus.editMidiClip(clip)}>
                <span className="lt-setlist-automation-when">
                  <span className="lt-setlist-sections-position">{formatMusicalPosition(clip.timelineStartSeconds, song)}</span>
                  {section ? <span className="lt-setlist-automation-section">{section.name}</span> : null}
                  <span className="lt-setlist-automation-section">{trackName(clip.trackId)}</span>
                </span>
                <strong className="lt-setlist-automation-name">{clip.name || "MIDI"}</strong>
                <span className="lt-setlist-automation-what">{midiClipSummary(clip)}</span>
              </button>
              <button
                type="button"
                className="lt-setlist-song-button"
                aria-label={t("setlistView.sections.menu", { name: clip.name || "MIDI" })}
                title={t("setlistView.sections.menu", { name: clip.name || "MIDI" })}
                onClick={(event) => menus.openMidiClipMenu(event, clip)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">more_horiz</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const SetlistMidiPanel = memo(SetlistMidiPanelComponent);
