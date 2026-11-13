import { afterEach, describe, expect, it } from "vitest";

import { getMixerSize, initMixerSize, setMixerSize } from "./mixerSize";

describe("mixerSize", () => {
  afterEach(() => {
    setMixerSize("auto");
    window.localStorage.removeItem("lt.ui.mixerSize");
  });

  it("puts one size class on <html> and remembers it", () => {
    setMixerSize("xlarge");
    const root = document.documentElement;
    expect(root.classList.contains("lt-mixer-size-xlarge")).toBe(true);
    expect(window.localStorage.getItem("lt.ui.mixerSize")).toBe("xlarge");
    setMixerSize("normal");
    expect(root.classList.contains("lt-mixer-size-xlarge")).toBe(false);
    expect(root.classList.contains("lt-mixer-size-normal")).toBe(true);
    expect(getMixerSize()).toBe("normal");
  });

  it("automatic leaves the class off, so the tablet rule applies", () => {
    setMixerSize("large");
    setMixerSize("auto");
    initMixerSize();
    expect([...document.documentElement.classList].some((c) => c.startsWith("lt-mixer-size-"))).toBe(false);
  });
});
