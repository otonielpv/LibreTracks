import { clamp, getZoomLevelDelta } from "../timelineMath";

type NativeZoomView = {
  cameraX: number;
  zoomLevel: number;
};

type InputManagerState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  canZoom: boolean;
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
      const nextCameraX = this.options.onPreviewCameraX(
        state.cameraX + event.deltaX + (event.shiftKey ? event.deltaY : 0),
      );
      this.schedulePanCommit(nextCameraX);
      return;
    }

    if (!state.canZoom) {
      return;
    }

    event.preventDefault();
    const bounds = this.container.getBoundingClientRect();
    const anchorViewportX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const nextZoomLevel = getZoomLevelDelta(
      state.zoomLevel,
      event.deltaY < 0 ? "in" : "out",
      this.options.zoomMultiplier,
    );
    const nextView = this.options.onPreviewZoom(nextZoomLevel, anchorViewportX);
    if (!nextView) {
      return;
    }

    this.scheduleZoomCommit(nextView);
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

    const deltaX = this.dragPanState.startClientX - event.clientX;
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