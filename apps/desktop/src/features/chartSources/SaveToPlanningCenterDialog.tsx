import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { compareCharts } from "@libretracks/shared/charts/chartRefresh";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";
import { chartTextHash, planningCenterToImported } from "@libretracks/shared/charts/importedChart";
import { planningCenterSequence, toPlanningCenterChart } from "@libretracks/shared/charts/planningCenterExport";
import type { ChartLink, ChartSource, SectionMarkerSummary, SongRegionSummary } from "@libretracks/shared/models";

import type { PcoArrangement } from "../transport/desktopApi";
import { chartSourceHandlers } from "./chartSourceHandlers";
import { pcoErrorMessage, toPcoError } from "./pcoErrors";
import "./chartSources.css";

type Props = {
  region: SongRegionSummary;
  markers: readonly SectionMarkerSummary[];
  /** The chart as it is in the editor now (adjusted and corrected). */
  text: string;
  links: readonly ChartLink[];
  source: ChartSource;
  /** Where the chart is linked now (the new arrangement, or the replaced one
   * with its new date), for the editor to save with the lyrics. */
  onSaved: (source: ChartSource) => void;
  onClose: () => void;
};

/**
 * "Save to Planning Center": the chart corrected and adjusted here goes back
 * to Planning Center with the song's sequence, so nobody has to fix it there
 * by hand. A new arrangement by default; replacing the original is an
 * explicit, confirmed choice, with what changes and a warning when it changed
 * there since the import.
 */
export function SaveToPlanningCenterDialog({ region, markers, text, links, source, onSaved, onClose }: Props) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<PcoArrangement | null>(null);
  const [kind, setKind] = useState<"new" | "replace">("new");
  const [name, setName] = useState(() => t("chartSources.save.defaultName"));
  // The key the lyrics are written in now ({key: D} once adjusted); the
  // song's or the source's only for a sheet that does not say.
  const [key, setKey] = useState(() => parseChordPro(text).key ?? region.key ?? source.key ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chartSourceHandlers
      .loadArrangement(source.songId, source.arrangementId)
      .then(setCurrent)
      .catch((cause) => setError(pcoErrorMessage(t, toPcoError(cause))));
  }, [source.songId, source.arrangementId, t]);

  const sequence = useMemo(() => planningCenterSequence(text, links, markers), [text, links, markers]);
  const changedThere = Boolean(current?.updatedAt && source.updatedAt && current.updatedAt !== source.updatedAt);
  const changes = useMemo(() => {
    if (!current) return [];
    try {
      return compareCharts(parseChordPro(planningCenterToImported(current).text), parseChordPro(text));
    } catch {
      return [];
    }
  }, [current, text]);

  const canSave = !busy && !saved && key.trim() !== "" && (kind === "new" ? name.trim() !== "" : confirmed && current !== null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const write = { chordChart: toPlanningCenterChart(text), chordChartKey: key.trim(), sequence };
      const result = await chartSourceHandlers.saveToPlanningCenter(
        kind === "new"
          ? { kind: "new", songId: source.songId, name: name.trim() }
          : { kind: "replace", songId: source.songId, arrangementId: source.arrangementId },
        write,
      );
      onSaved({
        provider: "planningCenter",
        songId: source.songId,
        arrangementId: result.id,
        ...(kind === "replace" && source.planItemId ? { planItemId: source.planItemId } : {}),
        key: key.trim(),
        ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
        importedHash: chartTextHash(text),
      });
      setSaved(true);
    } catch (cause) {
      setError(pcoErrorMessage(t, toPcoError(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lt-modal-backdrop lt-chart-import-backdrop" onClick={busy ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-chart-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-pco-save-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("chartSources.save.eyebrow")}</span>
            <h2 id="lt-pco-save-title">{t("chartSources.save.title")}</h2>
            <p>{region.name}</p>
          </div>
        </header>
        <div className="lt-settings-modal-body lt-chart-import-body">
          <label className="lt-chart-import-key">
            <input type="radio" name="pco-save-kind" checked={kind === "new"} onChange={() => setKind("new")} />
            {t("chartSources.save.newArrangement")}
          </label>
          {kind === "new" ? (
            <>
              <p className="lt-chart-import-legend">{t("chartSources.save.newHelp")}</p>
              <label className="lt-plan-import-field">
                {t("chartSources.save.name")}
                <input className="lt-pco-save-input" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            </>
          ) : null}
          <label className="lt-chart-import-key">
            <input
              type="radio"
              name="pco-save-kind"
              checked={kind === "replace"}
              disabled={!current}
              onChange={() => setKind("replace")}
            />
            {t("chartSources.save.replace", { name: current?.name ?? "" })}
          </label>
          {kind === "replace" ? (
            <div className="lt-chart-import-warning-box">
              <p className="lt-chart-import-warning">{t("chartSources.save.replaceHelp")}</p>
              {changedThere ? (
                <p className="lt-chart-import-warning" role="alert">
                  {t("chartSources.save.changedThere")}
                </p>
              ) : null}
              <section className="lt-chart-import-changes" aria-label={t("chartSources.save.changes")}>
                <h3>{t("chartSources.save.changes")}</h3>
                {changes.length === 0 ? (
                  <p className="lt-chart-import-legend">{t("chartSources.save.noChanges")}</p>
                ) : (
                  <ul>
                    {changes.map((change, index) => (
                      <li key={index} data-testid="pco-save-change">
                        {t(`chartSources.refresh.${change.change}`)}: {change.label}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <label className="lt-chart-import-key">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                {t("chartSources.save.replaceConfirm")}
              </label>
            </div>
          ) : null}
          <label className="lt-plan-import-field">
            {t("chartSources.save.key")}
            <input className="lt-pco-save-input" value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <section className="lt-chart-import-changes" aria-label={t("chartSources.save.sequence")}>
            <h3>{t("chartSources.save.sequence")}</h3>
            {sequence.length === 0 ? (
              <p className="lt-chart-import-legend">{t("chartSources.save.noSequence")}</p>
            ) : (
              <p data-testid="pco-save-sequence">{sequence.join(" · ")}</p>
            )}
          </section>
          {saved ? <p role="status">{t("chartSources.save.saved")}</p> : null}
          {error ? (
            <p className="lt-render-warning" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="lt-inline-actions">
          <button type="button" className="lt-secondary-button" disabled={busy} onClick={onClose}>
            {saved ? t("chartSources.plan.close") : t("chartSources.import.cancel")}
          </button>
          {!saved ? (
            <button type="button" className="is-primary" disabled={!canSave} onClick={() => void save()}>
              {busy ? t("chartSources.save.saving") : t("chartSources.save.save")}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
