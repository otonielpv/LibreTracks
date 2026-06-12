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

export class InputManager {
  private readonly container: HTMLElement;

  private panCommitTimer: number | null = null;

  private zoomCommitTimer: number | null = null;

  private dragPanState: DragPanState | null = null;

  constructor(private readonly options: InputManagerOptions) {
    this.container = options.container;
    this.container.addEventListener("wheel", this.handleWheel, { passive: false });
    this.container.addEventListener("mousedown", this.handleMouseDown, { passive: false });
  }

  destroy() {
    this.container.removeEventListener("wheel", this.handleWheel);
    this.container.removeEventListener("mousedown", this.handleMouseDown);
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
