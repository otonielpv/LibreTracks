import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GUEST_COMMAND_ROUTES } from "./guestCommandTable";
import { guestRouteFor } from "./guestRouting";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

describe("guest mirror routing", () => {
  it("session commands go to the host, device ones stay, files are blocked", () => {
    expect(guestRouteFor("get_song_view")).toBe("host");
    expect(guestRouteFor("play_transport")).toBe("host");
    expect(guestRouteFor("move_clip")).toBe("host");
    expect(guestRouteFor("save_settings")).toBe("host");
    expect(guestRouteFor("get_audio_output_devices")).toBe("local");
    expect(guestRouteFor("set_ui_language")).toBe("local");
    expect(guestRouteFor("link_leave")).toBe("local");
    expect(guestRouteFor("import_audio_files_from_paths")).toBe("blocked");
    expect(guestRouteFor("save_project")).toBe("blocked");
    expect(guestRouteFor("a_command_nobody_classified")).toBe("blocked");
  });

  it("every command the desktop UI invokes is classified", () => {
    const source = readFileSync(path.join(here, "desktopApi.ts"), "utf8");
    const used = [...source.matchAll(/invokeCommand(?:<[^>]*>)?\(\s*"([a-z_0-9]+)"/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(100);
    const unclassified = used.filter(
      (command) => !command.startsWith("link_") && !(command in GUEST_COMMAND_ROUTES),
    );
    // Add each to scripts/link-commands.json and run `npm run gen:link-proxy`.
    expect(unclassified).toEqual([]);
  });

  it("the generated files match scripts/link-commands.json", () => {
    // Throws (non-zero exit) when stale.
    execFileSync(process.execPath, [path.join(root, "scripts/generate-link-proxy.mjs"), "--check"]);
  });
});
