import type { ClipFades } from "./clipFadeMath";

/**
 * The fade a handle is being dragged to, painted instead of the stored one.
 *
 * Module state, not React state, like the video drag preview: the timeline
 * repaints from refs (docs/REDESIGN_transport_refs_to_stores.md) and dragging
 * a fade must not re-render the transport panel. Writers flag a repaint and
 * the canvas's work hook consumes it (`consumeClipFadeRepaint`).
 */
type Preview = ClipFades & {
  /** Set once the drag is committed: the preview then stays until the song
   * brings the same values back, so the fade doesn't jump to its old length
   * for the round trip. */
  committedAt: number | null;
};

/** A committed preview older than this is dropped even if the song never
 * matched it (a rejected command, a clamp on the backend). */
const COMMITTED_PREVIEW_TTL_MS = 3000;

const previews = new Map<string, Preview>();
let repaintRequested = false;

export function requestClipFadeRepaint() {
  repaintRequested = true;
}

/** True once per requested repaint. Wired into the renderer's work hook. */
export function consumeClipFadeRepaint(): boolean {
  const requested = repaintRequested;
  repaintRequested = false;
  return requested;
}

export function setClipFadePreview(clipId: string, fades: ClipFades | null) {
  if (fades) {
    previews.set(clipId, { ...fades, committedAt: null });
  } else {
    previews.delete(clipId);
  }
  requestClipFadeRepaint();
}

export function markClipFadePreviewCommitted(clipId: string, now = Date.now()) {
  const preview = previews.get(clipId);
  if (preview) preview.committedAt = now;
}

/**
 * The fades to paint for a clip: the drag preview when there is one, else
 * `stored`. A committed preview retires itself once `stored` catches up.
 */
export function resolveClipFades(clipId: string, stored: ClipFades, now = Date.now()): ClipFades {
  const preview = previews.get(clipId);
  if (!preview) return stored;
  if (preview.committedAt !== null) {
    const caughtUp =
      Math.abs(preview.fadeInSeconds - stored.fadeInSeconds) < 1e-3 &&
      Math.abs(preview.fadeOutSeconds - stored.fadeOutSeconds) < 1e-3 &&
      Math.abs(preview.fadeInCurve.x - stored.fadeInCurve.x) < 1e-3 &&
      Math.abs(preview.fadeInCurve.y - stored.fadeInCurve.y) < 1e-3 &&
      Math.abs(preview.fadeOutCurve.x - stored.fadeOutCurve.x) < 1e-3 &&
      Math.abs(preview.fadeOutCurve.y - stored.fadeOutCurve.y) < 1e-3;
    if (caughtUp || now - preview.committedAt > COMMITTED_PREVIEW_TTL_MS) {
      previews.delete(clipId);
      return stored;
    }
  }
  const { committedAt: _committedAt, ...fades } = preview;
  return fades;
}

/** Test hook. */
export function resetClipFadeCanvasState() {
  previews.clear();
  repaintRequested = false;
}
