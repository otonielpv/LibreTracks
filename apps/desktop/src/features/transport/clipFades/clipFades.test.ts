import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipSummary, TransportSnapshot } from "@libretracks/shared/models";

import {
  applyClipCurveDrag,
  applyClipFadeDrag,
  clampClipFades,
  fadeCurveGain,
  sharedFade,
} from "./clipFadeMath";
import {
  consumeClipFadeRepaint,
  markClipFadePreviewCommitted,
  resetClipFadeCanvasState,
  resolveClipFades,
  setClipFadePreview,
} from "./clipFadeCanvasState";
import { clipFadeMenuActions } from "./clipFadeMenu";
import { createClipFadeDrag, hitClipFadeHandle, TOUCH_HIT_SLOP } from "./clipFadeDrag";
import { createTouchClipSelection } from "../mobile/touchClipSelection";

function clip(overrides: Partial<ClipSummary> = {}): ClipSummary {
  return {
    id: "c1",
    trackId: "t1",
    trackName: "Bass",
    filePath: "audio/bass.wav",
    waveformKey: "bass",
    isMissing: false,
    timelineStartSeconds: 10,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 8,
    sourceDurationSeconds: 60,
    durationSeconds: 8,
    gain: 1,
    ...overrides,
  };
}

const snapshot = { projectRevision: 7 } as TransportSnapshot;

const LINEAR = { x: 0.5, y: 0.5 };
/** Fades with straight curves, the default. */
const f = (
  fadeInSeconds: number,
  fadeOutSeconds: number,
  fadeInCurve: { x: number; y: number } = LINEAR,
  fadeOutCurve: { x: number; y: number } = LINEAR,
) => ({
  fadeInSeconds,
  fadeOutSeconds,
  fadeInCurve,
  fadeOutCurve,
});

beforeEach(() => resetClipFadeCanvasState());

describe("clipFadeMath", () => {
  it("clamps the fade out to what the fade in leaves", () => {
    expect(clampClipFades(f(5, 5, { x: 0.2, y: 0.8 }), 8)).toEqual(f(5, 3, { x: 0.2, y: 0.8 }));
  });

  it("drags the fade in right and pushes the fade out back instead of crossing it", () => {
    const base = f(1, 4);
    expect(applyClipFadeDrag(clip(), base, "in", 2)).toEqual(f(3, 4));
    expect(applyClipFadeDrag(clip(), base, "in", 6)).toEqual(f(7, 1));
    expect(applyClipFadeDrag(clip(), base, "in", -5).fadeInSeconds).toBe(0);
  });

  it("drags the fade out leftwards to make it longer", () => {
    const base = f(0, 1);
    expect(applyClipFadeDrag(clip(), base, "out", -2).fadeOutSeconds).toBe(3);
    expect(applyClipFadeDrag(clip(), base, "out", 3).fadeOutSeconds).toBe(0);
  });

  it("converts view seconds to source seconds on a stretched clip", () => {
    // Drawn twice as long as its source: 2 view seconds are 1 source second.
    const stretched = clip({ durationSeconds: 16 });
    expect(
      applyClipFadeDrag(stretched, f(0, 0), "in", 2).fadeInSeconds,
    ).toBe(1);
  });

  it("reports the shared value or null when the clips differ", () => {
    expect(sharedFade([clip({ fadeInSeconds: 2 }), clip({ fadeInSeconds: 2 })], "in")).toBe(2);
    expect(sharedFade([clip({ fadeInSeconds: 2 }), clip()], "in")).toBeNull();
  });
});

describe("fade curves", () => {
  it("matches the engine's curve: a Bezier through the control point", () => {
    expect(fadeCurveGain(0.25, LINEAR)).toBe(0.25);
    // Control point on the diagonal: still a straight line.
    expect(fadeCurveGain(0.3, { x: 0.2, y: 0.2 })).toBeCloseTo(0.3, 3);
    expect(fadeCurveGain(0.5, { x: 0, y: 1 })).toBeGreaterThan(0.7);
    expect(fadeCurveGain(0.5, { x: 1, y: 0 })).toBeLessThan(0.3);
    // Same height, leaning early vs late: x changes the shape too.
    expect(fadeCurveGain(0.25, { x: 0.1, y: 0.8 })).toBeGreaterThan(
      fadeCurveGain(0.25, { x: 0.6, y: 0.8 }),
    );
    for (const curve of [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0.3, y: 0.6 }]) {
      expect(fadeCurveGain(0, curve)).toBeCloseTo(0, 6);
      expect(fadeCurveGain(1, curve)).toBeCloseTo(1, 6);
    }
  });

  it("moves the control point twice the handle's drag, clamped, snapping to straight", () => {
    expect(applyClipCurveDrag(LINEAR, 0.1, 0.2)).toEqual({ x: 0.7, y: 0.9 });
    expect(applyClipCurveDrag(LINEAR, -1, 1)).toEqual({ x: 0, y: 1 });
    expect(applyClipCurveDrag({ x: 0.7, y: 0.9 }, -0.095, -0.2)).toEqual(LINEAR);
  });
});

describe("clipFadeCanvasState", () => {
  it("paints the preview and asks for a repaint", () => {
    setClipFadePreview("c1", f(2, 0));
    expect(consumeClipFadeRepaint()).toBe(true);
    expect(consumeClipFadeRepaint()).toBe(false);
    expect(resolveClipFades("c1", f(0, 0)).fadeInSeconds).toBe(2);
  });

  it("keeps a committed preview until the song catches up", () => {
    setClipFadePreview("c1", f(2, 0));
    markClipFadePreviewCommitted("c1", 1000);
    const stale = f(0, 0);
    expect(resolveClipFades("c1", stale, 1500).fadeInSeconds).toBe(2);
    expect(resolveClipFades("c1", f(2, 0), 1600).fadeInSeconds).toBe(2);
    // Retired: the stored value is used from now on.
    expect(resolveClipFades("c1", stale, 1700).fadeInSeconds).toBe(0);
  });

  it("drops a committed preview the song never matched", () => {
    setClipFadePreview("c1", f(2, 0));
    markClipFadePreviewCommitted("c1", 1000);
    expect(resolveClipFades("c1", f(0, 0), 5000).fadeInSeconds).toBe(0);
  });
});

describe("clipFadeMenuActions", () => {
  function setup(clips: ClipSummary[], answer: string | null) {
    const updateFades = vi.fn(async () => snapshot);
    const deps = {
      t: (key: string, options?: Record<string, unknown>) =>
        options && "seconds" in options ? `${key}:${options.seconds}` : key,
      runAction: async (action: () => Promise<void>) => action(),
      applyPlaybackSnapshot: vi.fn(),
      setStatus: vi.fn(),
      prompt: vi.fn(async () => answer),
      updateFades,
    };
    return { actions: clipFadeMenuActions(clips, deps), deps, updateFades };
  }

  it("shows the current values and sets the fade in alone", async () => {
    const { actions, deps, updateFades } = setup([clip({ fadeInSeconds: 1.5 })], "2,5");
    expect(actions[0].label).toBe("transport.menu.clipFadeIn:1.5");
    expect(actions[1].label).toBe("transport.menu.clipFadeOut:0");
    await actions[0].onSelect();
    expect(deps.prompt).toHaveBeenCalledWith("transport.prompt.clipFadeIn", "1.5");
    expect(updateFades).toHaveBeenCalledWith(["c1"], 2.5, null, {});
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("edits every selected clip in one call", async () => {
    const clips = [clip({ id: "a" }), clip({ id: "b", fadeOutSeconds: 3 })];
    const { actions, updateFades } = setup(clips, "1");
    expect(actions[1].label).toBe("transport.menu.clipFadeOut:transport.menu.clipFadeMixed");
    await actions[1].onSelect();
    expect(updateFades).toHaveBeenCalledTimes(1);
    expect(updateFades).toHaveBeenCalledWith(["a", "b"], null, 1, {});
  });

  it("leaves mixed values alone when the field is left empty", async () => {
    const { actions, updateFades } = setup([clip({ id: "a" }), clip({ id: "b", fadeOutSeconds: 3 })], "");
    await actions[1].onSelect();
    expect(updateFades).not.toHaveBeenCalled();
  });

  it("removes both fades, and is disabled when there are none", async () => {
    const none = setup([clip()], null);
    expect(none.actions[2].disabled).toBe(true);
    const faded = setup([clip({ fadeInSeconds: 1 })], null);
    expect(faded.actions[2].disabled).toBe(false);
    await faded.actions[2].onSelect();
    expect(faded.updateFades).toHaveBeenCalledWith(["c1"], 0, 0, {});
  });

  it("offers curve presets for the fades the clips have", async () => {
    const openSubMenu = vi.fn();
    const updateFades = vi.fn(async () => snapshot);
    const actions = clipFadeMenuActions([clip({ fadeInSeconds: 2, fadeInCurve: { x: 0.1, y: 0.9 } })], {
      t: (key: string, options?: Record<string, unknown>) =>
        options && "name" in options ? `${key}:${options.name}` : key,
      runAction: async (action: () => Promise<void>) => action(),
      applyPlaybackSnapshot: vi.fn(),
      setStatus: vi.fn(),
      openSubMenu,
      updateFades,
    });
    const inCurve = actions.find((action) => action.label.startsWith("transport.menu.clipFadeInCurve"))!;
    const outCurve = actions.find((action) => action.label.startsWith("transport.menu.clipFadeOutCurve"))!;
    expect(inCurve.label).toContain("transport.menu.clipFadeCurves.fast");
    // No fade out yet: nothing to bend.
    expect(outCurve.disabled).toBe(true);
    await inCurve.onSelect();
    const presets = openSubMenu.mock.calls[0][1] as Array<{ label: string; disabled?: boolean; onSelect: () => Promise<void> }>;
    expect(presets.find((p) => p.label.endsWith(".fast"))!.disabled).toBe(true);
    await presets.find((p) => p.label.endsWith(".slow"))!.onSelect();
    expect(updateFades).toHaveBeenCalledWith(["c1"], null, null, { fadeInCurve: { x: 0.9, y: 0.1 } });
  });

  it("does nothing when the prompt is cancelled or invalid", async () => {
    for (const answer of [null, "abc", "-1"]) {
      const { actions, updateFades } = setup([clip()], answer);
      await actions[0].onSelect();
      expect(updateFades).not.toHaveBeenCalled();
    }
  });
});

describe("clip fade handles", () => {
  // 10 px per second, camera at 0: the clip spans x = 100..180.
  const pps = 10;

  it("grabs the handles on the top corners, and nothing below the band", () => {
    const clips = [clip()];
    expect(hitClipFadeHandle(clips, 103, 3, 0, pps)).toMatchObject({ edge: "in" });
    expect(hitClipFadeHandle(clips, 177, 3, 0, pps)).toMatchObject({ edge: "out" });
    expect(hitClipFadeHandle(clips, 140, 3, 0, pps)).toBeNull();
    expect(hitClipFadeHandle(clips, 103, 30, 0, pps)).toBeNull();
  });

  it("finds a handle where its fade ends", () => {
    const clips = [clip({ fadeInSeconds: 2 })];
    expect(hitClipFadeHandle(clips, 120, 3, 0, pps)).toMatchObject({ edge: "in" });
  });

  it("skips clips too narrow to grab", () => {
    expect(hitClipFadeHandle([clip({ durationSeconds: 2 })], 101, 3, 0, pps)).toBeNull();
  });

  function lane(): HTMLElement {
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetWidth", { value: 1000 });
    Object.defineProperty(element, "offsetHeight", { value: 80 });
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 80, right: 1000, bottom: 80 }) as DOMRect;
    return element;
  }

  function setupDrag(selected: string[] = [], selectedClips?: ClipSummary[]) {
    const target = new EventTarget();
    const updateFades = vi.fn(async () => snapshot);
    const deps = {
      getCameraX: () => 0,
      getPixelsPerSecond: () => pps,
      runAction: async (action: () => Promise<void>) => action(),
      applyPlaybackSnapshot: vi.fn(),
      selectClip: vi.fn(),
      getSelectedClips: () => selectedClips ?? selected.map((id) => clip({ id })),
      updateFades,
      target: target as unknown as Window,
    };
    return { drag: createClipFadeDrag(deps), deps, target, updateFades };
  }

  const pointer = (type: string, clientX: number) => {
    const event = new Event(type) as Event & { clientX: number };
    event.clientX = clientX;
    return event;
  };

  it("commits one update with the dragged fade on release", async () => {
    const { drag, target, updateFades } = setupDrag();
    const press = { clientX: 103, clientY: 3, preventDefault: vi.fn() };
    expect(drag.tryBegin(press, lane(), [clip()])).toBe(true);
    expect(press.preventDefault).toHaveBeenCalled();
    target.dispatchEvent(pointer("pointermove", 133));
    expect(resolveClipFades("c1", f(0, 0)).fadeInSeconds).toBe(3);
    target.dispatchEvent(pointer("pointerup", 133));
    await Promise.resolve();
    expect(updateFades).toHaveBeenCalledWith(["c1"], 3, null);
    expect(drag.isDragging()).toBe(false);
  });

  it("gives every selected clip the dragged fade, in one update", async () => {
    // c2 is on another track and shorter: its fade out is clamped to fit.
    const c2 = clip({ id: "c2", trackId: "t2", durationSeconds: 2, sourceWindowDurationSeconds: 2 });
    const c3 = clip({ id: "c3", timelineStartSeconds: 30, fadeInSeconds: 1 });
    const { drag, deps, target, updateFades } = setupDrag([], [clip(), c2, c3]);
    // Fade-out handle of c1 (x = 177), dragged 30 px left: a 3 s fade out.
    drag.tryBegin({ clientX: 177, clientY: 3, preventDefault: () => {} }, lane(), [clip()]);
    target.dispatchEvent(pointer("pointermove", 147));
    const none = f(0, 0);
    expect(resolveClipFades("c1", none).fadeOutSeconds).toBe(3);
    expect(resolveClipFades("c2", none).fadeOutSeconds).toBe(2);
    expect(resolveClipFades("c3", none)).toEqual(f(1, 3));
    target.dispatchEvent(pointer("pointerup", 147));
    await Promise.resolve();
    expect(updateFades).toHaveBeenCalledTimes(1);
    expect(updateFades).toHaveBeenCalledWith(["c1", "c2", "c3"], null, 3);
    expect(deps.selectClip).not.toHaveBeenCalled();
  });

  it("keeps the selection on a click on a handle of a selected group", () => {
    const { drag, deps, target } = setupDrag(["c1", "c2"]);
    drag.tryBegin({ clientX: 177, clientY: 3, preventDefault: () => {} }, lane(), [clip()]);
    target.dispatchEvent(pointer("pointerup", 177));
    expect(deps.selectClip).not.toHaveBeenCalled();
  });

  it("edits only the dragged clip when it is not in the selection", async () => {
    const { drag, target, updateFades } = setupDrag(["x1", "x2"]);
    drag.tryBegin({ clientX: 103, clientY: 3, preventDefault: () => {} }, lane(), [clip()]);
    target.dispatchEvent(pointer("pointermove", 123));
    target.dispatchEvent(pointer("pointerup", 123));
    await Promise.resolve();
    expect(updateFades).toHaveBeenCalledWith(["c1"], 2, null);
  });

  it("selects the clip on a press that never moves", () => {
    const { drag, deps, target, updateFades } = setupDrag();
    drag.tryBegin({ clientX: 177, clientY: 3, preventDefault: () => {} }, lane(), [clip()]);
    target.dispatchEvent(pointer("pointerup", 177));
    expect(updateFades).not.toHaveBeenCalled();
    expect(deps.selectClip).toHaveBeenCalledWith("c1", "t1");
  });

  it("drops the preview when the drag is cancelled", () => {
    const { drag, target, updateFades } = setupDrag();
    drag.tryBegin({ clientX: 103, clientY: 3, preventDefault: () => {} }, lane(), [clip()]);
    target.dispatchEvent(pointer("pointermove", 133));
    target.dispatchEvent(pointer("pointercancel", 133));
    expect(updateFades).not.toHaveBeenCalled();
    expect(resolveClipFades("c1", f(0, 0)).fadeInSeconds).toBe(0);
  });

  it("leaves a press away from the handles to the clip move", () => {
    const { drag } = setupDrag();
    expect(
      drag.tryBegin({ clientX: 140, clientY: 3, preventDefault: () => {} }, lane(), [clip()]),
    ).toBe(false);
  });

  describe("curve handle", () => {
    // Lane 80 px tall; c1 has a 4 s fade in (x = 100..140), so its curve dot
    // sits at x = 120, y = 80 - 0.5 * 80 = 40 while straight.
    const faded = () => clip({ fadeInSeconds: 4 });
    const pointerXY = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type) as Event & { clientX: number; clientY: number };
      event.clientX = clientX;
      event.clientY = clientY;
      return event;
    };

    it("is grabbed on the fade's midpoint, only on a selected clip", () => {
      const selected = { laneHeight: 80, selectedIds: new Set(["c1"]) };
      expect(hitClipFadeHandle([faded()], 121, 41, 0, pps, undefined, selected)).toMatchObject({
        edge: "in",
        kind: "curve",
      });
      const unselected = { laneHeight: 80, selectedIds: new Set<string>() };
      expect(hitClipFadeHandle([faded()], 121, 41, 0, pps, undefined, unselected)).toBeNull();
    });

    it("moves freely: up and left shapes every selected clip with that fade, in one update", async () => {
      const c2 = clip({ id: "c2", trackId: "t2", fadeInSeconds: 1 });
      const c3 = clip({ id: "c3", trackId: "t3" }); // no fade in: left alone
      const { drag, target, updateFades } = setupDrag([], [faded(), c2, c3]);
      expect(drag.tryBegin({ clientX: 120, clientY: 40, preventDefault: () => {} }, lane(), [faded()])).toBe(true);
      // 10 px left of a 40 px fade and 20 px up an 80 px lane: a quarter of
      // the box each way, so the control point goes to the top-left corner.
      target.dispatchEvent(pointerXY("pointermove", 110, 20));
      const none = f(0, 0);
      expect(resolveClipFades("c1", none).fadeInCurve).toEqual({ x: 0, y: 1 });
      expect(resolveClipFades("c2", none).fadeInCurve).toEqual({ x: 0, y: 1 });
      expect(resolveClipFades("c3", none).fadeInCurve).toEqual(LINEAR);
      target.dispatchEvent(pointerXY("pointerup", 110, 20));
      await Promise.resolve();
      expect(updateFades).toHaveBeenCalledWith(["c1", "c2"], null, null, {
        fadeInCurve: { x: 0, y: 1 },
      });
    });

    it("moves sideways too, mirrored on a fade out", async () => {
      // 4 s fade out on the clip's end (x = 140..180): handle at x = 160.
      const out = clip({ fadeOutSeconds: 4 });
      const { drag, target, updateFades } = setupDrag(["c1"], [out]);
      expect(drag.tryBegin({ clientX: 160, clientY: 40, preventDefault: () => {} }, lane(), [out])).toBe(true);
      // Leftwards is towards full level for a fade out.
      target.dispatchEvent(pointerXY("pointermove", 150, 40));
      target.dispatchEvent(pointerXY("pointerup", 150, 40));
      await Promise.resolve();
      expect(updateFades).toHaveBeenCalledWith(["c1"], null, null, {
        fadeOutCurve: { x: 1, y: 0.5 },
      });
    });
  });

  describe("with a finger", () => {
    const touch = (clientX: number, clientY: number) => ({
      clientX,
      clientY,
      pointerType: "touch",
      preventDefault: () => {},
    });

    it("grabs a selected clip's handle from a finger's distance", () => {
      // 18 px right and 25 px down from the fade-in handle: a miss for a mouse.
      expect(hitClipFadeHandle([clip()], 121, 25, 0, pps)).toBeNull();
      expect(hitClipFadeHandle([clip()], 121, 25, 0, pps, TOUCH_HIT_SLOP)).toMatchObject({
        edge: "in",
      });
      const { drag } = setupDrag(["c1"]);
      expect(drag.tryBegin(touch(121, 25), lane(), [clip()])).toBe(true);
    });

    it("never grabs the handles of a clip that is not selected", () => {
      const { drag } = setupDrag([]);
      expect(drag.tryBegin(touch(103, 3), lane(), [clip()])).toBe(false);
    });

    it("ignores the small wobble of a finger before it drags", () => {
      const { drag, target, updateFades } = setupDrag(["c1"]);
      drag.tryBegin(touch(103, 3), lane(), [clip()]);
      target.dispatchEvent(pointer("pointermove", 107));
      target.dispatchEvent(pointer("pointerup", 107));
      expect(updateFades).not.toHaveBeenCalled();
    });
  });

  describe("touch navigation", () => {
    function navigation(selected: string[]) {
      return createTouchClipSelection({
        getClipsByTrack: () => ({ t1: [clip()] }),
        getSelectedClipIds: () => selected,
        getCameraX: () => 0,
        getPixelsPerSecond: () => pps,
        selectClips: vi.fn(),
        clearRegionSelection: vi.fn(),
        isMultiSelect: () => false,
        toggleClip: vi.fn(),
      });
    }
    function row() {
      const element = lane();
      element.dataset.trackId = "t1";
      return element;
    }

    it("hands the finger to the edit on a selected clip's handle, even past its edge", () => {
      // x = 90 is 10 px left of the clip: outside it, but on its fade-in handle.
      expect(navigation(["c1"]).shouldEdit(90, 5, row())).toBe(true);
    });

    it("keeps panning over the handles of a clip that is not selected", () => {
      expect(navigation([]).shouldEdit(90, 5, row())).toBe(false);
    });
  });
});
