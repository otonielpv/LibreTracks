import { beforeEach, describe, expect, it } from "vitest";

import {
  INITIAL_PREPARATION_STATUS,
  selectAudioPreparationUiState,
  usePreparationStatusStore,
} from "./preparationStatusStore";

function countPublications(run: () => void) {
  let publications = 0;
  const unsubscribe = usePreparationStatusStore.subscribe(() => {
    publications += 1;
  });
  run();
  unsubscribe();
  return publications;
}

const preparing = {
  active: true,
  percent: 40,
  readyCount: 4,
  total: 10,
  failedCount: 0,
};

describe("preparationStatusStore", () => {
  beforeEach(() => {
    usePreparationStatusStore.setState(INITIAL_PREPARATION_STATUS);
  });

  it("does not publish when a poll repeats the same numbers", () => {
    const { setSources, setSourcesPreparing } = usePreparationStatusStore.getState();
    setSources(preparing);
    setSourcesPreparing(true);

    const publications = countPublications(() => {
      for (let poll = 0; poll < 8; poll += 1) {
        setSources({ ...preparing });
        setSources((prev) => ({ ...prev }));
        setSourcesPreparing(true);
      }
    });

    expect(publications).toBe(0);
  });

  it("publishes when the progress actually moves", () => {
    const { setSources } = usePreparationStatusStore.getState();
    setSources(preparing);

    const publications = countPublications(() => {
      setSources({ ...preparing, percent: 41 });
      setSources({ ...preparing, percent: 41, failedCount: 1 });
    });

    expect(publications).toBe(2);
    expect(usePreparationStatusStore.getState().sources.failedCount).toBe(1);
  });

  it("keeps the idle pitch state stable across polls", () => {
    const { setPitch } = usePreparationStatusStore.getState();

    const publications = countPublications(() => {
      setPitch({ active: false, message: "" });
      setPitch({ active: false, message: "" });
    });

    expect(publications).toBe(0);
  });

  it("keeps the first startedAt while the same pitch notice stays on", () => {
    const { setPitch } = usePreparationStatusStore.getState();
    setPitch({ active: true, message: "Preparing", startedAt: 1 });

    const publications = countPublications(() => {
      setPitch({ active: true, message: "Preparing", startedAt: 2 });
    });

    expect(publications).toBe(0);
    expect(usePreparationStatusStore.getState().pitch.startedAt).toBe(1);
  });

  it("shows the project preparation over the engine sources while it is active", () => {
    const { setSources, setProject } = usePreparationStatusStore.getState();
    setSources(preparing);
    setProject({ ...preparing, percent: 92 });

    expect(
      selectAudioPreparationUiState(usePreparationStatusStore.getState()).percent,
    ).toBe(92);

    setProject({ ...preparing, active: false });
    expect(
      selectAudioPreparationUiState(usePreparationStatusStore.getState()).percent,
    ).toBe(40);
  });
});
