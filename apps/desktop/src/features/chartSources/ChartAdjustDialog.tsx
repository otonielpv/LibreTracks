import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildImportReview,
  finalizeImport,
  relinkImportReview,
  reviewTimingForSong,
} from "@libretracks/shared/charts/chartImportReview";
import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

import { useSongStore } from "../transport/songStore";
import type { AdjustInput } from "./chartImportStore";
import { ReviewView, SheetChangesList } from "./ReviewView";
import "./chartSources.css";

type Props = {
  region: SongRegionSummary;
  /** The song's section markers in timeline order, repeats included. */
  markers: readonly SectionMarkerSummary[];
  input: AdjustInput;
  /** The adjusted chart: cleaned text, links, source. Nothing is saved here:
   * the chart editor takes it and the user saves. */
  /** Bars each marker lasts (`markerBars`), shown beside its name. */
  bars?: Readonly<Record<string, number>>;
  onApply: (chart: SongChart) => void;
  onClose: () => void;
};

/**
 * "Adjust to the sequence": what the cleanup will change in the sheet, then
 * the song marker by marker with the section each one will show (and how
 * many times), before anything changes. Same for a file, pasted text or
 * Planning Center: the import brings the sheet as it comes, this adjusts it.
 */
export function ChartAdjustDialog({ region, markers, input, bars, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const timing = useMemo(() => reviewTimingForSong(song, region), [song, region]);
  /** The automatic adjust: sections and passes worked out from the sheet,
   * the song's markers and their length (plus what an update keeps). */
  const automatic = () => {
    const built = buildImportReview(
      input.imported,
      markers,
      region.key,
      input.locked ?? [],
      timing,
      input.passOverrides ?? {},
    );
    return input.keepLineBeats ? { ...built, keepLineBeats: input.keepLineBeats } : built;
  };
  const [review, setReview] = useState(automatic);
  const [transpose, setTranspose] = useState(true);

  const setSection = (markerId: string, value: string) => {
    const section = value === "" ? null : Number(value);
    const locked = [...review.locked.filter((link) => link.markerId !== markerId), { markerId, section }];
    setReview(relinkImportReview(review, markers, locked));
  };
  const setPasses = (markerId: string, passes: number) =>
    setReview(relinkImportReview(review, markers, review.locked, { ...review.passOverrides, [markerId]: passes }));

  const apply = () =>
    onApply(
      finalizeImport(review, {
        transpose: transpose && review.key.semitones !== null,
        linked: !review.noMarkers,
      }),
    );

  return (
    <div className="lt-modal-backdrop lt-chart-import-backdrop" onClick={onClose}>
      <section
        className="lt-settings-modal lt-chart-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-chart-adjust-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("chartSources.adjust.eyebrow")}</span>
            <h2 id="lt-chart-adjust-title">{t("chartSources.adjust.title")}</h2>
            <p>{region.name}</p>
          </div>
        </header>
        <div className="lt-settings-modal-body lt-chart-import-body">
          <SheetChangesList changes={review.changes} />
          <ReviewView
            review={review}
            transpose={transpose}
            onTranspose={setTranspose}
            onSection={setSection}
            onPasses={setPasses}
            bars={bars}
          />
        </div>
        <div className="lt-inline-actions">
          <button
            type="button"
            className="lt-secondary-button"
            title={t("chartSources.adjust.recalculateHelp")}
            onClick={() => setReview(automatic())}
          >
            {t("chartSources.adjust.recalculate")}
          </button>
          <button type="button" className="lt-secondary-button" onClick={onClose}>
            {t("chartSources.import.cancel")}
          </button>
          <button type="button" className="is-primary" onClick={apply}>
            {review.noMarkers ? t("chartSources.adjust.applyUnlinked") : t("chartSources.adjust.apply")}
          </button>
        </div>
      </section>
    </div>
  );
}
