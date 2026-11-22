import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsOverrideTarget, LyricsStartTarget } from "@libretracks/shared/models";

import { usePortraitWhileOpen } from "../transport/mobile/usePortraitWhileOpen";
import { useSongStore } from "../transport/songStore";
import { LeadTimeField } from "../transport/panels/LeadTimeField";
import { describeLead } from "../transport/panels/leadTime";
import {
  asLyricsError,
  type LyricsError,
  type MarkerReport,
  type Presentation,
  type RegionReport,
} from "./lyricsApi";
import { isRepeat, linkFor } from "./lyricsEdits";
import type { LyricsApi } from "./lyricsHandlers";
import { LyricsModal } from "./LyricsModal";
import { LyricsSectionEditor, slideLabel } from "./LyricsSectionEditor";
import { lyricsErrorText } from "./LyricsSettingsTab";
import { useLyricsStore } from "./lyricsStore";
import { useLyricsHandlers } from "./useLyricsHandlers";

const AUTO = "__auto";
const CLEAR = "__clear";
const CLEAR_TEXT = "__clearText";
const SKIP = "__skip";

function selectValue(marker: MarkerReport): string {
  switch (marker.status) {
    case "clear":
      return CLEAR;
    case "clearText":
      return marker.automatic ? AUTO : CLEAR_TEXT;
    case "skip":
      return SKIP;
    case "matched":
      return marker.automatic ? AUTO : marker.groupLabel;
    default:
      return AUTO;
  }
}

function targetOf(value: string): LyricsOverrideTarget | null {
  if (value === AUTO) return null;
  if (value === CLEAR) return { type: "clear" };
  if (value === CLEAR_TEXT) return { type: "clearText" };
  if (value === SKIP) return { type: "skip" };
  return { type: "group", label: value };
}

type PendingRepeat = { markerId: string; target: LyricsOverrideTarget | null };

const START_AUTO = "auto";
const START_CLEAR = "clear";
const START_CLEAR_TEXT = "clearText";

function startValue(report: RegionReport): string {
  const start = report.link?.start;
  if (!start) return START_AUTO;
  if (start.type === "clear") return START_CLEAR;
  if (start.type === "clearText") return START_CLEAR_TEXT;
  return `slide:${start.index}`;
}

function startOf(value: string): LyricsStartTarget | null {
  if (value === START_AUTO) return null;
  if (value === START_CLEAR) return { type: "clear" };
  if (value === START_CLEAR_TEXT) return { type: "clearText" };
  return { type: "slide", index: Number(value.slice("slide:".length)) };
}

/**
 * One song's lyrics: its presentation, each section marker and the group it
 * shows (corrections, "Test"), and its own lead. Opened from the song menu
 * of every view; the actions live in `lyricsHandlers`.
 */
export function LyricsSongPanel({
  regionId,
  api,
  onSnapshot,
}: {
  regionId: string;
  api?: LyricsApi;
  onSnapshot?: (snapshot: unknown) => void;
}) {
  const { t } = useTranslation();
  // Teléfono: escribir en vertical (plan portrait-text-modals).
  const close = usePortraitWhileOpen(useLyricsStore((state) => state.closeSongPanel));
  const linksVersion = useLyricsStore((state) => state.linksVersion);
  const software = useLyricsStore((state) => state.configView?.config.software ?? null);
  const globalLead = useLyricsStore((state) => state.configView?.config.lead ?? null);
  const handlers = useLyricsHandlers(api, onSnapshot);
  const [report, setReport] = useState<RegionReport | null>(null);
  const [error, setError] = useState<LyricsError | null>(null);
  const [catalog, setCatalog] = useState<Presentation[] | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<PendingRepeat | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [editing, setEditing] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  /** Where the table was scrolled when a marker's editor opened: Back
   * returns there instead of to the top. */
  const tableScroll = useRef(0);

  const openEditor = (markerId: string) => {
    tableScroll.current = body.current?.scrollTop ?? 0;
    setEditing(markerId);
  };

  useLayoutEffect(() => {
    if (editing === null && body.current) body.current.scrollTop = tableScroll.current;
  }, [editing]);

  const region = useSongStore(
    (state) => state.song?.regions.find((candidate) => candidate.id === regionId) ?? null,
  );
  const stored = software ? linkFor(region?.lyrics, software) : null;

  const load = useCallback(() => {
    handlers
      .regionReport(regionId)
      .then((next) => {
        setReport(next);
        setError(null);
      })
      .catch((reason) => setError(asLyricsError(reason)));
  }, [handlers, regionId]);

  useEffect(() => {
    load();
  }, [load, linksVersion]);

  // Every change is saved at once (one undo step each); the footer says so.
  const after = (work: Promise<unknown>) => {
    setSaving("saving");
    void work
      .then(() => {
        setSaving("saved");
        load();
      })
      .catch((reason) => {
        setSaving("idle");
        setError(asLyricsError(reason));
      });
  };

  useEffect(() => {
    if (saving !== "saved") return () => {};
    const timer = window.setTimeout(() => setSaving("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [saving]);

  const applyOverride = (markerId: string, target: LyricsOverrideTarget | null, onlyThisTime: boolean) => {
    setPending(null);
    after(handlers.setOverride(regionId, markerId, target, onlyThisTime));
  };

  const openSearch = () => {
    setCatalog([]);
    void handlers
      .listPresentations()
      .then(setCatalog)
      .catch((reason) => setError(asLyricsError(reason)));
  };

  const enabled = region?.lyrics?.enabled ?? true;
  const filtered = (catalog ?? []).filter((presentation) =>
    presentation.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const editingMarker = editing ? report?.markers.find((marker) => marker.markerId === editing) : null;
  const linked = report?.linkState.state === "linked";
  const slides = report?.slides ?? [];
  const autoStartSlide =
    report?.start?.automatic && report.start.slide !== null
      ? slides.find((slide) => slide.index === report.start?.slide)
      : null;

  const footer = (
    <footer className="lt-lyrics-modal-footer">
      <span className={`lt-lyrics-save-state is-${saving}`} role="status">
        {saving === "saving"
          ? t("lyrics.song.saving")
          : saving === "saved"
            ? t("lyrics.song.saved")
            : t("lyrics.song.autoSave")}
      </span>
      <button type="button" className="lt-lyrics-btn is-primary" onClick={close}>
        {t("lyrics.song.done")}
      </button>
    </footer>
  );

  if (report && editingMarker) {
    // Its own key: the editor opens at the top, not at the table's scroll.
    return (
      <LyricsModal
        key={`edit-${editingMarker.markerId}`}
        title={t("lyrics.song.title", { name: region?.name ?? "" })}
        onClose={close}
      >
        <LyricsSectionEditor
          regionId={regionId}
          report={report}
          marker={editingMarker}
          handlers={handlers}
          onSave={after}
          onBack={() => setEditing(null)}
          inheritedLead={region?.lyrics?.lead ?? globalLead}
        />
        {footer}
      </LyricsModal>
    );
  }

  return (
    <LyricsModal
      key="table"
      bodyRef={body}
      title={t("lyrics.song.title", { name: region?.name ?? "" })}
      onClose={close}
    >
      {error ? (
        <div className="lt-lyrics-probe is-error" role="alert">
          <p>{lyricsErrorText(error, t)}</p>
          {stored ? <p>{t("lyrics.song.savedLink", { name: stored.presentationName })}</p> : null}
        </div>
      ) : null}

      <div className="lt-lyrics-row">
        <div className="lt-settings-field">
          <span>{t("lyrics.song.presentation")}</span>
          <strong>
            {report?.link?.presentationName ?? stored?.presentationName ?? t("lyrics.song.noPresentation")}
          </strong>
          {report && report.linkState.state === "linked" && !report.stored ? (
            <small>{t("lyrics.song.foundByName")}</small>
          ) : null}
        </div>
        <button className="lt-lyrics-btn" type="button" disabled={Boolean(error)} onClick={openSearch}>
          {t("lyrics.song.change")}
        </button>
      </div>

      {report && report.linkState.state === "linked" && !report.stored && report.link?.presentationId ? (
        <button className="lt-lyrics-btn"
          type="button"
          onClick={() =>
            after(
              handlers.linkRegion(regionId, {
                id: report.link!.presentationId!,
                name: report.link!.presentationName,
              }),
            )
          }
        >
          {t("lyrics.song.confirm")}
        </button>
      ) : null}

      {catalog !== null ? (
        <div className="lt-settings-field">
          <input className="lt-lyrics-input"
            aria-label={t("lyrics.song.search")}
            placeholder={t("lyrics.song.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="lt-lyrics-search">
            {filtered.slice(0, 30).map((presentation) => (
              <li key={presentation.id}>
                <button className="lt-lyrics-btn"
                  type="button"
                  onClick={() => {
                    setCatalog(null);
                    setSearch("");
                    after(handlers.linkRegion(regionId, presentation));
                  }}
                >
                  {presentation.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => after(handlers.setRegionEnabled(regionId, event.target.checked))}
        />
        <span className="lt-settings-toggle-copy">
          <strong>{t("lyrics.song.enabled")}</strong>
        </span>
      </label>

      {report && linked && slides.length > 0 ? (
        <label className="lt-settings-field">
          <span>{t("lyrics.song.start")}</span>
          <select
            className="lt-lyrics-select"
            aria-label={t("lyrics.song.start")}
            value={startValue(report)}
            onChange={(event) => after(handlers.setStart(regionId, startOf(event.target.value)))}
          >
            <option value={START_AUTO}>
              {t("lyrics.song.startAuto", {
                what: autoStartSlide
                  ? slideLabel(autoStartSlide, t)
                  : report.start?.clearText
                    ? t("lyrics.song.textCleared")
                    : t("lyrics.song.cleared"),
              })}
            </option>
            <option value={START_CLEAR}>{t("lyrics.song.startClear")}</option>
            <option value={START_CLEAR_TEXT}>{t("lyrics.song.clearText")}</option>
            {slides.map((slide) => (
              <option key={slide.index} value={`slide:${slide.index}`}>
                {slideLabel(slide, t)}
              </option>
            ))}
          </select>
          <small>{t("lyrics.song.startHelp")}</small>
        </label>
      ) : null}

      {pending ? (
        <div className="lt-lyrics-probe" role="group" aria-label={t("lyrics.song.repeatQuestion")}>
          <p>{t("lyrics.song.repeatQuestion")}</p>
          <div className="lt-lyrics-row">
            <button className="lt-lyrics-btn" type="button" onClick={() => applyOverride(pending.markerId, pending.target, true)}>
              {t("lyrics.song.onlyThisTime")}
            </button>
            <button className="lt-lyrics-btn" type="button" onClick={() => applyOverride(pending.markerId, pending.target, false)}>
              {t("lyrics.song.everyTime")}
            </button>
          </div>
        </div>
      ) : null}

      {report && report.markers.length > 0 ? (
        <table className="lt-lyrics-table">
          <thead>
            <tr>
              <th>{t("lyrics.song.marker")}</th>
              <th>{t("lyrics.song.group")}</th>
              <th>{t("lyrics.song.slides")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {report.markers.map((marker) => (
              <tr key={marker.markerId}>
                <td>
                  {marker.markerName}
                  {marker.occurrence > 0 ? (
                    <small> {t("lyrics.song.occurrence", { n: marker.occurrence + 1 })}</small>
                  ) : null}
                  {marker.lead ? (
                    <small className="lt-lyrics-marker-lead">
                      {t("lyrics.song.markerLead", { lead: describeLead(marker.lead, t) })}
                    </small>
                  ) : null}
                </td>
                <td>
                  <select
                    aria-label={t("lyrics.song.groupFor", {
                      name: marker.markerName,
                      n: marker.occurrence + 1,
                    })}
                    className={`lt-lyrics-select ${marker.status === "unmatched" ? "lt-lyrics-unmatched" : ""}`}
                    value={selectValue(marker)}
                    onChange={(event) => {
                      const target = targetOf(event.target.value);
                      if (isRepeat(marker.markerId)) {
                        setPending({ markerId: marker.markerId, target });
                      } else {
                        applyOverride(marker.markerId, target, false);
                      }
                    }}
                  >
                    <option value={AUTO}>
                      {marker.status === "matched" && marker.automatic
                        ? t("lyrics.song.auto", { group: marker.groupLabel })
                        : marker.status === "clearText" && marker.automatic
                          ? t("lyrics.song.auto", { group: t("lyrics.song.clearTextShort") })
                          : marker.status === "unmatched"
                          ? t("lyrics.song.unmatched")
                          : t("lyrics.song.autoPlain")}
                    </option>
                    {report.groups.map((group) => (
                      <option key={group.label} value={group.label}>
                        {group.label}
                      </option>
                    ))}
                    <option value={CLEAR}>{t("lyrics.song.clear")}</option>
                    <option value={CLEAR_TEXT}>{t("lyrics.song.clearText")}</option>
                    <option value={SKIP}>{t("lyrics.song.skip")}</option>
                  </select>
                </td>
                <td>
                  <span className="lt-lyrics-slide-count">
                    {marker.slideCount > 0 ? marker.slideCount : ""}
                    {linked &&
                    marker.status !== "clear" &&
                    !(marker.status === "clearText" && !marker.automatic) &&
                    marker.status !== "skip" ? (
                      <button
                        className="lt-lyrics-btn lt-lyrics-edit"
                        type="button"
                        aria-label={t("lyrics.section.editFor", {
                          name:
                            marker.occurrence > 0
                              ? `${marker.markerName} ${t("lyrics.song.occurrence", { n: marker.occurrence + 1 })}`
                              : marker.markerName,
                        })}
                        onClick={() => openEditor(marker.markerId)}
                      >
                        {t("lyrics.section.edit")}
                      </button>
                    ) : null}
                  </span>
                </td>
                <td>
                  <button className="lt-lyrics-btn"
                    type="button"
                    disabled={(marker.status === "unmatched" && !marker.customSlides) || marker.status === "skip"}
                    onClick={() => void handlers.testSend(regionId, marker.markerId, 0)}
                  >
                    {t("lyrics.song.test")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {report && report.linkState.state === "linked" && report.markers.length === 0 ? (
        <p>{t("lyrics.song.noMarkers")}</p>
      ) : null}


      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={Boolean(region?.lyrics?.lead)}
          onChange={(event) =>
            after(
              handlers.setRegionLead(
                regionId,
                event.target.checked ? { unit: "beats", count: 1 } : null,
              ),
            )
          }
        />
        <span className="lt-settings-toggle-copy">
          <strong>{t("lyrics.song.ownLead")}</strong>
          <small>{t("lyrics.song.leadHelp")}</small>
        </span>
      </label>
      {region?.lyrics?.lead ? (
        <LeadTimeField
          value={region.lyrics.lead}
          onChange={(lead) =>
            after(handlers.setRegionLead(regionId, lead ?? { unit: "beats", count: 0 }))
          }
        />
      ) : null}

      {footer}
    </LyricsModal>
  );
}
