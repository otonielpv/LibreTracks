import { memo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  markerCategory,
  markerColor,
  transposeKey,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";

import type { ShortcutActionId } from "../keyboard/actions";
import { useTimelineUIStore } from "../uiStore";
import type { SectionEditHandlers } from "./sectionEditHandlers";
import { barStartsInSong, stepBar } from "./sectionScrubModel";
import { SongScrubView } from "./SongScrubView";

type SectionScrubEditorProps = {
  song: SongView;
  region: SongRegionSummary;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
  handlers: Pick<
    SectionEditHandlers,
    | "createKindAt"
    | "openCreateMenuAt"
    | "commitMove"
    | "select"
    | "dragGroup"
    | "openMenu"
    | "duplicateSelection"
    | "deleteSelection"
    | "openTimingMenuAt"
    | "openTimingMarkMenu"
  >;
};

/**
 * Edit → Sections on a phone, the way Playback does it: the song's waveform
 * zoomed under a fixed line (SongScrubView, with play/pause to hear where
 * each mark falls). Sections ride on top, cues («avisos») below them; tap
 * one to select it, hold it for its menu. «+ Section» / «+ Cue» open the
 * DAW's kind list at the line's bar, and the arrows move the selected mark
 * one bar at a time (Playback's «Move Song Section»). Tempo, meter and key
 * changes sit along the bottom (tap one for its DAW menu), and «Tempo» adds
 * one at the line: on a phone there is no ruler to right-click.
 */
function SectionScrubEditorComponent({
  song,
  region,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  runShortcutAction,
  handlers,
}: SectionScrubEditorProps) {
  const { t } = useTranslation();
  // Two plain fields: a selector building `[{…}]` would be a new array on
  // every read and re-render forever.
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);

  const marks = song.sectionMarkers.filter(
    (marker) => marker.startSeconds >= region.startSeconds && marker.startSeconds < region.endSeconds,
  );
  const selectedIds =
    selectedMarkers.length > 0
      ? selectedMarkers.filter((marker) => marker.kind === "section").map((marker) => marker.id)
      : selectedSectionId
        ? [selectedSectionId]
        : [];
  const primarySelected = marks.find((marker) => marker.id === selectedIds[0]) ?? null;

  const inSong = (seconds: number) => seconds > region.startSeconds && seconds < region.endSeconds;
  const timingMarks = [
    ...song.tempoMarkers
      .filter((marker) => inSong(marker.startSeconds))
      .map((marker) => ({ kind: "tempo" as const, id: marker.id, at: marker.startSeconds, label: `${marker.bpm} BPM`, icon: "speed" })),
    ...song.timeSignatureMarkers
      .filter((marker) => inSong(marker.startSeconds))
      .map((marker) => ({ kind: "meter" as const, id: marker.id, at: marker.startSeconds, label: marker.signature, icon: "straighten" })),
    ...(region.keyChanges ?? [])
      .filter((change) => inSong(change.startSeconds))
      .map((change) => ({
        kind: "key" as const,
        id: change.id,
        at: change.startSeconds,
        label: transposeKey(change.key, region.transposeSemitones) ?? change.key,
        icon: "music_note",
      })),
  ];

  const nudgeSelected = (direction: -1 | 1) => {
    if (!primarySelected) return;
    const bars = barStartsInSong(song, region);
    const target = stepBar(bars, primarySelected.startSeconds, direction);
    if (target === null || target >= region.endSeconds) return;
    handlers.commitMove(handlers.dragGroup(primarySelected.id), target - primarySelected.startSeconds);
  };

  const bubble = (marker: SectionMarkerSummary, x: number) => {
    const isSelected = selectedIds.includes(marker.id);
    const isCue = markerCategory(marker) === "cue";
    return (
      <button
        key={marker.id}
        type="button"
        className={`lt-setlist-scrub-section${isCue ? " is-cue" : ""}${isSelected ? " is-selected" : ""}`}
        style={{ left: `${x}px`, "--lt-setlist-block-color": markerColor(marker) } as CSSProperties}
        aria-pressed={isSelected}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => handlers.select(marker.id, { additive: false, range: false })}
        onContextMenu={(event) => {
          event.preventDefault();
          handlers.openMenu(event, marker.id);
        }}
      >
        {isCue ? (
          <span className="material-symbols-outlined" aria-hidden="true">notifications</span>
        ) : null}
        {marker.name}
      </button>
    );
  };

  return (
    <SongScrubView
      song={song}
      region={region}
      waveformSummaries={waveformSummaries}
      positionSecondsRef={positionSecondsRef}
      onSeek={onSeek}
      runShortcutAction={runShortcutAction}
      overlay={({ xOf }) => (
        <>
          {marks.map((marker) => bubble(marker, xOf(marker.startSeconds)))}
          {timingMarks.map((mark) => (
            <button
              key={`${mark.kind}:${mark.id}`}
              type="button"
              className={`lt-setlist-scrub-timing is-${mark.kind}`}
              style={{ left: `${xOf(mark.at)}px` }}
              title={mark.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => handlers.openTimingMarkMenu(event, mark)}
              onContextMenu={(event) => {
                event.preventDefault();
                handlers.openTimingMarkMenu(event, mark);
              }}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{mark.icon}</span>
              {mark.label}
            </button>
          ))}
        </>
      )}
      actions={({ cursorSeconds }) => (
        <>
          <button
            type="button"
            className="lt-setlist-settings-button is-primary"
            aria-haspopup="menu"
            aria-label={t("setlistView.sections.add")}
            title={t("setlistView.sections.add")}
            onClick={(event) => handlers.openCreateMenuAt(event, cursorSeconds())}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {t("setlistView.sections.add")}
          </button>
          <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.moveLeft")} title={t("setlistView.sections.moveLeft")} onClick={() => nudgeSelected(-1)}>
            <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          </button>
          <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.moveRight")} title={t("setlistView.sections.moveRight")} onClick={() => nudgeSelected(1)}>
            <span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
          </button>
          <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.duplicate")} title={t("setlistView.sections.duplicate")} onClick={handlers.duplicateSelection}>
            <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
          </button>
          <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.delete")} title={t("setlistView.sections.delete")} onClick={handlers.deleteSelection}>
            <span className="material-symbols-outlined" aria-hidden="true">delete</span>
          </button>
        </>
      )}
    />
  );
}

export const SectionScrubEditor = memo(SectionScrubEditorComponent);
