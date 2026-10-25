import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { formatMusicalPosition } from "../helpers";
import type { TimelineMenus } from "../menus/timelineMenus";
import { describeAutomationCue } from "../timeline/describeAutomationCue";
import { sectionAt, songAutomationCues } from "./lanes/automationLaneModel";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistAutomationPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  layout: SetlistLayoutClass;
  menus: Pick<
    TimelineMenus,
    "openMenu" | "createAutomationCueAt" | "editAutomationCue" | "automationCueContextMenu" | "openMixScenes"
  >;
  positionSecondsRef: { readonly current: number };
};

/**
 * Edit → Automation: the song's automation cues as a list in time order
 * (musical position, the section it falls in, what it does). Same actions as
 * the lane's diamonds, all the DAW's: create opens the cue modal, a row
 * edits, «…» is the cue menu. On a phone this is the way to work (the lane
 * is too narrow to aim at diamonds).
 */
function SetlistAutomationPanelComponent({
  song,
  region,
  layout,
  menus,
  positionSecondsRef,
}: SetlistAutomationPanelProps) {
  const { t } = useTranslation();
  const cues = songAutomationCues(song, region);
  const playhead = () =>
    Math.min(Math.max(positionSecondsRef.current, region.startSeconds), region.endSeconds - 0.05);

  return (
    <div className={`lt-setlist-automation is-${layout}`}>
      <div className="lt-setlist-sections-bar" role="toolbar" aria-label={t("setlistView.automation.list")}>
        <button
          type="button"
          className="lt-setlist-settings-button"
          title={t("setlistView.automation.addAtPlayhead")}
          onClick={() => menus.createAutomationCueAt(playhead())}
        >
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
          {t("setlistView.automation.add")}
        </button>
        <button
          type="button"
          className="lt-setlist-settings-button"
          title={t("setlistView.automation.addAtSectionTitle")}
          onClick={() =>
            menus.createAutomationCueAt(sectionAt(song, region, playhead())?.startSeconds ?? region.startSeconds)
          }
        >
          <span className="material-symbols-outlined" aria-hidden="true">bolt</span>
          {t("setlistView.automation.addAtSection")}
        </button>
        <button
          type="button"
          className="lt-setlist-settings-button"
          title={t("setlistView.automation.scenesTitle")}
          onClick={menus.openMixScenes}
        >
          <span className="material-symbols-outlined" aria-hidden="true">tune</span>
          {t("setlistView.automation.scenes")}
        </button>
      </div>
      {cues.length === 0 ? <p className="lt-setlist-sections-hint">{t("setlistView.automation.empty")}</p> : null}
      <ul className="lt-setlist-automation-list" aria-label={t("setlistView.automation.list")}>
        {cues.map((cue) => {
          const section = sectionAt(song, region, cue.atSeconds);
          return (
            <li key={cue.id} className={`lt-setlist-automation-item${cue.enabled && !cue.exhausted ? "" : " is-off"}`}>
              <span className="lt-setlist-cue-diamond" aria-hidden="true" />
              <button type="button" className="lt-setlist-automation-main" onClick={() => menus.editAutomationCue(cue)}>
                <span className="lt-setlist-automation-when">
                  <span className="lt-setlist-sections-position">{formatMusicalPosition(cue.atSeconds, song)}</span>
                  {section ? <span className="lt-setlist-automation-section">{section.name}</span> : null}
                </span>
                <strong className="lt-setlist-automation-name">{cue.name}</strong>
                <span className="lt-setlist-automation-what">{describeAutomationCue(cue, song, t)}</span>
              </button>
              <button
                type="button"
                className="lt-setlist-song-button"
                aria-label={t("setlistView.sections.menu", { name: cue.name })}
                title={t("setlistView.sections.menu", { name: cue.name })}
                onClick={(event) => menus.openMenu(event, cue.name, menus.automationCueContextMenu(cue))}
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

export const SetlistAutomationPanel = memo(SetlistAutomationPanelComponent);
