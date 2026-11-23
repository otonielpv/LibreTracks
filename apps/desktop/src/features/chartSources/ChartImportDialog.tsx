import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  buildImportReview,
  finalizeImport,
  relinkImportReview,
  type ImportReview,
} from "@libretracks/shared/charts/chartImportReview";
import { ChartImportError, planningCenterToImported } from "@libretracks/shared/charts/importedChart";
import type { RefreshResult } from "@libretracks/shared/charts/chartRefresh";

import type { PcoArrangement, PcoSong } from "../transport/desktopApi";
import { chartSourceHandlers } from "./chartSourceHandlers";
import { useChartSourceStore } from "./chartSourceStore";
import type { ChartImportSession } from "./chartImportStore";
import { pcoErrorMessage, toPcoError } from "./pcoErrors";
import "./chartSources.css";

type Props = { session: ChartImportSession; onClose: () => void };

const hasText = (arrangement: PcoArrangement) => Boolean(arrangement.chordChart?.trim() || arrangement.lyrics?.trim());

/**
 * "From Planning Center…": search the song, pick the arrangement, see the
 * song marker by marker with the words each marker will show, fix what looks
 * wrong and import (D13, D14). Every action is a `chartSourceHandlers` call;
 * the matching is `@libretracks/shared/charts`.
 */
export function ChartImportDialog({ session, onClose }: Props) {
  const { t } = useTranslation();
  const status = useChartSourceStore((state) => state.status);
  const connecting = useChartSourceStore((state) => state.connecting);
  const { region, markers, chart } = session;

  const [query, setQuery] = useState(region.name);
  const [songs, setSongs] = useState<PcoSong[] | null>(null);
  const [song, setSong] = useState<PcoSong | null>(null);
  const [arrangements, setArrangements] = useState<PcoArrangement[] | null>(null);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [transpose, setTranspose] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshing = session.mode === "refresh";
  const [refresh, setRefresh] = useState<RefreshResult | null>(null);

  useEffect(() => {
    void chartSourceHandlers.refreshStatus();
  }, []);

  const connectedNow = status?.state === "connected";
  useEffect(() => {
    if (!refreshing || !connectedNow || !chart || refresh) return;
    void run(async () => {
      const result = await chartSourceHandlers.refreshFromSource(chart, markers, region.key, region.name);
      setRefresh(result);
      if (!result.upToDate) setReview(result.review);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing, connectedNow]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof ChartImportError
          ? t(`chartSources.errors.${cause.code}`)
          : pcoErrorMessage(t, toPcoError(cause)),
      );
    } finally {
      setBusy(false);
    }
  };

  const search = (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    void run(async () => {
      setSong(null);
      setArrangements(null);
      setSongs((await chartSourceHandlers.searchSongs(query.trim())).items);
    });
  };

  const pickSong = (picked: PcoSong) =>
    void run(async () => {
      setSong(picked);
      setArrangements(await chartSourceHandlers.loadArrangements(picked.id));
    });

  const pickArrangement = (arrangement: PcoArrangement) =>
    void run(async () => {
      const fresh = await chartSourceHandlers.loadArrangement(arrangement.songId || song!.id, arrangement.id);
      const imported = planningCenterToImported({
        ...fresh,
        songTitle: song?.title ?? null,
        songAuthor: song?.author ?? null,
      });
      setReview(buildImportReview(imported, markers, region.key));
    });

  const setSection = (markerId: string, value: string) => {
    if (!review) return;
    const section = value === "" ? null : Number(value);
    const locked = [...review.locked.filter((link) => link.markerId !== markerId), { markerId, section }];
    setReview(relinkImportReview(review, markers, locked));
  };

  const apply = (linked: boolean) => {
    if (!review) return;
    const finalized = finalizeImport(review, { transpose: transpose && review.key.semitones !== null, linked });
    // An update keeps the plan item the chart first came from.
    const planItemId = refreshing ? chart?.source?.planItemId : undefined;
    const next = planItemId && finalized.source ? { ...finalized, source: { ...finalized.source, planItemId } } : finalized;
    void run(async () => {
      await chartSourceHandlers.applyImport(session.onSave, next);
      onClose();
    });
  };

  const connected = status?.state === "connected";

  return (
    <div className="lt-modal-backdrop" onClick={busy ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-chart-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-chart-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("chartSources.import.eyebrow")}</span>
            <h2 id="lt-chart-import-title">
              {refreshing
                ? t("chartSources.refresh.title")
                : review
                  ? t("chartSources.import.reviewTitle")
                  : t("chartSources.import.title")}
            </h2>
            <p>{region.name}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-chart-import-body">
          {!connected ? (
            <div className="lt-chart-import-connect">
              <p>{t("chartSources.import.connectFirst")}</p>
              <button type="button" className="is-primary" disabled={connecting} onClick={() => void chartSourceHandlers.connect()}>
                {connecting ? t("chartSources.account.connecting") : t("chartSources.account.connect")}
              </button>
            </div>
          ) : refreshing ? (
            refresh?.upToDate ? (
              <p role="status">{t("chartSources.refresh.upToDate")}</p>
            ) : refresh && review ? (
              <>
                {refresh.editedLocally ? (
                  <p className="lt-chart-import-warning" role="alert">
                    {t("chartSources.refresh.editedWarning")}
                  </p>
                ) : null}
                <section className="lt-chart-import-changes" aria-label={t("chartSources.refresh.changes")}>
                  <h3>{t("chartSources.refresh.changes")}</h3>
                  {refresh.changes.length === 0 ? (
                    <p>{t("chartSources.refresh.noChanges")}</p>
                  ) : (
                    <ul>
                      {refresh.changes.map((change, index) => (
                        <li key={index} data-testid="chart-refresh-change">
                          {t(`chartSources.refresh.${change.change}`)}: {change.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <ReviewView review={review} transpose={transpose} onTranspose={setTranspose} onSection={setSection} />
              </>
            ) : (
              <p>{t("chartSources.import.loading")}</p>
            )
          ) : review ? (
            <ReviewView review={review} transpose={transpose} onTranspose={setTranspose} onSection={setSection} />
          ) : (
            <>
              <form className="lt-chart-import-search" onSubmit={search}>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={t("chartSources.import.searchLabel")}
                />
                <button type="submit" disabled={busy || !query.trim()}>
                  {busy && !song ? t("chartSources.import.searching") : t("chartSources.import.search")}
                </button>
              </form>
              {songs && songs.length === 0 ? <p>{t("chartSources.import.noResults")}</p> : null}
              {songs && songs.length > 0 ? (
                <ul className="lt-chart-import-list" aria-label={t("chartSources.import.searchLabel")}>
                  {songs.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className={candidate.id === song?.id ? "is-active" : undefined}
                        onClick={() => pickSong(candidate)}
                      >
                        <strong>{candidate.title}</strong>
                        {candidate.author ? <span>{candidate.author}</span> : null}
                      </button>
                      {candidate.id === song?.id && arrangements ? (
                        <ul className="lt-chart-import-arrangements" aria-label={t("chartSources.import.arrangements")}>
                          {arrangements.map((arrangement) => (
                            <li key={arrangement.id}>
                              <button
                                type="button"
                                disabled={busy || !hasText(arrangement)}
                                onClick={() => pickArrangement(arrangement)}
                              >
                                <span>{arrangement.name}</span>
                                <span className="lt-chart-import-meta">
                                  {hasText(arrangement)
                                    ? (arrangement.chordChartKey ?? t("chartSources.import.noKey"))
                                    : t("chartSources.import.pdfOnly")}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {error ? (
            <p className="lt-render-warning" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="lt-inline-actions">
          {review && !refreshing ? (
            <button type="button" className="lt-secondary-button" disabled={busy} onClick={() => setReview(null)}>
              {t("chartSources.import.back")}
            </button>
          ) : null}
          <button type="button" className="lt-secondary-button" disabled={busy} onClick={onClose}>
            {t("chartSources.import.cancel")}
          </button>
          {review ? (
            review.noMarkers ? (
              <button type="button" className="is-primary" disabled={busy} onClick={() => apply(false)}>
                {t("chartSources.import.importUnlinked")}
              </button>
            ) : (
              <button type="button" className="is-primary" disabled={busy} onClick={() => apply(true)}>
                {refreshing
                  ? t("chartSources.refresh.apply")
                  : chart
                    ? t("chartSources.import.replace")
                    : t("chartSources.import.apply")}
              </button>
            )
          ) : null}
        </div>
        {review && chart && !refreshing ? (
          <p className="lt-chart-import-note">{t("chartSources.import.replaceWarning")}</p>
        ) : null}
      </section>
    </div>
  );
}

function ReviewView({
  review,
  transpose,
  onTranspose,
  onSection,
}: {
  review: ImportReview;
  transpose: boolean;
  onTranspose: (value: boolean) => void;
  onSection: (markerId: string, value: string) => void;
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
                <span className="lt-chart-import-line">{row.firstLine ?? ""}</span>
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
