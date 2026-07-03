import {
  clamp,
  clientDeltaXToLocalDelta,
  clientXToLocalX,
  getElementScaleX,
} from "../timelineMath";

type NativeZoomView = {
  cameraX: number;
  zoomLevel: number;
};

export type TimelineNavigationScheme = "ableton" | "libretracks";

type InputManagerState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  canZoom: boolean;
  navigationScheme: TimelineNavigationScheme;
};

type InputManagerOptions = {
  container: HTMLElement;
  getState: () => InputManagerState;
  dragThresholdPx: number;
  panCommitDelayMs: number;
  zoomCommitDelayMs: number;
  zoomMultiplier: number;
  trackHeightStep: number;
  trackHeightMin: number;
  trackHeightMax: number;
  onPreviewCameraX: (cameraX: number) => number;
  onCommitCameraX: (cameraX: number) => void;
  onPreviewZoom: (nextZoomLevel: number, anchorViewportX: number) => NativeZoomView | null;
  onCommitZoom: (view: NativeZoomView) => void;
  onTrackHeightChange: (trackHeight: number) => void;
  onScrollVertical?: (deltaY: number) => void;
};

type DragPanState = {
  startClientX: number;
  originCameraX: number;
  hasMoved: boolean;
  latestCameraX: number;
};

type TouchGestureState = {
  originZoom: number;
  startDistance: number;
  lastMidClientX: number;
  lastMidClientY: number;
};

export class InputManager {
  private readonly container: HTMLElement;

  private panCommitTimer: number | null = null;

  private zoomCommitTimer: number | null = null;

  private dragPanState: DragPanState | null = null;

  private touchGesture: TouchGestureState | null = null;

  constructor(private readonly options: InputManagerOptions) {
    this.container = options.container;
    this.container.addEventListener("wheel", this.handleWheel, { passive: false });
    this.container.addEventListener("mousedown", this.handleMouseDown, { passive: false });
    // Touch (Android): two-finger pan + pinch zoom, DAW-tablet convention.
    // One finger stays with the existing pointer interactions (select, drag
    // clips, seek), so the gestures only engage at two touches.
    this.container.addEventListener("touchstart", this.handleTouchStart, { passive: false });
    this.container.addEventListener("touchmove", this.handleTouchMove, { passive: false });
    this.container.addEventListener("touchend", this.handleTouchEnd, { passive: false });
    this.container.addEventListener("touchcancel", this.handleTouchEnd, { passive: false });
  }

  destroy() {
    this.container.removeEventListener("wheel", this.handleWheel);
    this.container.removeEventListener("mousedown", this.handleMouseDown);
    this.container.removeEventListener("touchstart", this.handleTouchStart);
    this.container.removeEventListener("touchmove", this.handleTouchMove);
    this.container.removeEventListener("touchend", this.handleTouchEnd);
    this.container.removeEventListener("touchcancel", this.handleTouchEnd);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);

    if (this.panCommitTimer !== null) {
      window.clearTimeout(this.panCommitTimer);
      this.panCommitTimer = null;
    }

    if (this.zoomCommitTimer !== null) {
      window.clearTimeout(this.zoomCommitTimer);
      this.zoomCommitTimer = null;
    }
  }

  private schedulePanCommit(cameraX: number) {
    if (this.panCommitTimer !== null) {
      window.clearTimeout(this.panCommitTimer);
    }

    this.panCommitTimer = window.setTimeout(() => {
      this.panCommitTimer = null;
      this.options.onCommitCameraX(cameraX);
    }, this.options.panCommitDelayMs);
  }

  private scheduleZoomCommit(view: NativeZoomView) {
    if (this.zoomCommitTimer !== null) {
      window.clearTimeout(this.zoomCommitTimer);
    }

    this.zoomCommitTimer = window.setTimeout(() => {
      this.zoomCommitTimer = null;
      this.options.onCommitZoom(view);
    }, this.options.zoomCommitDelayMs);
  }

  private handleWheel = (event: WheelEvent) => {
    const state = this.options.getState();

    if (state.navigationScheme === "ableton") {
      this.handleWheelAbleton(event, state);
      return;
    }

    this.handleWheelLibreTracks(event, state);
  };

  private handleWheelLibreTracks(event: WheelEvent, state: InputManagerState) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const nextTrackHeight = clamp(
        Math.round(
          state.trackHeight + (event.deltaY < 0 ? this.options.trackHeightStep : -this.options.trackHeightStep),
        ),
        this.options.trackHeightMin,
        this.options.trackHeightMax,
      );
      this.options.onTrackHeightChange(nextTrackHeight);
      return;
    }

    const shouldPanHorizontally = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (shouldPanHorizontally) {
      event.preventDefault();
      const horizontalDelta =
        event.deltaX + (event.shiftKey ? event.deltaY : 0);
      const nextCameraX = this.options.onPreviewCameraX(
        state.cameraX + this.wheelDeltaXToLocalDelta(horizontalDelta),
      );
      this.schedulePanCommit(nextCameraX);
      return;
    }

    if (!state.canZoom) {
      return;
    }

    this.applyZoomFromWheel(event, state);
  }

  private handleWheelAbleton(event: WheelEvent, state: InputManagerState) {
    // Trackpad pinch gestures arrive as wheel events with ctrlKey=true on every
    // major browser/OS. Treat ctrlKey/metaKey + wheel as horizontal zoom.
    if (event.ctrlKey || event.metaKey) {
      if (!state.canZoom) {
        event.preventDefault();
        return;
      }
      this.applyZoomFromWheel(event, state);
      return;
    }

    // Alt + wheel = track height (replaces Ctrl + wheel from the legacy scheme).
    if (event.altKey) {
      event.preventDefault();
      const nextTrackHeight = clamp(
        Math.round(
          state.trackHeight + (event.deltaY < 0 ? this.options.trackHeightStep : -this.options.trackHeightStep),
        ),
        this.options.trackHeightMin,
        this.options.trackHeightMax,
      );
      this.options.onTrackHeightChange(nextTrackHeight);
      return;
    }

    // Horizontal pan: explicit horizontal scroll, or shift + vertical.
    const hasHorizontalIntent =
      event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (hasHorizontalIntent) {
      event.preventDefault();
      const horizontalDelta =
        event.deltaX + (event.shiftKey ? event.deltaY : 0);
      const nextCameraX = this.options.onPreviewCameraX(
        state.cameraX + this.wheelDeltaXToLocalDelta(horizontalDelta),
      );
      this.schedulePanCommit(nextCameraX);
      return;
    }

    // Plain vertical scroll: forward to track list scroller if provided,
    // otherwise let the browser scroll the viewport naturally.
    if (this.options.onScrollVertical) {
      event.preventDefault();
      this.options.onScrollVertical(event.deltaY);
    }
  }

  private applyZoomFromWheel(event: WheelEvent, state: InputManagerState) {
    event.preventDefault();
    const bounds = this.container.getBoundingClientRect();
    const viewportWidth = this.container.offsetWidth || bounds.width;
    const anchorViewportX = clamp(
      clientXToLocalX(event.clientX, bounds, this.container.offsetWidth),
      0,
      viewportWidth,
    );
    const nextZoomLevel = this.computeNextZoomLevel(event, state.zoomLevel);
    const nextView = this.options.onPreviewZoom(nextZoomLevel, anchorViewportX);
    if (!nextView) {
      return;
    }

    this.scheduleZoomCommit(nextView);
  }

  private wheelDeltaXToLocalDelta(deltaX: number) {
    const bounds = this.container.getBoundingClientRect();
    return deltaX / getElementScaleX(bounds, this.container.offsetWidth);
  }

  private computeNextZoomLevel(event: WheelEvent, currentZoomLevel: number) {
    // Trackpad pinch gestures fire many wheel events with very small deltaY
    // values (often 1-10), while a real mouse wheel notch is ~100. Using a
    // fixed per-event multiplier (the legacy behaviour) makes pinch zoom feel
    // explosive. Scale the multiplier exponentially by the normalized deltaY
    // magnitude so that small gestures produce small steps and large notches
    // still feel snappy.
    const lineHeightPx = 16;
    const pageHeightPx = 800;
    const normalizedDelta =
      event.deltaMode === 1
        ? event.deltaY * lineHeightPx
        : event.deltaMode === 2
          ? event.deltaY * pageHeightPx
          : event.deltaY;
    // Cap a single event's contribution so an OS that bursts a huge delta
    // (e.g. macOS momentum scroll) can't snap multiple stops at once.
    const cappedDelta = clamp(normalizedDelta, -200, 200);
    // Map a full mouse notch (~100px) to roughly the legacy 1.2x factor.
    const stepReference = 100;
    const baseStep = Math.log(Math.max(1.01, this.options.zoomMultiplier));
    const factor = Math.exp((-cappedDelta * baseStep) / stepReference);
    return Math.max(0.01, currentZoomLevel * factor);
  }

  private handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      return;
    }

    // Two fingers own the gesture: stop the browser's scroll/zoom AND any
    // in-flight one-finger clip interaction from fighting the camera.
    event.preventDefault();
    const state = this.options.getState();
    const [a, b] = [event.touches[0], event.touches[1]];
    this.touchGesture = {
      originZoom: state.zoomLevel,
      startDistance: Math.max(
        1,
        Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      ),
      lastMidClientX: (a.clientX + b.clientX) / 2,
      lastMidClientY: (a.clientY + b.clientY) / 2,
    };
  };

  private handleTouchMove = (event: TouchEvent) => {
    if (!this.touchGesture || event.touches.length !== 2) {
      return;
    }

    event.preventDefault();
    const state = this.options.getState();
    const bounds = this.container.getBoundingClientRect();
    const [a, b] = [event.touches[0], event.touches[1]];
    const distance = Math.max(
      1,
      Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
    );
    const midClientX = (a.clientX + b.clientX) / 2;
    const midClientY = (a.clientY + b.clientY) / 2;

    // Pinch → horizontal zoom anchored at the finger midpoint. The target
    // zoom derives from the gesture's ORIGIN zoom and the total distance
    // ratio (not incremental steps), so wobbly fingers don't accumulate
    // drift. A small dead zone keeps two-finger pans from micro-zooming.
    let cameraAfterZoom = state.cameraX;
    const scale = distance / this.touchGesture.startDistance;
    if (state.canZoom && Math.abs(scale - 1) > 0.02) {
      const anchorViewportX = clamp(
        clientXToLocalX(midClientX, bounds, this.container.offsetWidth),
        0,
        this.container.offsetWidth || bounds.width,
      );
      const nextZoomLevel = Math.max(0.01, this.touchGesture.originZoom * scale);
      const view = this.options.onPreviewZoom(nextZoomLevel, anchorViewportX);
      if (view) {
        cameraAfterZoom = view.cameraX;
        this.scheduleZoomCommit(view);
      }
    }

    // Two-finger drag → pan. Horizontal moves the camera; vertical scrolls
    // the track list (when the host wired a vertical scroller).
    const dragDeltaX = clientDeltaXToLocalDelta(
      this.touchGesture.lastMidClientX - midClientX,
      bounds,
      this.container.offsetWidth,
    );
    const nextCameraX = this.options.onPreviewCameraX(cameraAfterZoom + dragDeltaX);
    this.schedulePanCommit(nextCameraX);

    const dragDeltaY = this.touchGesture.lastMidClientY - midClientY;
    if (this.options.onScrollVertical && Math.abs(dragDeltaY) > 0.5) {
      this.options.onScrollVertical(dragDeltaY);
    }

    this.touchGesture.lastMidClientX = midClientX;
    this.touchGesture.lastMidClientY = midClientY;
  };

  private handleTouchEnd = (event: TouchEvent) => {
    if (this.touchGesture && event.touches.length < 2) {
      // Commits are already debounced by the pan/zoom schedulers.
      this.touchGesture = null;
    }
  };

  private handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    const state = this.options.getState();
    this.dragPanState = {
      startClientX: event.clientX,
      originCameraX: state.cameraX,
      hasMoved: false,
      latestCameraX: state.cameraX,
    };

    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.dragPanState) {
      return;
    }

    const bounds = this.container.getBoundingClientRect();
    const deltaX = clientDeltaXToLocalDelta(
      this.dragPanState.startClientX - event.clientX,
      bounds,
      this.container.offsetWidth,
    );
    const exceededThreshold = Math.abs(deltaX) > this.options.dragThresholdPx;
    if (!this.dragPanState.hasMoved && !exceededThreshold) {
      return;
    }

    this.dragPanState.hasMoved = true;
    this.dragPanState.latestCameraX = this.options.onPreviewCameraX(
      this.dragPanState.originCameraX + deltaX,
    );
    this.schedulePanCommit(this.dragPanState.latestCameraX);
  };

  private handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 1) {
      return;
    }

    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);

    if (this.dragPanState?.hasMoved) {
      this.schedulePanCommit(this.dragPanState.latestCameraX);
    }

    this.dragPanState = null;
  };
}
