import { beforeEach, describe, expect, it } from "vitest";

import {
  countUiActivity,
  readUiActivityRates,
  resetUiActivityForTests,
} from "./uiActivity";

describe("uiActivity", () => {
  beforeEach(() => {
    resetUiActivityForTests();
  });

  it("has no rate until there is a previous reading", () => {
    countUiActivity("snapshots");
    expect(readUiActivityRates(1000)).toBeNull();
  });

  it("reports events per second since the previous reading", () => {
    readUiActivityRates(1000);
    for (let i = 0; i < 5; i += 1) countUiActivity("snapshots");
    countUiActivity("panelRenders");

    const rates = readUiActivityRates(3000);

    expect(rates?.snapshots).toBe(2.5);
    expect(rates?.panelRenders).toBe(0.5);
    expect(rates?.meterEvents).toBe(0);
  });

  it("only counts what happened after the last reading", () => {
    readUiActivityRates(0);
    countUiActivity("meterEvents");
    readUiActivityRates(1000);

    expect(readUiActivityRates(2000)?.meterEvents).toBe(0);
  });
});
