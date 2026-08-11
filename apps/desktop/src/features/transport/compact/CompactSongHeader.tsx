import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  meterDbToDisplayScale,
  peakToMeterDb,
  stepMeterDb,
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_MIN_DB,
} from "@libretracks/shared/meterBallistics";

import { clientToZoomedCoords } from "../../../shared/uiZoom";
import {
  regionEffectiveKey,
  SONG_KEY_OPTIONS,
  type SongRegionSummary,
} from "../desktopApi";
import { useTransportStore } from "../store";

type CompactSongHeaderProps = {
  region: SongRegionSummary;
  isActive: boolean;
  bpm: number | undefined;
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onPlay: () => void;
  onRename: () => void;
  onSetBpm: () => void;
  onDelete: () => void;
  onExport: () => void;
  onSetKey: (key: string | null) => void;
  /** True when this region matches the project selection. Drives the
   * `is-selected` styling so the user sees which song the toolbar's
   * Transpose / Warp / Master controls are bound to. */
  isSelected: boolean;
  /** Click on the header (anywhere except the play button or fader)
   * selects the region — same selection slot the DAW uses, so the
   * Transposition / Warp / Master groups in the toolbar pick this up
   * automatically. */
  onSelect: () => void;
};

// Master fader snaps to unity (1.0) within ±3% of full range (0..2), so the
// magnetic zone is [0.94, 1.06]. Shift bypasses, double-click resets.
const MASTER_SNAP_TARGET = 1.0;
const MASTER_SNAP_RANGE = 2.0;
const MASTER_SNAP_THRESHOLD = MASTER_SNAP_RANGE * 0.03;

function applyMasterSnap(value: number, bypass: boolean): number {
  if (bypass) return value;
  return Math.abs(value - MASTER_SNAP_TARGET) <= MASTER_SNAP_THRESHOLD
    ? MASTER_SNAP_TARGET
    : value;
}

function CompactSongHeaderComponent({
  region,
  isActive,
  bpm,
  onMasterGainChange,
  onMasterGainCommit,
  onPlay,
  onRename,
  onSetBpm,
  onDelete,
  onExport,
  onSetKey,
  isSelected,
  onSelect,
}: CompactSongHeaderProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // When true the menu shows the 24-key picker instead of the root actions.
  const [keyMenuOpen, setKeyMenuOpen] = useState(false);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => {
      setContextMenu(null);
      setKeyMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);
  const openMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = clientToZoomedCoords(event.clientX, event.clientY);
    setContextMenu({ x, y });
  }, []);
  // Track Shift state via window listeners so the slider's onChange can
  // read it; same pattern as the CompactMixerStrip volume / pan.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
  const optimistic = useTransportStore((state) =>
    state.optimisticRegionMaster[region.id],
  );
  const gain = optimistic ?? region.master?.gain ?? 1.0;

  const meterFillRef = useRef<HTMLDivElement | null>(null);
  const animationStateRef = useRef({
    frameId: null as number | null,
    lastFrameAt: 0,
    currentDb: METER_MIN_DB,
    targetDb: METER_MIN_DB,
  });

  // Same animation loop the toolbar's RegionMasterFader uses. The store
  // update arrives via the shared useRegionMeters hook already wired in
  // TransportPanelContent.
  const driveAnimation = useCallback(() => {
    const animationState = animationStateRef.current;
    const applyFill = () => {
      const element = meterFillRef.current;
      if (!element) return;
      const scale = meterDbToDisplayScale(animationState.currentDb);
      element.style.width = `${(scale * 100).toFixed(2)}%`;
      element.style.opacity = scale > 0 ? "1" : "0";
    };
    const step = (now: number) => {
      const elapsed =
        animationState.lastFrameAt > 0 ? now - animationState.lastFrameAt : 16.67;
      animationState.lastFrameAt = now;
      animationState.currentDb = stepMeterDb(
        animationState.currentDb,
        animationState.targetDb,
        elapsed,
        DEFAULT_METER_FALLOFF_DB_PER_SECOND,
      );
      applyFill();
      const settled =
        Math.abs(animationState.currentDb - animationState.targetDb) <
        METER_ACTIVE_EPSILON_DB;
      if (settled) {
        animationState.currentDb = animationState.targetDb;
        applyFill();
        animationState.frameId = null;
        animationState.lastFrameAt = 0;
        return;
      }
      animationState.frameId = requestAnimationFrame(step);
    };
    if (animationState.frameId === null) {
      animationState.frameId = requestAnimationFrame(step);
    }
  }, []);

  useTransportStore.subscribe(
    (state) => state.regionMeters[region.id] ?? 0,
    (peak) => {
      animationStateRef.current.targetDb = peakToMeterDb(peak);
      driveAnimation();
    },
  );

  // Click on the header (anywhere but the play button or the fader)
  // selects the region. We listen on the root with a check that the
  // event reached us un-stopped — the play button and master fader
  // call stopPropagation when they handle the click, so this only
  // fires for clicks on the header's body.
  const handleHeaderClick = useCallback(() => {
    onSelect();
  }, [onSelect]);

  return (
    <div
      className={`lt-compact-song-header ${isActive ? "is-active" : ""} ${
        isSelected ? "is-selected" : ""
      }`}
      onContextMenu={openMenu}
      onClick={handleHeaderClick}
    >
      <div className="lt-compact-song-name-row">
        <button
          type="button"
          className="lt-compact-song-play"
          aria-label={`Reproducir ${region.name}`}
          title={`Reproducir ${region.name} (respeta la transición global)`}
          onClick={(event) => {
            // Don't bubble to the header — the play button shouldn't
            // also select the region, only transport-jump to it.
            event.stopPropagation();
            onPlay();
          }}
        >
          <span className="material-symbols-outlined">play_arrow</span>
        </button>
        <div className="lt-compact-song-name" title={region.name}>
          {region.name}
        </div>
        {bpm !== undefined ? (
          <div
            className="lt-compact-song-bpm"
            title={`BPM efectivo al inicio de la canción`}
          >
            {bpm.toFixed(bpm % 1 === 0 ? 0 : 2)} BPM
          </div>
        ) : null}
        {regionEffectiveKey(region) ? (
          <div
            className="lt-compact-song-key"
            title="Nota de la canción (con el cambio de tono aplicado)"
          >
            {regionEffectiveKey(region)}
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          className={`lt-compact-clip-menu ${keyMenuOpen ? "is-key-picker" : ""}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {keyMenuOpen ? (
            <>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  setKeyMenuOpen(false);
                  onSetKey(null);
                }}
              >
                {(region.key ?? null) === null ? "✓ " : ""}Sin nota
              </button>
              {SONG_KEY_OPTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="lt-compact-clip-menu-item"
                  onClick={() => {
                    setContextMenu(null);
                    setKeyMenuOpen(false);
                    onSetKey(key);
                  }}
                >
                  {region.key === key ? "✓ " : ""}
                  {key}
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onRename();
                }}
              >
                Renombrar canción
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onSetBpm();
                }}
              >
                Cambiar BPM…
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={(event) => {
                  // Keep the menu open and swap to the key picker instead of
                  // closing — mirrors the DAW's reopen-with-keys submenu.
                  event.stopPropagation();
                  setKeyMenuOpen(true);
                }}
              >
                Nota de la canción ▸
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onExport();
                }}
              >
                Exportar canción
              </button>
              <div className="lt-compact-clip-menu-divider" aria-hidden="true" />
              <button
                type="button"
                className="lt-compact-clip-menu-item is-destructive"
                onClick={() => {
                  setContextMenu(null);
                  onDelete();
                }}
              >
                Eliminar canción
              </button>
            </>
          )}
        </div>
      ) : null}
      <div
        className="lt-compact-song-master"
        // The master fader sits inside the clickable header. Swallow
        // clicks so dragging or double-clicking the fader doesn't
        // re-fire the header's selection handler.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lt-compact-song-meter" aria-hidden="true">
          <div className="lt-compact-song-meter-fill" ref={meterFillRef} />
        </div>
        <input
          className="lt-compact-song-fader"
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={gain}
          aria-label={`Master gain for ${region.name}`}
          onChange={(event) => {
            const next = Number(event.target.value) || 0;
            onMasterGainChange(applyMasterSnap(next, shiftPressedRef.current));
          }}
          onDoubleClick={() => {
            onMasterGainChange(MASTER_SNAP_TARGET);
            onMasterGainCommit();
          }}
          onPointerUp={onMasterGainCommit}
          onPointerCancel={onMasterGainCommit}
          onKeyUp={(event) => {
            if (
              event.key === "ArrowUp" ||
              event.key === "ArrowDown" ||
              event.key === "ArrowLeft" ||
              event.key === "ArrowRight" ||
              event.key === "PageUp" ||
              event.key === "PageDown" ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              onMasterGainCommit();
            }
          }}
        />
      </div>
    </div>
  );
}

export const CompactSongHeader = memo(CompactSongHeaderComponent);
