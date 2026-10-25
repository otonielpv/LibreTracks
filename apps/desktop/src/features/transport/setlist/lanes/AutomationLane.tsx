import {
  memo,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { AutomationCueSummary, SongRegionSummary, SongView } from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../../constants";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { describeAutomationCue } from "../../timeline/describeAutomationCue";
import { useTimelineUIStore } from "../../uiStore";
import type { SongTimeScale } from "../songTimeScale";
import { resolvePointDrag, songAutomationCues } from "./automationLaneModel";
import { LANE_PREVIEW_FALLBACK_MS } from "./useClipGestures";

/** Row height of the automation lane, in px. */
export const AUTOMATION_LANE_HEIGHT = 56;

type AutomationLaneMenus = Pick<
  TimelineMenus,
  | "openMenu"
  | "createAutomationCueAt"
  | "editAutomationCue"
  | "automationCueContextMenu"
  | "automationTrackContextMenu"
  | "moveAutomationCue"
  | "setAutomationTrackOn"
>;

type AutomationLaneProps = {
  song: SongView;
  region: SongRegionSummary;
  scale: SongTimeScale;
  menus: AutomationLaneMenus;
  positionSecondsRef: { readonly current: number };
};

const clearCuePreviews = (root: ParentNode | null) =>
  root?.querySelectorAll<HTMLElement>("[data-lane-cue-id]").forEach((element) => {
    element.style.removeProperty("transform");
  });

/**
 * The automation lane of Edit → Lanes (step 12): each cue of the song is a
 * diamond at its time, with its name. The lane is the DAW's synthetic
 * automation track, so every action is the DAW's: click edits (the cue
 * modal), drag moves on the grid with one upsert on release, the menus are
 * the DAW's cue and lane menus, double click on the lane creates a cue there.
 * During a drag only the DOM moves; Esc puts the cue back.
 */
function AutomationLaneComponent({ song, region, scale, menus, positionSecondsRef }: AutomationLaneProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const cues = songAutomationCues(song, region);
  const enabled = song.automationTrack?.enabled !== false;
  // A new snapshot puts every cue where the model says.
  useLayoutEffect(() => clearCuePreviews(rowRef.current), [song.automationCues]);

  const secondsAtClientX = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const zoomFactor = rect.width > 0 ? element.offsetWidth / rect.width : 1;
    return scale.clampSeconds(scale.pxToSeconds((clientX - rect.left) * (zoomFactor || 1)));
  };

  const openTrackMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    menus.openMenu(event, t("transport.automation.menuTitle"), menus.automationTrackContextMenu());
  };

  const openCueMenu = (event: ReactMouseEvent<HTMLElement>, cue: AutomationCueSummary) => {
    event.preventDefault();
    event.stopPropagation();
    menus.openMenu(event, cue.name, menus.automationCueContextMenu(cue));
  };

  const startCueGesture = (event: ReactPointerEvent<HTMLElement>, cue: AutomationCueSummary) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let moved = false;
    let target = cue.atSeconds;

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const cancel = () => {
      detach();
      element.style.removeProperty("transform");
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      target = resolvePointDrag({
        song,
        region,
        originSeconds: cue.atSeconds,
        rawDeltaSeconds: scale.pxPerSecond > 0 ? dx / scale.pxPerSecond : 0,
        pxPerSecond: scale.pxPerSecond,
        snapEnabled: useTimelineUIStore.getState().snapEnabled,
      });
      element.style.setProperty(
        "transform",
        `translate3d(${(target - cue.atSeconds) * scale.pxPerSecond}px, 0, 0)`,
      );
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      detach();
      if (!moved) {
        menus.editAutomationCue(cue);
        return;
      }
      if (Math.abs(target - cue.atSeconds) < 1e-6) {
        element.style.removeProperty("transform");
        return;
      }
      void menus.moveAutomationCue(cue.id, target);
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = window.setTimeout(
        () => element.style.removeProperty("transform"),
        LANE_PREVIEW_FALLBACK_MS,
      );
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) cancel();
    };
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const trackName = t("transport.automation.trackName");
  return (
    <div
      ref={rowRef}
      className={`lt-setlist-lane-row is-automation${enabled ? "" : " is-disabled"}`}
      style={{ height: `${AUTOMATION_LANE_HEIGHT}px` } as CSSProperties}
      data-lane-kind="automation"
    >
      <div className="lt-setlist-lane-header" title={trackName} onContextMenu={openTrackMenu}>
        <button
          type="button"
          className={`lt-setlist-lane-toggle is-power${enabled ? " is-active" : ""}`}
          aria-pressed={enabled}
          aria-label={t(enabled ? "transport.automation.disableTrack" : "transport.automation.enableTrack")}
          title={t(enabled ? "transport.automation.disableTrack" : "transport.automation.enableTrack")}
          onClick={() => void menus.setAutomationTrackOn(!enabled)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">power_settings_new</span>
        </button>
        <strong className="lt-setlist-lane-name">{trackName}</strong>
        <button
          type="button"
          className="lt-setlist-lane-toggle"
          aria-label={t("setlistView.automation.addAtPlayhead")}
          title={t("setlistView.automation.addAtPlayhead")}
          onClick={() => menus.createAutomationCueAt(scale.clampSeconds(positionSecondsRef.current))}
        >
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
        </button>
      </div>
      <div
        className="lt-setlist-lane-cell lt-setlist-automation-cell"
        aria-label={t("transport.automation.laneAria")}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget) return;
          menus.createAutomationCueAt(secondsAtClientX(event.currentTarget, event.clientX));
        }}
        onContextMenu={openTrackMenu}
      >
        {cues.map((cue) => {
          const x = scale.secondsToPx(cue.atSeconds);
          if (x < -40 || x > scale.widthPx + 40) return null;
          const description = describeAutomationCue(cue, song, t);
          return (
            <button
              key={cue.id}
              type="button"
              className={`lt-setlist-cue${cue.enabled && !cue.exhausted ? "" : " is-off"}`}
              data-lane-cue-id={cue.id}
              style={{ left: `${x}px` }}
              aria-label={`${cue.name}: ${description}`}
              title={`${cue.name}\n${description}`}
              onPointerDown={(event) => startCueGesture(event, cue)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  menus.editAutomationCue(cue);
                }
              }}
              onContextMenu={(event) => openCueMenu(event, cue)}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <span className="lt-setlist-cue-diamond" aria-hidden="true" />
              <span className="lt-setlist-cue-label">{cue.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const AutomationLane = memo(AutomationLaneComponent);
