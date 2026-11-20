// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AutomationActionSummary,
  AutomationCueSummary,
  EqPreset,
  SongView,
  TrackEq,
} from "@libretracks/shared/models";

const presetEq: TrackEq = {
  enabled: true,
  bands: [{ enabled: true, kind: "lowCut", frequencyHz: 80, gainDb: 0, q: 0.71, slope: 12 }],
};
const trackEq: TrackEq = {
  enabled: true,
  bands: [{ enabled: true, kind: "peak", frequencyHz: 400, gainDb: 3, q: 1, slope: 12 }],
};
const presets: EqPreset[] = [{ id: "factory-hpf-80", name: "HPF", eq: presetEq, factory: true }];

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  listEqPresets: vi.fn(async () => presets),
}));

import { describeAutomationCue } from "../timeline/describeAutomationCue";
import { TrackEqActionEditor } from "./TrackEqActionEditor";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join("|")})` : key;

afterEach(cleanup);

type EqAction = Extract<AutomationActionSummary, { type: "setTrackEq" | "setTrackEqEnabled" }>;

function renderEditor(action: EqAction) {
  const onChange = vi.fn();
  render(
    <TrackEqActionEditor
      action={action}
      trackSelect={<span>pista</span>}
      trackEqOf={(id) => (id === "voz" ? trackEq : null)}
      t={t}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("EQ cue actions", () => {
  it("picks the track's current curve, a preset, or removes the eq", async () => {
    const onChange = renderEditor({ type: "setTrackEq", trackId: "voz", eq: null });
    const curve = screen.getByLabelText("transport.automation.eqCurveLabel") as HTMLSelectElement;
    expect(curve.value).toBe("remove");
    fireEvent.change(curve, { target: { value: "current" } });
    expect(onChange.mock.calls[0][0]).toEqual({ type: "setTrackEq", trackId: "voz", eq: trackEq });

    const option = await screen.findByRole("option", {
      name: "transport.automation.eqPreset(eq.presets.names.factory-hpf-80(HPF))",
    });
    fireEvent.change(curve, { target: { value: (option as HTMLOptionElement).value } });
    expect(onChange.mock.calls[1][0].eq).toEqual(presetEq);
  });

  it("the ramp is stored in seconds and 0 means none", () => {
    const onChange = renderEditor({ type: "setTrackEq", trackId: "voz", eq: trackEq, rampSeconds: 2 });
    const ramp = screen.getByLabelText("transport.automation.smoothingSeconds");
    fireEvent.change(ramp, { target: { value: "4" } });
    expect(onChange.mock.calls[0][0].rampSeconds).toBe(4);
    fireEvent.change(ramp, { target: { value: "0" } });
    expect(onChange.mock.calls[1][0].rampSeconds).toBeNull();
  });

  it("the bypass action turns the eq on or off", () => {
    const onChange = renderEditor({ type: "setTrackEqEnabled", trackId: "voz", enabled: false });
    fireEvent.change(screen.getByLabelText("transport.automation.eqLabel"), {
      target: { value: "on" },
    });
    expect(onChange.mock.calls[0][0]).toEqual({
      type: "setTrackEqEnabled",
      trackId: "voz",
      enabled: true,
    });
  });

  it("describeAutomationCue names each eq action", () => {
    const song = {
      tracks: [{ id: "voz", name: "Voz", kind: "audio" }],
      regions: [],
    } as unknown as SongView;
    const cue = {
      id: "c",
      name: "c",
      atSeconds: 0,
      actions: [
        { type: "setTrackEq", trackId: "voz", eq: trackEq, rampSeconds: 2 },
        { type: "setTrackEq", trackId: "voz", eq: null },
        { type: "setTrackEqEnabled", trackId: "voz", enabled: false },
      ],
    } as unknown as AutomationCueSummary;
    const text = describeAutomationCue(cue, song, t);
    expect(text).toContain("transport.automation.cueEq(");
    expect(text).toContain("transport.automation.cueEqRamp(2.0)");
    expect(text).toContain("transport.automation.cueEqRemove(");
    expect(text).toContain("transport.automation.cueEqOff(");
  });
});
