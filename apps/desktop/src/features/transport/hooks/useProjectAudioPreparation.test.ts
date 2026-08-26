import { describe, expect, it } from "vitest";
import type { ProjectLoadProgressEvent } from "@libretracks/shared/models";
import { projectAudioPreparationStateFromEvent } from "../projectAudioPreparation";

function progress(
  overrides: Partial<ProjectLoadProgressEvent> = {},
): ProjectLoadProgressEvent {
  return {
    percent: 18,
    message: "Preparando audio...",
    sourcesReady: 0,
    sourcesTotal: 39,
    ramCacheMb: 0,
    diskCacheMb: 0,
    ...overrides,
  };
}

describe("projectAudioPreparationStateFromEvent", () => {
  it("remains active after every source is decoded while first-play work continues", () => {
    const state = projectAudioPreparationStateFromEvent(
      progress({ percent: 92, sourcesReady: 39 }),
    );

    expect(state.active).toBe(true);
    expect(state.readyCount).toBe(39);
    expect(state.percent).toBe(92);
  });

  it("only dismisses on the backend's terminal ready event", () => {
    expect(
      projectAudioPreparationStateFromEvent(
        progress({ percent: 99, sourcesReady: 39 }),
      ).active,
    ).toBe(true);
    expect(
      projectAudioPreparationStateFromEvent(
        progress({ percent: 100, sourcesReady: 39 }),
      ).active,
    ).toBe(false);
  });

  it("clamps malformed progress values", () => {
    expect(
      projectAudioPreparationStateFromEvent(progress({ percent: -5 })).percent,
    ).toBe(0);
    expect(
      projectAudioPreparationStateFromEvent(progress({ percent: 140 })).percent,
    ).toBe(100);
  });
});
