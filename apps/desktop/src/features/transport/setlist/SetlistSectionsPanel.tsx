import { memo } from "react";
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
};

/**
 * Edit → Sections: the actions bar (+ section at the playhead, duplicate,
 * delete) and the list of the song's sections. The waveform and its handles
 * stay in the view's main band in every layout.
 */
function SetlistSectionsPanelComponent({ song, region, handlers, layout }: SetlistSectionsPanelProps) {
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
      <button
        type="button"
        className="lt-setlist-settings-button"
        aria-label={t("setlistView.sections.add")}
        title={t("setlistView.sections.add")}
        aria-haspopup="menu"
        onClick={handlers.createAtPlayhead}
      >
        <span className="material-symbols-outlined" aria-hidden="true">add</span>
        <span className="lt-setlist-sections-action-label">{t("setlistView.sections.add")}</span>
      </button>
      <button
        type="button"
        className="lt-setlist-settings-button"
        aria-label={t("setlistView.sections.duplicate")}
        title={t("setlistView.sections.duplicate")}
        disabled={!hasSelection}
        onClick={handlers.duplicateSelection}
      >
        <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
        <span className="lt-setlist-sections-action-label">{t("setlistView.sections.duplicate")}</span>
      </button>
      <button
        type="button"
        className="lt-setlist-settings-button"
        aria-label={t("setlistView.sections.delete")}
        title={t("setlistView.sections.delete")}
        disabled={!hasSelection}
        onClick={handlers.deleteSelection}
      >
        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        <span className="lt-setlist-sections-action-label">{t("setlistView.sections.delete")}</span>
      </button>
    </div>
  );

  return (
    <div className={`lt-setlist-sections is-${layout}`}>
      {layout === "short" ? bar : null}
      {layout === "short" ? null : bar}
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
    </div>
  );
}

export const SetlistSectionsPanel = memo(SetlistSectionsPanelComponent);
