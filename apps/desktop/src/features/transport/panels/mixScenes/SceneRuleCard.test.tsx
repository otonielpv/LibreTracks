// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EqPreset, MixSceneRule, TrackEq } from "@libretracks/shared/models";

const presetEq: TrackEq = {
  enabled: true,
  bands: [{ enabled: true, kind: "lowCut", frequencyHz: 80, gainDb: 0, q: 0.71, slope: 12 }],
};
const presets: EqPreset[] = [
  { id: "factory-hpf-80", name: "Remove lows (HPF 80)", eq: presetEq, factory: true },
  { id: "user-1", name: "Mi voz", eq: presetEq },
];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "name" in options ? `${key}:${String(options.name)}` : key,
  }),
}));

vi.mock("../../desktopApi", async (original) => ({
  ...(await original<object>()),
  listEqPresets: vi.fn(async () => presets),
}));

import { SceneRuleCard } from "./SceneRuleCard";

afterEach(cleanup);

function renderCard(rule: MixSceneRule) {
  const onChange = vi.fn();
  render(
    <SceneRuleCard
      index={0}
      rule={rule}
      folders={[]}
      trackGroups={[]}
      onChange={onChange}
      onRemove={vi.fn()}
    />,
  );
  return onChange;
}

const base: MixSceneRule = { select: { type: "activeSong" }, change: {} };

describe("EQ in a scene rule", () => {
  it("turns the eq on or off", () => {
    const onChange = renderCard(base);
    const select = screen.getByLabelText("transport.mixScene.eq") as HTMLSelectElement;
    expect(select.value).toBe("none");
    fireEvent.change(select, { target: { value: "off" } });
    expect(onChange.mock.calls[0][0].change.eq).toEqual({ enabled: false });
    fireEvent.change(select, { target: { value: "on" } });
    expect(onChange.mock.calls[1][0].change.eq).toEqual({ enabled: true });
  });

  it("choosing a preset stores its curve in the rule", async () => {
    const onChange = renderCard(base);
    const option = await screen.findByRole("option", {
      name: "transport.mixScene.eqPreset:eq.presets.names.factory-hpf-80",
    });
    fireEvent.change(screen.getByLabelText("transport.mixScene.eq"), {
      target: { value: (option as HTMLOptionElement).value },
    });
    expect(onChange.mock.calls[0][0].change.eq).toEqual({
      presetId: "factory-hpf-80",
      eq: presetEq,
      enabled: true,
    });
  });

  it("a rule whose preset was deleted still shows its saved curve; 'no change' clears it", async () => {
    const onChange = renderCard({
      ...base,
      change: { eq: { presetId: "gone", eq: presetEq } },
    });
    await screen.findByRole("option", { name: "transport.mixScene.eqPreset:Mi voz" });
    const select = screen.getByLabelText("transport.mixScene.eq") as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("transport.mixScene.eqSavedCurve");
    fireEvent.change(select, { target: { value: "none" } });
    expect(onChange.mock.calls[0][0].change.eq).toBeNull();
  });
});
