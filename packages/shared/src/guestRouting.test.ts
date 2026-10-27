import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GUEST_COMMAND_ROUTES } from "./guestCommandTable";
import { guestCanInvoke, guestRouteFor } from "./guestRouting";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

describe("guest mirror routing", () => {
  it("checks every classified command against the same minimum role as the host", () => {
    for (const [command, access] of Object.entries(GUEST_COMMAND_ROUTES)) {
      for (const role of [null, "viewer", "controller", "editor"] as const) {
        const expected = access === "local" || access === "view" ||
          ((access === "control" || access === "custom") && (role === "controller" || role === "editor")) ||
          (access === "edit" && role === "editor");
        expect(guestCanInvoke(role, command), `${role}: ${command}`).toBe(expected);
      }
    }
    expect(guestCanInvoke("editor", "unclassified")).toBe(false);
  });

  it("routes video state and live controls to the host, but not its display setup", () => {
    for (const command of ["video_live_state", "video_output_status", "video_media_status", "video_live_action", "video_scrub", "get_pads_catalog", "load_pad_key"]) {
      expect(guestRouteFor(command)).toBe("host");
    }
    expect(guestCanInvoke("viewer", "video_live_state")).toBe(true);
    expect(guestCanInvoke("viewer", "video_live_action")).toBe(false);
    expect(guestCanInvoke("controller", "video_live_action")).toBe(true);
    expect(guestCanInvoke("controller", "load_pad_key")).toBe(false);
    expect(guestCanInvoke("editor", "load_pad_key")).toBe(true);
    expect(guestRouteFor("video_apply_settings")).toBe("local");
  });
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
