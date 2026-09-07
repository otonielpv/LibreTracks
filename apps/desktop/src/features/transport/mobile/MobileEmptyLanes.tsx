import { useTranslation } from "react-i18next";
import { isMobileApp } from "../desktopApi";

type MobileEmptyLanesProps = {
  /** Cuantas pistas hay pintadas ahora mismo en el area de carriles. */
  trackCount: number;
  /** Abre el MISMO dialogo de importacion que la biblioteca. */
  onAddAudios: () => void;
};

/**
 * El vacio deja de ser un muro negro y propone el primer paso.
 *
 * Abriendo una sesion nueva en un movil, cerca del 70% de la pantalla era area
 * negra sin ninguna indicacion: la unica entrada para meter audio era un icono
 * de la barra lateral. Esto no anade pipeline ninguno —dispara el mismo
 * `handleImportLibraryFromDialog` que el boton de la biblioteca—, solo saca la
 * puerta a donde el usuario ya esta mirando.
 *
 * Desaparece en cuanto hay una pista: el sitio es del audio, no del cartel.
 */
export function MobileEmptyLanes({
  trackCount,
  onAddAudios,
}: MobileEmptyLanesProps) {
  const { t } = useTranslation();
  if (!isMobileApp || trackCount > 0) {
    return null;
  }

  return (
    <div className="lt-mobile-empty-lanes">
      <span className="material-symbols-outlined" aria-hidden="true">
        graphic_eq
      </span>
      <p className="lt-mobile-empty-lanes-title">
        {t("mobileEmptyLanes.title", {
          defaultValue: "Aún no hay audio en esta sesión",
        })}
      </p>
      <p className="lt-mobile-empty-lanes-hint">
        {t("mobileEmptyLanes.hint", {
          defaultValue:
            "Añade los audios de la canción y aparecerán aquí como pistas.",
        })}
      </p>
      <button
        type="button"
        className="lt-button lt-mobile-empty-lanes-cta"
        onClick={onAddAudios}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          library_music
        </span>
        {t("mobileEmptyLanes.addAudios", { defaultValue: "Añadir audios" })}
      </button>
    </div>
  );
}
