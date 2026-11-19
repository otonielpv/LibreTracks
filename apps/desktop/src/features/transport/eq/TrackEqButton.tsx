import { useTranslation } from "react-i18next";

import { useSongStore } from "../songStore";
import { openTrackEq } from "../tracks/trackEqHandlers";
import { trackEqIsActive } from "./trackEqModel";
import "./TrackEqButton.css";

/**
 * Botón «EQ» de una pista (plan track-eq, D12). El mismo en la cabecera DAW,
 * la tira de Compacta/Setlist y la barra móvil: lee la pista del store de la
 * canción (así no cambia la memoización de quien lo monta), solo aparece en
 * pistas de audio y se ilumina si el EQ está encendido y alguna banda hace
 * algo. Abre el editor único con `openTrackEq`.
 */
export function TrackEqButton({
  trackId,
  className = "",
  disabled = false,
}: {
  trackId: string;
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const track = useSongStore(
    (state) => state.song?.tracks.find((candidate) => candidate.id === trackId) ?? null,
  );
  if (!track || track.kind !== "audio") return null;
  const active = trackEqIsActive(track.eq);
  return (
    <button
      type="button"
      className={`lt-track-eq-button ${active ? "is-active" : ""} ${className}`}
      aria-label={t("eq.openFor", { name: track.name })}
      title={t("eq.openFor", { name: track.name })}
      aria-pressed={active}
      disabled={disabled}
      data-eq-active={active ? "true" : "false"}
      onClick={(event) => {
        event.stopPropagation();
        openTrackEq(track);
      }}
    >
      {t("eq.open")}
    </button>
  );
}
