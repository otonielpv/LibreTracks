import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsOverrideTarget } from "@libretracks/shared/models";

import { getSong } from "../transport/songStore";
import { LeadTimeField } from "../transport/panels/LeadTimeField";
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
import { lyricsErrorText } from "./LyricsSettingsTab";
import { useLyricsStore } from "./lyricsStore";
import { useLyricsHandlers } from "./useLyricsHandlers";

const AUTO = "__auto";
const CLEAR = "__clear";
const SKIP = "__skip";

function selectValue(marker: MarkerReport): string {
  switch (marker.status) {
    case "clear":
      return CLEAR;
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
  if (value === SKIP) return { type: "skip" };
  return { type: "group", label: value };
}

type PendingRepeat = { markerId: string; target: LyricsOverrideTarget | null };

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
  const close = useLyricsStore((state) => state.closeSongPanel);
  const linksVersion = useLyricsStore((state) => state.linksVersion);
  const software = useLyricsStore((state) => state.configView?.config.software ?? null);
  const handlers = useLyricsHandlers(api, onSnapshot);
  const [report, setReport] = useState<RegionReport | null>(null);
  const [error, setError] = useState<LyricsError | null>(null);
  const [catalog, setCatalog] = useState<Presentation[] | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<PendingRepeat | null>(null);

  const region = getSong()?.regions.find((candidate) => candidate.id === regionId) ?? null;
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

  const after = (work: Promise<unknown>) => {
    void work.then(load).catch((reason) => setError(asLyricsError(reason)));
  };

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

  return (
    <LyricsModal title={t("lyrics.song.title", { name: region?.name ?? "" })} onClose={close}>
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
        <button type="button" disabled={Boolean(error)} onClick={openSearch}>
          {t("lyrics.song.change")}
        </button>
      </div>

      {report && report.linkState.state === "linked" && !report.stored && report.link?.presentationId ? (
        <button
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
          <input
            aria-label={t("lyrics.song.search")}
            placeholder={t("lyrics.song.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="lt-lyrics-search">
            {filtered.slice(0, 30).map((presentation) => (
              <li key={presentation.id}>
                <button
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

      {pending ? (
        <div className="lt-lyrics-probe" role="group" aria-label={t("lyrics.song.repeatQuestion")}>
          <p>{t("lyrics.song.repeatQuestion")}</p>
          <div className="lt-lyrics-row">
            <button type="button" onClick={() => applyOverride(pending.markerId, pending.target, true)}>
              {t("lyrics.song.onlyThisTime")}
            </button>
            <button type="button" onClick={() => applyOverride(pending.markerId, pending.target, false)}>
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
                </td>
                <td>
                  <select
                    aria-label={t("lyrics.song.groupFor", {
                      name: marker.markerName,
                      n: marker.occurrence + 1,
                    })}
                    className={marker.status === "unmatched" ? "lt-lyrics-unmatched" : ""}
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
                    <option value={SKIP}>{t("lyrics.song.skip")}</option>
                  </select>
                </td>
                <td>{marker.slideCount > 0 ? marker.slideCount : ""}</td>
                <td>
                  <button
                    type="button"
                    disabled={marker.status === "unmatched" || marker.status === "skip"}
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

      <LeadTimeField
        value={region?.lyrics?.lead ?? null}
        onChange={(lead) => after(handlers.setRegionLead(regionId, lead))}
      />
      <small>{t("lyrics.song.leadHelp")}</small>
    </LyricsModal>
  );
}
