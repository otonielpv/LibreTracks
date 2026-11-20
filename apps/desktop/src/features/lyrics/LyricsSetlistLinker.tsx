import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { asLyricsError, type LyricsError, type Presentation, type RegionReport } from "./lyricsApi";
import type { LyricsApi } from "./lyricsHandlers";
import { LyricsModal } from "./LyricsModal";
import { lyricsErrorText } from "./LyricsSettingsTab";
import { useLyricsStore } from "./lyricsStore";
import { useLyricsHandlers } from "./useLyricsHandlers";

/**
 * "Link songs": every song of the session and its presentation. Exact
 * titles link on their own, look-alikes are one click, the rest are
 * searched. Each confirmation is one undo step.
 */
export function LyricsSetlistLinker({
  api,
  onSnapshot,
}: {
  api?: LyricsApi;
  onSnapshot?: (snapshot: unknown) => void;
}) {
  const { t } = useTranslation();
  const close = useLyricsStore((state) => state.closeLinker);
  const linksVersion = useLyricsStore((state) => state.linksVersion);
  const handlers = useLyricsHandlers(api, onSnapshot);
  const [reports, setReports] = useState<RegionReport[] | null>(null);
  const [error, setError] = useState<LyricsError | null>(null);
  const [catalog, setCatalog] = useState<Presentation[]>([]);
  const [searching, setSearching] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    handlers
      .setlistReport()
      .then((next) => {
        setReports(next);
        setError(null);
      })
      .catch((reason) => setError(asLyricsError(reason)));
  }, [handlers]);

  useEffect(() => {
    load();
  }, [load, linksVersion]);

  const after = (work: Promise<unknown>) => {
    void work.then(load).catch((reason) => setError(asLyricsError(reason)));
  };

  const pending = (reports ?? []).filter(
    (report) =>
      report.linkState.state === "suggested" ||
      (report.linkState.state === "linked" && !report.stored),
  );

  return (
    <LyricsModal title={t("lyrics.linker.title")} onClose={close}>
      {error ? (
        <p className="lt-lyrics-probe is-error" role="alert">
          {lyricsErrorText(error, t)}
        </p>
      ) : null}
      {reports === null && !error ? <p>{t("lyrics.linker.loading")}</p> : null}
      {pending.length > 0 ? (
        <button className="lt-lyrics-btn" type="button" onClick={() => after(handlers.acceptAllSuggestions(pending))}>
          {t("lyrics.linker.acceptAll", { count: pending.length })}
        </button>
      ) : null}
      {reports ? (
        <table className="lt-lyrics-table">
          <thead>
            <tr>
              <th>{t("lyrics.linker.song")}</th>
              <th>{t("lyrics.linker.presentation")}</th>
              <th>{t("lyrics.linker.sections")}</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.regionId} data-region-id={report.regionId}>
                <td>
                  <button
                    type="button"
                    className="lt-lyrics-link-button"
                    onClick={() => handlers.openSongPanel(report.regionId)}
                  >
                    {report.regionName}
                  </button>
                </td>
                <td>
                  <LinkCell
                    report={report}
                    onUse={(presentation) => after(handlers.linkRegion(report.regionId, presentation))}
                    onSearch={() => {
                      setSearching(report.regionId);
                      void handlers.listPresentations().then(setCatalog).catch(() => {});
                    }}
                  />
                  {searching === report.regionId ? (
                    <div className="lt-settings-field">
                      <input className="lt-lyrics-input"
                        aria-label={t("lyrics.song.search")}
                        placeholder={t("lyrics.song.search")}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      <ul className="lt-lyrics-search">
                        {catalog
                          .filter((presentation) =>
                            presentation.name.toLowerCase().includes(search.trim().toLowerCase()),
                          )
                          .slice(0, 20)
                          .map((presentation) => (
                            <li key={presentation.id}>
                              <button className="lt-lyrics-btn"
                                type="button"
                                onClick={() => {
                                  setSearching(null);
                                  setSearch("");
                                  after(handlers.linkRegion(report.regionId, presentation));
                                }}
                              >
                                {presentation.name}
                              </button>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}
                </td>
                <td className={report.unmatchedSections > 0 ? "lt-lyrics-unmatched" : ""}>
                  {report.linkState.state === "linked"
                    ? report.unmatchedSections > 0
                      ? t("lyrics.linker.unmatched", { count: report.unmatchedSections })
                      : t("lyrics.linker.allMatched")
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <footer className="lt-lyrics-modal-footer">
        <span className="lt-lyrics-save-state is-idle">{t("lyrics.song.autoSave")}</span>
        <button type="button" className="lt-lyrics-btn is-primary" onClick={close}>
          {t("lyrics.song.done")}
        </button>
      </footer>
    </LyricsModal>
  );
}

function LinkCell({
  report,
  onUse,
  onSearch,
}: {
  report: RegionReport;
  onUse: (presentation: { id: string; name: string }) => void;
  onSearch: () => void;
}) {
  const { t } = useTranslation();
  const state = report.linkState.state;
  if (state === "linked" && report.link) {
    return (
      <span className="lt-lyrics-state-linked">
        <span aria-hidden="true">✔ </span>
        {report.link.presentationName}
        {report.stored ? null : <small> {t("lyrics.linker.toConfirm")}</small>}
      </span>
    );
  }
  if (state === "suggested" && report.suggestions.length > 0) {
    const [best, ...others] = report.suggestions;
    return (
      <span className="lt-lyrics-state-suggested">
        <span aria-hidden="true">? </span>
        <button className="lt-lyrics-btn" type="button" onClick={() => onUse({ id: best.id, name: best.name })}>
          {t("lyrics.linker.use", { name: best.name })}
        </button>
        {others.length > 0 ? (
          <select className="lt-lyrics-select"
            aria-label={t("lyrics.linker.others", { name: report.regionName })}
            value=""
            onChange={(event) => {
              const chosen = others.find((other) => other.id === event.target.value);
              if (chosen) onUse({ id: chosen.id, name: chosen.name });
            }}
          >
            <option value="">{t("lyrics.linker.otherOptions")}</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
        ) : null}
      </span>
    );
  }
  return (
    <span className="lt-lyrics-state-notFound">
      <span aria-hidden="true">✗ </span>
      {t("lyrics.linker.notFound")}{" "}
      <button className="lt-lyrics-btn" type="button" onClick={onSearch}>
        {t("lyrics.linker.search")}
      </button>
    </span>
  );
}
