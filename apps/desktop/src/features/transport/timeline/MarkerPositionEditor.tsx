import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp, type SongView } from "../desktopApi";
import { formatMusicalPosition } from "../helpers";
import { useTimelineUIStore } from "../uiStore";
import {
  musicalPositionToSeconds,
  parseMusicalPosition,
} from "../mobile/musicalPosition";

type MarkerPositionEditorProps = {
  song: SongView | null;
  /** Fin del espacio de trabajo: techo al que se recorta lo que se escriba. */
  workspaceEndSeconds: number;
  /**
   * El MISMO commit que usa arrastrar la bandera (`handleMarkerMoveCommit`).
   * Escribir el compás y arrastrar no pueden acabar guardando cosas distintas.
   */
  onCommit: (markerId: string, startSeconds: number) => void;
};

/**
 * Corregir a mano dónde cae una marca.
 *
 * Arrastrar la bandera es el gesto rápido, pero en un móvil no da precisión:
 * un píxel a poco zoom son varios compases. Aquí se escribe el compás o el
 * segundo exacto.
 *
 * Los dos campos son la MISMA posición vista de dos maneras y se siguen el uno
 * al otro mientras se escribe, así que el usuario no tiene que saber en cuál de
 * los dos "manda". Compás.tiempo se convierte a segundos invirtiendo la
 * conversión que ya existe (ver ../mobile/musicalPosition), no rehaciendo el
 * mapa de tempos.
 *
 * Gana sitio DENTRO de la vista y no la sustituye: hoja inferior en móvil,
 * panel flotante en escritorio. La regla que incumplió el panel "Preparar
 * canción" que se revirtió.
 */
export function MarkerPositionEditor({
  song,
  workspaceEndSeconds,
  onCommit,
}: MarkerPositionEditorProps) {
  const { t } = useTranslation();
  const markerId = useTimelineUIStore((state) => state.markerPositionEditorId);
  const setMarkerId = useTimelineUIStore(
    (state) => state.setMarkerPositionEditorId,
  );
  const marker = markerId
    ? song?.sectionMarkers.find((entry) => entry.id === markerId)
    : undefined;

  const [seconds, setSeconds] = useState(0);
  const [barDraft, setBarDraft] = useState("1.1.00");
  const [secondsDraft, setSecondsDraft] = useState("0.000");

  // Recarga los campos al abrir sobre otra marca. La posición de partida es la
  // que la marca tiene AHORA, no la del cabezal.
  useEffect(() => {
    if (!marker) {
      return;
    }
    setSeconds(marker.startSeconds);
    setBarDraft(formatMusicalPosition(marker.startSeconds, song ?? null));
    setSecondsDraft(marker.startSeconds.toFixed(3));
    // `song` cambia en cada refresco; sólo interesa reiniciar al cambiar de
    // marca, o escribir un dígito borraría lo escrito en el otro campo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker?.id]);

  if (!marker) {
    return null;
  }

  return (
    <div
      className={`lt-marker-position-editor${isMobileApp ? " is-mobile-sheet" : ""}`}
      role="dialog"
      aria-label={t("markerPosition.title", {
        defaultValue: "Posición de la marca",
      })}
      onClick={(event) => event.stopPropagation()}
    >
      <strong>{marker.name}</strong>
      <label className="lt-marker-position-field">
        <span>
          {t("markerPosition.bar", { defaultValue: "Compás.tiempo" })}
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={barDraft}
          onChange={(event) => {
            const next = event.target.value;
            setBarDraft(next);
            const parsed = parseMusicalPosition(next);
            if (!parsed) {
              return; // a medias de escribir: no muevas nada
            }
            const nextSeconds = musicalPositionToSeconds(
              parsed,
              song ?? null,
              workspaceEndSeconds,
            );
            setSeconds(nextSeconds);
            setSecondsDraft(nextSeconds.toFixed(3));
          }}
        />
      </label>
      <label className="lt-marker-position-field">
        <span>{t("markerPosition.seconds", { defaultValue: "Segundos" })}</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={secondsDraft}
          onChange={(event) => {
            const next = event.target.value;
            setSecondsDraft(next);
            const parsed = Number(next);
            if (!Number.isFinite(parsed)) {
              return;
            }
            const clamped = Math.min(
              Math.max(0, parsed),
              Math.max(0, workspaceEndSeconds),
            );
            setSeconds(clamped);
            setBarDraft(formatMusicalPosition(clamped, song ?? null));
          }}
        />
      </label>
      <div className="lt-marker-position-buttons">
        <button
          type="button"
                    onClick={() => setMarkerId(null)}
        >
          {t("common.cancel", { defaultValue: "Cancelar" })}
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => {
            onCommit(marker.id, seconds);
            setMarkerId(null);
          }}
        >
          {t("common.apply", { defaultValue: "Aplicar" })}
        </button>
      </div>
    </div>
  );
}
