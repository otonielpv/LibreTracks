import { useTranslation } from "react-i18next";

type MulticoreAudioFieldProps = {
  singleThreadRender: boolean;
  disabled?: boolean;
  onSingleThreadRenderChange: (enabled: boolean) => void;
};

/**
 * User-facing form of the engine's single-thread fallback.
 *
 * The persisted setting remains negative (`audioSingleThreadRender`) for
 * backwards compatibility, but Audio settings present the normal capability
 * positively, like other DAWs do: multicore processing is on by default.
 */
export function MulticoreAudioField({
  singleThreadRender,
  disabled = false,
  onSingleThreadRenderChange,
}: MulticoreAudioFieldProps) {
  const { t } = useTranslation();

  return (
    <label className="lt-settings-toggle">
      <input
        type="checkbox"
        checked={!singleThreadRender}
        disabled={disabled}
        onChange={(event) =>
          onSingleThreadRenderChange(!event.target.checked)
        }
      />
      <span className="lt-settings-toggle-copy">
        <span>
          {t("transport.settingsModal.audioMulticoreProcessing", {
            defaultValue: "Multicore processing",
          })}
        </span>
        <small>
          {t("transport.settingsModal.audioMulticoreProcessingHint", {
            defaultValue:
              "Distributes audio processing across multiple CPU cores to give demanding sessions more headroom. Recommended.",
          })}
        </small>
      </span>
    </label>
  );
}
