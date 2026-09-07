import { useTranslation } from "react-i18next";
import { deleteAutomationCue, type AutomationCueSummary } from "../desktopApi";
import type { MobilePanelProps } from "./types";

const ACTION_LABELS = {
  jump: "actionJump",
  setTrackMute: "actionMute",
  setTrackSolo: "actionSolo",
  setTrackMix: "actionMix",
  applyScene: "actionScene",
  setPad: "actionPad",
  wait: "actionWait",
} as const;

type MobileAutomationPanelProps = MobilePanelProps & {
  onCreateCue: (seconds: number) => void;
  onEditCue: (cue: AutomationCueSummary) => void;
};

export function MobileAutomationPanel({
  song,
  regionId,
  run,
  positionRef,
  onCreateCue,
  onEditCue,
}: MobileAutomationPanelProps) {
  const { t } = useTranslation();
  const region = song.regions.find((item) => item.id === regionId);
  const cues = [...(song.automationCues ?? [])]
    .filter(
      (cue) =>
        !region ||
        (cue.atSeconds >= region.startSeconds &&
          cue.atSeconds < region.endSeconds),
    )
    .sort((a, b) => a.atSeconds - b.atSeconds);

  return (
    <>
      <button
        type="button"
        className="is-primary"
        onClick={() => onCreateCue(positionRef.current)}
      >
        {t("mobilePreparation.newCue")}
      </button>
      {cues.length === 0 && <p>{t("mobilePreparation.noCues")}</p>}
      <div className="lt-prep-list">
        {cues.map((cue) => (
          <div className="lt-prep-row" key={cue.id}>
            <button type="button" onClick={() => onEditCue(cue)}>
              <strong>{cue.name || t("mobilePreparation.automation")}</strong>
              <small>
                {cue.atSeconds.toFixed(3)} s ·{" "}
                {cue.actions
                  .map((action) =>
                    t(`transport.automation.${ACTION_LABELS[action.type]}`),
                  )
                  .join(", ")}
              </small>
            </button>
            <button
              type="button"
              aria-label={`${t("mobilePreparation.delete")} · ${cue.name}`}
              onClick={() => void run(() => deleteAutomationCue(cue.id))}
            >
              {t("mobilePreparation.delete")}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
