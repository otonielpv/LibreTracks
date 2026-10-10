import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { appliedArrangementName } from "../structure/arrangementName";

import {
  getEffectiveBpmAt,
  markerColor,
  regionEffectiveKey,
  type ActiveVampSummary,
  type AppSettings,
  type SectionMarkerSummary,
  type SongChart,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";
import {
  buildLiveMarkerGroups,
  formatLiveClock,
  groupContainsMarker,
  liveMarkerGroupsForRegion,
  resolveLivePlaybackPosition,
} from "./liveMarkerModel";
import { useLiveMarkerPlayback } from "./useLiveMarkerPlayback";
import {
  calculateLiveProgress,
  useLiveProgressBars,
} from "./useLiveProgressBars";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { LiveChartPanel } from "../charts/LiveChartPanel";
import { SongReorderHandle } from "../songs/SongReorderHandle";
import {
  SONG_REORDER_ID_ATTRIBUTE,
  useSongReorder,
} from "../songs/useSongReorder";
import type { ViewMode } from "../uiStore";
import { ViewModeSwitcher } from "../timeline/ViewModeSwitcher";
import "./LivePerformanceView.css";

type LivePerformanceViewProps = {
  song: SongView;
  positionSecondsRef: { readonly current: number };
  settings: AppSettings;
  pendingMarkerId: string | null;
  pendingMarkerName: string | null;
  activeVamp: ActiveVampSummary | null;
  onViewModeChange: (mode: ViewMode) => void;
  onMarkerAction: (marker: SectionMarkerSummary) => void;
  onSongAction: (region: SongRegionSummary) => void;
  /** Drag a setlist song to another position; `targetIndex` is its final
   * position in start order (0 = first). */
  onReorderSong?: (regionId: string, targetIndex: number) => void;
  /** Replace a song's lyrics and chords (`null` removes them). */
  onChartChange: (regionId: string, chart: SongChart | null) => Promise<void>;
  onToggleVamp: () => void;
  onCancelPendingJump: () => void;
  onGlobalJumpModeChange: (mode: AppSettings["globalJumpMode"]) => void;
  onGlobalJumpBarsChange: (bars: number) => void;
  onSongJumpTriggerChange: (trigger: AppSettings["songJumpTrigger"]) => void;
  onSongJumpBarsChange: (bars: number) => void;
  onSongTransitionModeChange: (mode: AppSettings["songTransitionMode"]) => void;
  onVampModeChange: (mode: AppSettings["vampMode"]) => void;
  onVampBarsChange: (bars: number) => void;
};

const CHART_OPEN_KEY = "lt.liveView.chartOpen";

/** Whether the lyrics panel is shown. A per-viewer convenience, so browser
 * storage; open by default so the feature is found. */
function readChartOpen(): boolean {
  try {
    return window.localStorage.getItem(CHART_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeChartOpen(open: boolean) {
  try {
    window.localStorage.setItem(CHART_OPEN_KEY, String(open));
  } catch {
    // Blocked storage: the panel just opens again next time.
  }
}

type SettingCardProps = {
  label: string;
  barsLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  bars?: number;
  onBarsChange?: (bars: number) => void;
  action?: ReactNode;
};

function SettingCard({
  label,
  barsLabel,
  value,
  onChange,
  options,
  bars,
  onBarsChange,
  action,
}: SettingCardProps) {
  return (
    <div className="lt-live-setting-card">
      <span className="material-symbols-outlined" aria-hidden="true">tune</span>
      <span className="lt-live-setting-copy">
        <small>{label}</small>
        <span className="lt-live-setting-options" role="group" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              className={option.value === value ? "is-active" : ""}
              aria-pressed={option.value === value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </span>
      {typeof bars === "number" && onBarsChange ? (
        <input
          className="lt-live-setting-bars"
          type="number"
          min={1}
          max={64}
          value={bars}
          aria-label={`${label}: ${barsLabel}`}
          onChange={(event) => onBarsChange(Number(event.target.value))}
        />
      ) : null}
      {action}
    </div>
  );
}

function LivePerformanceViewComponent({
  song,
  positionSecondsRef,
  settings,
  pendingMarkerId,
  pendingMarkerName,
  activeVamp,
  onViewModeChange,
  onMarkerAction,
  onSongAction,
  onReorderSong,
  onChartChange,
  onToggleVamp,
  onCancelPendingJump,
  onGlobalJumpModeChange,
  onGlobalJumpBarsChange,
  onSongJumpTriggerChange,
  onSongJumpBarsChange,
  onSongTransitionModeChange,
  onVampModeChange,
  onVampBarsChange,
}: LivePerformanceViewProps) {
  const { t } = useTranslation();
  const allGroups = useMemo(
    () => buildLiveMarkerGroups(song.sectionMarkers),
    [song.sectionMarkers],
  );
  const sortedRegions = useMemo(
    () => [...song.regions].sort((left, right) => left.startSeconds - right.startSeconds),
    [song.regions],
  );
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(() =>
    sortedRegions.find(
      (region) =>
        positionSecondsRef.current >= region.startSeconds &&
        positionSecondsRef.current < region.endSeconds,
    )?.id ?? sortedRegions[0]?.id ?? null,
  );
  const playback = useLiveMarkerPlayback(
    allGroups,
    sortedRegions,
    positionSecondsRef,
  );
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const songChipRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const setlistRef = useRef<HTMLElement | null>(null);
  const sortedRegionIds = useMemo(
    () => sortedRegions.map((region) => region.id),
    [sortedRegions],
  );
  const songReorder = useSongReorder({
    itemIds: sortedRegionIds,
    containerRef: setlistRef,
    onReorder: onReorderSong,
  });
  // Lyrics ship behind a flag (see featureFlags): off, the live view is the
  // markers alone, as before the feature existed.
  const [chartOpenSetting, setChartOpen] = useState(() => readChartOpen());
  const chartOpen = FEATURE_FLAGS.lyrics && chartOpenSetting;
  const [chartExpanded, setChartExpanded] = useState(false);
  const toggleChartOpen = () => {
    setChartOpen((current) => {
      writeChartOpen(!current);
      return !current;
    });
    setChartExpanded(false);
  };
  const toggleChartExpanded = useCallback(() => setChartExpanded((current) => !current), []);
  const markerProgressFillRef = useRef<HTMLSpanElement | null>(null);
  const songProgressFillRef = useRef<HTMLSpanElement | null>(null);
  const lastPlaybackRegionIdRef = useRef<string | null>(null);
  const currentRegion =
    sortedRegions.find((region) => region.id === playback.currentRegionId) ?? null;
  const selectedRegion =
    sortedRegions.find((region) => region.id === selectedRegionId) ??
    currentRegion ??
    sortedRegions[0] ??
    null;
  const groups = useMemo(
    () => liveMarkerGroupsForRegion(allGroups, selectedRegion),
    [allGroups, selectedRegion],
  );
  const selectedPlayback = resolveLivePlaybackPosition(
    groups,
    sortedRegions,
    playback.positionSeconds,
  );
  const activeGroupIndex = groups.findIndex(
    (group) => group.id === selectedPlayback.activeGroupId,
  );
  const activeGroup = activeGroupIndex >= 0 ? groups[activeGroupIndex] : null;
  const nextGroup = activeGroupIndex >= 0 ? groups[activeGroupIndex + 1] ?? null : null;
  const currentRegionDuration = currentRegion
    ? Math.max(0, currentRegion.endSeconds - currentRegion.startSeconds)
    : 0;
  const currentRegionElapsed = currentRegion
    ? Math.max(
        0,
        Math.min(
          currentRegionDuration,
          playback.positionSeconds - currentRegion.startSeconds,
        ),
      )
    : 0;
  const currentRegionProgress = calculateLiveProgress(
    playback.positionSeconds,
    currentRegion?.startSeconds ?? null,
    currentRegion?.endSeconds ?? null,
  );
  const markerProgress = calculateLiveProgress(
    playback.positionSeconds,
    activeGroup?.startSeconds ?? null,
    nextGroup?.startSeconds ?? selectedRegion?.endSeconds ?? null,
  );
  const isVampActive = activeVamp !== null;
  const vampGroupId = useMemo(() => {
    if (!activeVamp) return null;
    return [...groups]
      .reverse()
      .find((group) => group.startSeconds <= activeVamp.startSeconds + 0.001)?.id ?? null;
  }, [activeVamp, groups]);

  useLiveProgressBars({
    positionSecondsRef,
    markerStartSeconds: activeGroup?.startSeconds ?? null,
    markerEndSeconds: nextGroup?.startSeconds ?? selectedRegion?.endSeconds ?? null,
    regionStartSeconds: currentRegion?.startSeconds ?? null,
    regionEndSeconds: currentRegion?.endSeconds ?? null,
    markerFillRef: markerProgressFillRef,
    songFillRef: songProgressFillRef,
  });

  useEffect(() => {
    if (
      playback.currentRegionId &&
      playback.currentRegionId !== lastPlaybackRegionIdRef.current
    ) {
      lastPlaybackRegionIdRef.current = playback.currentRegionId;
      setSelectedRegionId(playback.currentRegionId);
    }
  }, [playback.currentRegionId]);

  // The song playing stays visible in the header strip.
  useEffect(() => {
    const chip = currentRegion ? songChipRefs.current[currentRegion.id] : null;
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [currentRegion?.id]);

  useEffect(() => {
    if (!selectedPlayback.activeGroupId) return;
    const row = rowRefs.current[selectedPlayback.activeGroupId];
    if (!row) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [selectedPlayback.activeGroupId]);

  const jumpOptions = [
    { value: "immediate", label: t("liveView.immediate") },
    { value: "after_bars", label: t("liveView.afterBars") },
    { value: "next_marker", label: t("liveView.nextMarker") },
  ];
  const songJumpOptions = [
    { value: "immediate", label: t("liveView.immediate") },
    { value: "region_end", label: t("liveView.regionEnd") },
    { value: "after_bars", label: t("liveView.afterBars") },
    { value: "next_marker", label: t("liveView.nextMarker") },
  ];
  const vampOptions = [
    { value: "section", label: t("liveView.section") },
    { value: "bars", label: t("liveView.bars") },
  ];
  const songTransitionOptions = [
    { value: "instant", label: t("liveView.cleanCut") },
    { value: "fade_out", label: t("liveView.fadeOut") },
  ];

  return (
    <main
      className={`lt-live-view${chartOpen ? " has-chart" : ""}${chartOpen && chartExpanded ? " is-chart-expanded" : ""}`}
      aria-label={t("liveView.title")}
    >
      <header className="lt-live-header">
        <ViewModeSwitcher value="live" onChange={onViewModeChange} />
        <div className="lt-live-heading">
          <span className="material-symbols-outlined" aria-hidden="true">stadium</span>
          <div><small>{t("liveView.title")}</small><strong>{currentRegion?.name ?? song.title}</strong></div>
        </div>
        <div className="lt-live-song-metrics">
          <span>{currentRegion ? `${getEffectiveBpmAt(song, currentRegion.startSeconds).toFixed(0)} BPM` : `${song.bpm.toFixed(0)} BPM`}</span>
          <span>{regionEffectiveKey(currentRegion) ?? "—"}</span>
        </div>
        <div className="lt-live-song-progress">
          <span className="lt-live-song-progress-times">
            {formatLiveClock(currentRegionElapsed)} / {formatLiveClock(currentRegionDuration)}
          </span>
          <span
            className="lt-live-song-progress-track"
            role="progressbar"
            aria-label={t("liveView.songProgress")}
            aria-valuenow={Math.round(currentRegionProgress * 100)}
          >
            <span ref={songProgressFillRef} />
          </span>
          <small className="lt-live-song-remaining">
            {t("liveView.remaining", {
              time: formatLiveClock(currentRegionDuration - currentRegionElapsed),
            })}
          </small>
        </div>
        <nav
          className="lt-live-region-buttons"
          aria-label={t("liveView.setlist")}
          ref={(node) => { setlistRef.current = node; }}
        >
          {sortedRegions.map((region, index) => (
            <div
              className={`lt-live-region-row${region.id === selectedRegion?.id ? " is-selected" : ""}${region.id === currentRegion?.id ? " is-playing" : ""}${region.id === pendingMarkerId ? " is-queued" : ""}${songReorder.enabled ? " has-reorder" : ""}`}
              key={region.id}
              ref={(node) => { songChipRefs.current[region.id] = node; }}
              {...{ [SONG_REORDER_ID_ATTRIBUTE]: region.id }}
            >
              {songReorder.enabled ? (
                <SongReorderHandle
                  name={region.name}
                  handleProps={songReorder.handleProps(region.id)}
                />
              ) : null}
              <button
                type="button"
                className="lt-live-region-select"
                aria-label={t("liveView.selectSong", { name: region.name })}
                onClick={() => setSelectedRegionId(region.id)}
                {...songReorder.surfaceProps(region.id)}
              >
                <span>{index + 1}</span>{region.name}
                {appliedArrangementName(region) ? (
                  <em className="lt-live-region-arrangement">
                    {t("transport.structure.live.badge", { name: appliedArrangementName(region) })}
                  </em>
                ) : null}
                {region.id === pendingMarkerId ? (
                  <em className="lt-live-region-queued">{t("liveView.queued")}</em>
                ) : null}
              </button>
              <button
                type="button"
                className="lt-live-region-play"
                aria-label={t("liveView.playSong", { name: region.name })}
                onClick={() => onSongAction(region)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">play_arrow</span>
              </button>
            </div>
          ))}
        </nav>
        {FEATURE_FLAGS.lyrics ? (
        <div className="lt-live-header-tools lt-bottom-controls">
          <button
            type="button"
            className={`lt-live-chart-toggle${chartOpen ? " is-active" : ""}`}
            aria-pressed={chartOpen}
            aria-label={t("liveChart.toggle")}
            title={t("liveChart.toggle")}
            onClick={toggleChartOpen}
          >
            <span className="material-symbols-outlined" aria-hidden="true">lyrics</span>
            <span>{t("liveChart.toggleLabel")}</span>
          </button>
        </div>
        ) : null}
      </header>

      <section className="lt-live-settings" aria-label={t("liveView.performanceSettings")}>
        <SettingCard
          label={t("liveView.markerJump")}
          barsLabel={t("liveView.bars")}
          value={settings.globalJumpMode}
          options={jumpOptions}
          onChange={(value) => onGlobalJumpModeChange(value as AppSettings["globalJumpMode"])}
          bars={settings.globalJumpMode === "after_bars" ? settings.globalJumpBars : undefined}
          onBarsChange={onGlobalJumpBarsChange}
        />
        <SettingCard
          label={t("liveView.songJump")}
          barsLabel={t("liveView.bars")}
          value={settings.songJumpTrigger}
          options={songJumpOptions}
          onChange={(value) => onSongJumpTriggerChange(value as AppSettings["songJumpTrigger"])}
          bars={settings.songJumpTrigger === "after_bars" ? settings.songJumpBars : undefined}
          onBarsChange={onSongJumpBarsChange}
          action={(
            <span
              className="lt-live-song-transition"
              role="group"
              aria-label={t("liveView.songTransition")}
            >
              {songTransitionOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={settings.songTransitionMode === option.value ? "is-active" : ""}
                  aria-pressed={settings.songTransitionMode === option.value}
                  title={`${t("liveView.songTransition")}: ${option.label}`}
                  onClick={() => onSongTransitionModeChange(
                    option.value as AppSettings["songTransitionMode"],
                  )}
                >
                  {option.label}
                </button>
              ))}
            </span>
          )}
        />
        <SettingCard
          label={t("liveView.vampType")}
          barsLabel={t("liveView.bars")}
          value={settings.vampMode}
          options={vampOptions}
          onChange={(value) => onVampModeChange(value as AppSettings["vampMode"])}
          bars={settings.vampMode === "bars" ? settings.vampBars : undefined}
          onBarsChange={onVampBarsChange}
          action={(
            <button type="button" className={`lt-live-vamp${isVampActive ? " is-active" : ""}`} aria-pressed={isVampActive} onClick={(event) => { event.preventDefault(); onToggleVamp(); }}>
              VAMP
            </button>
          )}
        />
      </section>

      <section className="lt-live-cue-panel" aria-labelledby="lt-live-cue-title">
        <div className="lt-live-section-title">
          <h2 id="lt-live-cue-title">{t("liveView.markerMatrix")}</h2>
          <div className="lt-live-section-actions">
            <span className="lt-live-section-count">
              {selectedRegion?.name ?? "—"}
              {selectedRegion && appliedArrangementName(selectedRegion)
                ? ` · ${t("transport.structure.live.badge", { name: appliedArrangementName(selectedRegion) })}`
                : ""}
              {" · "}
              {groups.length} {t("liveView.markers")}
            </span>
            <button
              type="button"
              className="lt-live-cancel"
              disabled={!pendingMarkerId}
              title={pendingMarkerName ? t("liveView.cancelNamedJump", { name: pendingMarkerName }) : t("liveView.noPendingJump")}
              onClick={onCancelPendingJump}
            >
              <span className="material-symbols-outlined" aria-hidden="true">cancel_schedule_send</span>
              <span>{t("liveView.cancelJump")}</span>
            </button>
          </div>
        </div>
        <div className="lt-live-cue-grid">
          {groups.map((group, index) => {
            const isActive = group.id === selectedPlayback.activeGroupId;
            const isNext = group.id === selectedPlayback.nextGroupId;
            const isPending = pendingMarkerId
              ? groupContainsMarker(group, pendingMarkerId)
              : false;
            const isPast = activeGroupIndex >= 0 && index < activeGroupIndex;
            const isVampAnchor = group.id === vampGroupId;
            return (
              <button
                type="button"
                key={group.id}
                ref={(node) => { rowRefs.current[group.id] = node; }}
                className={`lt-live-cue-row${isActive ? " is-active" : ""}${isNext ? " is-next" : ""}${isPending ? " is-pending" : ""}${isPast ? " is-past" : ""}${isVampAnchor ? " is-vamp" : ""}${group.category === "cue" ? " is-cue" : ""}`}
                style={{ "--lt-live-marker-color": markerColor(group.primary) } as CSSProperties}
                onClick={() => onMarkerAction(group.primary)}
              >
                <span className="lt-live-cue-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="lt-live-cue-copy">
                  <span className="lt-live-cue-name-line">
                    <strong>{group.primary.name}</strong>
                    {group.category === "cue" ? <em>{t("liveView.warning")}</em> : null}
                    {isActive ? <em className="is-now">{t("liveView.now")}</em> : null}
                    {isPending ? <em className="is-queued">{t("liveView.queued")}</em> : null}
                    {/* La cuenta atras va en la LINEA DEL NOMBRE, no en una
                        linea propia al final de la fila. La lista se desplaza
                        para centrar la marca ACTIVA, asi que la SIGUIENTE
                        -que es la que lleva la cuenta atras- suele quedar a
                        medias por el borde inferior del scroll: lo ultimo de
                        la fila es justamente lo que se corta. Arriba se lee
                        aunque la fila salga a medias, y de paso se mira de un
                        vistazo junto al nombre, que es como se usa en directo. */}
                    {isNext && selectedPlayback.secondsToNextGroup !== null ? (
                      <em className="is-countdown">
                        <span className="lt-live-countdown-long">
                          {t("liveView.nextIn", { time: formatLiveClock(selectedPlayback.secondsToNextGroup) })}
                        </span>
                        <span className="lt-live-countdown-short" aria-hidden="true">
                          <span className="material-symbols-outlined">timer</span>
                          {formatLiveClock(selectedPlayback.secondsToNextGroup)}
                        </span>
                      </em>
                    ) : null}
                    {isVampAnchor ? (
                      <em
                        className="is-vamp"
                        title={settings.vampMode === "section"
                          ? t("liveView.vampSectionFeedback")
                          : t("liveView.vampBarsFeedback", { count: settings.vampBars })}
                      >
                        {settings.vampMode === "section"
                          ? t("liveView.vampSectionBadge")
                          : t("liveView.vampBarsBadge", { count: settings.vampBars })}
                      </em>
                    ) : null}
                  </span>
                  {group.cues.length > 0 ? (
                    <span className="lt-live-cue-warnings">
                      {group.cues.map((cue) => <span key={cue.id}>{t("liveView.warning")}: {cue.name}</span>)}
                    </span>
                  ) : null}
                  <span
                    className={`lt-live-cue-progress${isActive ? " is-active" : ""}`}
                    role={isActive ? "progressbar" : undefined}
                    aria-valuenow={isActive ? Math.round(markerProgress * 100) : undefined}
                    aria-hidden={!isActive}
                  >
                    <span ref={isActive ? markerProgressFillRef : undefined} />
                  </span>
                </span>
                <time>{formatLiveClock(group.startSeconds - (selectedRegion?.startSeconds ?? 0))}</time>
                <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
              </button>
            );
          })}
          {groups.length === 0 ? <p className="lt-live-empty">{t("liveView.noMarkers")}</p> : null}
        </div>
      </section>

      {chartOpen ? (
        <LiveChartPanel
          song={song}
          region={selectedRegion}
          positionSecondsRef={positionSecondsRef}
          pendingMarkerId={pendingMarkerId}
          expanded={chartExpanded}
          onToggleExpanded={toggleChartExpanded}
          onClose={toggleChartOpen}
          onChartChange={onChartChange}
        />
      ) : null}

    </main>
  );
}

export const LivePerformanceView = memo(LivePerformanceViewComponent);
