import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { markerCategory, markerColor, type SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { sectionLabel } from "./structureEditor";
import type { StructureHandlers } from "./structureHandlers";
import { useStructureStore } from "./structureStore";
import type { SongStructureSummary } from "./types";

/**
 * Pieces of the arrangement editor that the desktop panel and the mobile
 * screen share: the "save the original first" view and the capture warnings.
 */

/** Section markers inside a song that has no original yet (the preview shown
 * before "Save as original"). Uses `markerCategory`, never the kind alone, so
 * a marker dragged into the cue lane does not count. */
export function detectedSections(song: SongView | null, regionId: string) {
  const region = song?.regions.find((candidate) => candidate.id === regionId);
  if (!song || !region) return [];
  return song.sectionMarkers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds - 0.001 &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

export function StructureCapture({
  regionId,
  handlers,
}: {
  regionId: string;
  handlers: StructureHandlers;
}) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const detected = useMemo(() => detectedSections(song, regionId), [regionId, song]);
  return (
    <div className="lt-structure-capture">
      <p>{t("transport.structure.noOriginal")}</p>
      <div className="lt-structure-caption">
        <strong>{t("transport.structure.detectedSections")}</strong>
      </div>
      <ol className="lt-structure-detected">
        {detected.map((marker, index) => (
          <li key={marker.id}>
            <span className="lt-structure-detected-index">{index + 1}</span>
            <span
              className="lt-structure-swatch"
              style={{ ["--lt-structure-color" as string]: markerColor(marker) }}
              aria-hidden="true"
            />
            {marker.name}
          </li>
        ))}
      </ol>
      {detected.length < 2 ? (
        <p className="lt-structure-hint">{t("transport.structure.needTwoSections")}</p>
      ) : null}
      <button
        type="button"
        className="is-primary lt-structure-capture-button"
        disabled={detected.length < 2}
        onClick={() => void handlers.captureOriginal(regionId)}
      >
        {t("transport.structure.captureOriginal")}
      </button>
    </div>
  );
}

export function StructureWarnings({
  regionId,
  structure,
  handlers,
}: {
  regionId: string;
  structure: SongStructureSummary | undefined;
  handlers: StructureHandlers;
}) {
  const { t } = useTranslation();
  const report = useStructureStore((state) => state.report);
  const song = useSongStore((state) => state.song);
  const warnings = report?.regionId === regionId ? report.warnings : [];
  if (warnings.length === 0) return null;
  const sectionName = (markerId: string) => {
    const section = structure?.sections.find((s) => s.markerId === markerId);
    if (section) return sectionLabel(section, t);
    return song?.sectionMarkers.find((m) => m.id === markerId)?.name ?? markerId;
  };
  return (
    <ul className="lt-structure-warnings" aria-label={t("transport.structure.warnings.title")}>
      {warnings.map((warning) => (
        <li key={`${warning.kind}:${warning.markerId}:${warning.clipId ?? ""}`}>
          <span>
            {warning.kind === "offBeatSection"
              ? t("transport.structure.warnings.offBeat", { name: sectionName(warning.markerId) })
              : t("transport.structure.warnings.midiCrosses", {
                  name: sectionName(warning.markerId),
                })}
          </span>
          {warning.kind === "offBeatSection" && warning.suggestedStartSeconds !== null ? (
            <button
              type="button"
              onClick={() =>
                void handlers.snapSectionToBar(
                  regionId,
                  { id: warning.markerId, name: sectionName(warning.markerId) },
                  warning.suggestedStartSeconds ?? 0,
                )
              }
            >
              {t("transport.structure.warnings.snapToBar")}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
