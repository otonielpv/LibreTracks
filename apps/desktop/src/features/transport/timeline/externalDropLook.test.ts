import { describe, expect, it } from "vitest";
import {
  EXTERNAL_DROP_LABELS,
  externalDropBadgeColors,
  externalDropGuideColors,
} from "./externalDropLook";

describe("externalDropLook", () => {
  // Dragging an .mp4 over the timeline said "Unsupported" in red although
  // the drop itself was accepted.
  it("shows a dragged video as accepted, like audio", () => {
    expect(EXTERNAL_DROP_LABELS.video).toBe("Video");
    expect(externalDropGuideColors("video")).toEqual(externalDropGuideColors("audio"));
    expect(externalDropBadgeColors("video")).toEqual(externalDropBadgeColors("audio"));
  });

  it("keeps the previous colours", () => {
    expect(externalDropGuideColors("audio")).toEqual({
      background: "#7ae582",
      boxShadow: "0 0 0 1px rgba(122,229,130,0.24), 0 0 18px rgba(122,229,130,0.44)",
    });
    expect(externalDropGuideColors("unknown")).toEqual({
      background: "#76b8ff",
      boxShadow: "0 0 0 1px rgba(118,184,255,0.22), 0 0 18px rgba(118,184,255,0.42)",
    });
    expect(externalDropBadgeColors("external")).toEqual({
      background: "rgba(255,184,107,0.18)",
      border: "1px solid rgba(255,184,107,0.34)",
    });
    expect(externalDropBadgeColors("unknown").background).toBe("rgba(118,184,255,0.16)");
    expect(externalDropBadgeColors("unsupported")).toEqual({
      background: "rgba(255,107,107,0.18)",
      border: "1px solid rgba(255,107,107,0.34)",
    });
  });
});
