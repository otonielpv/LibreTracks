// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickFilesViaWebView } from "./mobileFilePicker";

describe("pickFilesViaWebView", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("leaves accept unset so iOS Files does not disable valid documents", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const pending = pickFilesViaWebView();
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.hasAttribute("accept")).toBe(false);

    input?.dispatchEvent(new Event("cancel"));
    await expect(pending).resolves.toEqual([]);
  });

  it("supports a single-file picker without adding a content filter", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const pending = pickFilesViaWebView(undefined, false);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(false);
    expect(input.hasAttribute("accept")).toBe(false);

    input.dispatchEvent(new Event("cancel"));
    await expect(pending).resolves.toEqual([]);
  });
});
