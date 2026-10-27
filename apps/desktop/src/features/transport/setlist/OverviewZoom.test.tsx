import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { OverviewZoom } from "./OverviewZoom";

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
});

describe("OverviewZoom touch gestures", () => {
  it("pinches to zoom when the first finger lands on a section handle", async () => {
    const { container } = render(
      <OverviewZoom
        startSeconds={0}
        endSeconds={60}
        positionSecondsRef={{ current: 0 }}
      >
        <button type="button" className="lt-setlist-section-handle" />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    const handle = container.querySelector<HTMLButtonElement>(".lt-setlist-section-handle")!;

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
    });
    fireEvent.pointerDown(viewport, {
      button: 0,
      pointerId: 2,
      pointerType: "touch",
      clientX: 200,
    });
    fireEvent.pointerMove(window, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 250,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
    });
    fireEvent.pointerUp(window, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 250,
    });

    await waitFor(() => {
      expect(useSetlistStore.getState().overviewZoom).toBe(1.5);
    });
  });
});
