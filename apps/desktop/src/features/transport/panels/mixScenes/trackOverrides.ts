import type { MixSceneRule, MixSceneSummary } from "@libretracks/shared/models";

/** One track's absolute values in a scene, as the per-track editor shows them. */
export type TrackOverride = {
  trackId: string;
  volume: number | null;
  pan: number | null;
  muted: boolean | null;
  solo: boolean | null;
};

const isTrackRule = (rule: MixSceneRule, trackId: string) =>
  rule.select.type === "track" &&
  rule.select.trackId === trackId &&
  (rule.except ?? []).length === 0;

/** The absolute values a scene's `track` rule sets on `trackId`, if any. */
export function trackOverrideOf(
  scene: MixSceneSummary,
  trackId: string,
): TrackOverride | undefined {
  const rule = scene.rules.find((candidate) => isTrackRule(candidate, trackId));
  if (!rule) return undefined;
  const { volume, pan, muted, solo } = rule.change;
  return {
    trackId,
    volume: volume?.type === "absolute" ? volume.value : null,
    pan: pan?.type === "absolute" ? pan.value : null,
    muted: muted ?? null,
    solo: solo ?? null,
  };
}

/** `scene` with the `track` rule of `override.trackId` replaced (or dropped when empty). */
export function withTrackOverride(
  scene: MixSceneSummary,
  override: TrackOverride,
): MixSceneSummary {
  const rules = scene.rules.filter((rule) => !isTrackRule(rule, override.trackId));
  const isEmpty =
    override.volume == null &&
    override.pan == null &&
    override.muted == null &&
    override.solo == null;
  if (!isEmpty) {
    rules.push({
      select: { type: "track", trackId: override.trackId },
      change: {
        volume: override.volume == null ? null : { type: "absolute", value: override.volume },
        pan: override.pan == null ? null : { type: "absolute", value: override.pan },
        muted: override.muted,
        solo: override.solo,
      },
    });
  }
  return { ...scene, rules };
}
