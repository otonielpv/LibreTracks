import { describe, expect, it } from "vitest";

import {
  MOBILE_TRACK_HEIGHT_STOPS,
  resolveMobileTrackHeightChange,
  uniformMobileTrackRows,
} from "./mobileTrackHeights";

describe("mobile track height stops", () => {
  it("offers exactly four ordered densities", () => {
    expect(MOBILE_TRACK_HEIGHT_STOPS).toEqual([18, 76, 108, 148]);
  });

  it("moves one whole stop per increase or decrease", () => {
    expect(resolveMobileTrackHeightChange(76, 84)).toBe(108);
    expect(resolveMobileTrackHeightChange(108, 100)).toBe(76);
    expect(resolveMobileTrackHeightChange(18, 10)).toBe(18);
    expect(resolveMobileTrackHeightChange(148, 156)).toBe(148);
  });

  it("enters the ladder predictably from a non-mobile height", () => {
    expect(resolveMobileTrackHeightChange(90, 98)).toBe(108);
    expect(resolveMobileTrackHeightChange(90, 82)).toBe(76);
    expect(resolveMobileTrackHeightChange(100, 100)).toBe(108);
  });

  it("presents uniform rows without deleting the source offsets", () => {
    const tracks = [
      { id: "keys", heightOffset: 42 },
      { id: "vocals", heightOffset: -10 },
    ];

    expect(uniformMobileTrackRows(tracks)).toEqual([
      { id: "keys" },
      { id: "vocals" },
    ]);
    expect(tracks[0].heightOffset).toBe(42);
  });
});
