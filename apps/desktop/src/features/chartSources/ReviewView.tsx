import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ImportReview } from "@libretracks/shared/charts/chartImportReview";
import type { SheetChange } from "@libretracks/shared/charts/importedChart";

/** The review of an adjust, marker by marker: section, confidence, passes
 * and first line. Shared by the adjust dialog and the plan import. */
export function ReviewView({
  review,
  transpose,
  onTranspose,
  onSection,
  onPasses,
}: {
  review: ImportReview;
  transpose: boolean;
  onTranspose: (value: boolean) => void;
  onSection: (markerId: string, value: string) => void;
  onPasses?: (markerId: string, passes: number) => void;
}) {
  const { t } = useTranslation();
  const sectionName = (index: number) => review.doc.sections[index]?.label || `#${index + 1}`;
  const unused = useMemo(() => review.match.unusedSections.map(sectionName), [review]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lt-chart-import-review">
      {review.key.semitones ? (
        <label className="lt-chart-import-key">
          <input type="checkbox" checked={transpose} onChange={(event) => onTranspose(event.target.checked)} />
          {t("chartSources.import.transpose", { source: review.key.source, song: review.key.song })}
        </label>
      ) : null}
      {review.noMarkers ? (
        <div className="lt-chart-import-warning">
          <p>{t("chartSources.import.noMarkers")}</p>
          <p>{t("chartSources.import.analyze")}</p>
        </div>
      ) : (
        <>
          <p className="lt-chart-import-help">{t("chartSources.import.reviewHelp")}</p>
          {review.hasMissing ? <p className="lt-chart-import-warning" role="status">{t("chartSources.import.missing")}</p> : null}
          {review.rows.some((row) => row.confidence !== "high") ? (
            <p className="lt-chart-import-legend">{t("chartSources.import.legend")}</p>
          ) : null}
          <ul className="lt-chart-import-rows" aria-label={t("chartSources.import.reviewTitle")}>
            {review.rows.map((row) => (
              <li key={row.markerId} className={row.repeatOf ? "is-repeat" : undefined} data-testid="chart-import-row">
                <span className="lt-chart-import-marker">
                  {row.name}
                  {row.repeatOf ? <small>{t("chartSources.import.repeatOf")}</small> : null}
                </span>
                <select
                  value={row.section === null ? "" : String(row.section)}
                  disabled={row.repeatOf !== null}
                  aria-label={`${t("chartSources.import.section")}: ${row.name}`}
                  onChange={(event) => onSection(row.markerId, event.target.value)}
                >
                  <option value="">{t("chartSources.import.none")}</option>
                  {review.doc.sections.map((_, index) => (
                    <option key={index} value={index}>
                      {sectionName(index)}
                    </option>
                  ))}
                </select>
                {row.confidence !== "high" ? (
                  <span
                    className={`lt-chart-import-badge is-${row.confidence}`}
                    title={t(`chartSources.import.reason.${row.reason}`)}
                  >
                    {t(`chartSources.import.confidence.${row.confidence}`)}
                  </span>
                ) : (
                  <span className="lt-chart-import-badge is-high" title={t(`chartSources.import.reason.${row.reason}`)} />
                )}
                <span className="lt-chart-import-line">
                  {row.section !== null && !row.repeatOf && onPasses ? (
                    <select
                      className="lt-chart-import-passes"
                      value={row.passes}
                      aria-label={`${t("chartSources.import.passes")}: ${row.name}`}
                      title={t("chartSources.import.passesHelp")}
                      onChange={(event) => onPasses(row.markerId, Number(event.target.value))}
                    >
                      {[1, 2, 3, 4].map((count) => (
                        <option key={count} value={count}>
                          ×{count}
                        </option>
                      ))}
                    </select>
                  ) : row.passes > 1 ? (
                    <span className="lt-chart-import-meta">×{row.passes} </span>
                  ) : null}
                  {row.firstLine ?? ""}
                </span>
              </li>
            ))}
          </ul>
          {unused.length > 0 ? (
            <p className="lt-chart-import-unused">
              {t("chartSources.import.unused")}: {unused.join(", ")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What the adjust changes in the sheet, before it changes it. */
export function SheetChangesList({ changes }: { changes: readonly SheetChange[] }) {
  const { t } = useTranslation();
  return (
    <section className="lt-chart-import-changes" aria-label={t("chartSources.adjust.changes")}>
      <h3>{t("chartSources.adjust.changes")}</h3>
      {changes.length === 0 ? (
        <p className="lt-chart-import-legend">{t("chartSources.adjust.noChanges")}</p>
      ) : (
        <ul>
          {changes.map((change, index) => (
            <li key={index} data-testid="sheet-change">
              {change.kind === "layout"
                ? t("chartSources.adjust.change.layout", { count: change.count })
                : change.kind === "repeatLines"
                  ? t("chartSources.adjust.change.repeatLines", { label: change.label, line: change.line, count: change.count })
                  : t(`chartSources.adjust.change.${change.kind}`, { label: change.label })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
