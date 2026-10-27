import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";
import { NetworkControls } from "../../network/NetworkControls";

import { clientToZoomedCoords } from "../../../shared/uiZoom";
import { useDismissOnBack } from "../mobile/backNavigation";
import { openRenderSong } from "../render/renderStore";
import { openSongAnalysis } from "../songAnalysis/songAnalysisStore";
import { ArrangementBadge } from "../structure/ArrangementBadge";
import { KeySequenceLabel } from "../keyChanges/SoundingKeyLabel";
import { openStructureEditor } from "../structure/structureEditor";
import {
  regionEffectiveKey,
  SONG_KEY_OPTIONS,
  type SongRegionSummary,
} from "../desktopApi";
import { useTransportStore } from "../store";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import {
  SongReorderHandle,
  type SongReorderHandleProps,
} from "../songs/SongReorderHandle";
import { SONG_REORDER_IGNORE_ATTRIBUTE } from "../songs/useSongReorder";
import { SongMasterMeter } from "../tracks/TrackMeter";

/** Spread onto the fader: dragging it must never start a song reorder from
 * the header surface. (The context menu already stops pointerdown.) */
const NO_SONG_REORDER = { [SONG_REORDER_IGNORE_ATTRIBUTE]: "" };

type CompactSongHeaderProps = {
  region: SongRegionSummary;
  isActive: boolean;
  isQueued: boolean;
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
  /** Grip that drags the song to another position (any pointer, keyboard
   * arrows). Undefined hides the grip — reordering is off. */
  reorderHandleProps?: SongReorderHandleProps;
  /** Mouse drag from the header body also reorders, past a few pixels so a
   * click still selects. */
  reorderSurfaceProps?: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  };
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

export function CompactSongHeaderComponent({
  region,
  isActive,
  isQueued,
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
  reorderHandleProps,
  reorderSurfaceProps,
}: CompactSongHeaderProps) {
  const { canEdit, canControl, canUseFiles } = useNetworkPermissions();
  const { t } = useTranslation();
  const touchContextMenu = useTouchContextMenu({
    ignoreTarget: (target) =>
      target instanceof Element &&
      target.closest(
        "button, input, select, [data-song-reorder-ignore], [data-no-song-reorder], .lt-compact-clip-menu",
      ) !== null,
  });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // When true the menu shows the 24-key picker instead of the root actions.
  const [keyMenuOpen, setKeyMenuOpen] = useState(false);
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setKeyMenuOpen(false);
  }, []);
  // En Android, atras cierra el menu contextual en vez de salir.
  useDismissOnBack(closeContextMenu, contextMenu !== null);
  // Con el selector de nota abierto, atras vuelve al menu raiz antes de
  // cerrar. Se registra despues que el del menu, asi que queda encima.
  const closeKeyMenu = useCallback(() => setKeyMenuOpen(false), []);
  useDismissOnBack(closeKeyMenu, contextMenu !== null && keyMenuOpen);

  useEffect(() => {
    if (!contextMenu) return;
    const close = closeContextMenu;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, closeContextMenu]);
  const openMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canEdit) return;
    const { x, y } = clientToZoomedCoords(event.clientX, event.clientY);
    setContextMenu({ x, y });
  }, [canEdit]);
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
        isQueued ? "is-queued" : ""
      } ${
        isSelected ? "is-selected" : ""
      }`}
      onPointerDownCapture={touchContextMenu.begin}
      onPointerMoveCapture={touchContextMenu.move}
      onPointerUpCapture={touchContextMenu.cancel}
      onPointerCancelCapture={touchContextMenu.cancel}
      onClickCapture={(event) => {
        if (!touchContextMenu.consumeTriggered()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={openMenu}
      onClick={handleHeaderClick}
      onPointerDown={reorderSurfaceProps?.onPointerDown}
    >
      <div className="lt-compact-song-name-row">
        {reorderHandleProps ? (
          <SongReorderHandle
            name={region.name}
            handleProps={reorderHandleProps}
          />
        ) : null}
        <button
          type="button"
          className="lt-compact-song-play"
          disabled={!canControl}
          aria-label={t("compactView.playAria", { name: region.name })}
          title={t("compactView.playTitle", { name: region.name })}
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
        <ArrangementBadge region={region} />
        {isQueued ? (
          <div className="lt-compact-song-queued">{t("liveView.queued")}</div>
        ) : null}
        {bpm !== undefined ? (
          <div
            className="lt-compact-song-bpm"
            title={t("compactView.bpmTitle")}
          >
            {bpm.toFixed(bpm % 1 === 0 ? 0 : 2)} BPM
          </div>
        ) : null}
        {regionEffectiveKey(region) ? (
          <div
            className="lt-compact-song-key"
            title={t("compactView.songKeyTitle")}
          >
            <KeySequenceLabel region={region} />
          </div>
        ) : null}
      </div>
      {contextMenu && canEdit ? (
        <div
          className={`lt-compact-clip-menu ${keyMenuOpen ? "is-key-picker" : ""}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {keyMenuOpen ? (
            <>
              <button
                type="button"
                className="lt-compact-clip-menu-item lt-compact-clip-menu-back"
                aria-label={t("common.back", { defaultValue: "Atrás" })}
                onClick={closeKeyMenu}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  arrow_back
                </span>
                {t("compactView.songKey")}
              </button>
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
                {t("compactView.renameSong")}
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onSetBpm();
                }}
              >
                {t("compactView.changeBpm")}
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
                {t("compactView.songKey")} ▸
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  openStructureEditor(region.id);
                }}
              >
                {t("transport.structure.menuItem")}
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                disabled={!canUseFiles}
                onClick={() => {
                  setContextMenu(null);
                  onExport();
                }}
              >
                {t("compactView.exportSong")}
              </button>
              <button
                type="button"
                className="lt-compact-clip-menu-item"
                disabled={!canUseFiles}
                onClick={() => {
                  setContextMenu(null);
                  openRenderSong({ regionId: region.id, regionName: region.name });
                }}
              >
                {t("transport.menu.renderSong")}
              </button>
              {FEATURE_FLAGS.songAnalysis ? (
                <button
                  type="button"
                  className="lt-compact-clip-menu-item"
                  disabled={!canUseFiles}
                  onClick={() => {
                    setContextMenu(null);
                    openSongAnalysis({ regionId: region.id, regionName: region.name });
                  }}
                >
                  {t("transport.menu.analyzeSong")}
                </button>
              ) : null}
              <div className="lt-compact-clip-menu-divider" aria-hidden="true" />
              <button
                type="button"
                className="lt-compact-clip-menu-item is-destructive"
                onClick={() => {
                  setContextMenu(null);
                  onDelete();
                }}
              >
                {t("compactView.deleteSong")}
              </button>
            </>
          )}
        </div>
      ) : null}
      <NetworkControls permission="edit"><div
        className="lt-compact-song-master"
        {...NO_SONG_REORDER}
        // The master fader sits inside the clickable header. Swallow
        // clicks so dragging or double-clicking the fader doesn't
        // re-fire the header's selection handler.
        onClick={(event) => event.stopPropagation()}
      >
        <SongMasterMeter regionId={region.id} className="lt-compact-song-meter" />
        <input
          className="lt-compact-song-fader lt-fader is-master"
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
      </div></NetworkControls>
    </div>
  );
}

export const CompactSongHeader = memo(CompactSongHeaderComponent);
