import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "@libretracks/shared/models";

import {
  resetTestDesktopApiMock,
  rhythmTriggerCallsForTest,
  testDesktopApiMock,
} from "../../../app/testDesktopApiMock";
import { createRhythmHandlers } from "./rhythmHandlers";

function setup(overrides: Partial<AppSettings> = {}) {
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...overrides };
  const applied: AppSettings[] = [];
  const api = {
    ...testDesktopApiMock,
    setLoopConfig: vi.fn(testDesktopApiMock.setLoopConfig),
    setActivePattern: vi.fn(testDesktopApiMock.setActivePattern),
    setOneShotBank: vi.fn(testDesktopApiMock.setOneShotBank),
    setOneShotConfig: vi.fn(testDesktopApiMock.setOneShotConfig),
  };
  let clock = 0;
  const handlers = createRhythmHandlers({
    api,
    getSettings: () => settings,
    applySettings: (next) => {
      settings = next;
      applied.push(next);
    },
    now: () => clock,
  });
  return { handlers, api, applied, getSettings: () => settings, advance: (ms: number) => (clock += ms) };
}

describe("rhythm handlers", () => {
  beforeEach(() => resetTestDesktopApiMock());

  it("live actions go through the fast-path commands", async () => {
    const { handlers } = setup();
    await handlers.toggleLoop();
    await handlers.toggleRow(2);
    await handlers.setRowVariation(1, 3);
    await handlers.setAllRows(2);
    await handlers.stopAllPads();
    expect(rhythmTriggerCallsForTest).toEqual([
      { command: "loop_toggle", args: {} },
      { command: "loop_toggle_row", args: { row: 2 } },
      { command: "loop_set_row", args: { row: 1, variation: 3 } },
      { command: "loop_set_all_rows", args: { variation: 2 } },
      { command: "one_shots_stop_all", args: {} },
    ]);
  });

  it("pad down and up of the same pad stay in order", async () => {
    const { handlers } = setup();
    handlers.padDown(4, 100);
    handlers.padDown(7);
    await handlers.padUp(4);
    await handlers.padUp(7);
    const pad4 = rhythmTriggerCallsForTest.filter((c) => c.args.pad === 4).map((c) => c.command);
    expect(pad4).toEqual(["one_shot_down", "one_shot_up"]);
    expect(rhythmTriggerCallsForTest.find((c) => c.args.pad === 4)?.args.velocity).toBe(100);
  });

  it("pattern, bank and config update and apply the settings", async () => {
    const { handlers, api, getSettings } = setup();
    await handlers.selectPattern("pop");
    expect(api.setActivePattern).toHaveBeenCalledWith("pop");
    expect(getSettings().activeLoopPatternId).toBe("pop");
    await handlers.selectBank(9);
    expect(api.setOneShotBank).toHaveBeenCalledWith(3);
    await handlers.setClockMode("free");
    expect(api.setLoopConfig).toHaveBeenLastCalledWith(expect.objectContaining({ clockMode: "free", quantize: "bar" }));
    await handlers.setQuantize("beat");
    expect(getSettings().loopQuantize).toBe("beat");
    expect(getSettings().loopClockMode).toBe("free");
    await handlers.setLoopVolume(0.5);
    expect(getSettings().loopVolume).toBe(0.5);
    await handlers.setOneShotVolume(0.7);
    expect(api.setOneShotConfig).toHaveBeenCalledWith("master", 0.7);
  });

  it("tap sets the free BPM only in free mode", async () => {
    const follow = setup({ loopClockMode: "follow" });
    expect(follow.handlers.tap()).toBeNull();
    expect(follow.api.setLoopConfig).not.toHaveBeenCalled();

    const free = setup({ loopClockMode: "free" });
    expect(free.handlers.tap()).toBeNull();  // hace falta un segundo toque
    free.advance(500);
    expect(free.handlers.tap()).toBe(120);
    await vi.waitFor(() =>
      expect(free.api.setLoopConfig).toHaveBeenCalledWith(expect.objectContaining({ freeBpm: 120 })),
    );
  });

  it("a burst of volume changes applies only the last answer, in order", async () => {
    const { handlers, api, applied } = setup();
    const resolvers: Array<() => void> = [];
    api.setLoopConfig.mockImplementation(
      (config) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ ...DEFAULT_APP_SETTINGS, loopVolume: config.volume }));
        }),
    );
    const done = [0.2, 0.4, 0.6].map((v) => handlers.setLoopVolume(v));
    // En serie: la segunda no sale hasta que vuelve la primera.
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]();
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]();
    await Promise.all(done);
    expect(applied.map((s) => s.loopVolume)).toEqual([0.6]);
  });

  it("screen buttons ask for an explicit start or stop", async () => {
    const { handlers } = setup();
    await handlers.setLoopPlaying(true);
    await handlers.setLoopPlaying(false);
    expect(rhythmTriggerCallsForTest).toEqual([
      { command: "set_loop_playing", args: { playing: true } },
      { command: "set_loop_playing", args: { playing: false } },
    ]);
  });
});
