import { describe, expect, it, vi } from "vitest";
import {
  createKeyedLatestWinsStreams,
  createLatestWinsStream,
} from "./latestWinsStream";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createLatestWinsStream", () => {
  it("never has two calls in flight and applies the newest value last", async () => {
    // The regression this guards: these commands are `(async)` on the Rust
    // side, so two overlapping calls run on different threadpool threads and
    // can be applied out of order, leaving the engine on a stale value after
    // the user stopped moving the control.
    const gates = [deferred(), deferred()];
    let call = 0;
    const run = vi.fn(() => gates[call++]?.promise ?? Promise.resolve());
    const push = createLatestWinsStream<number>(run);

    const first = push(0.1);
    void push(0.2);
    void push(0.3);

    expect(run.mock.calls).toEqual([[0.1]]);

    gates[0].resolve();
    await flushMicrotasks();
    expect(run.mock.calls).toEqual([[0.1], [0.3]]);

    gates[1].resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("compares values with a custom isSame", async () => {
    const gate = deferred();
    const run = vi.fn().mockReturnValueOnce(gate.promise);
    const push = createLatestWinsStream<{ id: string }>(
      run,
      (a, b) => a.id === b.id,
    );

    const first = push({ id: "a" });
    void push({ id: "a" });

    gate.resolve();
    await first;

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("createKeyedLatestWinsStreams", () => {
  it("serializes per key without making different keys wait on each other", async () => {
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
    };
    const started: string[] = [];
    const run = vi.fn((key: string, value: number) => {
      started.push(`${key}:${value}`);
      return gates[key]?.promise ?? Promise.resolve();
    });
    const push = createKeyedLatestWinsStreams<number>(run);

    void push("a", 1);
    void push("b", 1);

    // Region b is not held up by region a's in-flight call.
    expect(started).toEqual(["a:1", "b:1"]);

    void push("a", 2);
    void push("a", 3);
    expect(started).toEqual(["a:1", "b:1"]);

    gates.a.resolve();
    await flushMicrotasks();
    expect(started).toEqual(["a:1", "b:1", "a:3"]);
  });
});
