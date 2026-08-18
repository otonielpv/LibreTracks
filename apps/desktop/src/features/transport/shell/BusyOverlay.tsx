import { useTranslation } from "react-i18next";

type BusyOverlayProps = {
  visible: boolean;
  feedback: { message: string; detail?: string; percent?: number } | null;
  displayPercent: number | null;
};

export function BusyOverlay({
  visible,
  feedback,
  displayPercent,
}: BusyOverlayProps) {
  const { t } = useTranslation();
  if (!visible) return null;

  const percent =
    typeof displayPercent === "number"
      ? Math.max(0, Math.min(100, displayPercent))
      : null;

  return (
    <div className="busy-overlay" aria-live="polite">
      <div className="busy-overlay-card">
        <div className="busy-overlay-heading">
          <span className="busy-overlay-spinner" aria-hidden="true" />
          <strong>{t("transport.shell.busyTitle")}</strong>
          {percent !== null ? (
            <span className="busy-overlay-percent">{Math.round(percent)}%</span>
          ) : null}
        </div>
        <p>{feedback?.message ?? t("transport.shell.busyDescription")}</p>
        {percent !== null ? (
          <div
            className="busy-overlay-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-valuetext={feedback?.message}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {feedback?.detail ? <small>{feedback.detail}</small> : null}
      </div>
    </div>
  );
}
