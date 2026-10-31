import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MixSceneSummary, SongView } from "@libretracks/shared/models";

import { useSoundingKeyStore } from "../../keyChanges/soundingKeyStore";
import { MixSceneModal } from "../MixSceneModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "names" in options ? `${key}:${String(options.names)}` : key,
  }),
}));

const baseSong = {
  regions: [{ id: "r1", name: "Canción", startSeconds: 0, endSeconds: 100 }],
  tracks: [
    { id: "bajo", name: "Bajo", kind: "audio", parentTrackId: null },
    { id: "voz", name: "Voz", kind: "audio", parentTrackId: null },
  ],
  clips: [
    { trackId: "bajo", timelineStartSeconds: 0, durationSeconds: 10 },
    { trackId: "voz", timelineStartSeconds: 0, durationSeconds: 10 },
  ],
  midiClips: [],
  videoClips: [],
  mixScenes: [],
} as unknown as SongView;

function withScenes(mixScenes: MixSceneSummary[]): SongView {
  return { ...baseSong, mixScenes } as SongView;
}

function renderModal(song: SongView) {
  const props = {
    onCancel: vi.fn(),
    onUpsert: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
  };
  const view = render(<MixSceneModal open song={song} {...props} />);
  return { ...view, props };
}

describe("MixSceneModal", () => {
  beforeEach(() => {
    useSoundingKeyStore.setState({ regionId: "r1" });
  });

  it("creates the band-down scene and shows it the same after reopening", () => {
    const { props, unmount } = renderModal(baseSong);
    fireEvent.click(screen.getByText("transport.mixScene.bandDownTemplate"));

    expect(props.onUpsert).toHaveBeenCalledTimes(1);
    const saved = props.onUpsert.mock.calls[0][0] as MixSceneSummary;
    expect(saved.rampSeconds).toBe(2);
    expect(saved.rules[0].select).toEqual({ type: "activeSong" });
    expect(saved.rules[0].change.volume).toEqual({ type: "relativeDb", value: -12 });
    // The preview: the bass, not the voice.
    expect(screen.getByText("transport.mixScene.preview:Bajo")).toBeTruthy();
    unmount();

    // Reopened from what was saved: same rule, same values.
    renderModal(withScenes([saved]));
    const rule = screen.getByTestId("scene-rule-0");
    expect(
      (within(rule).getByLabelText("transport.mixScene.selectLabel") as HTMLSelectElement).value,
    ).toBe("activeSong");
    expect((within(rule).getByLabelText("transport.mixScene.wordsLabel") as HTMLInputElement).value)
      .toBe("voz, voc, vox, click, guía, guide");
    expect((within(rule).getByLabelText("transport.mixScene.volumeDb") as HTMLInputElement).value)
      .toBe("-12");
  });

  it("edits words on blur, not per keystroke", () => {
    const scene: MixSceneSummary = {
      id: "s1",
      name: "S1",
      rampSeconds: 0,
      rules: [
        {
          select: { type: "activeSong" },
          except: [{ type: "nameContains", words: [] }],
          change: { muted: true },
        },
      ],
    };
    const { props } = renderModal(withScenes([scene]));
    const words = screen.getByLabelText("transport.mixScene.wordsLabel");
    fireEvent.change(words, { target: { value: "voz," } });
    expect(props.onUpsert).not.toHaveBeenCalled();
    fireEvent.blur(words);
    const saved = props.onUpsert.mock.calls[0][0] as MixSceneSummary;
    expect(saved.rules[0].except).toEqual([{ type: "nameContains", words: ["voz"] }]);
  });

  it("shows a migrated scene as track rules and saves it unchanged", () => {
    // A pre-plan scene as the backend now sends it (paso 01 migration).
    const migrated: MixSceneSummary = {
      id: "old",
      name: "Vieja",
      rampSeconds: 0,
      rules: [
        {
          select: { type: "track", trackId: "bajo" },
          change: { volume: { type: "absolute", value: 0.4 }, muted: false },
        },
      ],
    };
    const { props } = renderModal(withScenes([migrated]));
    const rule = screen.getByTestId("scene-rule-0");
    expect(
      (within(rule).getByLabelText("transport.mixScene.selectLabel") as HTMLSelectElement).value,
    ).toBe("track");
    expect((within(rule).getByLabelText("transport.mixScene.selectTrack") as HTMLSelectElement).value)
      .toBe("bajo");
    expect(
      (within(rule).getByLabelText("transport.mixScene.volumePercent") as HTMLInputElement).value,
    ).toBe("40");

    // Touching the name saves the rules exactly as they were.
    fireEvent.change(screen.getByDisplayValue("Vieja"), { target: { value: "Vieja 2" } });
    const saved = props.onUpsert.mock.calls[0][0] as MixSceneSummary;
    expect(saved.rules).toEqual(migrated.rules);
    expect(saved.name).toBe("Vieja 2");
  });

  it("reorders scenes: numbers follow and the order is saved", () => {
    const scene = (id: string): MixSceneSummary => ({ id, name: id, rampSeconds: 0, rules: [] });
    const { props } = renderModal(withScenes([scene("a"), scene("b"), scene("c")]));
    // Move "b" (second) up.
    fireEvent.click(screen.getAllByLabelText("transport.mixScene.moveUp")[1]);
    expect(props.onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("1b"),
      expect.stringContaining("2a"),
      expect.stringContaining("3c"),
    ]);
  });
});
