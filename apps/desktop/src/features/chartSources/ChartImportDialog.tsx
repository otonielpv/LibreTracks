import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import type { RefreshResult } from "@libretracks/shared/charts/chartRefresh";
import { reviewTimingForSong } from "@libretracks/shared/charts/chartImportReview";
import { ChartImportError, planningCenterToImported } from "@libretracks/shared/charts/importedChart";

import type { PcoArrangement, PcoSong } from "../transport/desktopApi";
import { useSongStore } from "../transport/songStore";
import { chartSourceHandlers } from "./chartSourceHandlers";
import { useChartSourceStore } from "./chartSourceStore";
import type { AdjustInput, ChartImportSession } from "./chartImportStore";
import { pcoErrorMessage, toPcoError } from "./pcoErrors";
import "./chartSources.css";

type Props = {
  session: ChartImportSession;
  /** The sheet as it comes, for the chart editor and its adjust. */
  onPicked: (input: AdjustInput) => void;
  onClose: () => void;
};

const hasText = (arrangement: PcoArrangement) => Boolean(arrangement.chordChart?.trim() || arrangement.lyrics?.trim());

/**
 * "From Planning Center…": search the song and pick the arrangement. The sheet
 * goes to the chart editor as it comes (only turned into ChordPro); adjusting
 * it to the song is the editor's "Adjust to the sequence", where every change
 * shows before it happens. Never adjusts on its own.
 *
 * In "refresh" mode: the imported song's arrangement read again, what changed
 * in it, and the same hand-over to the editor.
 */
export function ChartImportDialog({ session, onPicked, onClose }: Props) {
  const { t } = useTranslation();
  const status = useChartSourceStore((state) => state.status);
  const connecting = useChartSourceStore((state) => state.connecting);
  const song = useSongStore((state) => state.song);
  const { region, markers, chart } = session;
  const refreshing = session.mode === "refresh";

  const [query, setQuery] = useState(region.name);
  const [songs, setSongs] = useState<PcoSong[] | null>(null);
  const [picked, setPicked] = useState<PcoSong | null>(null);
  const [arrangements, setArrangements] = useState<PcoArrangement[] | null>(null);
  const [refresh, setRefresh] = useState<RefreshResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof ChartImportError ? t(`chartSources.errors.${cause.code}`) : pcoErrorMessage(t, toPcoError(cause)),
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void chartSourceHandlers.refreshStatus();
  }, []);

  const connected = status?.state === "connected";
  useEffect(() => {
    if (!refreshing || !connected || !chart || refresh) return;
    void run(async () => {
      setRefresh(
        await chartSourceHandlers.refreshFromSource(chart, markers, region.key, region.name, reviewTimingForSong(song, region)),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing, connected]);

  const search = (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    void run(async () => {
      setPicked(null);
      setArrangements(null);
      setSongs((await chartSourceHandlers.searchSongs(query.trim())).items);
    });
  };

  const pickSong = (candidate: PcoSong) =>
    void run(async () => {
      setPicked(candidate);
      setArrangements(await chartSourceHandlers.loadArrangements(candidate.id));
    });

  const pickArrangement = (arrangement: PcoArrangement) =>
    void run(async () => {
      const fresh = await chartSourceHandlers.loadArrangement(arrangement.songId || picked!.id, arrangement.id);
      const imported = planningCenterToImported({
        ...fresh,
        songTitle: picked?.title ?? null,
        songAuthor: picked?.author ?? null,
      });
      onPicked({ imported });
    });

  const bringUpdate = () => {
    if (!refresh || refresh.upToDate) return;
    const review = refresh.review;
    onPicked({
      imported: review.imported,
      locked: review.locked,
      passOverrides: review.passOverrides,
      keepLineBeats: review.keepLineBeats,
    });
  };

  return (
    <div className="lt-modal-backdrop lt-chart-import-backdrop" onClick={busy ? undefined : onClose}>
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
              {refreshing ? t("chartSources.refresh.title") : t("chartSources.import.title")}
            </h2>
            <p>{region.name}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-chart-import-body">
          {!connected ? (
            <div className="lt-chart-import-connect">
              <p>{t("chartSources.import.connectFirst")}</p>
              <button type="button" disabled={connecting} onClick={() => void chartSourceHandlers.connect()}>
                {connecting ? t("chartSources.account.connecting") : t("chartSources.account.connect")}
              </button>
            </div>
          ) : refreshing ? (
            refresh?.upToDate ? (
              <p role="status">{t("chartSources.refresh.upToDate")}</p>
            ) : refresh ? (
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
                <p className="lt-chart-import-legend">{t("chartSources.refresh.bringHelp")}</p>
              </>
            ) : (
              <p>{t("chartSources.import.loading")}</p>
            )
          ) : (
            <>
              <form className="lt-chart-import-search" onSubmit={search}>
                <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("chartSources.import.searchLabel")} />
                <button type="submit" disabled={busy || !query.trim()}>
                  {busy && !picked ? t("chartSources.import.searching") : t("chartSources.import.search")}
                </button>
              </form>
              {songs && songs.length === 0 ? <p>{t("chartSources.import.noResults")}</p> : null}
              {songs && songs.length > 0 ? (
                <ul className="lt-chart-import-list" aria-label={t("chartSources.import.searchLabel")}>
                  {songs.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className={candidate.id === picked?.id ? "is-active" : undefined}
                        onClick={() => pickSong(candidate)}
                      >
                        <strong>{candidate.title}</strong>
                        {candidate.author ? <span>{candidate.author}</span> : null}
                      </button>
                      {candidate.id === picked?.id && arrangements ? (
                        <ul className="lt-chart-import-arrangements" aria-label={t("chartSources.import.arrangements")}>
                          {arrangements.map((arrangement) => (
                            <li key={arrangement.id}>
                              <button type="button" disabled={busy || !hasText(arrangement)} onClick={() => pickArrangement(arrangement)}>
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
              <p className="lt-chart-import-legend">{t("chartSources.import.asItComes")}</p>
            </>
          )}
          {error ? (
            <p className="lt-render-warning" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="lt-inline-actions">
          <button type="button" className="lt-secondary-button" disabled={busy} onClick={onClose}>
            {t("chartSources.import.cancel")}
          </button>
          {refreshing && refresh && !refresh.upToDate ? (
            <button type="button" className="is-primary" onClick={bringUpdate}>
              {t("chartSources.refresh.bring")}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
