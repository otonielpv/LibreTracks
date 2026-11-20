import { useTranslation } from "react-i18next";
import { formatTransposeSemitones } from "@libretracks/shared/models";

import { formatBpm } from "../desktopApi";
import { usePendingPitchStore, usePendingRegionPitch } from "./pendingPitchStore";

type Props = {
  regionId: string | null | undefined;
};

/**
 * «Aplicar / Cancelar» del tono y el tempo elegidos con el ajuste «Cambio de
 * tono preparado». No pinta nada si la región no tiene nada pendiente, así
 * que con el ajuste apagado no aparece nunca.
 */
export function PendingPitchApplyBar({ regionId }: Props) {
  const { t } = useTranslation();
  const { transpose, bpm, hasPending } = usePendingRegionPitch(regionId);
  if (!hasPending) return null;

  const parts: string[] = [];
  if (transpose !== null) parts.push(formatTransposeSemitones(transpose));
  if (bpm !== null) parts.push(`${formatBpm(bpm)} BPM`);

  return (
    <div className="lt-pending-pitch-bar" role="group" aria-label={t("pendingPitch.label")}>
      <span className="lt-pending-pitch-value">
        {t("pendingPitch.pending", { value: parts.join(" · ") })}
      </span>
      <button
        type="button"
        className="lt-pending-pitch-apply"
        onClick={() => usePendingPitchStore.getState().apply?.()}
      >
        {t("pendingPitch.apply")}
      </button>
      <button
        type="button"
        className="lt-pending-pitch-cancel"
        onClick={() => usePendingPitchStore.getState().clear()}
      >
        {t("pendingPitch.cancel")}
      </button>
    </div>
  );
}
