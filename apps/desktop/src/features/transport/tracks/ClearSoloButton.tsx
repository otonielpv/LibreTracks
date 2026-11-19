import { useTranslation } from "react-i18next";

import { NetworkControls } from "../../network/NetworkControls";
import { useSongStore } from "../songStore";
import { useTransportStore } from "../store";
import "./ClearSoloButton.css";

/**
 * ¿Hay alguna pista en solo? Cuenta el valor optimista, igual que los botones
 * S de cada pista, para que el botón se encienda en el mismo fotograma que el
 * solo que lo provoca. Devuelve un booleano: sólo re-renderiza al cambiar.
 */
export function useAnySoloActive() {
  const tracks = useSongStore((state) => state.song?.tracks);
  return useTransportStore((state) =>
    (tracks ?? []).some(
      (track) => state.optimisticMix[track.id]?.solo ?? track.solo,
    ),
  );
}

type ClearSoloButtonProps = {
  onClear: () => void;
  /**
   * "toolbar": botón de icono de las barras del mixer y la cabecera Tracks.
   * "setlist-rail": acción del mixer de Setlist (rail con etiqueta en móvil).
   */
  placement?: "toolbar" | "setlist-rail";
  showRailLabel?: boolean;
  /** Sin solos no se pinta (rail del móvil, donde cada hueco cuenta). */
  hideWhenInactive?: boolean;
  className?: string;
};

/**
 * Quita el solo de todas las pistas a la vez (idea de un usuario). Siempre
 * visible para que se encuentre, pero apagado mientras no haya solos: se
 * enciende en amarillo, el color de la S, cuando hay alguno que quitar.
 */
export function ClearSoloButton({
  onClear,
  placement = "toolbar",
  showRailLabel = false,
  hideWhenInactive = false,
  className = "",
}: ClearSoloButtonProps) {
  const { t } = useTranslation();
  const anySolo = useAnySoloActive();
  const base =
    placement === "setlist-rail" ? "lt-setlist-mixer-action" : "lt-icon-button";
  const label = t("trackHeader.clearSolo");
  if (hideWhenInactive && !anySolo) {
    return null;
  }

  return (
    <NetworkControls permission="edit">
    <button
      type="button"
      className={`${base} lt-clear-solo${anySolo ? " is-solo-active" : ""} ${className}`.trim()}
      aria-label={label}
      title={anySolo ? label : t("trackHeader.clearSoloNone")}
      disabled={!anySolo}
      onClick={(event) => {
        event.stopPropagation();
        onClear();
      }}
    >
      <span className="lt-clear-solo-glyph" aria-hidden="true">S</span>
      {placement === "setlist-rail" ? (
        <span className="lt-setlist-mixer-action-label">
          {t("trackHeader.clearSoloShort")}
        </span>
      ) : null}
      {placement === "setlist-rail" && showRailLabel ? (
        <span className="lt-setlist-rail-label">
          {t("trackHeader.clearSoloShort")}
        </span>
      ) : null}
    </button>
    </NetworkControls>
  );
}
