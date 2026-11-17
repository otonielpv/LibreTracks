import { describe, expect, it, vi } from "vitest";

import { emitRhythmMetersForTest } from "../../../app/testDesktopApiMock";
import { act, fireEvent, render, screen, waitFor } from "../../../test/testUtils";
import { listenToRhythmMeters } from "../desktopApi";
import { RhythmButton } from "./RhythmButton";

describe("RhythmButton", () => {
  it("lights up while a loop or a one shot sounds, even with the panel closed", async () => {
    const onToggle = vi.fn();
    render(<RhythmButton open={false} onToggle={onToggle} />);
    const button = screen.getByTestId("rhythm-button");
    expect(button.dataset.active).toBe("false");
    await waitFor(() => expect(listenToRhythmMeters).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      emitRhythmMetersForTest({ loopStep: 2, loopBar: 0, loopPlaying: true, loopRows: [], oneShotsActive: 0 });
    });
    expect(button.dataset.active).toBe("true");
    act(() => emitRhythmMetersForTest({ loopStep: -1, loopBar: 0, loopPlaying: false, loopRows: [], oneShotsActive: 0 }));
    expect(button.dataset.active).toBe("false");
    act(() => emitRhythmMetersForTest({ loopStep: -1, loopBar: 0, loopPlaying: false, loopRows: [], oneShotsActive: 4 }));
    expect(button.dataset.active).toBe("true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
