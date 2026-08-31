import { describe, expect, it } from "vitest";

import {
  AUTOMATION_JUMP_FEEDBACK_LEAD_SECONDS,
  shouldShowAutomationJumpFeedback,
} from "./drawForeground";

describe("automation jump feedback", () => {
  it("stays hidden while an engine-armed automation is still far away", () => {
    expect(shouldShowAutomationJumpFeedback(0, 180)).toBe(false);
  });

  it("appears on the final approach to the automation", () => {
    expect(
      shouldShowAutomationJumpFeedback(
        180 - AUTOMATION_JUMP_FEEDBACK_LEAD_SECONDS,
        180,
      ),
    ).toBe(true);
  });

  it("remains visible until the executed jump disappears from the snapshot", () => {
    expect(shouldShowAutomationJumpFeedback(180.05, 180)).toBe(true);
  });
});
