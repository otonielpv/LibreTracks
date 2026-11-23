import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { finalizeImport, relinkImportReview } from "@libretracks/shared/charts/chartImportReview";
import { chartMarkersForRegion } from "@libretracks/shared/charts/chartSync";
import type { SongChart, SongView } from "@libretracks/shared/models";

import type { PcoPlan, PcoPlanItem, PcoServiceType } from "../transport/desktopApi";
import { chartSourceHandlers, type PlanEntry, type PlanSong } from "./chartSourceHandlers";
import { ReviewView } from "./ChartImportDialog";
import { pcoErrorMessage, toPcoError } from "./pcoErrors";
import "./chartSources.css";

type Props = {
  song: SongView;
  /** Saves one song's chart through the song's chart action. */
  save: (regionId: string, chart: SongChart) => Promise<void>;
  onClose: () => void;
};

type Step = "choose" | "preparing" | "summary" | "review" | "done";

/**
 * "Import a plan…" (step 09): a service type, one of its next plans, its
 * songs paired with the session's by title, then every arrangement read and
 * matched with the item's own sequence and key. Apply the clear ones and
 * review the rest, or review them one by one. Every action is in
 * `chartSourceHandlers`.
 */
export function PlanImportDialog({ song, save, onClose }: Props) {
  const { t } = useTranslation();
  const [types, setTypes] = useState<PcoServiceType[] | null>(null);
  const [typeId, setTypeId] = useState("");
  const [plans, setPlans] = useState<PcoPlan[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [items, setItems] = useState<PcoPlanItem[] | null>(null);
  const [pairing, setPairing] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<Record<string, string[]>>({});
  const [step, setStep] = useState<Step>("choose");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [entries, setEntries] = useState<PlanEntry[]>([]);
  const [queue, setQueue] = useState<PlanEntry[]>([]);
  const [applied, setApplied] = useState(0);
  const [transpose, setTranspose] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const regions = song.regions;
  const songFor = (regionId: string): PlanSong | null => {
    const region = regions.find((candidate) => candidate.id === regionId) ?? null;
    return region ? { region, markers: chartMarkersForRegion(song.sectionMarkers, region) } : null;
  };

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

  useEffect(() => {
    void run(async () => setTypes(await chartSourceHandlers.loadServiceTypes()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickType = (id: string) => {
    setTypeId(id);
    setPlans(null);
    setItems(null);
    if (id) void run(async () => setPlans(await chartSourceHandlers.loadPlans(id)));
  };

  const pickPlan = (id: string) => {
    setPlanId(id);
    setItems(null);
    if (!id) return;
    void run(async () => {
      const found = await chartSourceHandlers.loadPlanItems(typeId, id);
      const matches = await chartSourceHandlers.matchPlanTitles(found, regions);
      setItems(found);
      setPairing(Object.fromEntries(matches.map((match) => [match.id, match.exact ?? ""])));
      setSuggested(Object.fromEntries(matches.map((match) => [match.id, match.suggestions])));
    });
  };

  const pairs = useMemo(
    () => (items ?? []).flatMap((item) => (pairing[item.id] ? [{ item, regionId: pairing[item.id] }] : [])),
    [items, pairing],
  );

  const prepare = () =>
    void run(async () => {
      cancelled.current = false;
      setStep("preparing");
      setProgress({ done: 0, total: pairs.length });
      const prepared = await chartSourceHandlers.preparePlan(pairs, songFor, {
        isCancelled: () => cancelled.current,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setEntries(prepared);
      setStep("summary");
    });

  const applyClear = () =>
    void run(async () => {
      cancelled.current = false;
      const result = await chartSourceHandlers.applyClearEntries(entries, save, { isCancelled: () => cancelled.current });
      setApplied(result.applied.length);
      const toReview = result.remaining.filter((entry) => entry.review);
      setQueue(toReview);
      setStep(toReview.length > 0 ? "review" : "done");
    });

  const reviewEach = () => {
    setApplied(0);
    const toReview = entries.filter((entry) => entry.review);
    setQueue(toReview);
    setStep(toReview.length > 0 ? "review" : "done");
  };

  const current = queue[0] ?? null;
  const next = () => {
    const rest = queue.slice(1);
    setQueue(rest);
    if (rest.length === 0) setStep("done");
  };
  const applyCurrent = () =>
    void run(async () => {
      if (!current?.review) return;
      const chart = finalizeImport(current.review, {
        transpose: transpose && current.review.key.semitones !== null,
        linked: !current.review.noMarkers,
      });
      await save(current.regionId, chart);
      setApplied((count) => count + 1);
      next();
    });
  const setSection = (markerId: string, value: string) => {
    if (!current?.review) return;
    const section = value === "" ? null : Number(value);
    const locked = [...current.review.locked.filter((link) => link.markerId !== markerId), { markerId, section }];
    const markers = songFor(current.regionId)?.markers ?? [];
    setQueue([{ ...current, review: relinkImportReview(current.review, markers, locked) }, ...queue.slice(1)]);
  };

  const regionName = (id: string) => regions.find((region) => region.id === id)?.name ?? "";
  const reviewedTotal = entries.filter((entry) => entry.review).length;

  return (
    <div className="lt-modal-backdrop lt-chart-import-backdrop" onClick={busy ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-chart-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-plan-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("chartSources.plan.eyebrow")}</span>
            <h2 id="lt-plan-import-title">{t("chartSources.plan.title")}</h2>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-chart-import-body">
          {step === "choose" ? (
            <>
              <label className="lt-plan-import-field">
                {t("chartSources.plan.serviceType")}
                <select value={typeId} onChange={(event) => pickType(event.target.value)} disabled={!types}>
                  <option value="" />
                  {(types ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </label>
              {plans ? (
                plans.length === 0 ? (
                  <p>{t("chartSources.plan.noPlans")}</p>
                ) : (
                  <label className="lt-plan-import-field">
                    {t("chartSources.plan.plans")}
                    <select value={planId} onChange={(event) => pickPlan(event.target.value)}>
                      <option value="" />
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {[plan.dates, plan.title].filter(Boolean).join(" · ")}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              ) : null}
              {items ? (
                <ul className="lt-chart-import-rows" aria-label={t("chartSources.plan.songs")}>
                  {items.map((item) => {
                    const options = [...new Set([pairing[item.id], ...(suggested[item.id] ?? [])].filter(Boolean))];
                    return (
                      <li key={item.id} className="lt-plan-import-pair" data-testid="plan-item">
                        <span className="lt-chart-import-marker">{item.title}</span>
                        <select
                          value={pairing[item.id] ?? ""}
                          aria-label={`${t("chartSources.plan.inSession")}: ${item.title ?? ""}`}
                          onChange={(event) => setPairing({ ...pairing, [item.id]: event.target.value })}
                        >
                          <option value="">{t("chartSources.plan.notInSession")}</option>
                          {options.map((id) => (
                            <option key={id} value={id}>
                              {regionName(id)}
                            </option>
                          ))}
                          {regions
                            .filter((region) => !options.includes(region.id))
                            .map((region) => (
                              <option key={region.id} value={region.id}>
                                {region.name}
                              </option>
                            ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </>
          ) : null}

          {step === "preparing" ? (
            <p role="status">{t("chartSources.plan.preparing", progress)}</p>
          ) : null}

          {step === "summary" ? (
            <ul className="lt-chart-import-rows" aria-label={t("chartSources.plan.summary")}>
              {entries.map((entry) => (
                <li key={entry.item.id} className="lt-plan-import-pair" data-testid="plan-entry">
                  <span className="lt-chart-import-marker">{regionName(entry.regionId)}</span>
                  <span>
                    {entry.review
                      ? entry.clear
                        ? t("chartSources.plan.clear")
                        : t("chartSources.plan.toReview")
                      : t("chartSources.plan.failed")}
                  </span>
                  <span className="lt-chart-import-meta">
                    {songFor(entry.regionId)?.region.chart ? t("chartSources.plan.hasLyrics") : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {step === "review" && current?.review ? (
            <>
              <p className="lt-chart-import-help">
                {t("chartSources.plan.reviewing", {
                  current: reviewedTotal - queue.length + 1,
                  total: reviewedTotal,
                  song: regionName(current.regionId),
                })}
              </p>
              <ReviewView
                review={current.review}
                transpose={transpose}
                onTranspose={setTranspose}
                onSection={setSection}
                onPasses={(markerId, passes) => {
                  if (!current?.review) return;
                  const markers = songFor(current.regionId)?.markers ?? [];
                  const review = relinkImportReview(current.review, markers, current.review.locked, {
                    ...current.review.passOverrides,
                    [markerId]: passes,
                  });
                  setQueue([{ ...current, review }, ...queue.slice(1)]);
                }}
              />
            </>
          ) : null}

          {step === "done" ? <p role="status">{t("chartSources.plan.done", { count: applied })}</p> : null}

          {error ? (
            <p className="lt-render-warning" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="lt-inline-actions">
          {step === "preparing" || (busy && step === "summary") ? (
            <button type="button" className="lt-secondary-button" onClick={() => (cancelled.current = true)}>
              {t("chartSources.plan.stop")}
            </button>
          ) : null}
          {step === "choose" || step === "done" ? (
            <button type="button" className="lt-secondary-button" disabled={busy} onClick={onClose}>
              {step === "done" ? t("chartSources.plan.close") : t("chartSources.import.cancel")}
            </button>
          ) : null}
          {step === "choose" ? (
            <button type="button" className="is-primary" disabled={busy || pairs.length === 0} onClick={prepare}>
              {t("chartSources.plan.prepare")}
            </button>
          ) : null}
          {step === "summary" ? (
            <>
              <button type="button" className="lt-secondary-button" disabled={busy} onClick={reviewEach}>
                {t("chartSources.plan.reviewEach")}
              </button>
              <button type="button" className="is-primary" disabled={busy} onClick={applyClear}>
                {t("chartSources.plan.applyClear")}
              </button>
            </>
          ) : null}
          {step === "review" ? (
            <>
              <button type="button" className="lt-secondary-button" disabled={busy} onClick={next}>
                {t("chartSources.plan.skip")}
              </button>
              <button type="button" className="is-primary" disabled={busy} onClick={applyCurrent}>
                {t("chartSources.plan.applyOne")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export type { PlanEntry };
