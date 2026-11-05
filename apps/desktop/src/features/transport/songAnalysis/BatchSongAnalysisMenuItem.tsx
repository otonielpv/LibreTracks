import { useTranslation } from "react-i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { openBatchSongAnalysis } from "./songAnalysisStore";

/** "Analizar todas las canciones" in the mobile file-actions sheet. */
export function BatchSongAnalysisMenuItem({
  disabled,
  onSelected,
}: {
  disabled: boolean;
  onSelected: () => void;
}) {
  const { t } = useTranslation();
  if (!FEATURE_FLAGS.songAnalysis) return null;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelected();
        openBatchSongAnalysis();
      }}
    >
      <span className="material-symbols-outlined">graphic_eq</span>
      {t("transport.songAnalysis.batch.menu")}
    </button>
  );
}
