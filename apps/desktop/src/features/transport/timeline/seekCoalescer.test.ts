import { describe, expect, it, vi } from "vitest";
import { createSeekCoalescer } from "./seekCoalescer";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSeekCoalescer", () => {
  it("runs a lone seek straight through", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const seek = createSeekCoalescer(run);

    await seek(12);

    expect(run.mock.calls).toEqual([[12]]);
  });

  it("collapses a burst of clicks into the first and the last position", async () => {
    // The regression: one engine seek per click. Each of those takes the
    // session lock and blocks until its destination audio is in RAM, so five
    // clicks froze the UI for five round trips to land where the last one
    // pointed.
    const gates = [deferred(), deferred()];
    let call = 0;
    const run = vi.fn(() => gates[call++]?.promise ?? Promise.resolve());
    const seek = createSeekCoalescer(run);

    const first = seek(10);
    void seek(20);
    void seek(30);
    void seek(40);

    expect(run.mock.calls).toEqual([[10]]);

    gates[0].resolve();
    await flushMicrotasks();

    // 20 and 30 never reach the engine; only where the user ended up does.
    expect(run.mock.calls).toEqual([[10], [40]]);

    gates[1].resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not re-seek when the queued position is where the engine already is", async () => {
    const gate = deferred();
    const run = vi.fn().mockReturnValueOnce(gate.promise);
    const seek = createSeekCoalescer(run);

    const first = seek(10);
    void seek(10);

    gate.resolve();
    await first;

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("clears the queued position when the in-flight seek fails", async () => {
    // The caller restores the confirmed transport visual on failure; running a
    // queued seek afterwards would fight that restore.
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("engine busy"))
      .mockResolvedValue(undefined);
    const seek = createSeekCoalescer(run);

    const failing = seek(10);
    void seek(20);

    await expect(failing).rejects.toThrow("engine busy");
    expect(run).toHaveBeenCalledTimes(1);

    // ...and the coalescer is usable again afterwards.
    await seek(30);
    expect(run.mock.calls).toEqual([[10], [30]]);
  });
});
