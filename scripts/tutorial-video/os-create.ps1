# The "create session" scene of the tutorial video: a real click on the app's
# Create button, then the system save dialog filled in by typing — first the
# folder (to show it can go anywhere), then the session name.
#
#   powershell -File os-create.ps1 -ClickX 640 -ClickY 520 -Folder C:\Shows -Name "Domingo"
#
# The mouse and keyboard really move while this runs.
param(
  [int]$ClickX,
  [int]$ClickY,
  [string]$Folder,
  [string]$Name,
  # Only minimize the test drivers' consoles (before the recording starts).
  [switch]$HideConsolesOnly
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LtInput2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  // The test drivers' black console windows would sit over the app on camera.
  public static void MinimizeConsoles() {
    EnumWindows((h, p) => {
      var sb = new System.Text.StringBuilder(256);
      GetClassName(h, sb, 256);
      var c = sb.ToString();
      if (IsWindowVisible(h) && (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS")) ShowWindow(h, 6);
      return true;
    }, IntPtr.Zero);
  }
  public struct POINT { public int X; public int Y; }
}
"@

function Glide($toX, $toY, $ms) {
  $p = New-Object LtInput2+POINT; [LtInput2]::GetCursorPos([ref]$p) | Out-Null
  $steps = [Math]::Max(10, [int]($ms / 16))
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps
    $e = if ($t -lt 0.5) { 2 * $t * $t } else { 1 - [Math]::Pow(-2 * $t + 2, 2) / 2 }
    [LtInput2]::SetCursorPos([int]($p.X + ($toX - $p.X) * $e), [int]($p.Y + ($toY - $p.Y) * $e)) | Out-Null
    Start-Sleep -Milliseconds 16
  }
}
function Click() {
  [LtInput2]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  [LtInput2]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
}
# Typed a key at a time so the video shows it being written.
function TypeSlow($text) {
  foreach ($ch in $text.ToCharArray()) {
    $k = [string]$ch
    if ("+^%~(){}[]".Contains($k)) { $k = "{" + $k + "}" }
    [System.Windows.Forms.SendKeys]::SendWait($k)
    Start-Sleep -Milliseconds 55
  }
}

[LtInput2]::MinimizeConsoles()
if ($HideConsolesOnly) { exit 0 }
Start-Sleep -Milliseconds 300
Glide $ClickX $ClickY 900
Start-Sleep -Milliseconds 300
Click

# Wait for the "Crear proyecto" dialog.
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, "Crear proyecto")
$dlg = $null
for ($i = 0; $i -lt 60 -and -not $dlg; $i++) {
  Start-Sleep -Milliseconds 200
  $dlg = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
if (-not $dlg) { throw "the Crear proyecto dialog did not open" }
[LtInput2]::SetForegroundWindow([IntPtr]$dlg.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 1500

# The file-name box has the focus. Typing a folder and Enter navigates there.
[System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 300
TypeSlow $Folder
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 1800
# Now the session's name.
[System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 300
TypeSlow $Name
Start-Sleep -Milliseconds 1200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 800
Write-Output "session created: $Folder\$Name"
