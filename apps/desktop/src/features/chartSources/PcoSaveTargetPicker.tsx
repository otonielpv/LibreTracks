import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ChartSource } from "@libretracks/shared/models";

import type { PcoArrangement, PcoSong } from "../transport/desktopApi";
import { chartSourceHandlers } from "./chartSourceHandlers";
import { pcoErrorMessage, toPcoError } from "./pcoErrors";

type Props = {
  /** What to search first: the song's name. */
  initialQuery: string;
  /** The song picked, and whether to save as a new arrangement or replace one. */
  onPicked: (source: ChartSource, kind: "new" | "replace") => void;
  onCancel: () => void;
};

/**
 * Where to save lyrics that did not come from Planning Center: search the
 * song there and pick "New arrangement" or the arrangement to replace. The
 * result is the source the chart is linked to from then on.
 */
export function PcoSaveTargetPicker({ initialQuery, onPicked, onCancel }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [songs, setSongs] = useState<PcoSong[] | null>(null);
  const [picked, setPicked] = useState<PcoSong | null>(null);
  const [arrangements, setArrangements] = useState<PcoArrangement[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(pcoErrorMessage(t, toPcoError(cause)));
    } finally {
      setBusy(false);
    }
  };

  const search = (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    void run(async () => {
      setPicked(null);
      setArrangements(null);
      setSongs((await chartSourceHandlers.searchSongs(query.trim())).items);
    });
  };

  const pickSong = (song: PcoSong) =>
    void run(async () => {
      setPicked(song);
      setArrangements(await chartSourceHandlers.loadArrangements(song.id));
    });

  const choose = (song: PcoSong, arrangement: PcoArrangement, kind: "new" | "replace") =>
    onPicked(
      {
        provider: "planningCenter",
        songId: song.id,
        arrangementId: arrangement.id,
        ...(arrangement.chordChartKey ? { key: arrangement.chordChartKey } : {}),
        // Not imported from there: nothing to compare the text with.
        importedHash: "",
      },
      kind,
    );

  return (
    <div className="lt-pco-save-target">
      <p className="lt-chart-import-legend">{t("chartSources.save.pickHelp")}</p>
      <form className="lt-chart-import-search" onSubmit={search}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("chartSources.import.searchLabel")} />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy && !picked ? t("chartSources.import.searching") : t("chartSources.import.search")}
        </button>
      </form>
      {songs && songs.length === 0 ? <p>{t("chartSources.import.noResults")}</p> : null}
      {songs && songs.length > 0 ? (
        <ul className="lt-chart-import-list" aria-label={t("chartSources.import.searchLabel")}>
          {songs.map((song) => (
            <li key={song.id}>
              <button type="button" className={song.id === picked?.id ? "is-active" : undefined} onClick={() => pickSong(song)}>
                <strong>{song.title}</strong>
                {song.author ? <span>{song.author}</span> : null}
              </button>
              {song.id === picked?.id && arrangements ? (
                <ul className="lt-chart-import-arrangements" aria-label={t("chartSources.import.arrangements")}>
                  {arrangements.length > 0 ? (
                    <li>
                      <button type="button" disabled={busy} onClick={() => choose(song, arrangements[0], "new")}>
                        <span>{t("chartSources.save.pickNew")}</span>
                      </button>
                    </li>
                  ) : null}
                  {arrangements.map((arrangement) => (
                    <li key={arrangement.id}>
                      <button type="button" disabled={busy} onClick={() => choose(song, arrangement, "replace")}>
                        <span>{t("chartSources.save.pickReplace", { name: arrangement.name })}</span>
                        <span className="lt-chart-import-meta">{arrangement.chordChartKey ?? t("chartSources.import.noKey")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="lt-render-warning" role="alert">
          {error}
        </p>
      ) : null}
      <div className="lt-inline-actions">
        <button type="button" className="lt-secondary-button" disabled={busy} onClick={onCancel}>
          {t("chartSources.import.cancel")}
        </button>
      </div>
    </div>
  );
}
