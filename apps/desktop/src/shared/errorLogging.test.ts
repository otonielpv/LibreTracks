import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendFrontendError = vi.fn();

vi.mock("@libretracks/shared/desktopApi", () => ({
  appendFrontendError: (...args: unknown[]) => appendFrontendError(...args),
}));

async function loadFresh() {
  vi.resetModules();
  return import("./errorLogging");
}

beforeEach(() => {
  appendFrontendError.mockReset();
  appendFrontendError.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("installGlobalErrorHandlers", () => {
  it("forwards uncaught errors with location info", async () => {
    const { installGlobalErrorHandlers } = await loadFresh();
    installGlobalErrorHandlers();

    const error = new Error("kaboom");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error,
        message: "kaboom",
        filename: "app.js",
        lineno: 12,
        colno: 5,
      }),
    );

    expect(appendFrontendError).toHaveBeenCalledTimes(1);
    const message = appendFrontendError.mock.calls[0][0] as string;
    expect(message).toContain("uncaught: kaboom");
    expect(message).toContain("(app.js:12:5)");
  });

  it("falls back to the event message when there is no Error object", async () => {
    const { installGlobalErrorHandlers } = await loadFresh();
    installGlobalErrorHandlers();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "string failure" }),
    );

    expect(appendFrontendError).toHaveBeenCalledWith(
      expect.stringContaining("uncaught: string failure"),
    );
  });

  it("forwards unhandled promise rejections", async () => {
    const { installGlobalErrorHandlers } = await loadFresh();
    installGlobalErrorHandlers();

    // jsdom does not synthesize PromiseRejectionEvent reliably, so dispatch a
    // plain Event carrying the reason the handler reads.
    const event = new Event("unhandledrejection") as Event & {
      reason: unknown;
    };
    event.reason = new Error("promise boom");
    window.dispatchEvent(event);

    expect(appendFrontendError).toHaveBeenCalledWith(
      expect.stringContaining("unhandledrejection: promise boom"),
    );
  });

  it("is idempotent — installing twice registers handlers only once", async () => {
    const { installGlobalErrorHandlers } = await loadFresh();
    // jsdom shares one window across tests in a file, so assert on the number
    // of registrations from THIS fresh module rather than on dispatch counts
    // (handlers from earlier tests stay attached to the shared window).
    const addSpy = vi.spyOn(window, "addEventListener");
    installGlobalErrorHandlers();
    const afterFirst = addSpy.mock.calls.length;
    installGlobalErrorHandlers();
    const afterSecond = addSpy.mock.calls.length;
    addSpy.mockRestore();

    expect(afterFirst).toBe(2); // error + unhandledrejection
    expect(afterSecond).toBe(afterFirst); // second call wires nothing new
  });
});
