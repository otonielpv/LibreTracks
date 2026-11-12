import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordProductEvent } from "./telemetry";
import { startViewUsageTracking } from "./viewUsageTelemetry";

vi.mock("./telemetry", () => ({ recordProductEvent: vi.fn() }));

function press(element: Element) {
  // jsdom has no PointerEvent; a plain Event with the right type is enough.
  element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

describe("startViewUsageTracking", () => {
  let stop: () => void;

  beforeEach(() => {
    vi.mocked(recordProductEvent).mockClear();
    document.body.innerHTML = `
      <div id="toolbar"><button id="play">Play</button></div>
      <main data-lt-view="setlist">
        <div data-lt-view-usage-ignore=""><button id="switcher">View</button></div>
        <button id="song">Song</button>
      </main>
      <div data-lt-view="daw"><span id="clip">Clip</span></div>
    `;
    stop = startViewUsageTracking();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  it("does not record anything until the user interacts inside a view", () => {
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it("records the view the interaction happened in", () => {
    press(document.getElementById("song")!);
    expect(recordProductEvent).toHaveBeenCalledWith("feature_setlist_view");

    press(document.getElementById("clip")!);
    expect(recordProductEvent).toHaveBeenLastCalledWith("feature_daw_view");
  });

  it("ignores shared chrome and the view switcher", () => {
    press(document.getElementById("play")!);
    press(document.getElementById("switcher")!);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it("stops listening when disposed", () => {
    stop();
    press(document.getElementById("song")!);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });
});
