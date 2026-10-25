import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { markerCategory, markerColor, type SongRegionSummary, type SongView } from "@libretracks/shared/models";

import { formatMusicalPosition } from "../helpers";
import { useTimelineUIStore } from "../uiStore";
import type { SectionEditHandlers } from "./sectionEditHandlers";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistSectionsPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  handlers: SectionEditHandlers;
  layout: SetlistLayoutClass;
  /** `short`: the waveform with its handles, inside the full-screen drawer. */
  waveform?: ReactNode;
};

/**
 * Edit → Sections: the actions bar (+ section at the playhead, duplicate,
 * delete) and the list of the song's sections. In `wide`/`medium` the
 * handles live on the view's own waveform; in `short` the drawer covers the
 * view, so it brings the waveform along and the bar goes to the bottom, like
 * the mobile selection bar.
 */
function SetlistSectionsPanelComponent({ song, region, handlers, layout, waveform }: SetlistSectionsPanelProps) {
  const { t } = useTranslation();
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);
  const hasSelection = selectedMarkers.length > 0 || selectedSectionId !== null;
  const sections = song.sectionMarkers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const isSelected = (id: string) =>
    selectedMarkers.length > 0
      ? selectedMarkers.some((marker) => marker.kind === "section" && marker.id === id)
      : selectedSectionId === id;

  const bar = (
    <div className="lt-setlist-sections-bar" role="toolbar" aria-label={t("setlistView.sections.actions")}>
      {/* On the phone the scrub editor has its own «+» at its line. */}
      {layout === "short" ? null : (
        <button type="button" className="lt-setlist-settings-button" onClick={handlers.createAtPlayhead}>
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
          {t("setlistView.sections.addAtPlayhead")}
        </button>
      )}
      <button
        type="button"
        className="lt-setlist-settings-button"
        disabled={!hasSelection}
        onClick={handlers.duplicateSelection}
      >
        <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
        {t("setlistView.sections.duplicate")}
      </button>
      <button
        type="button"
        className="lt-setlist-settings-button"
        disabled={!hasSelection}
        onClick={handlers.deleteSelection}
      >
        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        {t("setlistView.sections.delete")}
      </button>
    </div>
  );

  return (
    <div className={`lt-setlist-sections is-${layout}`}>
      {layout === "short" ? null : bar}
      {waveform ? <div className="lt-setlist-sections-waveform">{waveform}</div> : null}
      <p className="lt-setlist-sections-hint">{t("setlistView.sections.hint")}</p>
      <ul className="lt-setlist-sections-list" aria-label={t("setlistView.sections.list")}>
        {sections.map((marker) => (
          <li key={marker.id} className={`lt-setlist-sections-item${isSelected(marker.id) ? " is-selected" : ""}`}>
            <span className="lt-setlist-sections-swatch" style={{ background: markerColor(marker) }} />
            <button
              type="button"
              className="lt-setlist-sections-name"
              aria-pressed={isSelected(marker.id)}
              onClick={(event) =>
                handlers.select(marker.id, {
                  additive: event.ctrlKey || event.metaKey,
                  range: event.shiftKey,
                })
              }
            >
              {marker.name}
            </button>
            <span className="lt-setlist-sections-position">{formatMusicalPosition(marker.startSeconds, song)}</span>
            <button
              type="button"
              className="lt-setlist-song-button"
              aria-label={t("setlistView.sections.menu", { name: marker.name })}
              title={t("setlistView.sections.menu", { name: marker.name })}
              onClick={(event) => handlers.openMenu(event, marker.id)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">more_horiz</span>
            </button>
          </li>
        ))}
      </ul>
      {/* On the phone the scrub editor brings its own bar (a sticky one here
          covered it). */}
      {layout === "short" && !waveform ? bar : null}
    </div>
  );
}

export const SetlistSectionsPanel = memo(SetlistSectionsPanelComponent);
