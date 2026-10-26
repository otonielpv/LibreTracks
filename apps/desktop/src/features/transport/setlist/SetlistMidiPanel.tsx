import { memo, useState, type CSSProperties } from "react";
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
    | "openMenu"
    | "createMidiClipAt"
    | "editMidiClip"
    | "openMidiClipMenu"
    | "globalTrackListContextMenu"
    | "trackContextMenu"
    | "toggleMidiTrackEnabled"
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
 * tapping a clip edits it, holding it (or «…») opens its menu. The row on
 * top picks the MIDI track «+ MIDI here» writes to, turns it on/off, and its
 * «…» is the DAW's track menu (rename, port, colour, delete).
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

  const [chosenId, setChosenId] = useState<string | null>(null);
  const target = midiTracks.find((track) => track.id === chosenId) ?? midiTracks[0] ?? null;

  const addAt = (seconds: number) => {
    if (target) menus.createMidiClipAt(target.id, seconds);
  };
  const addMidiTrack = menus
    .globalTrackListContextMenu()
    .find((action) => action.label === t("transport.midi.addTrack"));
  const addTrackButton = addMidiTrack ? (
    <button
      type="button"
      className={`lt-setlist-settings-button${midiTracks.length === 0 ? " is-primary" : ""}`}
      aria-label={addMidiTrack.label}
      title={addMidiTrack.label}
      onClick={() => void addMidiTrack.onSelect?.()}
    >
      <span className="material-symbols-outlined" aria-hidden="true">add</span>
      {midiTracks.length === 0 ? addMidiTrack.label : null}
    </button>
  ) : null;

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
          {addTrackButton}
        </div>
      ) : (
        <>
        <div className="lt-setlist-track-bar" role="radiogroup" aria-label={t("setlistView.midi.tracks")}>
          {midiTracks.map((track) => {
            const on = track.midiEnabled !== false;
            const chosen = track.id === target?.id;
            return (
              <span key={track.id} className={`lt-setlist-track-chip${chosen ? " is-chosen" : ""}${on ? "" : " is-off"}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  className="lt-setlist-track-chip-name"
                  title={track.name}
                  onClick={() => setChosenId(track.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    menus.openMenu(event, track.name, menus.trackContextMenu(track));
                  }}
                >
                  {track.name}
                </button>
                <button
                  type="button"
                  className="lt-setlist-track-chip-icon material-symbols-outlined"
                  aria-pressed={on}
                  aria-label={t(on ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
                  title={t(on ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
                  onClick={() => menus.toggleMidiTrackEnabled(track.id)}
                >
                  {on ? "power_settings_new" : "power_off"}
                </button>
                <button
                  type="button"
                  className="lt-setlist-track-chip-icon material-symbols-outlined"
                  aria-label={t("setlistView.sections.menu", { name: track.name })}
                  title={t("setlistView.sections.menu", { name: track.name })}
                  onClick={(event) => menus.openMenu(event, track.name, menus.trackContextMenu(track))}
                >
                  more_vert
                </button>
              </span>
            );
          })}
          {addTrackButton}
        </div>
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
              aria-label={t("setlistView.midi.addHere")}
              title={target ? `${t("setlistView.midi.addHere")} (${target.name})` : undefined}
              onClick={() => addAt(cursorSeconds())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {t("setlistView.midi.addHere")}
            </button>
          )}
        />
        </>
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
