import { execFileSync } from "node:child_process";

/**
 * Moves the REAL Windows mouse pointer off the app window, to the bottom-right
 * corner of the primary screen (over the taskbar). A pointer resting over the
 * webview sends its own pointermove events between the synthetic CDP ones, and
 * those steal pointer capture mid-drag: a resize or a clip drag then does
 * nothing. Harmless anywhere else.
 */
export function parkOsCursor(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($b.Right - 2), ($b.Bottom - 2))",
      ],
      { stdio: "ignore" },
    );
  } catch {
    // Best effort: the captures still work if nobody touches the mouse.
  }
}
