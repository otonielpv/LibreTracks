import { describe, expect, it } from "vitest";

import { joinTargetFromLink } from "./networkJoinLink";

describe("joinTargetFromLink", () => {
  it("takes IP:PORT from the host's QR link", () => {
    expect(joinTargetFromLink("libretracks://join?host=192.168.1.37:3041&name=PC%20de%20%C3%81na")).toBe(
      "192.168.1.37:3041",
    );
    expect(joinTargetFromLink("libretracks://join?name=PC&host=[fe80::1]:3040")).toBe("[fe80::1]:3040");
  });

  it("is null for a link without a host", () => {
    expect(joinTargetFromLink("libretracks://join?name=PC")).toBeNull();
    expect(joinTargetFromLink("libretracks://join")).toBeNull();
    expect(joinTargetFromLink("libretracks://join?host=")).toBeNull();
  });
});
