import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  markerColor,
  type SongChart,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import {
  clearSongRegionChart,
  removeSongChartAnchor,
  setSongChartAnchor,
  setSongRegionChart,
} from "../desktopApi";
import { buildLiveMarkerGroups } from "../live/liveMarkerModel";
import { useLiveMarkerPlayback } from "../live/useLiveMarkerPlayback";
import type { ViewMode } from "../uiStore";
import { ViewModeSwitcher } from "../timeline/ViewModeSwitcher";
import {
  anchorAtPosition,
  chartAnchorFor,
  chartRegionAt,
  chartScrollTopFor,
  chartSectionsForRegion,
} from "./chartModel";
import { ChartPages, type ChartPageMarker } from "./ChartPages";
import { useChartDocument } from "./useChartDocument";
import "./ChartView.css";

/** Mirrors Rust `SongChart::MAX_BYTES`; checked here too so the user gets a
 * translated message instead of the backend's. */
const MAX_CHART_BYTES = 25 * 1024 * 1024;

type ChartViewProps = {
  song: SongView;
  positionSecondsRef: { readonly current: number };
  onViewModeChange: (mode: ViewMode) => void;
  onSnapshot: (snapshot: TransportSnapshot) => void;
  /** Runs an action and reports its failure in the status bar. */
  run: (work: () => Promise<void>) => Promise<void>;
};

function sectionLabel(name: string, fallback: string) {
  return name.trim() || fallback;
}

export function ChartView({
  song,
  positionSecondsRef,
  onViewModeChange,
  onSnapshot,
  run,
}: ChartViewProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);

  const groups = useMemo(() => buildLiveMarkerGroups(song.sectionMarkers), [song.sectionMarkers]);
  const playback = useLiveMarkerPlayback(groups, song.regions, positionSecondsRef);
  const region =
    song.regions.find((candidate) => candidate.id === playback.currentRegionId) ??
    chartRegionAt(song.regions, playback.positionSeconds);
  const chart: SongChart | null = region?.chart ?? null;
  const sections = useMemo(
    () => chartSectionsForRegion(song.sectionMarkers, region),
    [song.sectionMarkers, region],
  );
  const followed = anchorAtPosition(chart, sections, playback.positionSeconds);
  const currentSection =
    [...sections].reverse().find((section) => section.startSeconds <= playback.positionSeconds + 0.001) ??
    null;
  const documentState = useChartDocument(region?.id ?? null, chart?.filePath ?? null);

  const markers = useMemo<ChartPageMarker[]>(
    () =>
      sections.flatMap((section) => {
        const anchor = chartAnchorFor(chart, section.id);
        return anchor
          ? [
              {
                markerId: anchor.markerId,
                page: anchor.page,
                y: anchor.y,
                label: sectionLabel(section.name, t("chartView.untitledSection")),
                color: markerColor(section),
              },
            ]
          : [];
      }),
    [chart, sections, t],
  );

  // While editing the chart stays where the user put it.
  const scrollRequest = useMemo(() => {
    if (editing || !region) return null;
    const key = `${region.id}:${followed ? `${followed.markerId}:${followed.page}:${followed.y}` : "top"}`;
    return {
      key,
      top: (layout: Parameters<typeof chartScrollTopFor>[1], viewportHeight: number) =>
        chartScrollTopFor(followed, layout, viewportHeight),
    };
  }, [editing, region, followed]);

  const selectedSection =
    sections.find((section) => section.id === editingMarkerId) ??
    sections.find((section) => !chartAnchorFor(chart, section.id)) ??
    sections[0] ??
    null;

  const startEditing = () => {
    setEditingMarkerId(null);
    setEditing(true);
  };

  const handlePick = useCallback(
    (page: number, y: number) => {
      if (!region || !selectedSection) return;
      const index = sections.findIndex((section) => section.id === selectedSection.id);
      void run(async () => {
        onSnapshot(await setSongChartAnchor(region.id, selectedSection.id, page, y));
        // Straight on to the next section: marking a whole song is then just
        // tapping down the page.
        setEditingMarkerId(sections[index + 1]?.id ?? selectedSection.id);
      });
    },
    [onSnapshot, region, run, sections, selectedSection],
  );

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Same file picked twice must still fire `change`.
    event.target.value = "";
    if (!file || !region) return;
    void run(async () => {
      if (file.size > MAX_CHART_BYTES) {
        throw new Error(t("chartView.tooLarge", { size: Math.round(file.size / 1048576) }));
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      onSnapshot(await setSongRegionChart(region.id, file.name, bytes));
      setEditing(false);
    });
  };

  const pickFile = () => fileInputRef.current?.click();

  const removeChart = () => {
    if (!region) return;
    void run(async () => {
      onSnapshot(await clearSongRegionChart(region.id));
      setEditing(false);
    });
  };

  const removeSelectedAnchor = () => {
    if (!region || !selectedSection) return;
    void run(async () => {
      onSnapshot(await removeSongChartAnchor(region.id, selectedSection.id));
    });
  };

  const selectedAnchored = selectedSection ? chartAnchorFor(chart, selectedSection.id) !== null : false;

  return (
    <main className="lt-chart-view" aria-label={t("chartView.title")}>
      <header className="lt-chart-header">
        <ViewModeSwitcher value="chart" onChange={onViewModeChange} />
        <div className="lt-chart-heading">
          <strong>{region?.name ?? song.title}</strong>
          {currentSection ? (
            <span
              className="lt-chart-current-section"
              style={{ ["--lt-chart-anchor-color" as string]: markerColor(currentSection) }}
            >
              {sectionLabel(currentSection.name, t("chartView.untitledSection"))}
            </span>
          ) : null}
        </div>
        {region && chart ? (
          <div className="lt-chart-actions">
            <button
              type="button"
              className={`lt-icon-button${editing ? " is-active" : ""}`}
              aria-pressed={editing}
              aria-label={t("chartView.markSections")}
              title={t("chartView.markSections")}
              onClick={() => (editing ? setEditing(false) : startEditing())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                {editing ? "check" : "edit_location_alt"}
              </span>
            </button>
            {editing ? (
              <>
                <button
                  type="button"
                  className="lt-icon-button"
                  aria-label={t("chartView.replace")}
                  title={t("chartView.replace")}
                  onClick={pickFile}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    upload_file
                  </span>
                </button>
                <button
                  type="button"
                  className="lt-icon-button"
                  aria-label={t("chartView.remove")}
                  title={t("chartView.remove")}
                  onClick={removeChart}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    delete
                  </span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {editing && region && chart ? (
        <div className="lt-chart-edit-bar" role="toolbar" aria-label={t("chartView.markSections")}>
          {sections.length === 0 ? (
            <span className="lt-chart-hint">{t("chartView.noSections")}</span>
          ) : (
            <>
              <span className="lt-chart-hint">{t("chartView.tapHint")}</span>
              <div className="lt-chart-section-chips">
                {sections.map((section) => {
                  const anchored = chartAnchorFor(chart, section.id) !== null;
                  const selected = section.id === selectedSection?.id;
                  return (
                    <button
                      type="button"
                      key={section.id}
                      className={`lt-chart-chip${selected ? " is-selected" : ""}${anchored ? " is-anchored" : ""}`}
                      style={{ ["--lt-chart-anchor-color" as string]: markerColor(section) }}
                      aria-pressed={selected}
                      onClick={() => setEditingMarkerId(section.id)}
                    >
                      {anchored ? (
                        <span className="material-symbols-outlined" aria-hidden="true">
                          check
                        </span>
                      ) : null}
                      {sectionLabel(section.name, t("chartView.untitledSection"))}
                    </button>
                  );
                })}
              </div>
              {selectedAnchored ? (
                <button type="button" className="lt-chart-text-button" onClick={removeSelectedAnchor}>
                  {t("chartView.removeAnchor")}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <section className="lt-chart-body">
        {!region ? (
          <div className="lt-chart-empty">
            <span className="material-symbols-outlined" aria-hidden="true">
              description
            </span>
            <p>{t("chartView.noSongs")}</p>
          </div>
        ) : !chart ? (
          <div className="lt-chart-empty">
            <span className="material-symbols-outlined" aria-hidden="true">
              description
            </span>
            <p>{t("chartView.noChart", { song: region.name })}</p>
            <button type="button" className="lt-chart-primary-button" onClick={pickFile}>
              {t("chartView.addPdf")}
            </button>
          </div>
        ) : documentState.status === "ready" ? (
          <ChartPages
            document={documentState.document}
            aspects={documentState.aspects}
            markers={markers}
            currentMarkerId={followed?.markerId ?? null}
            scrollRequest={scrollRequest}
            editing={editing}
            onPick={handlePick}
          />
        ) : documentState.status === "error" ? (
          <div className="lt-chart-empty" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">
              error
            </span>
            <p>{t("chartView.loadFailed")}</p>
            <small>{documentState.message}</small>
            <button type="button" className="lt-chart-primary-button" onClick={pickFile}>
              {t("chartView.replace")}
            </button>
          </div>
        ) : (
          <div className="lt-chart-empty" aria-busy="true">
            <p>{t("chartView.loading")}</p>
          </div>
        )}
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={handleFile}
        data-testid="chart-file-input"
      />
    </main>
  );
}
