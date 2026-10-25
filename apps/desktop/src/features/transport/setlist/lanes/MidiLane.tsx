import {
  memo,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { MidiClipSummary, MidiEventKindSummary } from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../../constants";
import { useTimelineUIStore } from "../../uiStore";
import { resolvePointDrag } from "./automationLaneModel";
import type { SongLaneRenderProps, SongLaneType } from "./laneTypes";
import { LANE_PREVIEW_FALLBACK_MS } from "./useClipGestures";

export const MIDI_LANE_HEIGHT = 56;

/** One message, short: «PC 12», «CC 64=127», «C4», «CC 7 0→127». */
export function midiEventLabel(kind: MidiEventKindSummary): string {
  switch (kind.type) {
    case "programChange":
      return `PC ${kind.program}`;
    case "controlChange":
      return `CC ${kind.controller}=${kind.value}`;
    case "controlCurve":
      return `CC ${kind.controller} ${kind.fromValue}→${kind.toValue}`;
    case "note": {
      const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      return `${names[kind.note % 12]}${Math.floor(kind.note / 12) - 1}`;
    }
  }
}

/** What a clip sends, in order, as one line (the first three and a count). */
export function midiClipSummary(clip: Pick<MidiClipSummary, "events">): string {
  const events = [...clip.events].sort((left, right) => left.atSeconds - right.atSeconds);
  const shown = events.slice(0, 3).map((event) => midiEventLabel(event.kind));
  return events.length > 3 ? `${shown.join(" · ")} +${events.length - 3}` : shown.join(" · ");
}

const clearMidiPreviews = (root: ParentNode | null) => {
  root?.querySelectorAll<HTMLElement>("[data-lane-midi-clip-id]").forEach((element) => {
    element.style.removeProperty("transform");
  });
  root?.querySelectorAll<HTMLElement>(".lt-setlist-lane.is-drop-target").forEach((row) => {
    row.classList.remove("is-drop-target");
  });
};

/**
 * A MIDI track in Edit → Lanes (step 12's twin for MIDI): each clip of the
 * song is a block at its time with what it sends. Every action is the DAW's:
 * click edits (MidiClipModal), drag moves with one `moveMidiClip` on release
 * (onto another MIDI track too), the menu is the clip menu, double click on
 * the lane creates a clip there. During a drag only the DOM moves; Esc puts
 * it back.
 */
function MidiLaneComponent({ track, song, region, scale, menus }: SongLaneRenderProps) {
  const { t } = useTranslation();
  const laneRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const clips = (song.midiClips ?? [])
    .filter(
      (clip) =>
        clip.trackId === track.id &&
        clip.timelineStartSeconds >= region.startSeconds &&
        clip.timelineStartSeconds < region.endSeconds,
    )
    .sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
  useLayoutEffect(() => clearMidiPreviews(laneRef.current?.closest(".lt-setlist-lanes") ?? null), [song.midiClips]);

  const startGesture = (event: ReactPointerEvent<HTMLElement>, clip: MidiClipSummary) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const element = event.currentTarget;
    const root = element.closest(".lt-setlist-lanes");
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let moved = false;
    let target = clip.timelineStartSeconds;
    let targetTrackId: string | null = null;

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const cancel = () => {
      detach();
      clearMidiPreviews(root);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      target = resolvePointDrag({
        song,
        region,
        originSeconds: clip.timelineStartSeconds,
        rawDeltaSeconds: scale.pxPerSecond > 0 ? dx / scale.pxPerSecond : 0,
        pxPerSecond: scale.pxPerSecond,
        snapEnabled: useTimelineUIStore.getState().snapEnabled,
      });
      element.style.setProperty(
        "transform",
        `translate3d(${(target - clip.timelineStartSeconds) * scale.pxPerSecond}px, 0, 0)`,
      );
      // Another MIDI lane under the pointer takes the clip.
      root?.querySelectorAll(".lt-setlist-lane.is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
      targetTrackId = null;
      const under = document.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
      const row = under?.closest<HTMLElement>(".lt-setlist-lane[data-lane-track-id]");
      const id = row?.dataset.laneTrackId ?? null;
      if (row && id && id !== clip.trackId && row.dataset.laneKind === "midi") {
        targetTrackId = id;
        row.classList.add("is-drop-target");
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      detach();
      if (!moved) {
        menus.editMidiClip(clip);
        return;
      }
      if (Math.abs(target - clip.timelineStartSeconds) < 1e-6 && !targetTrackId) {
        clearMidiPreviews(root);
        return;
      }
      menus.moveMidiClip(clip.id, target, targetTrackId);
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = window.setTimeout(() => clearMidiPreviews(root), LANE_PREVIEW_FALLBACK_MS);
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

  const secondsAtClientX = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const zoomFactor = rect.width > 0 ? element.offsetWidth / rect.width : 1;
    return scale.clampSeconds(scale.pxToSeconds((clientX - rect.left) * (zoomFactor || 1)));
  };

  return (
    <div
      ref={laneRef}
      className={`lt-setlist-lane is-midi${track.midiEnabled === false ? " is-disabled" : ""}`}
      data-lane-track-id={track.id}
      data-lane-kind="midi"
      aria-label={t("setlistView.midi.laneAria", { name: track.name })}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        menus.createMidiClipAt(track.id, secondsAtClientX(event.currentTarget, event.clientX));
      }}
      onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        menus.openMenu(
          event,
          track.name,
          menus.midiLaneContextMenu(track.id, secondsAtClientX(event.currentTarget, event.clientX)),
        );
      }}
    >
      {clips.map((clip) => {
        const x = scale.secondsToPx(clip.timelineStartSeconds);
        if (x < -200 || x > scale.widthPx + 40) return null;
        const summary = midiClipSummary(clip);
        return (
          <button
            key={clip.id}
            type="button"
            className="lt-setlist-midi-clip"
            data-lane-midi-clip-id={clip.id}
            style={{ left: `${x}px`, ...(clip.color ? { "--lt-midi-clip-color": clip.color } : {}) } as CSSProperties}
            aria-label={`${clip.name || "MIDI"}: ${summary}`}
            title={`${clip.name || "MIDI"}\n${summary}`}
            onPointerDown={(event) => startGesture(event, clip)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                menus.editMidiClip(clip);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              menus.openMidiClipMenu(event, clip);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span className="lt-setlist-midi-clip-name">{clip.name || "MIDI"}</span>
            <span className="lt-setlist-midi-clip-events">{summary}</span>
          </button>
        );
      })}
    </div>
  );
}

export const MidiLane = memo(MidiLaneComponent);

/** The MIDI track's header: on/off (its mute), routing and Settings. */
function MidiLaneHeaderComponent({ track, menus }: SongLaneRenderProps) {
  const { t } = useTranslation();
  const enabled = track.midiEnabled !== false;
  const route = `${track.midiPort ?? t("setlistView.midi.defaultPort")} · ${t("setlistView.midi.channel", {
    channel: track.midiChannel ?? 1,
  })}`;
  return (
    <>
      <button
        type="button"
        className={`lt-setlist-lane-toggle is-power${enabled ? " is-active" : ""}`}
        aria-pressed={enabled}
        aria-label={t(enabled ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
        title={t(enabled ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
        onClick={() => menus.toggleMidiTrackEnabled(track.id)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">power_settings_new</span>
      </button>
      <span className="lt-setlist-lane-name-block">
        <strong className="lt-setlist-lane-name">{track.name}</strong>
        <button
          type="button"
          className="lt-setlist-midi-route"
          aria-label={t("setlistView.midi.routeAria", { name: track.name, route })}
          title={t("transport.midi.routeModalTitle")}
          onClick={() => menus.openMidiRouteEditor(track.id)}
        >
          {route}
        </button>
      </span>
      <button
        type="button"
        className="lt-setlist-lane-toggle"
        aria-label={t("setlistView.midi.settings")}
        title={t("setlistView.midi.settings")}
        onClick={menus.openMidiSettings}
      >
        <span className="material-symbols-outlined" aria-hidden="true">settings</span>
      </button>
    </>
  );
}

export const MidiLaneHeader = memo(MidiLaneHeaderComponent);

export const midiLaneType: SongLaneType = {
  kind: "midi",
  rowHeight: MIDI_LANE_HEIGHT,
  accepts: (track) => track.kind === "midi",
  showEmpty: true,
  render: (props) => <MidiLane {...props} />,
  renderHeader: (props) => <MidiLaneHeader {...props} />,
};
