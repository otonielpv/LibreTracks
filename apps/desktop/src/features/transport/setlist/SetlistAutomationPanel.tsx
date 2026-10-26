import { memo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView, WaveformSummaryDto } from "@libretracks/shared/models";

import { formatMusicalPosition } from "../helpers";
import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import { describeAutomationCue } from "../timeline/describeAutomationCue";
import { sectionAt, songAutomationCues } from "./lanes/automationLaneModel";
import { SongScrubView } from "./SongScrubView";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistAutomationPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  layout: SetlistLayoutClass;
  menus: Pick<
    TimelineMenus,
    | "openMenu"
    | "createAutomationCueAt"
    | "editAutomationCue"
    | "automationCueContextMenu"
    | "openMixScenes"
    | "automationTrackContextMenu"
    | "setAutomationTrackOn"
    | "handleAddAutomationTrack"
  >;
  positionSecondsRef: { readonly current: number };
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
};

/**
 * Edit → Automation: the song's waveform (SongScrubView: swipe, zoom, play
 * from the line) with each automation cue where it fires — the reference
 * the iPhone test missed — and the list below (musical position, section,
 * what it does). Every action is the DAW's: create opens the cue modal at
 * the line's bar, a diamond or a row edits, holding it or «…» is the cue
 * menu. The row on top is the automation track itself: on/off, and the
 * DAW's track menu (scenes, remove), or «add» when the song has none.
 */
function SetlistAutomationPanelComponent({
  song,
  region,
  layout,
  menus,
  positionSecondsRef,
  waveformSummaries,
  onSeek,
  runShortcutAction,
}: SetlistAutomationPanelProps) {
  const { t } = useTranslation();
  const cues = songAutomationCues(song, region);
  const clampInSong = (seconds: number) =>
    Math.min(Math.max(seconds, region.startSeconds), region.endSeconds - 0.05);

  const automationTrack = song.automationTrack ?? null;
  const trackOn = automationTrack?.enabled !== false;
  const trackName = t("setlistView.automation.track");

  return (
    <div className={`lt-setlist-automation is-${layout}`}>
      <div className="lt-setlist-track-bar" role="toolbar" aria-label={trackName}>
        {automationTrack ? (
          <span className={`lt-setlist-track-chip is-chosen${trackOn ? "" : " is-off"}`}>
            <span
              className="lt-setlist-track-chip-name"
              onContextMenu={(event) => {
                event.preventDefault();
                menus.openMenu(event, trackName, menus.automationTrackContextMenu());
              }}
            >
              {trackName}
            </span>
            <button
              type="button"
              className="lt-setlist-track-chip-icon material-symbols-outlined"
              aria-pressed={trackOn}
              aria-label={t(trackOn ? "setlistView.automation.turnOff" : "setlistView.automation.turnOn")}
              title={t(trackOn ? "setlistView.automation.turnOff" : "setlistView.automation.turnOn")}
              onClick={() => void menus.setAutomationTrackOn(!trackOn)}
            >
              {trackOn ? "power_settings_new" : "power_off"}
            </button>
            <button
              type="button"
              className="lt-setlist-track-chip-icon material-symbols-outlined"
              aria-label={t("setlistView.sections.menu", { name: trackName })}
              title={t("setlistView.sections.menu", { name: trackName })}
              onClick={(event) => menus.openMenu(event, trackName, menus.automationTrackContextMenu())}
            >
              more_vert
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="lt-setlist-settings-button"
            onClick={() => void menus.handleAddAutomationTrack(null)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {t("setlistView.automation.addTrack")}
          </button>
        )}
      </div>
      <SongScrubView
        song={song}
        region={region}
        waveformSummaries={waveformSummaries}
        positionSecondsRef={positionSecondsRef}
        onSeek={onSeek}
        runShortcutAction={runShortcutAction}
        overlay={({ xOf }) =>
          cues.map((cue) => (
            <button
              key={cue.id}
              type="button"
              className={`lt-setlist-scrub-automation${cue.enabled && !cue.exhausted ? "" : " is-off"}`}
              style={{ left: `${xOf(cue.atSeconds)}px` } as CSSProperties}
              title={`${cue.name}\n${describeAutomationCue(cue, song, t)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => menus.editAutomationCue(cue)}
              onContextMenu={(event) => {
                event.preventDefault();
                menus.openMenu(event, cue.name, menus.automationCueContextMenu(cue));
              }}
            >
              <span className="lt-setlist-cue-diamond" aria-hidden="true" />
              {cue.name}
            </button>
          ))
        }
        actions={({ cursorSeconds }) => (
          <>
            <button
              type="button"
              className="lt-setlist-settings-button is-primary"
              title={t("setlistView.automation.addAtPlayhead")}
              onClick={() => menus.createAutomationCueAt(clampInSong(cursorSeconds()))}
            >
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {t("setlistView.automation.add")}
            </button>
            <button
              type="button"
              className="lt-setlist-settings-button"
              title={t("setlistView.automation.addAtSectionTitle")}
              onClick={() =>
                menus.createAutomationCueAt(
                  sectionAt(song, region, clampInSong(cursorSeconds()))?.startSeconds ?? region.startSeconds,
                )
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
          </>
        )}
      />
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
