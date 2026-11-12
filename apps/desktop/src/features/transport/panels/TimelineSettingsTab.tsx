import { useTranslation } from "react-i18next";
import type { AppSettings } from "@libretracks/shared/models";
import { SettingsTabSection } from "./SettingsTabSection";

type Props = {
  settings: Pick<AppSettings, "timelineNavigationScheme" | "timelinePlayheadFollowMode">;
  disabled: boolean;
  onTimelineNavigationSchemeChange: (value: "ableton" | "libretracks") => void;
  onTimelinePlayheadFollowModeChange: (
    value: AppSettings["timelinePlayheadFollowMode"],
  ) => void;
};

/** Settings › Timeline: how the wheel/trackpad moves and where the playhead sits. */
export function TimelineSettingsTab({
  settings,
  disabled,
  onTimelineNavigationSchemeChange,
  onTimelinePlayheadFollowModeChange,
}: Props) {
  const { t } = useTranslation();

  return (
    <SettingsTabSection id="timeline">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.timelineNavigationScheme", {
            defaultValue: "Timeline navigation",
          })}
        </span>
        <select
          value={settings.timelineNavigationScheme}
          disabled={disabled}
          onChange={(event) =>
            onTimelineNavigationSchemeChange(
              event.target.value === "libretracks" ? "libretracks" : "ableton",
            )
          }
        >
          <option value="ableton">
            {t("transport.settingsModal.timelineNavigationSchemeAbleton", {
              defaultValue: "Ableton / Audacity (pinch to zoom, scroll to pan)",
            })}
          </option>
          <option value="libretracks">
            {t("transport.settingsModal.timelineNavigationSchemeLibreTracks", {
              defaultValue: "LibreTracks classic (scroll wheel zooms)",
            })}
          </option>
        </select>
        <small>
          {t("transport.settingsModal.timelineNavigationSchemeHelp", {
            defaultValue:
              "Choose how the trackpad / mouse wheel moves around the timeline. In Ableton mode, pinch (or Ctrl + scroll) zooms toward the cursor and Alt + scroll resizes track height.",
          })}
        </small>
      </label>

      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.timelinePlayheadFollowMode", {
            defaultValue: "Playhead follow",
          })}
        </span>
        <select
          value={settings.timelinePlayheadFollowMode}
          disabled={disabled}
          onChange={(event) =>
            onTimelinePlayheadFollowModeChange(
              event.target.value === "center" ? "center" : "ahead",
            )
          }
        >
          <option value="ahead">
            {t("transport.settingsModal.timelinePlayheadFollowModeAhead", {
              defaultValue: "Keep ahead (75% of the view)",
            })}
          </option>
          <option value="center">
            {t("transport.settingsModal.timelinePlayheadFollowModeCenter", {
              defaultValue: "Centered",
            })}
          </option>
        </select>
        <small>
          {t("transport.settingsModal.timelinePlayheadFollowModeHelp", {
            defaultValue:
              "Choose where the cursor sits when follow is enabled in the timeline toolbar.",
          })}
        </small>
      </label>
    </SettingsTabSection>
  );
}
