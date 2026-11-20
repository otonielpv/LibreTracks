import { useTranslation } from "react-i18next";

import { trackEqIsActive } from "@libretracks/shared/eq/trackEqModel";

import { useSongStore } from "../songStore";
import { openSongMasterEq } from "./songMasterEqHandlers";
import "./TrackEqButton.css";

/**
 * Botón «EQ» del máster de la canción (plan track-eq-2, paso 09), en el
 * popover del máster. Lee la región del store de la canción, se ilumina si el
 * EQ suena y abre el editor único.
 */
export function SongMasterEqButton({
  regionId,
  disabled = false,
}: {
  regionId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const region = useSongStore(
    (state) => state.song?.regions.find((candidate) => candidate.id === regionId) ?? null,
  );
  if (!region) return null;
  const active = trackEqIsActive(region.master?.eq);
  const label = t("eq.openForMaster", { name: region.name });
  return (
    <button
      type="button"
      className={`lt-track-eq-button lt-song-master-eq-button ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        openSongMasterEq(region.id);
      }}
    >
      {t("eq.open")}
    </button>
  );
}
